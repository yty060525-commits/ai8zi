import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const REPO = 'yty060525-commits/ai8zi';
const GIT_DIR = process.cwd();
const cfg = fs.readFileSync(path.join(GIT_DIR, '.git', 'config'), 'utf8');
const m = cfg.match(/x-access-token:([^@]+)@github\.com\//);
const TOKEN = m ? m[1] : process.env.GH_TOKEN;
if (!TOKEN) throw new Error('no token');
const API = 'https://api.github.com';
async function gh(method, url, body) {
  const res = await fetch(API + url, { method, headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json', 'User-Agent': 'push-v2', Accept: 'application/vnd.github+json' }, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) { const t = await res.text(); throw new Error(method + ' ' + url + ' -> ' + res.status + ' ' + t.slice(0, 300)); }
  return res.status === 204 ? null : res.json();
}
const HEAD = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: GIT_DIR, encoding: 'utf8' }).trim();
// 本地 HEAD 全树（含 mode/sha）
const ls = execFileSync('git', ['ls-tree', '-r', '-z', 'HEAD'], { cwd: GIT_DIR, encoding: 'utf8' });
const local = new Map();
for (const part of ls.split('\0')) {
  if (!part.trim()) continue;
  const sp = part.indexOf(' ');
  const sp2 = part.indexOf(' ', sp + 1);
  const sp3 = part.indexOf('\t', sp2 + 1);
  const mode = part.slice(0, sp);
  const type = part.slice(sp + 1, sp2);
  const sha = part.slice(sp2 + 1, sp3 < 0 ? undefined : sp3);
  const p = part.slice(sp3 + 1);
  local.set(p, { mode, type, sha });
}
console.log('local blobs:', [...local.values()].filter(v => v.type === 'blob').length, 'head', HEAD);
const ref = await gh('GET', '/repos/' + REPO + '/git/ref/heads/main');
const baseCommit = await gh('GET', '/repos/' + REPO + '/git/commits/' + ref.object.sha);
const baseTree = await gh('GET', '/repos/' + REPO + '/git/trees/' + baseCommit.tree.sha + '?recursive=1');
const remote = new Map();
for (const e of baseTree.tree) if (e.type === 'blob') remote.set(e.path, e.sha);
console.log('remote blobs:', remote.size);

// 上传本地新增/变更的 blob；已有同 sha 直接复用
const todo = [];
for (const [p, v] of local) {
  if (v.type !== 'blob') continue;
  if (remote.get(p) === v.sha) continue;
  todo.push(p);
}
console.log('blobs to upload:', todo.length);
async function batch(items, n, fn) { const out = []; let i = 0; async function w() { while (i < items.length) { const k = i++; out.push(await fn(items[k])); } } await Promise.all(Array.from({ length: Math.min(n, items.length) }, w)); return out; }
await batch(todo, 8, async (p) => {
  const full = path.join(GIT_DIR, p);
  const content = fs.readFileSync(full).toString('base64');
  const blob = await gh('POST', '/repos/' + REPO + '/git/blobs', { content, encoding: 'base64' });
  local.set(p, { ...local.get(p), sha: blob.sha });
  console.log('uploaded', p);
});
const flat = [...local.values()].filter(v => v.type === 'blob').map(v => ({ path: [...local.entries()].find(([, x]) => x === v)?.[0], mode: v.mode === '100755' ? '100755' : '100644', type: 'blob', sha: v.sha }));
// 更稳妥：显式遍历 local map 构建路径
const flat2 = [];
for (const [p, v] of local) if (v.type === 'blob') flat2.push({ path: p, mode: v.mode === '100755' ? '100755' : '100644', type: 'blob', sha: v.sha });
const tree = await gh('POST', '/repos/' + REPO + '/git/trees', { tree: flat2 });
const commit = await gh('POST', '/repos/' + REPO + '/git/commits', { message: 'feat: prompt upgrades (strength framework/simplified Chinese/five sections) + desktop tone v5 + hide shensha + adaptive concurrency + batch export/import', tree: tree.sha, parents: [ref.object.sha] });
await gh('PATCH', '/repos/' + REPO + '/git/refs/heads/main', { sha: commit.sha, force: false });
console.log('PUSHED', commit.sha, 'tree blobs', flat2.length);
