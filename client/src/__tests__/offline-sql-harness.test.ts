import { describe, expect, it } from 'vitest';
import { literal, statementIn, stringLiteralsIn, concatLiteral, colsOf, createBody, RECORD_COLS, LEGACY_COLS, PRAGMA, recordColsFromSource, insertSqlFromSource, mirrorCreate, exportCreates, migrationStatements } from './helpers/offlineSqlLiterals';

/* 下面那批判据全靠「从源码文本里取出 SQL」，所以取文本的夹具本身必须先被钉住：
 * 夹具错了，判据会在正确的产品代码上报绿(或反过来)。这里用自造样本文本测夹具。 */
const A = (s: string, a: string) => literal(s, a);
const S = (s: string, p: string) => statementIn(s, p);

describe('SQL 取文本夹具自身', () => {
  it('锚点自带开引号：同一句里先出现别的引号也不会抓错段', () => {
    const sample = "db.run(`CREATE TABLE t (a TEXT);`); f('z'); const Y = `SELECT 'x' FROM t`;";
    expect(A(sample, 'db.run(`')).toBe('CREATE TABLE t (a TEXT);');
  });
  it('单引号字面量照取，SQL 内部的撇号不会截断(转义由调用方处理)', () => {
    const sample = "db.run('ALTER TABLE b ADD COLUMN c INTEGER');";
    expect(A(sample, "db.run('")).toBe('ALTER TABLE b ADD COLUMN c INTEGER');
  });
  it('跨行的模板字面量要整段还原', () => {
    const sample = "db.run(`CREATE TABLE t (\n  a TEXT PRIMARY KEY\n);`);\nexport const Z = 'other';";
    expect(A(sample, 'db.run(`')).toContain('a TEXT PRIMARY KEY');
    expect(colsOf(A(sample, 'db.run(`'))).toEqual(['a']);
  });
  it('锚点末尾不带开引号时必须抛错，不能猜(猜就会撞上 SQL 内部的引号)', () => {
    expect(() => A("db.run('abc');", 'abc')).toThrow(/开引号/);
    expect(() => A("const x = 'y';", 'CREATE TABLE nope (')).toThrow(/锚点/);
  });
  it('取语句一律「整条认领」：literal 靠同种引号配对，遇到 SQL 自带同类引号就会截断', () => {
    // 形态一：双引号包 SQL、内层是撇号 → 两种取法结果相同(外层闭合引号在 SQL 之后)
    const dq = "db.exec(\"SELECT name FROM pragma_table_info('bazi_records')\")";
    expect(A(dq, 'db.exec("')).toBe(S(dq, 'SELECT name FROM pragma_table_info('));
    // 形态二：单引号包 SQL、内部再转义单引号 → literal 认第一个 \' 为结尾，取出少一截尾巴。
    // 形态二：单引号包 SQL、内部**未转义**的撇号 → literal 认它为结尾，取出少一截尾巴。
    // 这就是这类语句必须整条认领的原因：literal 会「不抛错地」交出半句 SQL 去执行。
    const sq = "db.run('SELECT name FROM pragma_table_info('bazi_records')');";
    expect(A(sq, "db.run('")).toBe('SELECT name FROM pragma_table_info(');
    // 正向钉子：同一句改成合法写法(内层换双引号)后，两种取法都完好 —— 红不是扫描器失效
    const ok = 'db.run(\'SELECT name FROM pragma_table_info("bazi_records")\');';
    expect(A(ok, "db.run('")).toBe('SELECT name FROM pragma_table_info("bazi_records")');
    expect(S(ok, 'SELECT name FROM pragma_table_info(')).toBe('SELECT name FROM pragma_table_info("bazi_records")');
    // 正向钉子：产品现在用的是形态一，所以整条认领取出的正是界面里那句完整 pragma
    expect(migrationStatements().pragma).toBe(PRAGMA);
  });
  it('多段 + 拼接的字符串要还原成一条完整 SQL(concatLiteral)', () => {
    const sample = "lines.push('CREATE TABLE t ('\n  + 'a TEXT PRIMARY KEY, '\n  + 'b INTEGER);');\nlines.push('INSERT INTO u VALUES (1);');";
    expect(concatLiteral(sample, "lines.push('CREATE TABLE t ('")).toBe('CREATE TABLE t (a TEXT PRIMARY KEY, b INTEGER);');
  });
  it('拼接段里若改用 ${} 插值，必须抛错而不是悄悄拿到半截', () => {
    const sample = "lines.push('CREATE TABLE t (' + COLS.join(',') + `${x}`);');";
    expect(() => concatLiteral(sample, "lines.push('CREATE TABLE t ('")).toThrow(/插值/);
  });
  it('createBody 按括号配平收尾：内层 PRIMARY KEY (…) 不会提前截断，末段没有分号也能收', () => {
    expect(createBody('CREATE TABLE t (id TEXT PRIMARY KEY, n TEXT);')).toBe('id TEXT PRIMARY KEY, n TEXT');
    expect(createBody("CREATE TABLE t (id TEXT PRIMARY KEY, n TEXT)'")).toBe('id TEXT PRIMARY KEY, n TEXT');
    expect(() => createBody('CREATE TABLE t ( a TEXT')).toThrow(/没配对/);
  });
  it('语句级取法(statementIn)：整句原样取出，内层引号不会截断', () => {
    // pragma_table_info('t') 这种「SQL 里自带引号」的语句，用锚点+开引号会读出 "t')"
    // (实测踩过)，所以这里按前缀认领整条字面量。
    const sample = 'const rows = db.exec("SELECT name FROM pragma_table_info(\'t\')");';
    expect(S(sample, 'SELECT name FROM pragma_table_info(')).toBe("SELECT name FROM pragma_table_info('t')");
    // 反例一：源码里没有这句 → 抛错，不能返回 undefined 让判据空跑
    expect(() => S("db.run('DELETE FROM t');", 'SELECT name FROM pragma_table_info(')).toThrow(/恰好一条/);
    // 反例二：同一句出现两次(被复制/改名残留) → 也抛错，否则不知道执行的是哪一份
    expect(() => S("f('ALTER TABLE t');g('ALTER TABLE t extra');", 'ALTER TABLE t')).toThrow(/恰好一条/);
    // 正向钉子：只有一条时照常取出(证明上一条红是「多条」而不是扫描器失效)
    expect(S("f('ALTER TABLE t');g('ALTER TABLE u ADD COLUMN c');", 'ALTER TABLE u')).toBe('ALTER TABLE u ADD COLUMN c');
  });
  it('扫描器能跨过转义撇号、不把注释里的伪引号当语句(stringLiteralsIn)', () => {
    const sample = "const a = 'it\\'s ok'; // don't trust this\nconst b = `SELECT x FROM t`;";
    const values = stringLiteralsIn(sample);
    expect(values.get("it's ok")).toBe(1);
    // 注释里的 don 后面没有配对引号，不该被当成一条语句；'t' 那种片段也不该冒充整句
    expect([...values.keys()].some((v) => v.includes('trust'))).toBe(false);
    expect(values.has('SELECT x FROM t')).toBe(true);
  });
  it('夹具前提自证：LEGACY 就是 RECORD 去掉 tone_used', () => {
    expect(LEGACY_COLS.length).toBe(RECORD_COLS.length - 1);
    expect(RECORD_COLS.filter((c) => c !== 'tone_used')).toEqual(LEGACY_COLS);
  });
  it('从真实源码取出的 RECORD_COLS 与本文件的清单逐位相同(顺序也算)', () => {
    expect(recordColsFromSource()).toEqual(RECORD_COLS);
  });
  it('还原出的整行插入 SQL：列清单与占位符数量都等于列数', () => {
    const sql = insertSqlFromSource();
    expect(sql.startsWith('INSERT OR REPLACE INTO bazi_records (' + RECORD_COLS.join(',') + ') VALUES (')).toBe(true);
    expect(sql.split('?').length - 1).toBe(RECORD_COLS.length);
  });
  it('取迁移语句：整句原样，pragma 指向 bazi_records、ALTER 补的是 tone_used', () => {
    const mig = migrationStatements();
    expect(mig.pragma).toBe("SELECT name FROM pragma_table_info('bazi_records')");
    expect(mig.alter).toBe('ALTER TABLE bazi_records ADD COLUMN tone_used INTEGER');
  });
  it('镜像与导出的建表语句都能取到、且列集解析得出来(锚点漂移会当场抛错)', () => {
    const all = exportCreates().map(([name, body]) => [name, body] as const).concat([['镜像', mirrorCreate()] as const]);
    for (const [, body] of all) expect(colsOf(body).length).toBe(RECORD_COLS.length);
    expect(PRAGMA).toContain('bazi_records');
  });
});
