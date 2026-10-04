/* =============================================================================
 * 服务端北京口径变异电池(读数级裁决版)
 *
 * ⚠ 2026-10-04 重写。原先只用「进程内 UTC 设备桩 + node --test」量这批变异，实测那把尺
 *    在**读数层面是恒等的空判据**。原因(逐条实测，不是推测)：
 *      chinaParts(d) = new Date(d.getTime() + 8h).getUTC*()
 *    进程内桩 `class UtcHostDate extends Date` 改了本地 getter、保留 getUTC*，于是那个
 *    shifted 对象既是桩的子类实例(本地 getter 返回 UTC 值)、又被 getUTC* 读，两条路给出
 *    同一个数 ⇒ 「+8 小时」这一步在桩下被抵消，加不加都读出北京值。
 *    实测：基线与 S1..S6 在进程内桩下 9 种问法全部 same；给 S6 的变异体加 print 也证实
 *    「分支真跑了、传入时钟本地月确实是 12、结果仍是 [2026,1]」。
 *    ⇒ 之前报的「S1–S4 KILLED」杀的是源码层钉子与取证串文本，读数级判据一直是空白。
 *
 *    能真正分辨的唯一仪器是 **TZ 子进程探针**(server/test/tz-probe.test.mjs)：它不改任何
 *    字段读法，只把宿主时区换成非东八区。产品退回本地字段时实测读出 [2026,12](北京应为
 *    [2026,1])。本文件以探针读数为裁决者，并附带跑一遍套件报告有没有别的用例跟着红。
 *
 * 用法：
 *   node scripts/mutation-server-beijing-readings.cjs        # 探针矩阵 + 套件
 *   SKIP_SUITE=1 node scripts/mutation-server-beijing-readings.cjs
 *
 * 四条硬规矩：
 *  1) 锚点唯一命中、落地回读、旧锚点消失；
 *  2) 基线自证全绿，且先证明「探针这把尺本身能分叉」，否则整批绿等于没测；
 *  3) 净零用 git diff --numstat 前后逐字比对；
 *  4) 每条变异都要报出「哪个宿主分叉、读数是什么」，不许只报 KILLED 计数。
 * ============================================================================= */
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'server', 'chat.mjs');
const PROBE = path.join(ROOT, 'server', 'test', 'tz-probe.test.mjs');
const SUITE = 'test/chat-timezone.test.mjs';

const TEXT = fs.readFileSync(SRC, 'utf8');
const EOL = TEXT.includes('\r\n') ? '\r\n' : '\n';
const orig = TEXT;

const Q = String.fromCharCode(39);
const TOK = [['@Q@', Q], ['@DQ@', String.fromCharCode(34)]];
const expand = (s) => TOK.reduce((acc, [k, v]) => acc.split(k).join(v), s);

/* 这一刻北京是 2026-01；探针把「此刻」钉在 UTC 2025-12-31T16:00，期望值由此而来。 */
const EXPECT = [2026, 1];
/* 只有本地月≠北京月的宿主才可能暴露缺陷；其余宿主上「断言等于期望」属恒真巧合，单独点名。 */
const ZONES = ['America/New_York', 'UTC', 'Pacific/Kiritimati', 'Asia/Shanghai', '<未设>'];

