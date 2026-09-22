import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('C:/Users/yty06/Desktop/命理客户端/data/bazi_records.sqlite3', { readOnly: true });
const rec = db.prepare('SELECT id,name,gender,birth_year,birth_month,created_at,year_pillar,month_pillar,day_pillar,hour_pillar,non_ai_result,ai_tasks FROM bazi_records WHERE ai_status=?').get('completed');
const nonAi = JSON.parse(rec.non_ai_result || '{}');
const { buildTaskPayload } = await import('../server/ai.mjs');
const tasks = Object.values(JSON.parse(rec.ai_tasks || '{}')).map(t => t.task);
// 构造记录对象(与 DB 字段对应)
const record = { id: rec.id, gender: rec.gender, birthYear: rec.birth_year, birthMonth: rec.birth_month, yearPillar: rec.year_pillar, monthPillar: rec.month_pillar, dayPillar: rec.day_pillar, hourPillar: rec.hour_pillar, nonAiResult: nonAi };
const counts = [];
for (const task of tasks) {
  const { messages } = buildTaskPayload(record, task, 80);
  const user = messages[1]?.content || '';
  const cjk = (user.match(/[\u4e00-\u9fff]/g) || []).length;
  const ascii = (user.match(/[A-Za-z0-9{}[\]\".,:;+-]/g) || []).length;
  counts.push({ type: task.type, y: task.year ?? '', m: task.month ?? '', chars: user.length, cjk, ascii });
}
let totCJK = 0, totAscii = 0, totChars = 0;
for (const c of counts) { totCJK += c.cjk; totAscii += c.ascii; totChars += c.chars; }
console.log('任务数:', counts.length);
console.log('输入提示词合计: 字符', totChars, '中文', totCJK, 'ASCII', totAscii);
console.log('按 中文≈0.7token/字 + ASCII/4 估算输入 tokens ≈', Math.round(totCJK * 0.7 + totAscii / 4));
// 输出：从该记录 aiTasks 正文字符统计
let outCJK = 0; const outs = [];
for (const t of tasks) { const entry = JSON.parse(rec.ai_tasks)[Object.keys(JSON.parse(rec.ai_tasks)).find(k => JSON.parse(rec.ai_tasks)[k].task.taskId === t.taskId)]; const a = entry.analysis; if (a) { const text = (a.explanation||'')+(a.title||'')+(a.pattern||'')+(a.strength||''); const cjk = (text.match(/[\u4e00-\u9fff]/g)||[]).length; outCJK += cjk; outs.push(cjk); } }
console.log('输出正文中文合计:', outCJK, '→ 估算输出 tokens ≈', Math.round(outCJK * 0.7));
console.log('按任务输出(中文/任务):', outs.map(o=>Math.round(o)).join(', '));
db.close();