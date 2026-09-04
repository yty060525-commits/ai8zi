import type { BaziRecord } from '../types/domain';
import { listBaziRecords, saveBaziRecord } from './clientRepository';

/**
 * 导入备份(.sqlite / .json)：
 *  - 与导出同一套存储格式，读取为 BaziRecord[]；
 *  - 再由 clientRepository 落库，桌面版写入本机 SQLite、网页版写入本地库并同步镜像。
 *  - overwrite：同 id 覆盖、新记录追加；dedupe：性别+四柱+出生年相同则跳过(适合合并别人发的资料)。
 */

export type ImportMode = 'overwrite' | 'dedupe';

const jsonCell = (v: unknown) => (v === null || v === undefined ? undefined : JSON.parse(String(v)));
const fpOf = (r: BaziRecord) => [r.gender, r.yearPillar, r.monthPillar, r.dayPillar, r.hourPillar, r.birthYear].join('|');

/** 解析 .sqlite(与桌面版同构)或 .json 备份文件为记录数组。 */
export async function parseBackupFile(bytes: Uint8Array, fileName: string): Promise<{ records: BaziRecord[] }> {
  const head = new TextDecoder().decode(bytes.slice(0, 64)).trimStart();
  if (fileName.toLowerCase().endsWith('.json') || head.startsWith('{')) {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as { exportedAt?: string; records?: BaziRecord[] };
    const records = Array.isArray(parsed.records) ? parsed.records : Array.isArray(parsed) ? (parsed as unknown as BaziRecord[]) : [];
    return { records };
  }
  const initSqlJs = (await import('sql.js')).default;
  const SQL = await initSqlJs({ locateFile: () => './sql-wasm.wasm' });
  const db = new SQL.Database(bytes);
  try {
    const rows = db.exec('SELECT id,name,gender,birth_year,birth_month,created_at,year_pillar,month_pillar,day_pillar,hour_pillar,non_ai_result,ai_status,ai_analysis,ai_overview,ai_error,ai_tasks FROM bazi_records');
    if (!rows.length) return { records: [] };
    const cols = rows[0].columns;
    const records = rows[0].values.map((v) => {
      const row = Object.fromEntries(cols.map((c, i) => [c, v[i]])) as Record<string, unknown>;
      return {
        id: row.id as string, name: row.name as string, gender: row.gender as BaziRecord['gender'],
        birthYear: Number(row.birth_year), birthMonth: Number(row.birth_month), createdAt: row.created_at as string,
        yearPillar: row.year_pillar as string, monthPillar: row.month_pillar as string, dayPillar: row.day_pillar as string, hourPillar: row.hour_pillar as string,
        nonAiResult: jsonCell(row.non_ai_result), aiStatus: row.ai_status as BaziRecord['aiStatus'],
        aiAnalysis: jsonCell(row.ai_analysis), aiOverview: jsonCell(row.ai_overview), aiError: jsonCell(row.ai_error),
        aiTasks: jsonCell(row.ai_tasks),
      } as BaziRecord;
    });
    return { records };
  } finally {
    db.close();
  }
}

/** 落库导入结果统计。 */
export interface ImportSummary { added: number; updated: number; skipped: number; total: number }

/** 把备份记录合并进本机库。 */
export async function importRecords(records: BaziRecord[], mode: ImportMode): Promise<ImportSummary> {
  const existing = await listBaziRecords();
  const existingIds = new Set(existing.map((r) => r.id).filter((id): id is string => !!id));
  const fingerprint = new Set(existing.map(fpOf));
  const seen: Record<string, boolean> = {};
  let added = 0;
  let updated = 0;
  let skipped = 0;
  for (const raw of records) {
    const record = { ...raw, id: raw.id || undefined };
    if (!record.name || !record.yearPillar) { skipped += 1; continue; }
    const dedupeKey = fpOf(record as BaziRecord);
    if (seen[dedupeKey]) { skipped += 1; continue; } // 文件内部重复(同盘只保留一条)
    seen[dedupeKey] = true;
    if (mode === 'dedupe' && fingerprint.has(dedupeKey)) { skipped += 1; continue; }
    const isUpdate = !!record.id && existingIds.has(record.id);
    await saveBaziRecord(record);
    if (isUpdate) updated += 1; else added += 1;
    fingerprint.add(dedupeKey);
    if (record.id) existingIds.add(record.id);
  }
  return { added, updated, skipped, total: records.length };
}
