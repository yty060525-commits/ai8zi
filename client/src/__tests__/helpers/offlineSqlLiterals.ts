/* 从产品源码里逐字取出 SQL 字符串的公共夹具，供 offline-sql-mirror / offline-sql-harness 共用。
 * 之所以「取源码文本」而不是 import 产品常量：镜像那条建表/迁移语句只在真浏览器路径里执行
 * (ensureSql 在 MODE==='test' 直接返回 null)，判据必须绕开那扇门，又不能再手抄一份 SQL ——
 * 手抄的那份改了不会跟着红。锚点找不到一律抛错：宁可测试当场炸，也不要静默拿到空串再假绿。 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

/** rel 相对 helpers/ 目录；统一换行，避免 CRLF/LF 让锚点忽命中忽不命中。 */
export const src = (rel: string): string =>
  readFileSync(resolve(here, rel), 'utf8').replace(/\r\n/g, '\n');

/** 取锚点后的字面量。约定：锚点**必须**以开引号结尾(实测最稳的写法)，读取从它下一位开始。
 *  早先按「整段文本里最靠前的引号」猜，会撞上 SQL 内部的撇号或右引号，读到半截甚至
 *  报「没有收尾」(实测三轮才收敛) —— 所以位置交给调用方，它本来就知道自己在取哪一句。
 *  SQL 本身含引号时(如 pragma_table_info('t'))这句没法安全截断：外层闭合引号在 SQL
 *  之后，而扫描器一碰到内层引号就停。这类语句走 statementIn(整条认领)。 */
export const literal = (source: string, anchor: string): string => {
  const at = source.indexOf(anchor);
  if (at < 0) throw new Error('锚点没找到，SQL 被挪走或改名了：' + anchor);
  const quote = anchor[anchor.length - 1];
  if (!isQuote(quote)) throw new Error('锚点必须以开引号结尾：' + anchor);
  const tail = source.slice(at + anchor.length);
  let end = 0;
  while (end < tail.length) {
    // 同 stringLiteralsIn：只有转义符等于本串引号时才跳过下一字符，否则反斜杠是正文
    if (quote !== '`' && tail[end] === '\\' && tail[end + 1] === quote) { end += 2; continue; }
    if (tail[end] === quote) break;
    end += 1;
  }
  if (end >= tail.length) throw new Error('字面量没有收尾：' + anchor);
  return unescape(tail.slice(0, end), quote);
};

const isQuote = (ch: string | undefined): boolean => ch === '`' || ch === "'" || ch === '"';

/** 还原运行时字符串的值。反斜杠转义只在「转义符就是这种引号」时才生效 ——
 *  JS 里 'a\'b' 是 a'b，但 `a\'b` 的引号不是转义符，值仍是 a\'b。
 *  早先无条件剥掉 \' ，等于把产品 SQL 悄悄改短了一截(实测取出的 pragma 少右括号)。 */
const unescape = (raw: string, quote: string): string => {
  const out = quote === '`' ? raw : raw.replace(/\\'/g, "'").replace(/\\"/g, '"');
  return out.replace(/\\n/g, '\n');
};

/** 逐条扫源码里的字符串字面量，返回「运行时的值 -> 出现次数」。
 *  扫描必须**保留反斜杠原文**再按引号种类还原：JS 里 "\\'" 是一个撇号、"'\\''" 也是，
 *  而 "`\\'`" 是「反斜杠+撇号」(撇号不是模板串里的转义符)。早先无条件跳两字符并剥掉
 *  转义符，把 "pragma_table_info(\\'t\\')" 读成了少两个右括号 —— 夹具自己解析错了 SQL。 */
export const stringLiteralsIn = (source: string): Map<string, number> => {
  const found = new Map<string, number>();
  let cursor = 0;
  while (cursor < source.length) {
    const hit = nextLiteral(source, cursor);
    if (!hit) break;
    found.set(hit.value, (found.get(hit.value) ?? 0) + 1);
    cursor = hit.end + 1;
  }
  return found;
};

/** JS 源码里「若干段 '…' 用 + 拼起来」的表达式，还原成运行时的真实字符串。
 *  文本 dump 的建表语句就是这么写的，只取第一段会得到半截 SQL(实测报 near ")")。
 *  做法：从锚点起扫到这条语句结束的 '); 处(分号在引号内，紧跟收尾括号)，沿途把每一段
 *  **完整**字面量交给 stringLiteralsIn 取出再拼接。出现 ${ 一律抛错。 */
