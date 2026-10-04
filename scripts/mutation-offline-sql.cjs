/* 变异电池：把产品 SQL 逐条改坏，看 offline-sql-harness / offline-sql-mirror 是否真的红。
 * 只在脚本内临时改文件，结束时无论成败都从内存备份还原(净零由 git status 复核)。
 * 用法：node scripts/mutation-offline-sql.cjs */
const fs = require('fs');
const cp = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', 'client');
const OFFLINE = path.join(ROOT, 'src', 'data', 'offlineSql.ts');
const EXPORT = path.join(ROOT, 'src', 'data', 'sqliteExport.ts');
const TESTS = ['src/__tests__/offline-sql-harness.test.ts', 'src/__tests__/offline-sql-mirror.test.ts'];

// 每条只改一处，且都是「产品真会这么写错」的形态，不是我把测试改严
const MUTANTS = [
  ['镜像建表漏掉 tone_used 列', OFFLINE, 'ai_tasks TEXT, tone_used INTEGER\n          );', 'ai_tasks TEXT\n          );'],
  ['ALTER 补错列名(tone)', OFFLINE, 'ALTER TABLE bazi_records ADD COLUMN tone_used INTEGER', 'ALTER TABLE bazi_records ADD COLUMN tone INTEGER'],
  ['pragma 查错表名', OFFLINE, "pragma_table_info('bazi_records')", "pragma_table_info('bazi_record')"],
  ['RECORD_COLS 前两位互换(顺序判据)', OFFLINE, "'id', 'name', 'gender'", "'name', 'id', 'gender'"],
  ['.sqlite 导出建表漏 tone_used', EXPORT, 'ai_tasks TEXT, tone_used INTEGER\n  );', 'ai_tasks TEXT\n  );'],
  ['.sql 文本导出建表漏 tone_used', EXPORT, "ai_tasks TEXT, tone_used INTEGER);'", "ai_tasks TEXT);'"],
];

const read = (p) => fs.readFileSync(p, 'utf8');

/** 产品文件是 CRLF，判据夹具读进来会统一成 LF。变异锚点一律按「当前行尾」落地：
 *  把锚点里的换行改写成文件实际用的换行(实测用 \n 写锚点在 CRLF 文件里命中 0 次)。 */
const fitEol = (text, anchor) => {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  return anchor.replace(/\r?\n/g, eol);
};

const backups = new Map();
for (const f of [...new Set(MUTANTS.map((m) => m[1]))]) backups.set(f, read(f));

let restored = false;
const cleanup = () => {
  if (restored) return;
  restored = true;
  for (const [f, text] of backups) fs.writeFileSync(f, text);
};
process.on('exit', cleanup);

// 落地自证：锚点在真源码里必须恰好命中一次，否则「全绿」只是变异没进代码
for (const [name, file, fromRaw] of MUTANTS) {
  const from = fitEol(read(file), fromRaw);
  const hits = read(file).split(from).length - 1;
  console.log(`ANCHOR ${hits === 1 ? 'OK  ' : 'BAD '} x${hits}  ${name}`);
  if (hits !== 1) { console.log('锚点命中数不是 1，中止(避免假存活结论)'); process.exit(2); }
}

const stripAnsi = (s) => s.replace(/\u001b\[[0-9;]*m/g, '');

/** 用 json reporter 取「哪几条用例红了」+ 断言首行。
 *  进度行里的 × 不带套件名、失败清单的 FAIL 行在默认 reporter 下又抓不全，
 *  而 KILLED 计数本身不是质量指标 —— 必须点名(见既往教训)。 */
const JSON_OUT = path.join(ROOT, 'vj-mutation.json');
const runTests = () => {
  if (fs.existsSync(JSON_OUT)) fs.rmSync(JSON_OUT);
  const out = cp.spawnSync('npx', ['vitest', 'run', '--reporter=json', `--outputFile=${path.basename(JSON_OUT)}`, ...TESTS],
    { cwd: ROOT, encoding: 'utf8', shell: true });
  let report = null;
  try { report = JSON.parse(fs.readFileSync(JSON_OUT, 'utf8')); } catch { /* 用文本兜底 */ }
  const text = stripAnsi((out.stdout || '') + (out.stderr || ''));
  const failed = /Tests\s+.*?(\d+) failed/.exec(text);
  const passed = /Tests\s+.*?(\d+) passed/.exec(text);
  const names = [];
  if (report && Array.isArray(report.testResults)) {
    for (const file of report.testResults) {
      for (const a of file.assertionResults || []) {
        if (a.status !== 'failed') continue;
        const first = String((a.failureMessages || [])[0] || '').split('\n')[0].slice(0, 90);
        names.push(`${a.title} ⟵ ${first}`);
      }
    }
  }
  return {
    exit: out.status,
    failedCount: names.length || (failed ? Number(failed[1]) : 0),
    passedCount: passed ? Number(passed[1]) : 0,
    names,
    text,
  };
};

console.log('\n=== 基线(未变异) ===');
const base = runTests();
console.log(`exit=${base.exit} failed=${base.failedCount} passed=${base.passedCount}`);
if (base.failedCount !== 0) { console.log('基线不干净，后面的存活/杀死结论都不可信'); console.log(base.text.slice(-3000)); process.exit(3); }

let survived = 0;
for (const [name, file, fromRaw, toRaw] of MUTANTS) {
  const original = backups.get(file);
  const from = fitEol(original, fromRaw);
  const to = fitEol(original, toRaw);
  fs.writeFileSync(file, original.replace(from, to));
  const landed = read(file) !== original && read(file).includes(to);
  const res = runTests();
  const killed = res.failedCount > 0;
  if (!landed) { console.log(`LANDING-BAD  ${name}：变异没落进文件`); survived += 1; }
  else if (killed) {
    console.log(`KILLED       ${name}：failed=${res.failedCount}`);
    for (const n of res.names) console.log(`               · ${n}`);
  }
  else { console.log(`SURVIVED     ${name}：产品改坏了却仍全绿(exit=${res.exit})`); survived += 1; }
  fs.writeFileSync(file, original);
  if (read(file) !== original) { console.log(`RESIDUAL     ${name}：还原失败`); process.exit(4); }
}

cleanup();
console.log(`\n汇总：${MUTANTS.length - survived}/${MUTANTS.length} 杀死，${survived} 存活`);
process.exit(survived ? 5 : 0);
