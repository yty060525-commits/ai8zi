import type { BaziRecord } from '../types/domain';

/**
 * 客户端本地“真 SQLite 镜像”：sql.js 数据库文件字节持久化到 IndexedDB。
 * 无网时应用从该库读取记录；导出/搜索与桌面 SQLite 同构。
 * 仅在浏览器可用(测试/隐私模式自动禁用)。
 */
const IDB_NAME = 'mingli-local';
const IDB_STORE = 'kv';
const DB_KEY = 'sqlite-bytes';

const supported = (): boolean => typeof window !== 'undefined' && typeof indexedDB !== 'undefined' && import.meta.env.MODE !== 'test';

function openIdb(): Promise<IDBDatabase | null> {
  if (!supported()) return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(IDB_STORE)) req.result.createObjectStore(IDB_STORE); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}
async function idbGet(key: string): Promise<Uint8Array | null> {
  const db = await openIdb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(key);
      req.onsuccess = () => { resolve(req.result instanceof Uint8Array ? req.result : null); db.close(); };
      req.onerror = () => { resolve(null); db.close(); };
    } catch { resolve(null); db.close(); }
  });
}
async function idbSet(key: string, bytes: Uint8Array): Promise<boolean> {
  const db = await openIdb();
  if (!db) return false;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(bytes, key);
      tx.oncomplete = () => { resolve(true); db.close(); };
      tx.onerror = () => { resolve(false); db.close(); };
    } catch { resolve(false); db.close(); }
  });
}

interface SqlDb { run(sql: string, params?: unknown[]): void; prepare(sql: string): { run(params?: unknown[]): void; free(): void }; exec(sql: string): { columns: string[]; values: unknown[][] }[]; exportBytes(): Uint8Array; close(): void }

let sqlModulePromise: Promise<{ newDb: (bytes?: Uint8Array) => SqlDb } | null> | null = null;
async function ensureSql() {
  if (sqlModulePromise !== null) return sqlModulePromise;
  sqlModulePromise = (async () => {
    if (!supported()) return null;
    try {
      const mod = (await import('sql.js')).default;
      const SQL = await mod({ locateFile: () => './sql-wasm.wasm' });
      return {
        newDb: (bytes?: Uint8Array) => {
          const db = new SQL.Database(bytes);
          if (!bytes) db.run(`CREATE TABLE IF NOT EXISTS bazi_records (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, gender TEXT NOT NULL, birth_year INTEGER NOT NULL, birth_month INTEGER NOT NULL,
            created_at TEXT NOT NULL, year_pillar TEXT NOT NULL, month_pillar TEXT NOT NULL, day_pillar TEXT NOT NULL, hour_pillar TEXT NOT NULL,
            non_ai_result TEXT, ai_status TEXT NOT NULL, ai_analysis TEXT, ai_overview TEXT, ai_error TEXT, ai_tasks TEXT, tone_used INTEGER
          );`);
          else migrateToneColumn(db as never);
          return {
            run: (sql: string, params?: unknown[]) => db.run(sql, params),
            prepare: (sql: string) => {
              const st = db.prepare(sql);
              return { run: (params?: unknown[]) => st.run(params), free: () => st.free() };
            },
            exec: (sql: string) => db.exec(sql),
            exportBytes: () => db.export(),
            close: () => db.close(),
          };
        },
      };
    } catch { return null; }
  })();
  return sqlModulePromise;
}

const jsonCell = (v: unknown) => (v === null || v === undefined ? undefined : JSON.parse(String(v)));

/** bazi_records 的全部列，顺序即 SQL 里 VALUES 的顺序。三处写/读(本机镜像、导出 .sqlite、
 *  导入备份)共用这一份 —— 各写各的列名时，加一列就会有一处静默漏掉，语气档正是这么丢的。 */
export const RECORD_COLS = ['id', 'name', 'gender', 'birth_year', 'birth_month', 'created_at',
  'year_pillar', 'month_pillar', 'day_pillar', 'hour_pillar', 'non_ai_result', 'ai_status',
  'ai_analysis', 'ai_overview', 'ai_error', 'ai_tasks', 'tone_used'] as const;
