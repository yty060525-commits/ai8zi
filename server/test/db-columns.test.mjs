import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL as NodeURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

/* 三端各自手写了一遍「同一张表」：浏览器镜像(offlineSql.ts)、桌面 SQLite(lib.rs)、服务器(db.mjs)。
   编译器跨不了语言，测试也跨不了端 —— 加一列时漏掉哪一处，界面都不会报错，只会静默丢数据。
   语气档(tone_used)正是这么丢过一次：它当时不属于任何一列，换设备回读后滑杆谎报默认值，
   下一次分析还把本机已有的完整结果当成「改了语气」整轮清掉重算。

   这里用 node:sqlite 当第三方裁判(它不参与任何一端的实现)，把两份真实源码里的 SQL 字面量
   原样抽出来跑：建表语句能否执行、INSERT 的列名顺序与参数数组顺序是否逐位对得上。 */

const text = (rel) => readFileSync(fileURLToPath(new NodeURL(rel, import.meta.url)), 'utf8');

/** 从源码里取一条字符串字面量；找不到就抛错(而不是返回 undefined 让断言恒真)。 */
const literal = (rel, source, decl, group = 1) => {
  const hit = source.match(decl);
  if (!hit) throw new Error(`${rel} 里找不到 ${decl} —— 那段 SQL 被挪走或删掉了，判据本身失效`);
  return hit[group];
};

const DB_REL = '../db.mjs';
const OFFLINE_REL = '../../client/src/data/offlineSql.ts';
const dbSrc = text(DB_REL);
const offlineSrc = text(OFFLINE_REL);

/* ---------- 服务器端：recordToRow / rowToRecord 与 INSERT 的列序必须逐位一致 ---------- */

