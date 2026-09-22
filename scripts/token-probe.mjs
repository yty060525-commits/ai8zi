import { DatabaseSync } from 'node:sqlite';
const files = [
  'C:/Users/yty06/Desktop/命理客户端/data/bazi_records.sqlite3',
  'C:/Users/yty06/AppData/Roaming/com.example.mingli-client/bazi_records.sqlite3',
];
for (const f of files) {
  console.log('==== ' + f + ' ====');
  const db = new DatabaseSync(f, { readOnly: true });
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  console.log('tables:', tables.map(t => t.name).join(', '));
  for (const t of tables) {
    const cols = db.prepare('PRAGMA table_info(' + t.name + ')').all().map(c => c.name);
    console.log('  ' + t.name + ' cols: ' + cols.join(', '));
  }
  try {
    const n = db.prepare('SELECT COUNT(*) AS n FROM bazi_records').get();
    console.log('bazi_records count:', n.n);
    const cacheN = db.prepare('SELECT COUNT(*) AS n FROM ai_cache').get().n;
    const sum = db.prepare('SELECT COALESCE(SUM(LENGTH(payload)),0) AS s FROM ai_cache').get().s;
    console.log('ai_cache count:', cacheN, 'total payload chars:', sum);
    const recs = db.prepare('SELECT id,name,ai_tasks,ai_analysis,ai_status FROM bazi_records').all();
    for (const r of recs) {
      let tasks = 0, chars = 0;
      if (r.ai_tasks) { try { const obj = JSON.parse(r.ai_tasks); const vals = Object.values(obj); tasks = vals.length; for (const v of vals) { const a = v && v.analysis; if (a) { chars += (a.explanation||'').length + (a.title||'').length + (a.pattern||'').length + (a.strength||'').length + ((a.usefulElements||[]).join('')).length + ((a.avoidElements||[]).join('')).length; } } } catch(e) {} }
      console.log('  record', r.id, r.name, 'status=' + r.ai_status, 'aiTasks=' + tasks, 'analysisChars~' + chars, 'aiAnalysisChars~' + ((r.ai_analysis||'').length));
    }
  } catch (e) { console.log('  inspect error', String(e).slice(0,200)); }
  db.close();
}