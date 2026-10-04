/* 变异电池：把 storageInfo.ts 的浏览器/桌面分支逐条改坏，看 storage-info-browser 是否真红。
 * 用法：node scripts/mutation-storage-info.cjs */
const fs = require('fs');
const cp = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', 'client');
const SI = path.join(ROOT, 'src', 'data', 'storageInfo.ts');
const TESTS = ['src/__tests__/storage-info-browser.test.ts'];

const MUTANTS = [
  ['网页版 cacheEntries 摆个假 0', 'cacheEntries: null, dbBytes: 0 }', 'cacheEntries: 0, dbBytes: 0 }'],
  ['网页版记录数写死 0', 'records: (await listBaziRecords()).length', 'records: 0'],
  ['compactRecords 桌面版不再回 changedRecords', 'return result.changedRecords;', 'return 0;'],
  ['clearChartCache 漏传 hourPillar(参数名打错)', "hourPillar: fields.hourPillar });", "hourPillar2: fields.hourPillar });"],
  ['缺 id 时硬闯服务器(用空串当 id)', 'if (!recordId) return 0;', ''],
  ['自检改成一条像故障的失败(丢掉去哪儿测的指引)', "'网页版不能在本地做连通自检。要看批断是否可用：在任一命盘详情页点批断分析，或在排盘页的问问批断里提一个问题，看它能否答上。'", "'自检失败'"],
  ['inTauri 判断反了(桌面/浏览器互换)', "'__TAURI_INTERNALS__' in window", "'__TAURI_NOPE__' in window"],
];

const read = (p) => fs.readFileSync(p, 'utf8');
const original = read(SI);
let restored = false;
const cleanup = () => { if (restored) return; restored = true; fs.writeFileSync(SI, original); };
process.on('exit', cleanup);

for (const [name, from] of MUTANTS) {
  const hits = original.split(from).length - 1;
  console.log(`ANCHOR ${hits === 1 ? 'OK  ' : 'BAD '} x${hits}  ${name}`);
  if (hits !== 1) { console.log('锚点命中数不是 1，中止(避免假存活结论)'); process.exit(2); }
}

const JSON_OUT = path.join(ROOT, 'vj-mutation.json');
const runTests = () => {
  if (fs.existsSync(JSON_OUT)) fs.rmSync(JSON_OUT);
  const out = cp.spawnSync('npx', ['vitest', 'run', '--reporter=json', `--outputFile=${path.basename(JSON_OUT)}`, ...TESTS],
    { cwd: ROOT, encoding: 'utf8', shell: true });
  const text = String((out.stdout || '') + (out.stderr || '')).replace(/\u001b\[[0-9;]*m/g, '');
  const failed = /Tests\s+.*?(\d+) failed/.exec(text);
  let names = [];
  try {
    const report = JSON.parse(fs.readFileSync(JSON_OUT, 'utf8'));
    for (const file of report.testResults || []) {
      for (const a of file.assertionResults || []) {
        if (a.status !== 'failed') continue;
        names.push(`${a.title} ⟵ ${String((a.failureMessages || [])[0] || '').split('\n')[0].slice(0, 80)}`);
      }
    }
  } catch { /* 文本兜底 */ }
  return { exit: out.status, failedCount: names.length || (failed ? Number(failed[1]) : 0), names, text };
};

console.log('\n=== 基线(未变异) ===');
const base = runTests();
console.log(`exit=${base.exit} failed=${base.failedCount}`);
if (base.failedCount !== 0) { console.log(base.text.slice(-2500)); process.exit(3); }

let survived = 0;
for (const [name, from, to] of MUTANTS) {
  fs.writeFileSync(SI, original.replace(from, to));
  const landed = read(SI) !== original && read(SI).includes(to);
  const res = runTests();
  if (!landed) { console.log(`LANDING-BAD  ${name}`); survived += 1; }
  else if (res.failedCount > 0) {
    console.log(`KILLED       ${name}：failed=${res.failedCount}`);
    for (const n of res.names) console.log(`               · ${n}`);
  } else { console.log(`SURVIVED     ${name}：产品改坏了却仍全绿`); survived += 1; }
  fs.writeFileSync(SI, original);
  if (read(SI) !== original) { console.log(`RESIDUAL     ${name}：还原失败`); process.exit(4); }
}
cleanup();
console.log(`\n汇总：${MUTANTS.length - survived}/${MUTANTS.length} 杀死，${survived} 存活`);
process.exit(survived ? 5 : 0);