const serverCols = JSON.parse('[' + literal(DB_REL, dbSrc, /const RECORD_COLS = \[([^\]]+)\]/, 1).replace(/'/g, '"') + ']');
const { recordToRow, rowToRecord } = await import('../db.mjs');

test('服务器写库的列名顺序与参数数组顺序逐位对齐', () => {
  const rec = {
    id: 'r1', userId: 'u1', name: '甲', gender: 'male', birthYear: 1990, birthMonth: 5,
    createdAt: '2025-01-01T00:00:00.000Z',
    yearPillar: '庚午', monthPillar: '辛巳', dayPillar: '乙酉', hourPillar: '癸未',
    nonAiResult: { a: 1 }, aiStatus: 'completed', aiAnalysis: { b: 2 }, aiOverview: { c: 3 },
    aiError: 'e', aiTasks: { d: 4 }, toneUsed: 55,
  };
  const cells = recordToRow(rec);
  // 这一条同时钉住两件事：列数=参数数；以及「第 i 个参数确实落在第 i 个列上」。
  // 只比长度是假的 —— 上一版就是这么写的，交换相邻两个元素照样全绿。
  assert.equal(cells.length, serverCols.length, `列 ${serverCols.length} 个、参数 ${cells.length} 个`);
  const expected = [
    ['id', 'r1'], ['user_id', 'u1'], ['name', '甲'], ['gender', 'male'],
    ['birth_year', 1990], ['birth_month', 5], ['created_at', '2025-01-01T00:00:00.000Z'],
    ['year_pillar', '庚午'], ['month_pillar', '辛巳'], ['day_pillar', '乙酉'], ['hour_pillar', '癸未'],
    ['non_ai_result', '{"a":1}'], ['ai_status', 'completed'],
    ['ai_analysis', '{"b":2}'], ['ai_overview', '{"c":3}'], ['ai_error', 'e'],
    ['ai_tasks', '{"d":4}'], ['tone_used', 55],
  ];
  for (const [col, value] of expected) {
    const i = serverCols.indexOf(col);
    assert.ok(i >= 0, `RECORD_COLS 里没有 ${col}`);
    assert.deepEqual([col, cells[i]], [col, value]);
  }
  // updated_at 由服务端现算(nowText)，不参与比对，但必须是最后一列。
  assert.equal(serverCols.at(-1), 'updated_at');
});

test('服务器建表语句可执行，且 insert→读回 把语气档原样带回来', () => {
  const create = literal(DB_REL, dbSrc, /CREATE TABLE IF NOT EXISTS records \(([\s\S]*?)\n\);/, 1);
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE IF NOT EXISTS records (${create});`);
  db.exec("CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT NOT NULL, created_at TEXT NOT NULL)");
  db.prepare('INSERT INTO records (' + serverCols.join(',') + ') VALUES (' + serverCols.map(() => '?').join(',') + ')')
    .run(...recordToRow({ id: 'r2', userId: 'u2', name: '乙', gender: 'female', birthYear: 1984, birthMonth: 2,
      yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午', toneUsed: 70 }));
  const row = db.prepare('SELECT ' + serverCols.join(',') + ' FROM records WHERE id=?').get('r2');
  const back = rowToRecord(row);
  assert.equal(back.toneUsed, 70, '语气档存了却读不回来：换设备后滑杆会谎报默认档');
  assert.equal(back.userId, 'u2');
  assert.equal(back.hourPillar, '壬午');
});

/* ---------- 浏览器镜像：RECORD_COLS / recordToCells / CREATE TABLE 三者同序 ---------- */

const clientCols = JSON.parse('[' + literal(OFFLINE_REL, offlineSrc, /export const RECORD_COLS = \[([\s\S]*?)\] as const/, 1)
  .replace(/\s+/g, '').replace(/'/g, '"') + ']');
const { recordToCells, recordFromRow } = await import('../../client/src/data/offlineSql.ts');

test('浏览器镜像写库的列名顺序与参数数组顺序逐位对齐', () => {
  const cells = recordToCells({
    id: 'c1', name: '丙', gender: 'male', birthYear: 1990, birthMonth: 5,
    createdAt: '2025-01-01T00:00:00.000Z',
    yearPillar: '庚午', monthPillar: '辛巳', dayPillar: '乙酉', hourPillar: '癸未',
    nonAiResult: { a: 1 }, aiStatus: 'completed', aiAnalysis: { b: 2 }, aiOverview: { c: 3 },
    aiError: 'e', aiTasks: { d: 4 }, toneUsed: 55,
  });
  assert.equal(cells.length, clientCols.length, `列 ${clientCols.length} 个、参数 ${cells.length} 个`);
  const expected = [
    ['id', 'c1'], ['name', '丙'], ['gender', 'male'], ['birth_year', 1990], ['birth_month', 5],
    ['created_at', '2025-01-01T00:00:00.000Z'],
    ['year_pillar', '庚午'], ['month_pillar', '辛巳'], ['day_pillar', '乙酉'], ['hour_pillar', '癸未'],
    ['non_ai_result', '{"a":1}'], ['ai_status', 'completed'],
    ['ai_analysis', '{"b":2}'], ['ai_overview', '{"c":3}'], ['ai_error', 'e'],
    ['ai_tasks', '{"d":4}'], ['tone_used', 55],
  ];
  for (const [col, value] of expected) {
    const i = clientCols.indexOf(col);
    assert.ok(i >= 0, `RECORD_COLS 里没有 ${col}`);
    assert.deepEqual([col, cells[i]], [col, value]);
  }
});

test('浏览器镜像的建表语句可执行，列集与 RECORD_COLS 完全一致', () => {
  const create = literal(OFFLINE_REL, offlineSrc, /db\.run\(`CREATE TABLE IF NOT EXISTS bazi_records \(([\s\S]*?)\);`\)/, 1);
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE bazi_records (${create});`);
  const have = db.prepare("SELECT name FROM pragma_table_info('bazi_records')").all().map((r) => r.name);
  assert.deepEqual(have.sort(), [...clientCols].sort(), '建表语句与 RECORD_COLS 的列集不一致：某一处漏列，插入整行会直接报错');
  db.prepare('INSERT OR REPLACE INTO bazi_records (' + clientCols.join(',') + ') VALUES (' + clientCols.map(() => '?').join(',') + ')')
    .run(...recordToCells({ id: 'c2', name: '丁', gender: 'female', birthYear: 2000, birthMonth: 2,
      createdAt: '2025-01-01T00:00:00.000Z', yearPillar: '甲子', monthPillar: '乙丑', dayPillar: '丙寅',
      hourPillar: '丁卯', aiStatus: 'completed', toneUsed: 20 }));
  const row = db.prepare('SELECT ' + clientCols.join(',') + ' FROM bazi_records').get();
  const cols = Object.keys(row);
  const back = recordFromRow(Object.fromEntries(cols.map((c) => [c, row[c]])));
  assert.equal(back.toneUsed, 20, '镜像读不回语气档：本机重启后滑杆回到默认');
  assert.equal(back.dayPillar, '丙寅');
});

/* ---------- 跨端口径：三端共用的那一列必须都在 ---------- */

