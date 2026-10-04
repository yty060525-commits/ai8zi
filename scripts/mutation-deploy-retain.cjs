/* 变异电池：gh-pages 部署脚本的旧 chunk 保留规则(scripts/deploy-pages2.mjs)。
 * 用法：node scripts/mutation-deploy-retain.cjs
 * 判据文件是 client/src/__tests__/deploy-retain-rule.test.ts。
 * 这条链出过线上事故(删光旧哈希 chunk ⇒ 未刷新的旧页面动态 import 404)，所以每个变异都对应一次真实故障形态。
 * 只改本地脚本文件，不碰 GitHub；跑完按内存快照还原，净零用 git diff --numstat 判。 */
const { execFileSync, spawnSync } = require('node:child_process');
const { readFileSync, writeFileSync, existsSync, rmSync } = require('node:fs');
const { resolve } = require('node:path');

const ROOT = resolve(__dirname, '..');
const FILE = 'scripts/deploy-pages2.mjs';
const TEST = 'src/__tests__/deploy-retain-rule.test.ts';
const original = readFileSync(resolve(ROOT, FILE), 'utf8');
const EOL = original.includes('\r\n') ? '\r\n' : '\n';

/** 单锚点：命中次数必须恰好 1，否则 ABORT(不能拿「没落地」的变异冒充存活)。应用后回读自证。 */
/* 反斜杠一律用 BS() 拼出来，别在字符串字面量里写转义：本机的写文件通道会把字面量里的
   反斜杠吞掉一层甚至整层(实测：这里想写两个反斜杠，落盘成了四个，锚点于是 0 命中而 ABORT)。
   吞几层依环境而定、不可预测，所以干脆不依赖它 —— 下面两条判据保证锚点真的落在源码上。 */
const BS = String.fromCharCode(92);
function apply(from, to) {
  const anchor = from.includes('\n') ? from.replace(/\n/g, EOL) : from;
  const repl = to.includes('\n') ? to.replace(/\n/g, EOL) : to;
  const hits = original.split(anchor).length - 1;
  if (hits !== 1) throw new Error(`ANCHOR BAD x${hits}: ${from.slice(0, 70)}`);
  writeFileSync(resolve(ROOT, FILE), original.replace(anchor, repl));
  if (!readFileSync(resolve(ROOT, FILE), 'utf8').includes(repl)) throw new Error('变异没落地: ' + from.slice(0, 50));
}
const restore = () => writeFileSync(resolve(ROOT, FILE), original);

const mutants = [
  { name: 'D1 删光上一版的旧 chunk(线上 404 事故的成因)', run: () => apply('if (kept.length) console.log', 'kept.length = 0; if (kept.length) console.log'), undo: restore },
  { name: 'D2 取消每基名上限(回到全量累积，曾堆成 206 文件/41MB)', run: () => apply('list.slice(-KEEP_PER_BASE)', 'list'), undo: restore },
  { name: 'D3 上限从 3 放宽到 30(等于没有上限)', run: () => apply('const KEEP_PER_BASE = 3;', 'const KEEP_PER_BASE = 30;'), undo: restore },
  { name: 'D4 留最老的几份而不是最近的(slice(-N) → slice(0,N))', run: () => apply('list.slice(-KEEP_PER_BASE)', 'list.slice(0, KEEP_PER_BASE)'), undo: restore },
  { name: 'D5 当前版也进保留表(同名 blob 重复入树)', run: () => apply("&& !current.has(e.path)", ''), undo: restore },
  { name: 'D6 哈希判定放宽到任意 .js(入口文件也被当历史版本留着)', run: () => apply('const HASHED = /-[A-Za-z0-9_-]{8,}' + BS + '.(?:js|css)$/', 'const HASHED = /' + BS + '.(?:js|css)$/'), undo: restore },
  { name: 'D7 parent 改回 main(祖先链断成源码快照，无法按历史判龄)', run: () => apply('parents: [ref.data.object.sha]', 'parents: ["main"]'), undo: restore },
];

function runTests() {
  const outName = 'dr-mutation.json';
  const out = resolve(ROOT, 'client', outName);
  rmSync(out, { force: true });
  const r = spawnSync('npx vitest run ' + TEST + ' --reporter=json --outputFile=' + outName, { cwd: resolve(ROOT, 'client'), shell: true, encoding: 'utf8' });
  if (!existsSync(out)) {
    console.error('ABORT 没生成 json 报告(exit=' + r.status + ')\n' + String(r.stdout || '').slice(-1200) + '\n' + String(r.stderr || '').slice(-800));
    restore(); process.exit(5);
  }
  const json = JSON.parse(readFileSync(out, 'utf8'));
  const failed = json.testResults.flatMap((res) => res.assertionResults || []).filter((a) => a.status === 'failed');
  const msg = json.testResults.map((t) => t.message).filter(Boolean).join('\n');
  rmSync(out, { force: true });
  return { code: r.status ?? 1, failed, msg };
}

const base = runTests();
if (base.code !== 0 || base.failed.length > 0) {
  console.error('基线不净:', base.failed.map((f) => f.title), base.msg.split('\n')[0]);
  restore(); process.exit(2);
}
console.log('基线全绿\n');

let killed = 0; const survivors = [];
for (const m of mutants) {
  try { m.run(); } catch (e) { console.error('ABORT', e.message); restore(); process.exit(3); }
  const { failed, msg } = runTests();
  // 模块级求值失败也算红：那种时候 assertionResults 是空的，只看它会误报 SURVIVED
  if (failed.length > 0 || msg) killed++;
  console.log(((failed.length > 0 || msg) ? 'KILLED   ' : 'SURVIVED ') + m.name +
    ((failed.length ? '\n           → ' + failed.map((f) => f.title).join(' ; ') : '') || (msg ? '\n           → 模块报错 ' + msg.split('\n')[0].slice(0, 90) : '')));
  if (!(failed.length > 0 || msg)) survivors.push(m.name);
  m.undo();
}

const numstat = execFileSync('git', ['diff', '--numstat', '--', FILE], { cwd: ROOT, encoding: 'utf8' }).trim();
console.log(`\n汇总：${killed}/${mutants.length} 杀死，${survivors.length} 存活`);
console.log('净零判据 git diff --numstat: ' + (numstat === '' ? '(空=净零)' : '\n' + numstat));
if (survivors.length || numstat !== '') process.exit(1);
