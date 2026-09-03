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

let sqlModulePromise: Promise<{ newDb: (bytes?: Uint8Array) => { run(sql: string, params?: unknown[]): void; prepare(sql: string): { run(params?: unknown[]): void; free(): void }; exec(sql: string): { columns: string[]; values: unknown[][] }[]; exportBytes(): Uint8Array; close(): void } } | null> | null = null;
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
            non_ai_result TEXT, ai_status TEXT NOT NULL, ai_analysis TEXT, ai_overview TEXT, ai_error TEXT, ai_tasks TEXT
          );`);
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

export const sqlMirror = {
  supported,
  async readAll(): Promise<BaziRecord[] | null> {
    const bytes = await idbGet(DB_KEY);
    if (!bytes) return null;
    const sql = await ensureSql();
    if (!sql) return null;
    try {
      const db = sql.newDb(bytes);
      const rows = db.exec('SELECT id,name,gender,birth_year,birth_month,created_at,year_pillar,month_pillar,day_pillar,hour_pillar,non_ai_result,ai_status,ai_analysis,ai_overview,ai_error,ai_tasks FROM bazi_records');
      db.close();
      if (!rows.length) return [];
      const cols = rows[0].columns;
      return rows[0].values.map((v) => {
        const row = Object.fromEntries(cols.map((c, i) => [c, v[i]])) as Record<string, unknown>;
        return {
          id: row.id as string, name: row.name as string, gender: row.gender as BaziRecord['gender'],
          birthYear: Number(row.birth_year), birthMonth: Number(row.birth_month), createdAt: row.created_at as string,
          yearPillar: row.year_pillar as string, monthPillar: row.month_pillar as string, dayPillar: row.day_pillar as string, hourPillar: row.hour_pillar as string,
          nonAiResult: jsonCell(row.non_ai_result), aiStatus: row.ai_status as BaziRecord['aiStatus'],
          aiAnalysis: jsonCell(row.ai_analysis), aiOverview: jsonCell(row.ai_overview), aiError: row.ai_error as string | undefined,
          aiTasks: jsonCell(row.ai_tasks),
        } as BaziRecord;
      });
    } catch { return null; }
  },
  /** 全量覆盖写库(数据量小，简单可靠)，并落盘到 IndexedDB。 */
  async saveAll(records: BaziRecord[]): Promise<boolean> {
    const sql = await ensureSql();
    if (!sql) return false;
    try {
      const db = sql.newDb();
      const ins = db.prepare('INSERT OR REPLACE INTO bazi_records (id,name,gender,birth_year,birth_month,created_at,year_pillar,month_pillar,day_pillar,hour_pillar,non_ai_result,ai_status,ai_analysis,ai_overview,ai_error,ai_tasks) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
      for (const r of records) {
        ins.run([r.id, r.name, r.gender, r.birthYear, r.birthMonth, r.createdAt, r.yearPillar, r.monthPillar, r.dayPillar, r.hourPillar,
          r.nonAiResult ? JSON.stringify(r.nonAiResult) : null, r.aiStatus ?? 'not_started',
          r.aiAnalysis ? JSON.stringify(r.aiAnalysis) : null, r.aiOverview ? JSON.stringify(r.aiOverview) : null, r.aiError ?? null,
          r.aiTasks ? JSON.stringify(r.aiTasks) : null]);
      }
      ins.free();
      const out = db.exportBytes();
      db.close();
      return idbSet(DB_KEY, out);
    } catch { return false; }
  },
};
