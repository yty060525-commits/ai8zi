/* 变异电池 #144：一次一个变异，落地自证 + 命名判据抽取 + 字节还原 + 净零比对。
 * 用法：node scripts/mut-battery-144.mjs <ID>      （ID 见 MUTANTS）
 *        node scripts/mut-battery-144.mjs --check    只比 md5，不动文件 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const AI = path.join(ROOT, 'server/ai.mjs');
const GATE = path.join(ROOT, 'client/src/data/baziOrchestrator.ts');
const BACKUP = path.join(ROOT, 'key-backups/mut144');

const md5 = (p) => crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex');
const read = (p) => fs.readFileSync(p, 'utf8');
/** 按真实行尾 join：产品文件是 CRLF(当场量得 server/ai.mjs 486 CRLF / 0 bareLF)，
 *  LF 锚点在上面永不命中 ⇒ 静默 SKIP，把「没测」伪装成「存活」。缺陷 #123 同一课。 */
function apply(file, anchor, replacement) {
  const text = read(file);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const toEol = (s) => s.split('\n').join(eol);
  const a = toEol(anchor);
  const hits = text.split(a).length - 1;
  if (hits !== 1) return { ok: false, reason: `ANCHOR_ERROR hits=${hits}` };
  const next = text.replace(a, toEol(replacement));
  if (next === text) return { ok: false, reason: 'NO_CHANGE(变异体与原文件逐字相同)' };
  fs.writeFileSync(file, next);
  return { ok: true, landed: read(file).split(toEol(replacement)).length - 1 };
}

const M = (id, file, anchor, replacement, note) => ({ id, file, anchor, replacement, note });
const MUTANTS = [
  M('A1', AI,
    "export const AI_SERVER_UNCONFIGURED = '服务器未配置访问凭据，请在服务器设置中填写后保存';",
    "export const AI_SERVER_UNCONFIGURED = '服务器尚未接入任何通道，请机主补凭据';",
    '文案不再含「未配置」字样 —— 这正是本缺陷的成因形态'),
  M('A2', GATE,
    "  if (/not_configured|未配置|credential|keyring/i.test(error)) return false;",
    '  // 删掉这一句',
    '整条字样闸门摘掉'),
  M('A3', GATE,
    "  if (/HTTP 40[0-9]|服务返回四[零一二三四五六七八九]/.test(error)) return false;",
    '  // 删掉这一句',
    '整条状态码闸门摘掉'),
];

function runTests() {
  const out = [];
  const server = spawnSync('node', ['--test', 'test/retry-gate-unconfigured.test.mjs'], { cwd: path.join(ROOT, 'server'), encoding: 'utf8', shell: true });
  out.push({ label: 'server/test/retry-gate-unconfigured.test.mjs', code: server.status, text: (server.stdout || '') + (server.stderr || '') });
  const client = spawnSync('npx', ['vitest', 'run', 'src/__tests__/retry-gate-server-text.test.ts', '--pool=forks', '--maxWorkers=1'], { cwd: path.join(ROOT, 'client'), encoding: 'utf8', shell: true });
  out.push({ label: 'client retry-gate-server-text.test.ts', code: client.status, text: (client.stdout || '') + (client.stderr || '') });
  return out;
}

/** 剥 ANSI 再取失败名：vitest 汇总行带 \e[2m，纯文本正则读不出 failed 数(踩过两次)。 */
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

if (process.argv[2] === '--check') {
  for (const f of [AI, GATE]) console.log(md5(f), path.relative(ROOT, f), '(基线 ' + md5(path.join(BACKUP, path.basename(f))) + ')');
  process.exit(0);
}

const id = process.argv[2];
const m = MUTANTS.find((x) => x.id === id);
if (!m) { console.log('未知 ID，可选：' + MUTANTS.map((x) => x.id).join(', ')); process.exit(2); }

fs.mkdirSync(BACKUP, { recursive: true });
const pristine = path.join(BACKUP, path.basename(m.file));
if (!fs.existsSync(pristine)) fs.copyFileSync(m.file, pristine);
if (md5(m.file) !== md5(pristine)) { console.log('REFUSED：目标文件与基线不一致，先还原再跑'); process.exit(3); }

const res = apply(m.file, m.anchor, m.replacement);
if (!res.ok) { console.log(`${m.id} ${res.reason}`); fs.copyFileSync(pristine, m.file); process.exit(4); }
console.log(`${m.id} LANDED hits=${res.landed} :: ${m.note}`);
try {
  for (const t of runTests()) {
    const text = strip(t.text);
    const names = [...text.matchAll(/^\s*(?:✖|×|not ok \d+ -) ?(.+?)(?: \([\d.]+ms\))?\s*$/gm)].map((x) => x[1].trim())
      .filter((n) => n && !/^failing tests:/i.test(n));
    const uniq = [...new Set(names)];
    console.log(`${m.id} ${t.label} exit=${t.code} ${t.code === 0 ? 'GREEN' : 'RED'}${uniq.length ? ' | 红在: ' + uniq.slice(0, 4).join(' ;; ') : ''}`);
  }
} finally {
  fs.copyFileSync(pristine, m.file);
  const netZero = md5(m.file) === md5(pristine) && md5(m.file) === md5(path.join(ROOT, 'server/ai.mjs')) || true;
  console.log(`${m.id} RESTORED md5=${md5(m.file)} 净零=${md5(m.file) === md5(pristine)}`);
}
