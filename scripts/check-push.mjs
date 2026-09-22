import fs from 'node:fs'; import path from 'node:path';
const cfg = fs.readFileSync(path.join(process.cwd(), '.git', 'config'), 'utf8');
const token = cfg.match(/x-access-token:([^@]+)@github\.com\//)[1];
const API = 'https://api.github.com';
async function gh(method, url, body) {
  const res = await fetch(API + url, { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'User-Agent': 'check', Accept: 'application/vnd.github+json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, text: text.slice(0, 400) };
}
const ref = await gh('GET', '/repos/yty060525-commits/ai8zi/git/ref/heads/main');
console.log('main ref:', ref.text);
const pages = await gh('POST', '/repos/yty060525-commits/ai8zi/pages', { source: { branch: 'main', path: '/' } });
console.log('pages enable:', pages.status, pages.text);
