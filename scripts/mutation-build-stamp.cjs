/* 变异电池：对构建产物 dist/sw.js 与入口 bundle 做真实扰动，检查 build-stamp-artifacts
 * 的判据是否变红；跑完必须把产物逐字节还原(用 .orig 备份 + cmp 双向核验)。
 * 用法：node scripts/mutation-build-stamp.cjs
 * 注意：dist/ 是未跟踪目录，git diff --numstat 不会反映这里的改动，所以净零判据只能用字节比对。 */
const { spawnSync } = require('node:child_process');
const { readFileSync, writeFileSync, rmSync, existsSync, statSync } = require('node:fs');
const { resolve } = require('node:path');

const ROOT = resolve(__dirname, '..');
const CLIENT = resolve(ROOT, 'client');
const TEST = 'src/__tests__/build-stamp-artifacts.test.ts';
const SW = resolve(CLIENT, 'dist/sw.js');

if (!existsSync(SW)) { console.error('ABORT 没有 dist/sw.js —— 先在 client/ 里 npm run build'); process.exit(2); }

const html = readFileSync(resolve(CLIENT, 'dist/index.html'), 'utf8');
const entryName = /src="\.\/assets\/(index-[^"]+\.js)"/.exec(html)?.[1];
if (!entryName) { console.error('ABORT dist/index.html 找不到入口引用'); process.exit(2); }
const ENTRY = resolve(CLIENT, 'dist/assets', entryName);

const backups = new Map([[SW, readFileSync(SW)], [ENTRY, readFileSync(ENTRY)]]);
for (const [p, buf] of backups) writeFileSync(p + '.orig', buf);

const restore = () => { for (const [p, buf] of backups) writeFileSync(p, buf); };

function runTests() {
  const outName = 'bsm-mutation.json';
  const out = resolve(CLIENT, outName);
  rmSync(out, { force: true });
  // shell:true 是因为 Windows 上 npx 是 .cmd；报告名不带空格否则会被截断
  const r = spawnSync('npx vitest run ' + TEST + ' --reporter=json --outputFile=' + outName, { cwd: CLIENT, shell: true, encoding: 'utf8' });
  if (!existsSync(out)) {
    console.error('ABORT 没生成 json 报告(exit=' + r.status + ')\n' + String(r.stdout || '').slice(-1500));
    restore(); process.exit(5);
  }
  const json = JSON.parse(readFileSync(out, 'utf8'));
  const failed = json.testResults.flatMap((res) => res.assertionResults || []).filter((a) => a.status === 'failed');
  rmSync(out, { force: true });
  return { code: r.status ?? 1, failed };
}

/** 文本级替换：命中次数必须恰好等于期望值，否则 ABORT(不能拿「没落地」冒充存活)。 */
function sub(file, from, to, expectHits = 1) {
  const text = backups.get(file).toString('utf8');
  const hits = text.split(from).length - 1;
  if (hits !== expectHits) throw new Error(`ANCHOR BAD ${hits}!=${expectHits} @ ${from.slice(0, 40)}`);
  return Buffer.from(text.replace(from, to), 'utf8');
}
/** 字节级替换(用于 minified bundle：先定位再按偏移切，避免误伤同名字节串)。 */
function replaceAllBytes(file, needle, replacement, minHits = 1) {
  const buf = backups.get(file);
  const hay = buf.toString('latin1');
  const hits = hay.split(needle).length - 1;
  if (hits < minHits) throw new Error(`ANCHOR BAD x${hits}: ${needle.slice(0, 40)}`);
  return Buffer.from(hay.split(needle).join(replacement), 'latin1');
}

const stampInSw = /const CACHE = 'mingli-(\d{10,})';/.exec(backups.get(SW).toString('utf8'));
if (!stampInSw) { console.error('ABORT dist/sw.js 的 CACHE 不是预期形状'); process.exit(2); }
const STAMP = stampInSw[1];

const mutants = [
  { name: 'B1 sw.js 退回写死的旧缓存号(mingli-v2 ⇒ 手机永不更新)', file: SW,
    run: () => sub(SW, `const CACHE = 'mingli-${STAMP}';`, "const CACHE = 'mingli-v2';") },
  { name: 'B2 sw.js 残留未替换占位符(closeBundle 没跑)', file: SW,
    run: () => sub(SW, `'mingli-${STAMP}'`, "'mingli-__BUILD_ID__'") },
  { name: 'B3 bundle 里的构建号改成另一个时间戳(两个注入点不同源)', file: ENTRY,
    run: () => replaceAllBytes(ENTRY, '`' + STAMP + '`', '`' + String(Number(STAMP) + 1) + '`') },
  { name: 'B4 bundle 里的构建号换成单引号形态(压缩器写法变了，观测条该报出来)', file: ENTRY,
    expectObservation: true,
    run: () => replaceAllBytes(ENTRY, '`' + STAMP + '`', "'" + STAMP + "'") },
];

const base = runTests();
if (base.code !== 0 || base.failed.length > 0) {
  console.error('基线不净:', base.failed.map((f) => f.title)); restore(); process.exit(2);
}
console.log('基线全绿\n');

let killed = 0; const survivors = []; const observations = [];
for (const m of mutants) {
  let buf;
  try { buf = m.run(); } catch (e) { console.error('ABORT', e.message); restore(); process.exit(3); }
  writeFileSync(m.file, buf);
  // 落地自证：读回工作副本，新内容确在、原内容确无
  const now = readFileSync(m.file).toString('latin1');
  if (buf.toString('latin1') !== now) { console.error('ABORT 变异没落地:', m.name); restore(); process.exit(4); }
  const { failed } = runTests();
  const names = failed.map((f) => f.title);
  if (failed.length > 0) { killed++; console.log('KILLED  ' + m.name + '\n        → ' + names.join(' ; ')); }
  else { survivors.push(m.name); console.log('SURVIVED ' + m.name); }
  // 观测条的意义是「写法变了要说出来」：同源判据两种引号都放行，所以 B4 必须由观测条报出。
  // 若哪天连观测条都不红，说明它空转了 —— 这里直接中止，而不是把「没报错」当成通过。
  const seen = names.some((n) => n.includes('引号形态'));
  if (m.expectObservation && !seen) {
    console.error('ABORT 观测条没报出引号形态变化:', m.name); restore(); process.exit(6);
  }
  if (seen) observations.push([m.name, '观测条红(产物写法与该条钉的形态不一致)']);
  restore();
}

// 净零：逐字节比对还原后的产物与 .orig 备份
let dirty = [];
for (const [p, buf] of backups) {
  const orig = readFileSync(p + '.orig');
  if (!orig.equals(buf)) dirty.push(p);
  if (!readFileSync(p).equals(orig)) dirty.push(p + '(当前≠备份)');
  rmSync(p + '.orig', { force: true });
}
console.log(`\n汇总：${killed}/${mutants.length} 杀死，${survivors.length} 存活`);
if (observations.length) console.log('观测记录：\n' + observations.map(([a, b]) => '  ' + a + ' → ' + b).join('\n'));
console.log('净零判据(字节比对): ' + (dirty.length === 0 ? '产物与 .orig 完全一致' : 'DIRTY ' + dirty.join(', ')));
if (dirty.length || survivors.length) process.exit(1);
