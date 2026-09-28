import type { BaziRecord } from '../types/domain';
import { listBaziRecords, saveBaziRecord, fpOf } from './clientRepository';
import { RECORD_COLS, recordFromRow } from './offlineSql';

/**
 * 导入备份(.sqlite / .json)：
 *  - 与导出同一套存储格式，读取为 BaziRecord[]；
 *  - 再由 clientRepository 落库，桌面版写入本机 SQLite、网页版写入本地库并同步镜像。
 *  - overwrite：同 id 覆盖、新记录追加；dedupe：性别+四柱+出生年月相同则跳过(适合合并别人发的资料)。
 */

export type ImportMode = 'overwrite' | 'dedupe';

/** 行 -> BaziRecord 的映射与本机镜像/导出共用 offlineSql 里那一份(见 recordFromRow)。 */
/* 「同一个人」的指纹见 clientRepository.fpOf：性别+四柱+出生年月。之前只比到年份，
   「1990 年 3 月」和「1990 年 9 月」的四柱可能完全相同(月柱不同但年/日/时柱撞上的情况很常见)，
   dedupe 导入就会把第二个人当成重复而静默丢掉。同步合并也用同一口径。 */

/** 指纹一律取自存储(listBaziRecords 给的是瘦身版)。内存视图里 saveBaziRecord 的返回值带着
 *  引擎现算的派生数组，同一盘在两个时刻会算出不同指纹 —— 那会让第二次导入既认成老 id、
 *  又认成新人，去重形同虚设。 */
async function loadFingerprints(): Promise<Set<string>> {
  const set = new Set<string>();
  for (const r of await listBaziRecords()) set.add(fpOf(r));
  return set;
}

/** 解析 .sqlite(与桌面版同构)或 .json 备份文件为记录数组。 */
export async function parseBackupFile(bytes: Uint8Array, fileName: string): Promise<{ records: BaziRecord[] }> {
  const text = new TextDecoder().decode(bytes);
  const head = text.slice(0, 64).trimStart();
  // .json 备份
  if (fileName.toLowerCase().endsWith('.json') || head.startsWith('{')) {
    const parsed = JSON.parse(text) as { exportedAt?: string; records?: BaziRecord[] };
    const records = Array.isArray(parsed.records) ? parsed.records : Array.isArray(parsed) ? (parsed as unknown as BaziRecord[]) : [];
    return { records };
  }
  const initSqlJs = (await import('sql.js')).default;
  const SQL = await initSqlJs({ locateFile: () => './sql-wasm.wasm' });
  // SQLite 二进制(.sqlite/.sqlite3)按文件读；.sql 文本 dump 先执行整段 SQL 再读表
  const isBinary = head.startsWith('SQLite format 3');
  const db = isBinary ? new SQL.Database(bytes) : new SQL.Database();
  try {
    if (!isBinary) db.exec(text);
    // 老备份文件没有 tone_used 列：SELECT 指定它会让整条查询报错(整个文件都导不进来)，
    // 所以先按表实际有的列查，缺的那列读成 undefined，等于「这台设备没记录过语气」。
    const info = db.exec("SELECT name FROM pragma_table_info('bazi_records')");
    if (!info.length) return { records: [] };   // 表不存在(不是我们的备份)
    const have = new Set(info[0].values.map((v) => String(v[0])));
    const queryable = RECORD_COLS.filter((c) => have.has(c));
    if (!queryable.includes('id')) return { records: [] };
    const found = db.exec(`SELECT ${queryable.join(',')} FROM bazi_records`);
    if (!found.length) return { records: [] };
    const cols = found[0].columns;
    const records = found[0].values.map((v) => recordFromRow(Object.fromEntries(cols.map((c, i) => [c, v[i]])) as Record<string, unknown>));
    return { records };
  } finally {
    db.close();
  }
}
export interface ImportSummary { added: number; updated: number; skipped: number; total: number }

/** 把备份记录合并进本机库。 */
export async function importRecords(records: BaziRecord[], mode: ImportMode): Promise<ImportSummary> {
  const existing = await listBaziRecords();
  const existingIds = new Set(existing.map((r) => r.id).filter((id): id is string => !!id));
  // 指纹一律取自**存储里的那一份**(见 loadFingerprints)，不能拿 saveBaziRecord 的返回值算：
  // 它为了界面会再 hydrate 一次，于是同一盘在「刚入库」和「下次读列表」两个时刻算出两个指纹，
  // dedupe 第二次导入时既认成老 id(updated)又认成新人(added)，计数自相矛盾、去重形同虚设。
  const fingerprint = await loadFingerprints();
  const seen: Record<string, boolean> = {};
  let added = 0;
  let updated = 0;
  let skipped = 0;
  for (const raw of records) {
    const record = { ...raw, id: raw.id || undefined };
    if (!record.name || !record.yearPillar) { skipped += 1; continue; }
    const dedupeKey = fpOf(record as BaziRecord);
    const isUpdate = !!record.id && existingIds.has(record.id);
    // 「同 id 覆盖」优先于去重：用户勾了 overwrite 就是要这条盖掉库里那条。旧实现让文件内部
    // 去重(seen)先返回，于是「同一个人在备份里出现两次(改过名)」时第二条被静默丢掉，
    // 界面显示的仍是导入前的旧名字 —— 而它明明写着「同 id 覆盖」。
    if (isUpdate) {
      await saveBaziRecord(record);
      const previous = existing.find((r) => r.id === record.id);
      // 库里换了人，旧指纹要一并撤掉：否则同一批后面那条真·重复会被作废的指纹拦下。
      if (previous) fingerprint.delete(fpOf(previous));
      fingerprint.add(dedupeKey);
      updated += 1;
      continue;
    }
    if (seen[dedupeKey]) { skipped += 1; continue; } // 文件内部重复(新盘只保留一条)
    seen[dedupeKey] = true;
    if (mode === 'dedupe' && fingerprint.has(dedupeKey)) { skipped += 1; continue; }
    await saveBaziRecord(record);
    added += 1;
    fingerprint.add(dedupeKey);
    if (record.id) existingIds.add(record.id);
  }
  return { added, updated, skipped, total: records.length };
}