test('tone_used 在三端的列清单里都存在(它是独立一列，不是搭在某段 JSON 的顺风车里)', () => {
  assert.ok(serverCols.includes('tone_used'), '服务器少了这一列');
  assert.ok(clientCols.includes('tone_used'), '浏览器镜像少了这一列');
  const rustSelect = literal('client/src-tauri/src/lib.rs',
    text('../../client/src-tauri/src/lib.rs'),
    /prepare\("SELECT (id,name,[^"]*tone_used) FROM bazi_records ORDER BY rowid DESC"\)/, 1);
  assert.deepEqual(rustSelect.split(','), clientCols, '桌面端 SELECT 的列顺序与浏览器 RECORD_COLS 不一致：row_to_record 按下标取值，错一位就把柱当日期读');
});

/* ---------- 桌面端(Rust + rusqlite)：建表语句、读写列序、以及「老库补列」那段迁移 ----------
   桌面端跑的是另一套 SQL 引擎，这里只能把它源码里的字面量原样搬进 node:sqlite 执行 ——
   能执行、列集对得上，才谈得上 Rust 那边也成立。 */

const RUST_REL = '../../client/src-tauri/src/lib.rs';
const rustSrc = text(RUST_REL);
/** Rust 的整行字符串字面量里那条 CREATE TABLE(单行；正文里没有引号，所以到第一个 " 就收尾)。 */
const rustCreate = literal(RUST_REL, rustSrc,
  /CREATE TABLE IF NOT EXISTS bazi_records \(([^"]*?)\)/, 1);
/** SQLite 列定义：`名字 [类型] [约束]` —— 取第一个词就是列名。 */
const columnNames = (createBody) => createBody.split(',').map((piece) => piece.trim().split(/\s+/)[0]).filter(Boolean);
const rustSelectCols = literal(RUST_REL, rustSrc,
  /prepare\("SELECT (id,name,[^"]*?) FROM bazi_records ORDER BY rowid DESC"\)/, 1).split(',');
const rustInsertCols = literal(RUST_REL, rustSrc,
  /INSERT OR REPLACE INTO bazi_records \((id,name,[^"]*?)\) VALUES \(\?1/, 1).split(',');

test('桌面端建表语句可执行，且写/读两条 SQL 的列清单逐位一致', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE bazi_records (${rustCreate});`);
  // 桌面端靠 initialize() 里的 ALTER 补列，所以建表语句本身缺哪列都要在这里点名出来。
  const built = db.prepare("SELECT name FROM pragma_table_info('bazi_records')").all().map((r) => r.name);
  assert.deepEqual(rustSelectCols, rustInsertCols, '桌面端 SELECT 与 INSERT 的列清单不一致：读回来的下标和写进去的下标对不上');
  db.prepare('INSERT INTO bazi_records (' + rustInsertCols.join(',') + ') VALUES (' + rustInsertCols.map(() => '?').join(',') + ')')
    .run(...recordToCells({ id: 'd1', name: '戊', gender: 'male', birthYear: 1988, birthMonth: 9,
      createdAt: '2025-01-01T00:00:00.000Z', yearPillar: '戊辰', monthPillar: '壬戌', dayPillar: '甲子',
      hourPillar: '乙丑', aiStatus: 'completed', toneUsed: 44 }));
  const back = recordFromRow(Object.fromEntries(rustSelectCols.map((c) => [c, db.prepare(`SELECT ${c} AS v FROM bazi_records`).get().v])));
  assert.equal(back.dayPillar, '甲子');
  assert.equal(back.toneUsed, 44, '桌面端把语气档读回来了');
  return { built };
});

test('桌面端 initialize() 给老库补的列，必须覆盖它自己 SELECT/INSERT 用到的全部列', () => {
  /* 实测缺陷(本轮修掉)：lib.rs 的 CREATE TABLE 原本没有 tone_used，全靠 has_tone_used 那次
     ALTER 补上；而三条整行读取 SQL(list/get/delete_bazi_record)都是按下标取值(row.get(16))。
     一旦那次 ALTER 没跑到 —— 引擎不支持 pragma_table_info 时 prepare 返回 Err，initialize
     整个失败 —— 每一次读取都报「index out of range」，桌面端连列表都打不开。
     现在建表语句自带这一列，两条判据同时钉住：
       ① 新库(只跑 CREATE)就能按整套列读写，不需要任何迁移；
       ② 老库升级路径仍在：CREATE 缺的每一列都必须有对应 ALTER，别把迁移代码删干净。 */
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE bazi_records (${rustCreate});`);
  const built = new Set(db.prepare("SELECT name FROM pragma_table_info('bazi_records')").all().map((r) => r.name));
  assert.deepEqual(rustSelectCols.filter((c) => !built.has(c)), [], '新建的桌面端库就缺列：不跑迁移就打不开，pragma 不可用时整个 initialize 失败');
  db.prepare('INSERT INTO bazi_records (' + rustInsertCols.join(',') + ') VALUES (' + rustInsertCols.map(() => '?').join(',') + ')')
    .run(...[...Array(rustInsertCols.length)].map((_, i) => (i === 16 ? 44 : i === 0 ? 'd2' : i === 5 ? '2025-01-01T00:00:00.000Z' : 'x')));
  assert.equal(db.prepare('SELECT tone_used AS v FROM bazi_records WHERE id=?').get('d2').v, 44);

  // 反向钉子：老库(没有 tone_used)必须真能被那段迁移补上 —— 否则上面这条只是「基线恰好带列」。
  const legacy = new DatabaseSync(':memory:');
  /* 造一个「迁移之前」的老库：按 Rust 建表语句的列名逐列重建，但把 tone_used 摘掉。
     NOT NULL 必须逐列照搬 —— 少了 id/name 的约束，插入那步会报「NOT NULL constraint failed」，
     看起来像产品缺陷其实是夹具没还原真实表结构。 */
  const defs = Object.fromEntries(rustCreate.split(',').map((piece) => {
    const t = piece.trim();
    return [t.split(/\s+/)[0], t];
  }));
  legacy.exec('CREATE TABLE bazi_records (' + rustSelectCols.filter((c) => c !== 'tone_used').map((c) => defs[c]).join(', ') + ');');
  const before = new Set(legacy.prepare("SELECT name FROM pragma_table_info('bazi_records')").all().map((r) => r.name));
  assert.ok(!before.has('tone_used'), '反向钉子失效：剥掉 tone_used 之后仍读得到这一列');
  const migrated = new Set([...rustSrc.matchAll(/ALTER TABLE bazi_records ADD COLUMN (\w+)/g)].map((m) => m[1]));
  assert.ok(migrated.has('tone_used'), '桌面端没有为 tone_used 保留 ALTER 迁移：装在老库上的用户升级不了');
  for (const col of [...rustSelectCols].filter((c) => !before.has(c))) {
    assert.ok(migrated.has(col), `老库缺 ${col}，却没有对应的 ALTER`);
    legacy.exec(`ALTER TABLE bazi_records ADD COLUMN ${col} INTEGER`);
  }
  const after = new Set(legacy.prepare("SELECT name FROM pragma_table_info('bazi_records')").all().map((r) => r.name));
  assert.deepEqual(rustSelectCols.filter((c) => !after.has(c)), [], '补完迁移后仍读不全：按下标取值会整条失败');
});

test('导出备份的建表语句与浏览器镜像、桌面端读到的是同一张表(列集一致)', () => {
  const exportSrc = text('../../client/src/data/sqliteExport.ts');
  const binaryCreate = literal('client/src/data/sqliteExport.ts', exportSrc,
    /db\.run\(`CREATE TABLE bazi_records \(([\s\S]*?)\);`\)/, 1);
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE bazi_records (${binaryCreate});`);
  const have = db.prepare("SELECT name FROM pragma_table_info('bazi_records')").all().map((r) => r.name);
  assert.deepEqual(have.sort(), [...clientCols].sort(), '导出文件的列集与 RECORD_COLS 不一致：导出去再导回来会整行报错');
  // .sql 文本 dump 用的是第三条手写建表语句(逐行字符串相加)，它也必须给 recordToCells 留齐位置。
  const dumpHead = exportSrc.indexOf("lines.push('CREATE TABLE IF NOT EXISTS bazi_records ('");
  if (dumpHead < 0) throw new Error('sqliteExport.ts 里找不到 .sql dump 的建表语句 —— 判据本身失效');
  // 逐行字符串相加：第一片是那句提示语本身(已跳过)，最后一片收尾带 '); —— 剥掉它才是一段列定义。
  const chunk = exportSrc.slice(dumpHead, exportSrc.indexOf('\n  for (const r of records)', dumpHead));
  const parts = [...chunk.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]).slice(1);
  if (!parts.length) throw new Error('.sql dump 的建表语句没被抽出来 —— 判据本身失效');
  const last = parts.at(-1).replace(/\);$/, '');
  if (last === parts.at(-1)) throw new Error('最后一片不像以 ); 收尾，抽取逻辑需要重写：' + parts.at(-1));
  const textCreate = [...parts.slice(0, -1), last].join('');
  const db2 = new DatabaseSync(':memory:');
  db2.exec(`CREATE TABLE bazi_records (${textCreate});`);
  const have2 = db2.prepare("SELECT name FROM pragma_table_info('bazi_records')").all().map((r) => r.name);
  assert.deepEqual(have2.sort(), [...clientCols].sort(), '.sql 文本 dump 的列集与 RECORD_COLS 不一致');
});
