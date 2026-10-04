/* 变异电池：北京时间口径判据(beijing-date-caliber.test.ts)能不能杀掉「退回本地时区」这一类缺陷
 *
 * 用法：node scripts/mutation-beijing-caliber.cjs   (从仓库根跑)
 * 每条变异单锚点、命中数必须恰好 1；落地后回读自证(新串在场且旧锚点消失)；
 * 跑完从内存快照还原，末尾打印 git diff --numstat 作净零核对。
 *
 * 两条既有教训都在这儿生效：
 * ① 行尾按文件实测(date.ts 是 CRLF、PersonDetail.tsx 是 LF)，硬写 \r\n 会让 LF 文件的
 *    锚点 0 命中 ABORT —— 那等于没测。
 * ② 变异体需要的单引号一律用 String.fromCharCode(39) 拼装后再替换。上一版把占位符直接写在
 *    单引号字符串里，脚本连 SyntaxError 都没过 —— 「电池压根没跑」比「变异存活」更危险，
 *    因为它看起来像跑过了。本脚本开头就自检每个锚点/替换式的可解析性。
 */
const { execFileSync, spawnSync } = require('node:child_process');
const { readFileSync, writeFileSync } = require('node:fs');
const { resolve } = require('node:path');

const ROOT = 'C:/Users/yty06/Documents/ai/bbazi/ai 8zi/ai 8zi/ai 8zi';
const FILES = {
  date: 'client/src/utils/date.ts',
  detail: 'client/src/features/person/PersonDetail.tsx',
};
const TEST = 'src/__tests__/beijing-date-caliber.test.ts';
const Q = String.fromCharCode(39); // 单引号，靠码位拼出来，别在字面量里嵌转义

const originals = {};
const eols = {};
for (const f of Object.values(FILES)) {
  const text = readFileSync(resolve(ROOT, f), 'utf8');
  originals[f] = text;
  eols[f] = text.includes('\r\n') ? '\r\n' : '\n';
}

/** 占位符 → 真实片段(含引号)。锚点与替换式共用同一张表，保证两端拼法一致。 */
const TOK = new Map([
  ['@P0@', `${Q}0${Q}`],                        // '0' —— padStart 的填充实参
  ['@SQstr@', `${Q}string${Q}`],
  ['@SQ70@', `${Q}1970-01-01${Q}`],
  ['@SLASH@', `${Q}../../utils/date${Q}`],
]);
const expand = (s) => s.replace(/@[A-Z0-9_]+@/g, (m) => {
  if (!TOK.has(m)) throw new Error('未知占位符 ' + m);
  return TOK.get(m);
});

const mutants = [
  { name: 'B1 起运文案退回设备本地日期(原缺陷形态)', file: 'detail',
    from: 'const todayYmd = chinaYmd(new Date());',
    to: 'const todayYmd = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, @P0@)}-${String(new Date().getDate()).padStart(2, @P0@)}`;' },
  { name: 'B2 大运表 today0 退回本地读法', file: 'detail',
    from: 'const today0 = chinaDateParts(new Date());',
    to: 'const today0 = { year: new Date().getFullYear(), month: new Date().getMonth() + 1, day: new Date().getDate() };' },
  /* date.ts 里「const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);」有两处
     (chinaYearMonth / chinaDateParts)，锚点必须带上各自的后一行才唯一。 */
  { name: 'B3 chinaDateParts 少加 8 小时(等于没换算)', file: 'date',
    from: 'const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);\n  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day:',
    to: 'const shifted = new Date(date.getTime());\n  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day:' },
  /* 这一条同时把月、日两处补零改掉：replace 只换首个命中，所以锚点一次覆盖两个 padStart。 */
  { name: 'B4 chinaYmd 月日不补零(ISO 比较会错位)', file: 'date',
    from: 'String(month).padStart(2, @P0@)}-${String(day).padStart(2, @P0@)',
    to: 'String(month)}-${String(day)' },
  { name: 'B5 chinaYmd 绕过共享模块、自己按 UTC 直读', file: 'date',
    from: 'export function chinaYmd(value: string | Date): string {\n  const { year, month, day } = chinaDateParts(value);',
    to: 'export function chinaYmd(value: string | Date): string {\n  const d = typeof value === @SQstr@ ? new Date(value) : value;\n  const { year, month, day } = { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };' },
  { name: 'B6 大运表年份参数退回本地 getFullYear', file: 'detail',
    from: 'findCurrentFortune(result, today0.year, todayYmd0)',
    to: 'findCurrentFortune(result, new Date().getFullYear(), todayYmd0)' },
  { name: 'B7 详情页不再导入北京口径(改成同名本地桩)', file: 'detail',
    /* 导入行现在带 chinaYear(起运那一栏的年份走它)，锚点得跟产品当前那行逐字一致，
       否则 preflight 报 ANCHOR BAD —— 这比「变异悄悄没落地」好。 */
    from: 'import { chinaDateParts, chinaYmd, chinaYear } from @SLASH@;',
    to: 'const chinaYmd = () => @SQ70@;\nconst chinaDateParts = () => ({ year: 1970, month: 1, day: 1 });\nconst chinaYear = () => 1970;' },
  /* B8：上一版判据只钉「抽出来的变量」，这一类「调用方给错年份」的缺陷整轮全绿存活过。
     现在判据直接求值调用点实参，所以这条必须红。 */
  { name: 'B8 起运那一栏传给文案的年份退回本地 getFullYear', file: 'detail',
    from: 'luckStartText(result, chinaYear(new Date()))',
    to: 'luckStartText(result, new Date().getFullYear())' },
];