export const concatLiteral = (source: string, anchor: string): string => {
  const at = source.indexOf(anchor);
  if (at < 0) throw new Error('锚点没找到：' + anchor);
  if (anchor[anchor.length - 1] !== "'") throw new Error('拼接锚点要以开单引号结尾：' + anchor);
  // 语句收尾认「);'」—— SQL 的分号写在最后一个引号里面，紧跟收尾括号和分号
  const stop = source.indexOf(");'", at);
  if (stop < 0) throw new Error('找不到这条语句的收尾：' + anchor);
  const region = source.slice(at, stop + 3);
  if (region.includes('${')) throw new Error('拼接段里出现模板插值，还原方式要重对齐：' + anchor);
  const parts: string[] = [];
  let cursor = 0;
  while (cursor < region.length) {
    const found = nextLiteral(region, cursor);
    if (!found) break;
    parts.push(found.value);
    cursor = found.end + 1;   // 跳过闭合引号：它同时是下一段的开引号，原地不动会死循环
  }
  if (!parts.length) throw new Error('拼接段里一个字符串都没有：' + anchor);
  return parts.join('');
};

/** 从 from 起第一个**完整**字符串字面量。扫描必须按引号种类配对：
 *  直接写 /'([^']*)'/g 会把「段落之间的空白 + 加号」当成内容(起始引号其实是上一段的
 *  闭合引号)，实测把整条建表语句还原成了 '\n + \n + '。 */
const nextLiteral = (source: string, from: number): { value: string; end: number } | null => {
  for (let i = from; i < source.length; i += 1) {
    const q = source[i];
    if (!isQuote(q)) continue;
    let j = i + 1;
    let raw = '';
    while (j < source.length) {
      if (q !== '`' && source[j] === '\\' && source[j + 1] === q) { raw += source[j] + q; j += 2; continue; }
      if (source[j] === q) return { value: unescape(raw, q), end: j };
      if (q !== '`' && source[j] === '\n') break;
      raw += source[j];
      j += 1;
    }
  }
  return null;
};

/** CREATE TABLE (…) 括号里的列名。 */
export const colsOf = (create: string): string[] =>
  splitTopLevel(createBody(create)).map((piece) => piece.trim().split(/\s+/)[0])
    .filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name));

/** 语句级判据的通用取法：在产品源码里按前缀认领**唯一**一条字符串字面量。
 *  命中 0 条或 >1 条一律抛错 —— 锚点漂移、语句被复制、写法变了都要当场炸，
 *  不能拿着 undefined 去执行然后假绿。 */
export const statementIn = (source: string, prefix: string): string => {
  const hits = [...stringLiteralsIn(source).keys()].filter((s) => s.startsWith(prefix));
  if (hits.length !== 1) throw new Error(`以「${prefix}」开头的语句应当恰好一条，实际 ${hits.length} 条：${JSON.stringify(hits)}`);
  return hits[0];
};

/** 按顶层逗号切分：PRIMARY KEY (…) / CHECK (…) 内部的逗号不能当分隔符
 *  (早先直接 split(',') 把「PRIMARY KEY (id」切成一列，实测取到 18 个名字)。 */
const splitTopLevel = (body: string): string[] => {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of body) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.filter((piece) => !/^\s*(PRIMARY|UNIQUE|CHECK|FOREIGN|CONSTRAINT)\b/i.test(piece));
};

/** 取 CREATE TABLE 的括号正文：必须按**括号配平**找收尾，不能用 lastIndexOf(')')。
 *  文本 dump 那条建表语句是 JS 拼出来的多段 + ' 串，末段只有 ')' 没有分号，
 *  按 ');' 定位会一路吃到文件里下一条语句(实测报 near ")" 语法错)。
 *  内层的 PRIMARY KEY (…) 会先被 depth 计数吃掉，不会提前收尾。 */
export const createBody = (create: string): string => {
  const open = create.indexOf('(');
  if (open < 0) throw new Error('建表语句没有左括号：' + create.slice(0, 60));
  let depth = 0;
  for (let i = open; i < create.length; i += 1) {
    if (create[i] === '(') depth += 1;
    else if (create[i] === ')') {
      depth -= 1;
      if (depth === 0) return create.slice(open + 1, i);
    }
  }
  throw new Error('建表语句括号没配对：' + create.slice(0, 60));
};

