import fs from 'node:fs';
import path from 'node:path';
const REPO = 'yty060525-commits/ai8zi';
const GIT_DIR = process.cwd();
const cfg = fs.readFileSync(path.join(GIT_DIR, '.git', 'config'), 'utf8');
const token = process.env.GH_TOKEN || (() => { try { const cfg = fs.readFileSync(path.join(GIT_DIR, '.git', 'config'), 'utf8'); return cfg.match(/x-access-token:([^@]+)@github\.com\//)?.[1] || ''; } catch { return ''; } })();
const API = 'https://api.github.com';
async function gh(method, url, body) {
  const res = await fetch(API + url, { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'User-Agent': 'deploy2', Accept: 'application/vnd.github+json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data = null; try { data = JSON.parse(text); } catch {}
  if (res.status >= 400 && !(res.status === 422)) throw new Error(method + ' ' + url + ' ' + res.status + ' ' + text.slice(0, 300));
  return { status: res.status, data };
}
const distRoot = path.join(GIT_DIR, 'client', 'dist');
function walk(dir, base = '') { const out = []; for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const rel = base ? base + '/' + e.name : e.name; const full = path.join(dir, e.name); if (e.isDirectory()) out.push(...walk(full, rel)); else out.push({ rel, full }); } return out; }
const files = walk(distRoot);
const ref = await gh('GET', '/repos/' + REPO + '/git/refs/heads/gh-pages');
const commit = await gh('GET', '/repos/' + REPO + '/git/commits/' + ref.data.object.sha);
const treeInfo = await gh('GET', '/repos/' + REPO + '/git/trees/' + commit.data.tree.sha + '?recursive=1');
const existing = new Set((treeInfo.data?.tree || []).filter(e => e.type === 'blob').map(e => e.path));
console.log('dist:', files.length, 'existing on branch:', existing.size);
const shas = new Map();
for (const f of files) {
  const content = fs.readFileSync(f.full).toString('base64');
  const b = await gh('POST', '/repos/' + REPO + '/git/blobs', { content, encoding: 'base64' });
  if (b.status === 201 || b.data?.sha) shas.set(f.rel, b.data.sha);
  else console.log('FAIL', f.rel, b.status, JSON.stringify(b.data).slice(0,120));
}
console.log('blob shas ready:', shas.size);
const missing = files.filter(f => !shas.has(f.rel)).map(f => f.rel);
console.log('missing:', missing.length ? missing.join(', ') : '(none)');
if (shas.size !== files.length) process.exit(1);
const flat = [...shas].map(([p, sha]) => ({ path: p, mode: '100644', type: 'blob', sha }));
const tree = await gh('POST', '/repos/' + REPO + '/git/trees', { tree: flat });
const main = await gh('GET', '/repos/' + REPO + '/git/refs/heads/main');
const c = await gh('POST', '/repos/' + REPO + '/git/commits', { message: 'deploy: full PWA build', tree: tree.data.sha, parents: [main.data.object.sha] });
await gh('PATCH', '/repos/' + REPO + '/git/refs/heads/gh-pages', { sha: c.data.sha, force: true });
console.log('gh-pages force-updated to full build:', c.data.sha, 'blobs', flat.length);