/** 应用一条变异：单锚点、命中数须恰好 1，落地后回读自证(新串在场且旧锚点消失)。 */
function apply(m) {
  const file = FILES[m.file];
  const anchor = expand(m.from).replace(/\n/g, eols[file]);
  const repl = expand(m.to).replace(/\n/g, eols[file]);
  if (repl.includes('@PAD') || /@[A-Z]{2,}[0-9]?@/.test(repl)) throw new Error('替换式含未展开占位符: ' + repl.slice(0, 40));
  const src = originals[file];
  const hits = src.split(anchor).length - 1;
  if (hits !== 1) throw new Error(`ANCHOR BAD x${hits} in ${file}: ${anchor.slice(0, 60)}`);
  writeFileSync(resolve(ROOT, file), src.replace(anchor, () => repl));
  const back = readFileSync(resolve(ROOT, file), 'utf8');
  if (!back.includes(repl)) throw new Error('变异没落地: ' + anchor.slice(0, 50));
  if (back.split(anchor).length - 1 !== 0) throw new Error('旧锚点仍在(替换没生效): ' + anchor.slice(0, 40));
  return repl;
}
const restore = () => { for (const [f, text] of Object.entries(originals)) writeFileSync(resolve(ROOT, f), text); };

function runTest() {
  /* npx 在 Windows 上是 .cmd，execFileSync 不带 shell 会 ENOENT —— 上一版把它当成
     「判据本身没通过」(BASELINE RED)，差点把环境问题读成测试问题。走 shell:true，
     并且区分「跑失败」与「跑出红」：连 json 都没产出就报 BAD-RUN，不算杀掉。 */
  const outName = 'bj-mut.json';
  const r = spawnSync('npx vitest run ' + TEST + ' --reporter=json --outputFile=' + outName,
    { cwd: resolve(ROOT, 'client'), shell: true, encoding: 'utf8' });
  if (r.error) return { bad: true, why: 'SPAWN ' + r.error.message.slice(0, 60) };
  let j;
  try { j = JSON.parse(readFileSync(resolve(ROOT, 'client', outName), 'utf8')); }
  catch { return { bad: true, why: 'NO-JSON rc=' + r.status + ' ' + String(r.stdout || '').split('\n').slice(-3).join(' | ') }; }
  const failed = [];
  for (const t of j.testResults || []) {
    for (const a of t.assertionResults || []) if (a.status === 'failed') failed.push((a.title || '').slice(0, 40));
    if ((!t.assertionResults || !t.assertionResults.length) && t.message) failed.push('MODULE-ERROR ' + String(t.message).split('\n')[0].slice(0, 60));
  }
  return { killed: failed.length > 0, why: failed.join(' ; ') || 'all green' };
}

/* 自检一：所有锚点必须在当前源码里唯一命中(先全量预演，避免跑到第 5 条才发现拼错)。
   这一步不只是「防呆」——上一版本就是因为把占位符写进单引号字面量而在 SyntaxError 上
   压根没跑，却差点被当成「判据没问题」。电池必须能跑，才谈得上存活/杀掉。 */
const preflight = [];
for (const m of mutants) {
  try { apply(m); } catch (e) { preflight.push(m.name + ' → ' + e.message.slice(0, 90)); }
  restore();
}
if (preflight.length) { console.log('PREFLIGHT BAD:\n' + preflight.join('\n')); process.exit(2); }
console.log(`preflight: ${mutants.length}/${mutants.length} 锚点唯一命中且替换可落地\n`);

/* 净零判据从「写死的文案」改成程序当场算：进电池前先用 git 抓一次真实行数，
   跑完再比。手抄的基线数字会过期(曾写着 4/3、实际 8/5)，那种过期不但帮不上忙，
   还会让我把「对不上」误读成残留。 */
const baselineNet = execFileSync('git', ['-C', ROOT, 'diff', '--numstat', '--', ...Object.values(FILES)], { encoding: 'utf8' }).trim();
console.log(`进入电池前的基线 git diff --numstat:\n${baselineNet || '(empty)'}\n`);

/* 基线自证：未变异时必须全绿，否则后面的 KILLED 只是「本来就红」。跑不起来(rc/无 json)
   与跑出红是两回事，分开报，别把环境问题读成判据问题。 */
{
  const base = runTest();
  if (base.bad) { console.log('BASELINE BAD-RUN(测试没跑成，不算红): ' + base.why); process.exit(4); }
  if (base.killed) { console.log('BASELINE RED(判据本身就没通过，先修它): ' + base.why); process.exit(3); }
  console.log('baseline: all green\n');
}

let killed = 0;
const rows = [];
for (const m of mutants) {
  let r;
  try { apply(m); r = runTest(); }
  catch (e) { r = { bad: true, why: 'APPLY FAILED ' + e.message.slice(0, 80) }; }
  restore();
  if (r.bad) { console.log('BAD-RUN ' + m.name + ' → ' + r.why); process.exit(4); }
  if (r.killed) killed++;
  rows.push((r.killed ? 'KILLED   ' : 'SURVIVED ') + m.name + '  ← ' + r.why);
}
console.log(rows.join('\n'));
console.log(`--- ${killed}/${mutants.length} KILLED`);
const net = execFileSync('git', ['-C', ROOT, 'diff', '--numstat', '--', ...Object.values(FILES)], { encoding: 'utf8' }).trim();
console.log('净零核对 git diff --numstat(还原后):\n' + (net || '(empty)'));
if (net !== baselineNet) { console.log('!!! RESIDUAL: 还原后的行数与进入电池前不一致，判据结果不可信'); process.exit(5); }
console.log('净零: 与进入电池前逐字一致');
process.exit(killed === mutants.length ? 0 : 1);
