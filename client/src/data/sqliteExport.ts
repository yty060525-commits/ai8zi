import type { BaziRecord } from '../types/domain';

/** 在浏览器内用 sql.js 生成与桌面版一致的 SQLite 文件(.sqlite)。 */
export async function exportRecordsSQLite(records: BaziRecord[]): Promise<Uint8Array> {
  const initSqlJs = (await import('sql.js')).default;
  const SQL = await initSqlJs({ locateFile: () => './sql-wasm.wasm' });
  const db = new SQL.Database();
  db.run(`CREATE TABLE bazi_records (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, gender TEXT NOT NULL, birth_year INTEGER NOT NULL, birth_month INTEGER NOT NULL,
    created_at TEXT NOT NULL, year_pillar TEXT NOT NULL, month_pillar TEXT NOT NULL, day_pillar TEXT NOT NULL, hour_pillar TEXT NOT NULL,
    non_ai_result TEXT, ai_status TEXT NOT NULL, ai_analysis TEXT, ai_overview TEXT, ai_error TEXT, ai_tasks TEXT
  );`);
  db.run(`CREATE TABLE IF NOT EXISTS ai_cache (cache_key TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at TEXT NOT NULL);`);
  const insert = db.prepare(`INSERT OR REPLACE INTO bazi_records (id,name,gender,birth_year,birth_month,created_at,year_pillar,month_pillar,day_pillar,hour_pillar,non_ai_result,ai_status,ai_analysis,ai_overview,ai_error,ai_tasks) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const r of records) {
    insert.run([r.id, r.name, r.gender, r.birthYear, r.birthMonth, r.createdAt, r.yearPillar, r.monthPillar, r.dayPillar, r.hourPillar,
      r.nonAiResult ? JSON.stringify(r.nonAiResult) : null,
      r.aiStatus ?? 'not_started',
      r.aiAnalysis ? JSON.stringify(r.aiAnalysis) : null,
      r.aiOverview ? JSON.stringify(r.aiOverview) : null,
      r.aiError ?? null,
      r.aiTasks ? JSON.stringify(r.aiTasks) : null]);
  }
  insert.free();
  const out = db.export();
  db.close();
  return out;
}

/** 生成 SQL 文本 dump(.sql)：与 .sqlite 同一套表结构，方便在任意文本工具/DB 里查看。 */
export function exportRecordsSQLText(records: BaziRecord[]): string {
  const esc = (v: unknown) => (v === null || v === undefined ? 'NULL' : "'" + String(v).replace(/'/g, "''") + "'");
  const cols = ['id','name','gender','birth_year','birth_month','created_at','year_pillar','month_pillar','day_pillar','hour_pillar','non_ai_result','ai_status','ai_analysis','ai_overview','ai_error','ai_tasks'];
  const lines: string[] = [];
  lines.push('PRAGMA foreign_keys=OFF;');
  lines.push('BEGIN TRANSACTION;');
  lines.push('CREATE TABLE IF NOT EXISTS bazi_records ('
    + 'id TEXT PRIMARY KEY, name TEXT NOT NULL, gender TEXT NOT NULL, birth_year INTEGER NOT NULL, birth_month INTEGER NOT NULL, '
    + 'created_at TEXT NOT NULL, year_pillar TEXT NOT NULL, month_pillar TEXT NOT NULL, day_pillar TEXT NOT NULL, hour_pillar TEXT NOT NULL, '
    + 'non_ai_result TEXT, ai_status TEXT NOT NULL, ai_analysis TEXT, ai_overview TEXT, ai_error TEXT, ai_tasks TEXT);');
  for (const r of records) {
    const values = [r.id, r.name, r.gender, r.birthYear, r.birthMonth, r.createdAt, r.yearPillar, r.monthPillar, r.dayPillar, r.hourPillar,
      r.nonAiResult ? JSON.stringify(r.nonAiResult) : null, r.aiStatus ?? 'not_started',
      r.aiAnalysis ? JSON.stringify(r.aiAnalysis) : null, r.aiOverview ? JSON.stringify(r.aiOverview) : null, r.aiError ?? null,
      r.aiTasks ? JSON.stringify(r.aiTasks) : null];
    lines.push('INSERT OR REPLACE INTO bazi_records (' + cols.join(',') + ') VALUES (' + values.map(esc).join(',') + ');');
  }
  lines.push('COMMIT;');
  return lines.join('\n');
}

