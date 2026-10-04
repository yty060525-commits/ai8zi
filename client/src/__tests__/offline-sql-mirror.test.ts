import { describe, expect, it } from 'vitest';
import initSqlJs from 'sql.js';
import { RECORD_COLS, LEGACY_COLS, PRAGMA, colsOf, insertSqlFromSource, mirrorCreate, exportCreates, migrationStatements, offlineSource, stringLiteralsIn } from './helpers/offlineSqlLiterals';

/* 本机 SQLite 镜像(offlineSql.ts)是唯一一份「浏览器里真的拿去执行」的建表/迁移语句。
 * 这一层此前没有任何判据：ensureSql() 在 MODE==='test' 下直接返回 null，
 * sqlMirror.readAll/saveAll 在测试里一律短路成「不支持」，于是 migrateToneColumn 的
 * 两条承诺(老库要补列；整行插入依赖这一列)从没被执行过一次。
 *
 * 这里不走那扇门：逐字取出产品源码里的 SQL(取文本的夹具由 offline-sql-harness 单独钉住)，
 * 交给 sql.js —— 中立第三方裁判 —— 真执行。改坏那一句会红，删短逻辑锚点找不到会当场抛错。 */

type Db = { run(sql: string, params?: unknown[]): void; exec(sql: string, params?: unknown[]): { columns: string[]; values: unknown[][] }[]; close(): void };
const wasm = () => initSqlJs({ locateFile: () => './sql-wasm.wasm' });
const tableInfo = (db: Db): string[] => {
  const rows = db.exec(PRAGMA);
  return rows.length ? rows[0].values.map((v) => String(v[0])) : [];
};
/** 产品迁移里那条 pragma 就是整句可执行 SQL(逐字取自源码)，不再需要拼回。 */
const migrationPragma = (): string => migrationStatements().pragma;
/** 只含旧列的老库(逐列照搬产品建表语句的约束：id 主键、name 非空)。 */
const legacyBytes = async (): Promise<Uint8Array> => {
  const SQL = await wasm();
  const legacy = new SQL.Database() as unknown as Db;
  try {
    legacy.run('CREATE TABLE bazi_records (' + LEGACY_COLS.map((c) =>
      (c === 'id' ? 'id TEXT PRIMARY KEY' : c === 'name' ? 'name TEXT NOT NULL' : c + ' TEXT')).join(', ') + ')');
    legacy.run("INSERT INTO bazi_records (id,name,gender,birth_year,birth_month,created_at,year_pillar,month_pillar,day_pillar,hour_pillar,ai_status) VALUES ('row-1','甲','male',1990,5,'2025-01-01','庚午','辛巳','乙酉','癸未','completed')");
    return (legacy as unknown as { export(): Uint8Array }).export();
  } finally { legacy.close(); }
};

describe('本机 SQLite 镜像：建表、老库补列与整行插入', () => {
  it('镜像的建表语句可执行，列集与 RECORD_COLS 完全一致', async () => {
    const SQL = await wasm();
    const create = mirrorCreate();
    const db = new SQL.Database() as unknown as Db;
    try {
      db.run(create);
      expect([...tableInfo(db)].sort()).toEqual([...RECORD_COLS].sort());
      expect(colsOf(create)).toEqual(tableInfo(db));
    } finally { db.close(); }
  });

  it('缺 tone_used 的老库：ALTER 之后产品那条整行插入才成立，语气档写得进也读得回', async () => {
    const bytes = await legacyBytes();
    const SQL = await wasm();
    // 执行 migrateToneColumn 里那两句原文(先查 → 缺列才 ALTER)，不是照记忆重写
    const mig = migrationStatements();
    const opened = new SQL.Database(bytes) as unknown as Db;
    try {
      expect(tableInfo(opened), '夹具应当正好缺这一列').toEqual(LEGACY_COLS);
      expect(opened.exec(migrationPragma())[0].values.some((v) => String(v[0]) === 'tone_used')).toBe(false);
      opened.run(migrationStatements().alter);
      expect(tableInfo(opened)).toContain('tone_used');
      opened.run(insertSqlFromSource(),
        [...LEGACY_COLS.map((c) => (c === 'id' ? 'row-1' : c === 'birth_year' || c === 'birth_month' ? 1990 : 'v')), 70]);
      const back = opened.exec('SELECT tone_used FROM bazi_records WHERE id=?', ['row-1']);
      expect(Number(back[0].values[0][0]), '补了列却存不进语气档').toBe(70);
    } finally { opened.close(); }
  });

  it('反向钉子：没补列的老库上跑同一条整行插入必须当场报错(证明上一条不是空跑)', async () => {
    const bytes = await legacyBytes();
    const SQL = await wasm();
    const db = new SQL.Database(bytes) as unknown as Db;
    try {
      expect(tableInfo(db)).not.toContain('tone_used');
      expect(() => db.run(insertSqlFromSource(),
        [...LEGACY_COLS.map((c) => (c === 'birth_year' || c === 'birth_month' ? 1990 : 'v')), 50])).toThrow();
    } finally { db.close(); }
  });

  it('护栏测的是「表不存在」而不是「查询失效」：同一条 pragma 对真表和查不到的表读数不同', async () => {
    const bytes = await legacyBytes();
    const SQL = await wasm();
    const db = new SQL.Database(bytes) as unknown as Db;
    try {
      expect(db.exec(PRAGMA).length, '夹具本身要能查出列，否则「空数组」是查询失效而非表缺失').toBe(1);
      expect(db.exec("SELECT name FROM pragma_table_info('bazi_records_typo')")).toEqual([]);
    } finally { db.close(); }
  });

  it('pragma 查的必须就是 bazi_records：写成别的表名，缺列的老库会被当成已迁移而永不补列', () => {
    const mig = migrationStatements();
    // 判据执行的就是这一整句，所以「表名对不对」只能从这句里读出来再钉；
    // 而且要用**产品那份正则**去抽 —— 我自己写的那份和产品不一致时，这条判据等于没碰产品行为。
    expect(mig.pragma).toBe("SELECT name FROM pragma_table_info('bazi_records')");
    const tableOf = (sql: string): string => {
      const m = /pragma_table_info\('([^']+)'\)/.exec(sql);
      if (!m) throw new Error('这句不是 pragma_table_info 查询，判据失效：' + sql);
      return m[1];
    };
    expect(tableOf(mig.pragma), '迁移查的不是 bazi_records').toBe('bazi_records');
    expect(tableOf(PRAGMA)).toBe('bazi_records');
    // 源码里每一处 pragma 查询都得指向这张表(漏一处就是给未来的错表名留了门)。
    // 用扫描器取字面量，而不是自己写一条「引号配对」的正则：产品那句用双引号包 SQL、
    // 内层才是撇号，按 /'...'/ 去匹配会一条都取不到(实测命中 0 条，判据差点空跑)。
    const queries = [...stringLiteralsIn(offlineSource()).keys()].filter((s) => s.includes('pragma_table_info('));
    expect(queries.length, '源码里一处 pragma 都没有，判据失效').toBeGreaterThan(0);
    for (const q of queries) expect(tableOf(q)).toBe('bazi_records');
  });

  it('导出 .sqlite 与 .sql 文本的建表列集，和镜像读到的是同一张表', async () => {
    const SQL = await wasm();
    for (const [name, body] of exportCreates()) {
      const db = new SQL.Database() as unknown as Db;
      try {
        db.run(body);
        expect([...tableInfo(db)].sort(), name + ' 的列集与镜像不一致').toEqual([...RECORD_COLS].sort());
      } finally { db.close(); }
    }
  });
});
