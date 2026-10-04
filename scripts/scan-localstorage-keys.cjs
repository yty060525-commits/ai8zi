const fs = require('node:fs');
const path = require('node:path');
const ROOT = 'C:/Users/yty06/Documents/ai/bbazi/ai 8zi/ai 8zi/ai 8zi';
const TESTS = path.join(ROOT, 'client/src/__tests__');

// 1) 测试里出现过的 localStorage 键字面量
const keys = new Map();
for (const f of fs.readdirSync(TESTS)) {
  if (!/\.test\.(ts|tsx)$/.test(f)) continue;
  const text = fs.readFileSync(path.join(TESTS, f), 'utf8').replace(/\r\n/g, '\n');
  for (const m of text.matchAll(/localStorage\.(getItem|setItem|removeItem)\(\s*'([^']+)'/g)) {
    const k = m[2];
    if (!keys.has(k)) keys.set(k, new Set());
    keys.get(k).add(f + ':' + m[1]);
  }
}
console.log('=== 测试里读写的 localStorage 键 ===');
for (const [k, v] of [...keys.entries()].sort()) console.log(k.padEnd(34), '|', [...v].sort().join(', '));

// 2) 产品里的 mingli.* 键
console.log('\n=== 产品源码里的 mingli.* 字面量 ===');
const prod = {};
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name === '__tests__') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    if (!/\.(ts|tsx)$/.test(e.name)) continue;
    const text = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
    text.split('\n').forEach((line, i) => {
      for (const m of line.matchAll(/'mingli\.[^']*'/g)) prod[m[0]] = (prod[m[0]] || []).concat(path.relative(ROOT, p) + ':' + (i + 1));
    });
  }
};
walk(path.join(ROOT, 'client/src'));
for (const [k, v] of Object.entries(prod).sort()) console.log(k.padEnd(30), v.length, '|', v.join(', '));