const mutants = [
  { name: 'S1 「本月」退回设备本地月', from: 'const cm = chinaParts(now).month;', to: 'const cm = now.getMonth() + 1;' },
  { name: 'S2 「今年」锚年退回本地 getFullYear', from: 'const nowYear = chinaParts(now).year;', to: 'const nowYear = now.getFullYear();' },
  /* S3 打在取证层的 ?? 兜底上：`plan.scanFrom ?? chinaParts(new Date()).year`。
     ⚠ 这条**探针必然够不到**，不是判据空白：探针读的是 extractWhen('本月财运')，而 scanFrom
     正是 extractWhen 在扫年分支里算出来的值(且它自己已走北京口径)，所以真链路里 scanFrom
     恒有值、?? 右侧永不执行。实测把 S3 落进代码后五个宿主读数与基线逐字相同，与此一致。
     这一格由 chat-timezone.test.mjs 里「scanFrom 缺失」的夹具 + 进程内桩覆盖(文本层判据)。 */
  { name: 'S3 取证扫年兜底退回本地年(探针够不到：?? 右侧在真链路不执行)', from: `Number(plan.scanFrom ?? chinaParts(new Date()).year)`, to: `Number(plan.scanFrom ?? new Date().getFullYear())` },
  { name: 'S4 chinaParts 整体退化为宿主本地读数', from: `  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1 };`, to: `  return { year: d.getFullYear(), month: d.getMonth() + 1 };` },
  /* S5/S6 打在追问继承 applyFollowUp 的取时刻上，两者都**预期存活**：
     - S5：删掉形参默认值后 now=undefined，extractWhen 自己的默认参把它接住；
     - S6：继承分支改读宿主本地钟，但下游 chinaParts(+8h→getUTC*) 又把它折回北京值。
     两端实测读数与基线逐字相同 ⇒ 这一格在产品里不可观测，判据结构上打不响。
     诚实标注为预期存活，而不是假装它是被抓到的靶子。 */
  { name: 'S5 继承形参默认值被删(预期存活)', from: `applyFollowUp(plan, history, summaries = [], now = new Date()) {`, to: `applyFollowUp(plan, history, summaries = [], now) {` },
  { name: 'S6 继承分支改读宿主本地钟(预期存活)', from: `?.content ?? @Q@@Q@, now)`, to: `?.content ?? @Q@@Q@, new Date())` },
];
mutants.forEach((m) => { m.from = expand(m.from); m.to = expand(m.to); });
/* 明知存活的变异：红了算意外(要去查判据是否过强)，绿了不算失败。
   S3/S5/S6 各因不同机制在「读数」这一层不可观测，理由逐条写在上面的注释里。 */
const EXPECTED_SURVIVORS = new Set(mutants.filter((m) => /预期存活|探针够不到/.test(m.name)).map((m) => m.name));

function apply(m) {
  const from = m.from.split('\n').join(EOL);
  const to = m.to.split('\n').join(EOL);
  const hits = orig.split(from).length - 1;
  if (hits !== 1) throw new Error(`锚点命中 ${hits} 次(需 1): ${m.name}`);
  fs.writeFileSync(SRC, orig.replace(from, () => to), { encoding: 'utf8' });
  const back = fs.readFileSync(SRC, 'utf8');
  if (!back.includes(to)) throw new Error('落地回读失败(变异没进文件): ' + m.name);
  if (from !== to && back.split(from).length - 1 !== 0) throw new Error('旧锚点仍在(替换没生效): ' + m.name);
}
function restore() { fs.writeFileSync(SRC, orig, { encoding: 'utf8' }); }

/** 在一台指定宿主时区的子进程里读「本月」的年月；探针自己把此刻钉到跨年那一刻。 */
function probe(zone) {
  const env = { ...process.env };
  let want;
  if (zone === '<未设>') { delete env.TZ; want = ''; } else { env.TZ = zone; want = zone; }
  const r = spawnSync(process.execPath, [PROBE], { cwd: ROOT, encoding: 'utf8', env });
  const m = /PROBE (\{.*"tz".*\})/.exec(r.stdout || '');
  if (!m) throw new Error(`探针 ${zone} 没吐判据行 rc=${r.status} err=${String(r.stderr).slice(0, 140)}`);
  const got = JSON.parse(m[1]);
  if (got.tz !== want) throw new Error(`探针 TZ 读不回来(注入没生效)：want=${JSON.stringify(want)} got=${JSON.stringify(got)}`);
  return got;
}

