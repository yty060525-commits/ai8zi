import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const REPO = 'yty060525-commits/ai8zi';
const GIT_DIR = process.cwd();
const cfg = fs.readFileSync(path.join(GIT_DIR, '.git', 'config'), 'utf8');
const token = cfg.match(/x-access-token:([^@]+)@github\.com\//)?.[1];
if (!token) throw new Error('no token');
const API = 'https://api.github.com';
async function gh(method, url, body) {
  const res = await fetch(API + url, { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'User-Agent': 'deploy', Accept: 'application/vnd.github+json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}
// 1) 设公开
const pub = await gh('PATCH', '/repos/' + REPO, { visibility: 'public' });
console.log('public:', pub.status, pub.data?.visibility ?? pub.data?.message ?? '');
// 2) 上传 client/dist -> 新分支 gh-pages
const distRoot = path.join(GIT_DIR, 'client', 'dist');
function walk(dir, base = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? base + '/' + e.name : e.name;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full, rel));
    else out.push({ rel, full });
  }
  return out;
}
const files = walk(distRoot);
console.log('dist files:', files.length);
async function batch(items, n, fn) { let i = 0; async function w() { while (i < items.length) { const k = i++; await fn(items[k]); } } await Promise.all(Array.from({ length: Math.min(n, items.length) }, w)); }
const shas = new Map();
await batch(files, 8, async (f) => {
  const content = fs.readFileSync(f.full).toString('base64');
  const b = await gh('POST', '/repos/' + REPO + '/git/blobs', { content, encoding: 'base64' });
  if (b.status === 201) shas.set(f.rel, b.data.sha);
});
console.log('uploaded blobs:', shas.size);
const flat = [...shas].map(([p, sha]) => ({ path: p, mode: '100644', type: 'blob', sha }));
const tree = await gh('POST', '/repos/' + REPO + '/git/trees', { tree: flat });
const head = await gh('GET', '/repos/' + REPO + '/git/refs/heads/main');
const commit = await gh('POST', '/repos/' + REPO + '/git/commits', { message: 'deploy: PWA build (gh-pages)', tree: tree.data.sha, parents: [head.data.object.sha] });
let ref = await gh('GET', '/repos/' + REPO + '/git/refs/heads/gh-pages');
if (ref.status === 200) await gh('PATCH', '/repos/' + REPO + '/git/refs/heads/gh-pages', { sha: commit.data.sha, force: true });
else await gh('POST', '/repos/' + REPO + '/git/refs', { ref: 'refs/heads/gh-pages', sha: commit.data.sha });
console.log('gh-pages branch updated:', commit.data.sha);
// 3) 开启 Pages(source=gh-pages)
let pages = await gh('POST', '/repos/' + REPO + '/pages', { source: { branch: 'gh-pages', path: '/' } });
if (pages.status >= 400) pages = await gh('PATCH', '/repos/' + REPO + '/pages', { source: { branch: 'gh-pages', path: '/' } });
console.log('pages:', pages.status, pages.data?.html_url ?? pages.data?.message ?? '');
const info = await gh('GET', '/repos/' + REPO + '/pages');
console.log('pages info:', info.status, JSON.stringify(info.data?.html_url ?? info.data?.message ?? ''));