/** 与 offlineSql.ts 的 RECORD_COLS 同序同集 —— 由判据逐位比对源码常量来保证。 */
export const RECORD_COLS = ['id', 'name', 'gender', 'birth_year', 'birth_month', 'created_at',
  'year_pillar', 'month_pillar', 'day_pillar', 'hour_pillar', 'non_ai_result', 'ai_status',
  'ai_analysis', 'ai_overview', 'ai_error', 'ai_tasks', 'tone_used'];
export const LEGACY_COLS = RECORD_COLS.filter((c) => c !== 'tone_used');

export const PRAGMA = "SELECT name FROM pragma_table_info('bazi_records')";

/** offlineSql.ts 全文(换行统一)。判据要扫源码时用这一份，别在测试里 require('fs')。 */
export const offlineSource = (): string => src('../../data/offlineSql.ts');

/** 产品源码里 RECORD_COLS 的字面量数组(逐位取出来，不是 import)。 */
export const recordColsFromSource = (): string[] => {
  const offline = offlineSource();
  const at = offline.indexOf('export const RECORD_COLS = [');
  if (at < 0) throw new Error('RECORD_COLS 定义找不到了');
  const body = offline.slice(at, offline.indexOf('] as const', at));
  const names = [...body.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  if (names.length < 5) throw new Error('RECORD_COLS 解析不出列名(写法变了？)：' + body.slice(0, 80));
  return names;
};

/** 还原产品那条整行插入 SQL：先钉住源码模板字面量的形状，再按源码里的列顺序拼出可执行语句。
 *  这样「列顺序被打乱」会让这条红，而不是像只比长度那样照常通过。 */
export const insertSqlFromSource = (): string => {
  const raw = literal(offlineSource(), 'export const INSERT_RECORDS = `');
  const expected = "INSERT OR REPLACE INTO bazi_records (${RECORD_COLS.join(',')}) VALUES (${RECORD_COLS.map(() => '?').join(',')})";
  if (raw !== expected) throw new Error('INSERT_RECORDS 的模板不再是「RECORD_COLS 顺序 + 同数占位符」，判据要重新对齐：\n' + raw);
  const cols = recordColsFromSource();
  return 'INSERT OR REPLACE INTO bazi_records (' + cols.join(',') + ') VALUES (' + cols.map(() => '?').join(',') + ')';
};

/** migrateToneColumn 的语句逐字取出：判据必须执行产品真正执行的那两句，
 *  而不是我照记忆重写一遍(重写的那份改坏了也不会红)。
 *  这里取的是**整条可执行语句**(含 pragma_table_info 的内层括号)，用 stringLiteralsIn 扫出来
 *  再按前缀认领 —— 内层带引号的 SQL 没法用「锚点+开引号」安全截断(实测读出 "bazi_records')")。 */
export const migrationStatements = (): { pragma: string; alter: string } => {
  const offline = offlineSource();
  const at = offline.indexOf('function migrateToneColumn');
  if (at < 0) throw new Error('migrateToneColumn 不在了，判据失效');
  // 函数体收尾：找函数声明后第一个独立成行的右花括号。用 indexOf('\n}') 会停在
  // 注释里更早出现的位置(实测截断到取不到 ALTER 语句)。
  const rel = offline.slice(at).search(/\n\}/);
  if (rel < 0) throw new Error('migrateToneColumn 的函数体收尾不认识：判据失效');
  const body = offline.slice(at, at + rel);
  return {
    pragma: statementIn(body, 'SELECT name FROM pragma_table_info('),
    alter: statementIn(body, 'ALTER TABLE bazi_records'),
  };
};

/** 镜像新建库用的建表语句(逐字取自 offlineSql.ts)。 */
export const mirrorCreate = (): string => statementIn(offlineSource(), 'CREATE TABLE IF NOT EXISTS bazi_records (');

/** 导出功能里那条 .sqlite 建表语句。
 *  .sql 文本 dump 的那条**不走这里**：它在源码里是多段 '…' + '…' 拼出来的，
 *  单条字面量只是半截，必须用 concatLiteral 还原(见 exportCreates)。 */
export const exportCreates = (): Array<[string, string]> => {
  const exportSrc = src('../../data/sqliteExport.ts');
  return [
    ['.sqlite', statementIn(exportSrc, 'CREATE TABLE bazi_records (')],
    ['.sql 文本', concatLiteral(exportSrc, "lines.push('CREATE TABLE IF NOT EXISTS bazi_records ('")],
  ];
};
