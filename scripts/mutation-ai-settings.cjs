/* 变异电池：aiSettings 的浏览器(localStorage)支路 —— 这条支路在 MODE==='test' 下原本走不到，
 * 所以它的每一条判据都是这次新建的(ai-settings-browser-creds.test.ts)。
 * 用法：node scripts/mutation-ai-settings.cjs
 *
 * 每个变异都对应一个「改了不会报错、只有用户会撞上」的真实形态：
 *   A1 去掉写入侧的空白校验(回到「粘贴带空格也报已配置」)
 *   A2 去掉读取侧的 trim(显示与真正发出去的串分叉)
 *   A3 读取侧一律返回 undefined(反向钉子：把判据中性化，必须被正例杀掉)
 *   A4 credKey 前缀漂移(保存的密钥读不回来，存储里白躺一份)
 *   A5 服务↔通道映射错位(serviceOne 落到 kimi)
 *   A6 缺省通道不再是千问
 *   A7 clear 删错键(清了 a 却留着 b)
 *   A8 通道中文名与桌面端 lib.rs 分叉
 */
const { execFileSync, spawnSync } = require('node:child_process');
const { readFileSync, writeFileSync, rmSync, existsSync } = require('node:fs');
const { resolve } = require('node:path');

const ROOT = resolve(__dirname, '..');
const TEST = 'src/__tests__/ai-settings-browser-creds.test.ts';
const FILE = 'client/src/data/aiSettings.ts';
const original = readFileSync(resolve(ROOT, FILE), 'utf8');
const EOL = original.includes('\r\n') ? '\r\n' : '\n';

/** 锚点命中次数必须恰好 1，否则当 ABORT(不能拿「没落地」的变异冒充存活)。 */
function mutate(from, to) {
  const anchor = from.includes('\n') ? from.replace(/\n/g, EOL) : from;
  const repl = to.includes('\n') ? to.replace(/\n/g, EOL) : to;
  const hits = original.split(anchor).length - 1;
  if (hits !== 1) throw new Error(`ANCHOR BAD x${hits}: ${from.slice(0, 70)}`);
  return original.replace(anchor, repl);
}

const mutants = [
  { name: 'A1 写入侧不再拒绝空白、也不去首尾空白',
    from: "  const trimmed = (secret ?? '').trim();\n  if (!trimmed) return 'not_configured';",
    to: "  const trimmed = secret ?? '';" },
  { name: 'A2 读取侧原样返回(存量脏值仍算已配置，且发出的串带空白)',
    from: '    const trimmed = raw?.trim();\n    return trimmed ? trimmed : undefined;',
    to: '    return raw ?? undefined;' },
  { name: 'A3 读取侧一律 undefined(中性化判据本身，必须由正例杀)',
    from: '    const trimmed = raw?.trim();\n    return trimmed ? trimmed : undefined;',
    to: '    void raw;\n    return undefined;' },
  { name: 'A4 凭据键名前缀漂移',
    from: "const credKey = (provider: AiProvider) => 'mingli.cred.' + provider;",
    to: "const credKey = (provider: AiProvider) => 'mingli.credential.' + provider;" },
  { name: 'A5 服务→通道映射整体错位一格',
    from: "service === 'serviceOne' ? 'deepseek' : service === 'serviceTwo' ? 'kimi' : 'qwen'",
    to: "service === 'serviceOne' ? 'kimi' : service === 'serviceTwo' ? 'qwen' : 'deepseek'" },
  { name: 'A6 缺省使用通道不再是千问',
    from: "(localStorage.getItem('mingli.provider') as AiProvider) ?? 'qwen'",
    to: "(localStorage.getItem('mingli.provider') as AiProvider) ?? 'deepseek'" },
  { name: 'A7 清空时删掉别的通道的键',
    from: "if (isProdBrowser()) { localStorage.removeItem(credKey(provider)); return 'not_configured'; }",
    to: "if (isProdBrowser()) { localStorage.removeItem(credKey(provider === 'kimi' ? 'qwen' : 'kimi')); return 'not_configured'; }" },
  { name: 'A8 通道中文名与桌面端分叉',
    from: "{ deepseek: '通道一深思', kimi: '通道二克米', qwen: '通道三千问' }",
    to: "{ deepseek: '通道一深度', kimi: '通道二克米', qwen: '通道三千问' }" },
];

function runTests() {
  // 报告名不含空格：项目目录带空格，shell:true 下未加引号的 --outputFile 会被截断
  const outName = 'ais-mutation.json';
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
console.log('基线全绿(' + base.failed.length + ' 红)\n');

let killed = 0; const survivors = [];
for (const m of mutants) {
  let text;
  try { text = mutate(m.from, m.to); } catch (e) { console.error('ABORT', e.message); restore(); process.exit(3); }
  writeFileSync(resolve(ROOT, FILE), text);
  const now = readFileSync(resolve(ROOT, FILE), 'utf8');
  if (!now.includes(text)) { console.error('ABORT 变异没落地:', m.name); restore(); process.exit(4); }
  const { failed } = runTests();
  if (failed.length > 0) { killed++; console.log('KILLED   ' + m.name + '\n           → ' + failed.map((f) => f.title).join(' ; ')); }
  else { survivors.push(m.name); console.log('SURVIVED ' + m.name); }
  restore();
}

const numstat = execFileSync('git', ['diff', '--numstat'], { cwd: ROOT, encoding: 'utf8' }).trim();
console.log(`\n汇总：${killed}/${mutants.length} 杀死，${survivors.length} 存活`);
console.log('净零判据 git diff --numstat: ' + (numstat === '' ? '(空=净零)' : '\n' + numstat));
if (survivors.length || numstat !== '') process.exit(1);
