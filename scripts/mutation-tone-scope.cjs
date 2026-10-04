/* 变异电池：语气「本机 · 按盘」这条约束的每一环各自断开，检查判据是否变红。
 * 用法：node scripts/mutation-tone-scope.cjs
 * 关键一条是 T1(把语气写回 record)：这是产品注释承诺、行为测试看不见的那类改动。 */
const { execFileSync, spawnSync } = require('node:child_process');
const { readFileSync, writeFileSync, rmSync, existsSync } = require('node:fs');
const { resolve } = require('node:path');

const ROOT = resolve(__dirname, '..');
const TEST = 'src/__tests__/tone-local-scope.test.ts';
const FILE = 'client/src/features/person/PersonDetail.tsx';
const original = readFileSync(resolve(ROOT, FILE), 'utf8');

/** EOL 自适应 + 命中次数必须恰好 1，否则当 ABORT(不能拿「没落地」的变异冒充存活)。 */
function mutate(from, to) {
  const anchor = from.includes('\n') ? from.replace(/\n/g, original.includes('\r\n') ? '\r\n' : '\n') : from;
  const repl = to.includes('\n') ? to.replace(/\n/g, original.includes('\r\n') ? '\r\n' : '\n') : to;
  const hits = original.split(anchor).length - 1;
  if (hits !== 1) throw new Error(`ANCHOR BAD x${hits}: ${from.slice(0, 70)}`);
  return original.replace(anchor, repl);
}

const mutants = [
  { name: 'T1 语气写回会同步的 record(这边调档，别人那台也跟着变)',
    from: "aiStatus: 'pending', aiError: undefined }", to: "aiStatus: 'pending', aiError: undefined, toneUsed: currentTone }" },
  { name: 'T2 pref 与 ran 合并成同一个键(重跑判定永远命中缓存)',
    from: "const ranKey = (rec: string) => TONE_KEY + '.' + rec + '.ran';", to: "const ranKey = (rec: string) => TONE_KEY + '.' + rec;" },
  { name: 'T3 按盘的取值不再看本机选过的值(滑杆一动就丢)',
    from: "(rec ? readLocalTone(prefKey(rec)) ?? readLocalTone(ranKey(rec)) : undefined)", to: '(rec ? readLocalTone(ranKey(rec)) : undefined)' },
  { name: 'T4 空串读成 0(Number("") === 0 且 isFinite)',
    from: "if (raw === null || raw.trim() === '') return undefined;", to: 'if (raw === null) return undefined;' },
  { name: 'T5 越界不夹住(999 直接当语气档发出去)',
    from: 'const clampTone = (n: number) => Math.max(0, Math.min(100, Math.round(n)));', to: 'const clampTone = (n: number) => n;' },
  { name: 'T6 saveRecordTone 顺手把全局默认也改了',
    from: 'if (rec) writeLocalTone(prefKey(rec), v);', to: 'if (rec) { writeLocalTone(prefKey(rec), v); writeLocalTone(TONE_KEY, v); }' },
];

function runTests() {
  // 报告名不含空格：项目目录带空格，shell:true 下未加引号的 --outputFile 会被截断
  const outName = 'tls-mutation.json';
  const out = resolve(ROOT, 'client', outName);
  rmSync(out, { force: true });
  const r = spawnSync('npx vitest run ' + TEST + ' --reporter=json --outputFile=' + outName, { cwd: resolve(ROOT, 'client'), shell: true, encoding: 'utf8' });
  if (!existsSync(out)) {
    console.error('ABORT 没生成 json 报告(exit=' + r.status + ')\n' + String(r.stdout || '').slice(-1500) + '\n' + String(r.stderr || '').slice(-1200));
    restore(); process.exit(5);
  }
  const json = JSON.parse(readFileSync(out, 'utf8'));
  const failed = json.testResults.flatMap((res) => res.assertionResults || []).filter((a) => a.status === 'failed');
  rmSync(out, { force: true });
  return { code: r.status ?? 1, failed };
}
const restore = () => { writeFileSync(resolve(ROOT, FILE), original); };

const base = runTests();
if (base.code !== 0 || base.failed.length > 0) {
  console.error('基线不净:', base.failed.map((f) => f.title));
  restore(); process.exit(2);
}
console.log('基线 ' + (base.failed.length === 0 ? '全绿' : '?') + '\n');

let killed = 0; const survivors = [];
for (const m of mutants) {
  let text;
  try { text = mutate(m.from, m.to); } catch (e) { console.error('ABORT', e.message); restore(); process.exit(3); }
  writeFileSync(resolve(ROOT, FILE), text);
  const now = readFileSync(resolve(ROOT, FILE), 'utf8');
  if (!now.includes(text)) { console.error('ABORT 变异没落地:', m.name); restore(); process.exit(4); }
  const { failed } = runTests();
  if (failed.length > 0) { killed++; console.log('KILLED  ' + m.name + '\n        → ' + failed.map((f) => f.title).join(' ; ')); }
  else { survivors.push(m.name); console.log('SURVIVED ' + m.name); }
  restore();
}

const numstat = execFileSync('git', ['diff', '--numstat'], { cwd: ROOT, encoding: 'utf8' }).trim();
console.log(`\n汇总：${killed}/${mutants.length} 杀死，${survivors.length} 存活`);
console.log('净零判据 git diff --numstat: ' + (numstat === '' ? '(空=净零)' : '\n' + numstat));
if (survivors.length || numstat !== '') process.exit(1);