/** 跑判据套件：区分 BAD-RUN 与 RED(node:test 汇总无 ANSI，直接文本匹配)。 */
function runSuite() {
  const r = spawnSync(process.execPath, ['--test', SUITE],
    { cwd: path.join(ROOT, 'server'), encoding: 'utf8', env: { ...process.env, MINGLI_TZ_SUBPROCESS: '0' } });
  const out = String(r.stdout || '') + String(r.stderr || '');
  const failLine = /\nℹ fail (\d+)/.exec(out);
  if (!failLine) return { bad: true, why: 'NO-SUMMARY rc=' + r.status + ' ' + out.split('\n').slice(-3).join(' | ').slice(0, 140) };
  const failed = Number(failLine[1]);
  const names = [...out.matchAll(/^✖ (.+?) \(/gm)].map((x) => x[1].slice(0, 40));
  return { killed: failed > 0, why: failed + ' failed' + (names.length ? ': ' + names.join(' ; ') : '') };
}

/* —— 预检：锚点能落地 + 探针这把尺本身能分叉 —— */
const preflight = [];
for (const m of mutants) { try { apply(m); } catch (e) { preflight.push(m.name + ' → ' + e.message.slice(0, 90)); } restore(); }
if (preflight.length) { console.log('PREFLIGHT BAD:\n' + preflight.join('\n')); process.exit(2); }
console.log(`preflight: ${mutants.length}/${mutants.length} 锚点唯一命中且可落地`);

let diverged = 0;
for (const z of ZONES) {
  const g = probe(z);
  const ok = g.got[0] === EXPECT[0] && g.got[1] === EXPECT[1];
  const canReveal = g.localMonth !== EXPECT[1];
  if (canReveal) diverged += 1;
  console.log(`  基线 ${z.padEnd(19)} offset=${String(g.hostOffsetMin).padStart(5)} 本地月=${g.localMonth} 读数=[${g.got}] ${ok ? 'ok' : 'BAD'}${canReveal ? ' ← 可暴露缺陷' : ' ← 巧合(本地==北京)'}`);
  if (!ok) { console.log('BASELINE PROBE BAD: 正确代码在该宿主上就读错'); process.exit(3); }
}
if (diverged === 0) { console.log('PREFLIGHT BAD: 没有宿主出现本地/北京分叉，探针这把尺是空的'); process.exit(2); }
console.log(`  可暴露缺陷的宿主: ${diverged}/${ZONES.length}\n`);

if (!process.env.SKIP_SUITE) {
  const base = runSuite();
  if (base.bad) { console.log('BASELINE BAD-RUN(套件没跑成): ' + base.why); process.exit(4); }
  if (base.killed) { console.log('BASELINE RED(判据本身没过): ' + base.why); process.exit(3); }
  console.log('baseline suite: all green\n');
}

const baselineNet = execFileSync('git', ['-C', ROOT, 'diff', '--numstat', '--', 'server/chat.mjs'], { encoding: 'utf8' }).trim();

const rows = [];
let caught = 0, expectedSurvived = 0, unexpected = 0;
for (const m of mutants) {
  let readings = [];
  let suiteWhy = '(套件跳过)';
  let suiteKilled = false;
  let err = null;
  try {
    apply(m);
    readings = ZONES.map((z) => { const g = probe(z); return { z, local: g.localMonth, got: g.got }; });
    if (!process.env.SKIP_SUITE) { const s = runSuite(); suiteKilled = s.killed; suiteWhy = s.bad ? 'BAD-RUN ' + s.why : s.why; }
  } catch (e) { err = e.message.slice(0, 90); }
  restore();
  if (err) { console.log('APPLY FAILED ' + m.name + ' → ' + err); process.exit(4); }

  /* 裁决者 = 探针读数：任一「本地与北京分叉」的宿主上读出非北京年月，即这条被抓到。 */
  const hit = readings.filter((r) => r.local !== EXPECT[1] && (r.got[0] !== EXPECT[0] || r.got[1] !== EXPECT[1]));
  const coincidental = readings.filter((r) => r.local === EXPECT[1]).map((r) => r.z);
  const isExpected = EXPECTED_SURVIVORS.has(m.name);
  if (hit.length > 0) caught += 1;
  else if (isExpected) expectedSurvived += 1;
  else unexpected += 1;

  rows.push([
    (hit.length > 0 ? 'CAUGHT   ' : isExpected ? 'SURVIVED*' : 'SURVIVED !') + ' ' + m.name,
    '    分叉宿主读数: ' + (hit.length ? hit.map((c) => `${c.z}→[${c.got}]`).join(', ') : '无(各宿主与基线逐字相同)'),
    '    仅巧合的宿主: ' + (coincidental.join(', ') || '无'),
    '    套件: ' + suiteWhy + (suiteKilled ? ' (另有红，属源码层/文本层判据，不代表读数被抓)' : ''),
  ].join('\n'));
}
console.log(rows.join('\n'));
console.log(`\n--- 读数级抓到 ${caught}/${mutants.length}｜预期存活 ${expectedSurvived}｜意外存活 ${unexpected}`);
console.log('* = 该接缝在产品里不可观测：S5 被 extractWhen 的默认参接住，S6 被 chinaParts 的 +8h→getUTC* 折回。');

const net = execFileSync('git', ['-C', ROOT, 'diff', '--numstat', '--', 'server/chat.mjs'], { encoding: 'utf8' }).trim();
if (net !== baselineNet) { console.log('!!! RESIDUAL: 还原后与进入电池前不一致，以上结果不可信'); process.exit(5); }
console.log('净零: git diff --numstat 与进入电池前逐字一致');
process.exit(unexpected === 0 ? 0 : 1);
