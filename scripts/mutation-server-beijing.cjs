/* =============================================================================
 * 服务端北京口径变异电池：把 chat.mjs 里「本月/今年」的北京取值逐条退回宿主本地字段，
 * 看判据(chat-timezone.test.mjs)是否真的变红。
 *
 * 为什么单独做一个脚本(而不是塞进 scripts/mutation-beijing-caliber.cjs)：
 * 那套电池跑的是 client 的 vitest，本文件跑的是 server 的 node:test —— 运行器、
 * 判据套件、退出码形态都不同，混在一起会让「哪一组红了」重新变成要靠回忆的事。
 *
 * 用法(在仓库根或任意目录都行，路径都是绝对推导)：
 *   node scripts/mutation-server-beijing.cjs              # 默认含跨时区子进程用例
 *   MINGLI_TZ_SUBPROCESS=0 node scripts/mutation-server-beijing.cjs
 *
 * 三条硬规矩(都是以前踩过才写进来的)：
 *  1) 锚点必须唯一命中，且替换落地后回读确认 —— 否则「存活」其实是变异没进代码；
 *  2) 基线必须先自证全绿，且区分「跑失败(BAD-RUN)」与「跑出红(RED)」；
 *  3) 还原净零用 git diff --numstat 前后逐字比对，不靠手抄数字、也不靠自我快照。
 * ============================================================================= */
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'server', 'chat.mjs');
const GATE = process.env.MINGLI_TZ_SUBPROCESS !== '0' ? '1' : '0';

/* chat.mjs 是 CRLF：锚点按 LF 书写，落地前换成文件实际行尾，避免「找不到」被误读成「拼错」。 */
const TEXT = fs.readFileSync(SRC, 'utf8');
const EOL = TEXT.includes('\r\n') ? '\r\n' : '\n';
const orig = TEXT;

const Q = "'";
const TOK = [
  ['@Q@', Q],
  ['@DQ@', '"'],
];
const expand = (s) => TOK.reduce((acc, [k, v]) => acc.split(k).join(v), s);

/* S1/S2 打在 monthFromText / extractWhen 的两个锚点上；S3 打在取证层的 ?? 兜底上；
   S4 整体把 chinaParts 换成宿主本地实现(等价于「导入口径没换过来」)。 */
const mutants = [
  { name: 'S1 「本月」退回设备本地月', from: 'const cm = chinaParts(now).month;', to: 'const cm = now.getMonth() + 1;' },
  { name: 'S2 「今年」锚年退回本地 getFullYear', from: 'const nowYear = chinaParts(now).year;', to: 'const nowYear = now.getFullYear();' },
  { name: 'S3 取证扫年兜底退回本地年', from: `Number(plan.scanFrom ?? chinaParts(new Date()).year)`, to: `Number(plan.scanFrom ?? new Date().getFullYear())` },
  { name: 'S4 chinaParts 整体退化为宿主本地读数', from: `  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1 };`, to: `  return { year: d.getFullYear(), month: d.getMonth() + 1 };` },
];
mutants.forEach((m) => { m.from = expand(m.from); m.to = expand(m.to); });

function apply(m) {
  const from = m.from.split('\n').join(EOL);
  const to = m.to.split('\n').join(EOL);
  const hits = orig.split(from).length - 1;
  if (hits !== 1) throw new Error(`锚点命中 ${hits} 次(需 1): ${m.name}`);
  fs.writeFileSync(SRC, orig.replace(from, to), { encoding: 'utf8' });
  /* 落地回读：确认磁盘上确实是变异体，防止写入被编辑器/钩子改回去。 */
  const back = fs.readFileSync(SRC, 'utf8');
  if (!back.includes(to)) throw new Error('落地回读失败(变异没进文件): ' + m.name);
}
function restore() { fs.writeFileSync(SRC, orig, { encoding: 'utf8' }); }

/* 判据套件：node:test 只认它自己报的行，汇总里没有 ANSI，所以直接文本匹配即可
   (client 那边 vitest 的汇总带颜色码，才需要先剥 —— 这里别照搬)。 */
function runTest() {
  const r = spawnSync(process.execPath, ['--test', 'test/chat-timezone.test.mjs'],
    { cwd: path.join(ROOT, 'server'), encoding: 'utf8', env: { ...process.env, MINGLI_TZ_SUBPROCESS: GATE } });
  const out = String(r.stdout || '') + String(r.stderr || '');
  const failLine = /\nℹ fail (\d+)/.exec(out);
  if (!failLine) return { bad: true, why: 'NO-SUMMARY rc=' + r.status + ' ' + out.split('\n').slice(-4).join(' | ').slice(0, 160) };
  const failed = Number(failLine[1]);
  const names = [...out.matchAll(/^✖ (.+?) \(/gm)].map((x) => x[1].slice(0, 46));
  return { killed: failed > 0, why: failed + ' failed: ' + (names.join(' ; ') || out.split('\n').find((l) => l.startsWith('  AssertionError')) || '').slice(0, 90) };
}

const preflight = [];
for (const m of mutants) { try { apply(m); } catch (e) { preflight.push(m.name + ' → ' + e.message.slice(0, 90)); } restore(); }
if (preflight.length) { console.log('PREFLIGHT BAD:\n' + preflight.join('\n')); process.exit(2); }
console.log(`preflight: ${mutants.length}/${mutants.length} 锚点唯一命中且替换可落地`);
console.log(`跨时区子进程用例: MINGLI_TZ_SUBPROCESS=${GATE}\n`);

const baselineNet = execFileSync('git', ['-C', ROOT, 'diff', '--numstat', '--', 'server/chat.mjs'], { encoding: 'utf8' }).trim();
console.log(`进入电池前的基线 git diff --numstat:\n${baselineNet || '(empty)'}\n`);

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
  catch (e) { r = { bad: true, why: 'APPLY FAILED ' + e.message.slice(0, 90) }; }
  restore();
  if (r.bad) { console.log('BAD-RUN ' + m.name + ' → ' + r.why); process.exit(4); }
  if (r.killed) killed++;
  rows.push((r.killed ? 'KILLED   ' : 'SURVIVED ') + m.name + '  ← ' + r.why);
}
console.log(rows.join('\n'));
console.log(`--- ${killed}/${mutants.length} KILLED`);
const net = execFileSync('git', ['-C', ROOT, 'diff', '--numstat', '--', 'server/chat.mjs'], { encoding: 'utf8' }).trim();
console.log('净零核对 git diff --numstat(还原后):\n' + (net || '(empty)'));
if (net !== baselineNet) { console.log('!!! RESIDUAL: 还原后的行数与进入电池前不一致，判据结果不可信'); process.exit(5); }
console.log('净零: 与进入电池前逐字一致');
process.exit(killed === mutants.length ? 0 : 1);
