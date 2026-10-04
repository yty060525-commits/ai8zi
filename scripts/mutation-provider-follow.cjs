/* 变异电池：把「当前使用通道跟随设置」这条链上每一环各自断开，检查判据是否真的变红。
 * 用法：node scripts/mutation-provider-follow.cjs
 * 纪律(见用户记忆)：锚点落地前先断言命中次数==1；跑测试用 json reporter 取具名断言；
 * 还原后必须 git diff --numstat 净零；产物文件用完删掉。 */
const { execFileSync, spawnSync } = require('node:child_process');
const { readFileSync, writeFileSync, rmSync } = require('node:fs');
const { resolve } = require('node:path');

const ROOT = resolve(__dirname, '..');
const TEST = 'src/__tests__/provider-follow-contract.test.ts';

const files = {
  serverClient: 'client/src/data/serverClient.ts',
  chatEngine: 'client/src/data/chatEngine.ts',
  aiMjs: 'server/ai.mjs',
  libRs: 'client/src-tauri/src/lib.rs',
  aiSettings: 'client/src/data/aiSettings.ts',
  adapter: 'client/src/data/deepseekAdapter.ts',
};
const backups = {};
for (const [k, rel] of Object.entries(files)) backups[k] = readFileSync(resolve(ROOT, rel), 'utf8');

/** EOL 自适应：产品文件是 CRLF，锚点在这里统一写 \n。 */
const fitEol = (text, anchor) => anchor.includes('\n') ? anchor.replace(/\n/g, text.includes('\r\n') ? '\r\n' : '\n') : anchor;

const mutants = [
  { name: '批断请求丢掉 provider(服务器只能用自己那套顺序)', file: 'serverClient',
    from: "{ method: 'POST', body: { task, tone, record, provider }, signal }", to: "{ method: 'POST', body: { task, tone, record }, signal }" },
  // 这条是判据的自证：上一版用 stringContaining('provider') 且锚点不含该词，本变异全绿存活。
  { name: '批断请求把字段改名成 preferred(服务器读不到)', file: 'serverClient',
    from: 'body: { task, tone, record, provider }', to: 'body: { task, tone, record, preferred: provider }' },
  { name: '聊天请求丢掉 provider', file: 'chatEngine',
    from: "body: { question, history, recordId, tone, periodFacts, provider }", to: "body: { question, history, recordId, tone, periodFacts }" },
  { name: '服务器不再校验 preferred 名单(未知通道直接当首选)', file: 'aiMjs',
    from: 'preferred && PROVIDERS.some((p) => p.id === preferred)', to: 'preferred' },
  { name: '服务器通道名单里改掉 qwen 的 id', file: 'aiMjs',
    from: "{ id: 'qwen', label: 'Qwen3.8-Flash'", to: "{ id: 'qwenn', label: 'Qwen3.8-Flash'" },
  { name: '桌面端解析漏掉 kimi(选了它静默回落默认)', file: 'libRs',
    from: '"kimi" => Some(AiProvider::Kimi), ', to: '' },
  { name: '桌面端缺省从 Qwen 改成 Kimi', file: 'libRs',
    from: 'unwrap_or(AiProvider::Qwen)', to: 'unwrap_or(AiProvider::Kimi)' },
  { name: '设置页缺省从 qwen 改成 deepseek', file: 'aiSettings',
    from: "as AiProvider) ?? 'qwen'", to: "as AiProvider) ?? 'deepseek'" },
  { name: '直连缺省从 qwen 改成 kimi', file: 'adapter',
    from: "localStorage.getItem('mingli.provider') ?? 'qwen'", to: "localStorage.getItem('mingli.provider') ?? 'kimi'" },
];

function apply(file, from, to) {
  const text = backups[file];
  const anchor = fitEol(text, from);
  const hits = text.split(anchor).length - 1;
  if (hits !== 1) throw new Error(`ANCHOR BAD ${file} x${hits}: ${from.slice(0, 60)}`);
  return text.replace(anchor, to);
}

function runTests() {
  // 报告路径必须不含空格：项目目录带空格，shell:true 下未加引号的 --outputFile 会被截断
  // (实测 vitest 只写到 'C:/Users/yty06/Documents/ai/bbazi/ai' 就停了)。改用相对 cwd 的短名。
  const outName = 'pfc-mutation.json';
  const out = resolve(ROOT, 'client', outName);
  rmSync(out, { force: true });
  // Windows 上 npx 是 .cmd，execFileSync('npx') 会 ENOENT 并被 catch 伪装成「测试失败」；
  // 用 spawnSync(shell:true) 并把 stdout/stderr 留着，文件没生成时能报出真实原因。
  const r = spawnSync('npx vitest run ' + TEST + ' --reporter=json --outputFile=' + outName, {
    cwd: resolve(ROOT, 'client'), shell: true, encoding: 'utf8',
  });
  if (!require('node:fs').existsSync(out)) {
    console.error('ABORT 没生成 json 报告(exit=' + r.status + ')\n' + String(r.stdout || '').slice(-2000) + '\n' + String(r.stderr || '').slice(-1500));
    restoreAll(); process.exit(5);
  }
  const json = JSON.parse(readFileSync(out, 'utf8'));
  const failed = json.testResults.flatMap((res) => res.assertionResults || []).filter((a) => a.status === 'failed');
  rmSync(out, { force: true });
  return { code: r.status ?? 1, failed };
}

function restoreAll() {
  for (const [k, rel] of Object.entries(files)) writeFileSync(resolve(ROOT, rel), backups[k]);
}

// 基线必须先绿，否则后面的红都不能算判据的功劳
const base = runTests();
if (base.failed.length > 0 || base.code !== 0) {
  console.error('基线不净:', base.failed.map((f) => f.title));
  process.exit(2);
}
console.log('基线 4 passed\n');

let killed = 0;
const survivors = [];
for (const m of mutants) {
  let text;
  try { text = apply(m.file, m.from, m.to); } catch (e) { console.error('ABORT', e.message); restoreAll(); process.exit(3); }
  writeFileSync(resolve(ROOT, files[m.file]), text);
  // 落地自证：读回工作副本确认新串确实在、旧串确实没了(grep -qF 多行会假阴性，这里用 split 计数)
  const now = readFileSync(resolve(ROOT, files[m.file]), 'utf8');
  if (now.split(fitEol(now, m.to)).length - 1 < 1 || now.split(fitEol(now, m.from)).length - 1 > 0) {
    console.error('ABORT 变异没落地:', m.name);
    restoreAll(); process.exit(4);
  }
  const { failed } = runTests();
  if (failed.length > 0) { killed++; console.log('KILLED  ' + m.name + '\n        → ' + failed.map((f) => f.title).join(' ; ')); }
  else { survivors.push(m.name); console.log('SURVIVED ' + m.name); }
  restoreAll();
}

const numstat = execFileSync('git', ['diff', '--numstat'], { cwd: ROOT, encoding: 'utf8' }).trim();
console.log(`\n汇总：${killed}/${mutants.length} 杀死，${survivors.length} 存活`);
console.log('净零判据 git diff --numstat: ' + (numstat === '' ? '(空=净零)' : '\n' + numstat));
if (survivors.length || numstat !== '') process.exit(1);
