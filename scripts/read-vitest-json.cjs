const fs = require('fs');
const path = process.argv[2] || 'bj.json';
const strip = (s) => String(s).replace(/\u001b\[[0-9;]*m/g, '');
const j = JSON.parse(fs.readFileSync(path, 'utf8'));
for (const t of j.testResults || []) {
  console.log('FILE: ' + (t.name || '').slice(-45));
  if (t.message) console.log('MODULE-MSG: ' + strip(t.message).split('\n').slice(0, 8).join(' | '));
  const arr = t.assertionResults || [];
  if (!arr.length && !t.message) console.log('  (no assertions, no message)');
  for (const a of arr) {
    console.log('  ' + a.status + ' :: ' + a.title);
    for (const m of a.failureMessages || []) {
      console.log('      ' + strip(m).split('\n').slice(0, 6).join('\n      '));
    }
  }
}