export const SELECT_RECORDS = `SELECT ${RECORD_COLS.join(',')} FROM bazi_records`;
export const INSERT_RECORDS = `INSERT OR REPLACE INTO bazi_records (${RECORD_COLS.join(',')}) VALUES (${RECORD_COLS.map(() => '?').join(',')})`;
/** 一行 -> BaziRecord。缺 tone_used 列的老库(迁移前写的)会读出 undefined，等于「没记录过」。 */
export const recordFromRow = (row: Record<string, unknown>): BaziRecord => ({
  id: row.id as string, name: row.name as string, gender: row.gender as BaziRecord['gender'],
  birthYear: Number(row.birth_year), birthMonth: Number(row.birth_month), createdAt: row.created_at as string,
  yearPillar: row.year_pillar as string, monthPillar: row.month_pillar as string, dayPillar: row.day_pillar as string, hourPillar: row.hour_pillar as string,
  nonAiResult: jsonCell(row.non_ai_result), aiStatus: row.ai_status as BaziRecord['aiStatus'],
  aiAnalysis: jsonCell(row.ai_analysis), aiOverview: jsonCell(row.ai_overview), aiError: jsonCell(row.ai_error),
  aiTasks: jsonCell(row.ai_tasks),
  toneUsed: row.tone_used == null ? undefined : Number(row.tone_used),
} as BaziRecord);
/** BaziRecord -> 与 RECORD_COLS 同序的一行参数。 */
export const recordToCells = (r: BaziRecord): unknown[] => [
  r.id, r.name, r.gender, r.birthYear, r.birthMonth, r.createdAt, r.yearPillar, r.monthPillar, r.dayPillar, r.hourPillar,
  r.nonAiResult ? JSON.stringify(r.nonAiResult) : null, r.aiStatus ?? 'not_started',
  r.aiAnalysis ? JSON.stringify(r.aiAnalysis) : null, r.aiOverview ? JSON.stringify(r.aiOverview) : null, r.aiError ?? null,
  r.aiTasks ? JSON.stringify(r.aiTasks) : null, r.toneUsed ?? null,
];

/** 老库(含用户设备上早已存在的 IndexedDB 镜像、别人发的旧备份文件)补 tone_used 列。
 *  exec 返回空数组 = 表不存在，此时**不能** ALTER(SQLite 会建出一张只含这一列的假表，
 *  随后插入整行直接报错)，留给新建时的 CREATE TABLE 处理。 */
function migrateToneColumn(db: SqlDb): void {
  try {
    const rows = db.exec("SELECT name FROM pragma_table_info('bazi_records')");
    if (!rows.length) return;
    if (rows[0].values.some((v) => String(v[0]) === 'tone_used')) return;
    db.run('ALTER TABLE bazi_records ADD COLUMN tone_used INTEGER');
  } catch { /* 引擎不支持 pragma：读写路径自会兜住 */ }
}

export const sqlMirror = {
  supported,
  async readAll(): Promise<BaziRecord[] | null> {
    const bytes = await idbGet(DB_KEY);
    if (!bytes) return null;
    const sql = await ensureSql();
    if (!sql) return null;
    try {
      const db = sql.newDb(bytes);
      const rows = db.exec(SELECT_RECORDS);
      db.close();
      if (!rows.length) return [];
      const cols = rows[0].columns;
      return rows[0].values.map((v) => recordFromRow(Object.fromEntries(cols.map((c, i) => [c, v[i]])) as Record<string, unknown>));
    } catch { return null; }
  },
  /** 全量覆盖写库(数据量小，简单可靠)，并落盘到 IndexedDB。 */
  async saveAll(records: BaziRecord[]): Promise<boolean> {
    const sql = await ensureSql();
    if (!sql) return false;
    try {
      const db = sql.newDb();
      const ins = db.prepare(INSERT_RECORDS);
      for (const r of records) ins.run(recordToCells(r));
      ins.free();
      const out = db.exportBytes();
      db.close();
      return idbSet(DB_KEY, out);
    } catch { return false; }
  },
};
