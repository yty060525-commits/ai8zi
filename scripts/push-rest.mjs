import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO = 'yty060525-commits/ai8zi';
const BRANCH = 'main';
const GIT_DIR = process.cwd();
// 从 .git/config 提取 token
const cfg = fs.readFileSync(path.join(GIT_DIR, '.git', 'config'), 'utf8');
const m = cfg.match(/x-access-token:([^@]+)@github\.com\//);
const TOKEN = m ? m[1] : process.env.GH_TOKEN;
if (!TOKEN) { console.error('no token'); process.exit(1); }
const API = 'https://api.github.com';

async function gh(method, url, body) {
  const res = await fetch(API + url, {
    method, headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json', 'User-Agent': 'push-script', Accept: 'application/vnd.github+json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(method + ' ' + url + ' -> ' + res.status + ' ' + text.slice(0, 400));
  }
  return res.status === 204 ? null : res.json();
}
async function batch(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}
// changed files
const porcelain = execFileSync('git', ['status', '--porcelain', '-uall'], { cwd: GIT_DIR, encoding: 'utf8' }).split('\n').filter(Boolean);
const changed = [];
for (const line of porcelain) {
  const p = line.slice(3).trim();
  if (p) changed.push(p);
}
console.log('changed paths:', changed.length);

const baseRef = await gh('GET', '/repos/' + REPO + '/git/ref/heads/' + BRANCH);
const baseCommit = await gh('GET', '/repos/' + REPO + '/git/commits/' + baseRef.object.sha);
const baseTree = await gh('GET', '/repos/' + REPO + '/git/trees/' + baseCommit.tree.sha + '?recursive=1');
const entries = new Map();
for (const e of baseTree.tree) {
  if (e.type === 'blob') entries.set(e.path, { sha: e.sha, mode: e.mode });
}

// upload changed blobs
const blobs = await batch(changed, 8, async (p) => {
  const full = path.join(GIT_DIR, p);
  if (!fs.existsSync(full)) return { path: p, removed: true };
  const content = fs.readFileSync(full).toString('base64');
  const blob = await gh('POST', '/repos/' + REPO + '/git/blobs', { content, encoding: 'base64' });
  return { path: p, sha: blob.sha };
});
for (const b of blobs) {
  if (b.removed) entries.delete(b.path);
  else entries.set(b.path, { sha: b.sha, mode: '100644' });
}
console.log('tree blobs:', entries.size);

// 创建整树（含新服务器目录等）
const treeFlat = [...entries.entries()].map(([p, v]) => ({ path: p, mode: v.mode || '100644', type: 'blob', sha: v.sha }));
const treeChunks = [];
const CH = 200;
for (let i = 0; i < treeFlat.length; i += CH) treeChunks.push(treeFlat.slice(i, i + CH));
const trees = [];
for (const chunk of treeChunks) {
  trees.push(await gh('POST', '/repos/' + REPO + '/git/trees', { tree: chunk }));
}
console.log('trees chunks:', trees.length);

// 用嵌套方式合并 chunk：若只建一棵，直接把所有 chunk 的条目合并成一棵大 tree 即可
const mergedTree = await gh('POST', '/repos/' + REPO + '/git/trees', { tree: treeFlat });
const commit = await gh('POST', '/repos/' + REPO + '/git/commits', {
  message: 'feat: linux server + hybrid PWA client (accounts/server-first AI/offline sql mirror/tone slider/auto retry/concurrency/new icon)',
  tree: mergedTree.sha,
  parents: [baseCommit.sha],
});
await gh('PATCH', '/repos/' + REPO + '/git/refs/heads/' + BRANCH, { sha: commit.sha, force: false });
console.log('PUSHED commit', commit.sha);
