/* 变异电池：版本号链路(version.sh ↔ vite.config ↔ buildInfo ↔ dist 产物)。
 * 用法：node scripts/mutation-version-chain.cjs
 * 判据文件是 client/src/__tests__/version-chain.test.ts —— 它比对的是「两端各自从源码解析出的结果」，
 * 所以任何一端改格式都必须让另一端也改，否则相等比对当场变红。
 * V6/V7 直接改真实 dist 字节(与 mutation-build-stamp 同一手法)，跑完按字节还原。 */
const { execFileSync, spawnSync } = require('node:child_process');
const { readFileSync, writeFileSync, rmSync, existsSync } = require('node:fs');
const { resolve } = require('node:path');

const ROOT = resolve(__dirname, '..');
const TEST = 'src/__tests__/version-chain.test.ts';

/** 单文件、单锚点：命中次数必须恰好 1，否则 ABORT(不能拿「没落地」的变异冒充存活)。 */
function makeMutator(file) {
  const original = readFileSync(resolve(ROOT, file), 'utf8');
  const EOL = original.includes('\r\n') ? '\r\n' : '\n';
  return {
    original,
    file,
    apply(from, to) {
      const anchor = from.includes('\n') ? from.replace(/\n/g, EOL) : from;
      const repl = to.includes('\n') ? to.replace(/\n/g, EOL) : to;
      const hits = original.split(anchor).length - 1;
      if (hits !== 1) throw new Error(`ANCHOR BAD x${hits} in ${file}: ${from.slice(0, 70)}`);
      writeFileSync(resolve(ROOT, file), original.replace(anchor, repl));
      const now = readFileSync(resolve(ROOT, file), 'utf8');
      if (!now.includes(repl)) throw new Error(`变异没落地 in ${file}: ${from.slice(0, 50)}`);
    },
    restore() { writeFileSync(resolve(ROOT, file), original); },
  };
}

const CFG = makeMutator('client/vite.config.ts');
const SH = makeMutator('scripts/version.sh');
const INFO = makeMutator('client/src/utils/buildInfo.ts');

/* dist 是未跟踪目录，git diff 看不见它 ⇒ 净零判据要按字节自比。 */
const entryPath = (() => {
  const html = readFileSync(resolve(ROOT, 'client/dist/index.html'), 'utf8');
  const m = /assets\/(index-[A-Za-z0-9_-]+\.js)/.exec(html);
  if (!m) throw new Error('dist/index.html 里找不到入口 bundle —— 先 npm run build');
  return 'client/dist/assets/' + m[1];
})();
const entryOriginal = readFileSync(resolve(ROOT, entryPath));

function sub(distFrom, distTo) {
  const text = entryOriginal.toString('latin1');
  const hits = text.split(distFrom).length - 1;
  if (hits !== 1) throw new Error(`DIST ANCHOR BAD x${hits}: ${distFrom}`);
  return Buffer.from(text.replace(distFrom, distTo), 'latin1');
}
const VER = /(\d+-[0-9a-f]{7,})/.exec(entryOriginal.toString('latin1'))[1];

const mutants = [
  { name: 'V1 配置端把序号与哈希调换顺序', run: () => CFG.apply("return `${git(['rev-list', '--count', 'HEAD'])}-${git(['rev-parse', '--short', 'HEAD'])}`;", "return `${git(['rev-parse', '--short', 'HEAD'])}-${git(['rev-list', '--count', 'HEAD'])}`;"), undo: CFG.restore },
  { name: 'V2 脚本端给快照名再加一层前缀', run: () => SH.apply("bare_version() { current_version | sed 's/^build-//'; }", "bare_version() { current_version | sed 's/^build-/v/'; }"), undo: SH.restore },
  { name: 'V3 脚本端 echo 模板改用下划线分隔', run: () => SH.apply('echo "build-$n-$sha"', 'echo "build-$n_$sha"'), undo: SH.restore },
  { name: 'V4 读法不再拆「序号-哈希」(原样返回会把机器串印上屏)', run: () => INFO.apply('const m = /^(\\d+)-([0-9a-fA-F]+)$/.exec(String(raw ?? \'\').trim());', 'const m = null as never; void String(raw ?? \'\').trim();'), undo: INFO.restore },
  { name: 'V5 配置端不再注入 git 号(恒空串)', run: () => CFG.apply('define: { __BUILD_ID__: JSON.stringify(BUILD_ID), __GIT_VERSION__: JSON.stringify(GIT_VERSION) },', 'define: { __BUILD_ID__: JSON.stringify(BUILD_ID), __GIT_VERSION__: JSON.stringify(\'\') },'), undo: CFG.restore },
  { name: 'V6 产物里的版本号分隔符换成下划线(读法认不出)', run: () => writeFileSync(resolve(ROOT, entryPath), sub('-' + VER.split('-')[1], '_' + VER.split('-')[1])), undo: () => writeFileSync(resolve(ROOT, entryPath), entryOriginal) },
  { name: 'V7 产物里的版本号被截掉一位哈希', run: () => writeFileSync(resolve(ROOT, entryPath), sub(VER, VER.slice(0, VER.length - 1))), undo: () => writeFileSync(resolve(ROOT, entryPath), entryOriginal) },
];

function runTests() {
  const outName = 'vc-mutation.json';
  const out = resolve(ROOT, 'client', outName);
  rmSync(out, { force: true });
  const r = spawnSync('npx vitest run ' + TEST + ' --reporter=json --outputFile=' + outName, { cwd: resolve(ROOT, 'client'), shell: true, encoding: 'utf8' });
  if (!existsSync(out)) {
    console.error('ABORT 没生成 json 报告(exit=' + r.status + ')\n' + String(r.stdout || '').slice(-1500) + '\n' + String(r.stderr || '').slice(-1200));
    restoreAll(); process.exit(5);
  }
  const json = JSON.parse(readFileSync(out, 'utf8'));
  const failed = json.testResults.flatMap((res) => res.assertionResults || []).filter((a) => a.status === 'failed');
  rmSync(out, { force: true });
  return { code: r.status ?? 1, failed };
}
function restoreAll() { CFG.restore(); SH.restore(); INFO.restore(); writeFileSync(resolve(ROOT, entryPath), entryOriginal); }

const base = runTests();
if (base.code !== 0 || base.failed.length > 0) {
  console.error('基线不净:', base.failed.map((f) => f.title));
  restoreAll(); process.exit(2);
}
console.log('基线全绿\n');

let killed = 0; const survivors = [];
for (const m of mutants) {
  try { m.run(); } catch (e) { console.error('ABORT', e.message); restoreAll(); process.exit(3); }
  const { failed } = runTests();
  if (failed.length > 0) { killed++; console.log('KILLED   ' + m.name + '\n           → ' + failed.map((f) => f.title).join(' ; ')); }
  else { survivors.push(m.name); console.log('SURVIVED ' + m.name); }
  m.undo();
}

const numstat = execFileSync('git', ['diff', '--numstat'], { cwd: ROOT, encoding: 'utf8' }).trim();
const distSame = Buffer.compare(readFileSync(resolve(ROOT, entryPath)), entryOriginal) === 0;
console.log(`\n汇总：${killed}/${mutants.length} 杀死，${survivors.length} 存活`);
console.log('净零判据 git diff --numstat: ' + (numstat === '' ? '(空=净零)' : '\n' + numstat));
console.log('净零判据 dist 入口字节一致: ' + (distSame ? '是' : '否 ← 有残留！'));
if (survivors.length || numstat !== '' || !distSame) process.exit(1);
