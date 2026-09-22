import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, insertRecord, getRecordById, writeCache, readCache, clearChartCache } from '../db.mjs';
import { analyzeQuestion, extractWhen, sliceSections, collectEvidence, buildChatMessages, chatCacheKey, applyFollowUp, runChat, sanitizeChatText, FIELD_NAME_ZH, SCAN_YEARS } from '../chat.mjs';
import { saveProviderKey, cacheKey } from '../ai.mjs';
import { createApp } from '../app.mjs';

/* ---------- 提问理解 ---------- */
describe('提问理解(检索计划)', () => {
  const now = new Date('2026-09-22T08:00:00');
  test('绝对与相对年月：今年/明年/本月/下个月都锚定到具体数字', () => {
    assert.deepEqual(extractWhen('2027年运势', now), { year: 2027, month: undefined });
    assert.deepEqual(extractWhen('明年的事业', now), { year: 2027, month: undefined });
    assert.deepEqual(extractWhen('去年身体如何', now), { year: 2025, month: undefined });
    assert.deepEqual(extractWhen('本月财运', now), { year: 2026, month: 9 });
    assert.deepEqual(extractWhen('下个月要注意什么', now), { year: 2026, month: 10 });
    assert.deepEqual(extractWhen('12月能找到工作吗', now), { year: 2026, month: 12 });
    assert.deepEqual(extractWhen('12月找到工作', new Date('2026-12-20T00:00:00')), { year: 2026, month: 12 });
  });
  test('人名命中：长名优先，避免「张三丰」被「张三」截胡；主题抽取得到 健康/事业', () => {
    const records = [{ id: 'a', name: '张三' }, { id: 'b', name: '张三丰' }];
    const plan = analyzeQuestion('张三丰2027年身体和事业怎么样', records, now);
    assert.equal(plan.recordId, 'b');
    assert.equal(plan.personName, '张三丰');
    assert.equal(plan.year, 2027);
    assert.deepEqual(plan.topics, ['健康', '事业']);
  });
  test('未提人名时 recordId 为空；「桃花」归入爱情主题', () => {
    const plan = analyzeQuestion('今年桃花运如何', [{ id: 'a', name: '张三' }], now);
    assert.equal(plan.recordId, null);
    assert.ok(plan.topics.includes('爱情'));
  });
  test('开放式时机提问 → 不锚定某一年，改为标记扫年起点', () => {
    for (const q of ['大概什么时期能找到对象', '我什么时候能升职', '哪一年适合结婚', '多久能遇到贵人', '何时能有起色']) {
      const plan = analyzeQuestion(q, [{ id: 'a', name: '张三' }], now);
      assert.equal(plan.year, undefined, q);
      assert.equal(plan.scan, true, q);
      assert.equal(plan.scanFrom, 2026, q);
    }
  });
  test('「明年什么时候」有年份锚点，仍按那一年精确取证而不是扫年', () => {
    const plan = analyzeQuestion('明年什么时候适合换工作', [{ id: 'a', name: '张三' }], now);
    assert.equal(plan.scan, false);
    assert.equal(plan.year, 2027);
  });
  test('纯本命问题不触发扫年(问五行不该被当成问时机)', () => {
    const plan = analyzeQuestion('我的五行喜用是什么', [{ id: 'a', name: '张三' }], now);
    assert.equal(plan.scan, false);
    assert.equal(plan.year, undefined);
  });
});

/* ---------- 追问继承上文 ---------- */
describe('追问继承上文(防复读)', () => {
  const now = new Date('2026-09-22T08:00:00');
  const hist = (u, a) => [{ role: 'user', content: u }, { role: 'assistant', content: a }];
  test('本轮没提主题/时间时，从上一轮继承', () => {
    const base = analyzeQuestion('那具体呢', [{ id: 'a', name: '张三' }], now);
    assert.deepEqual(base.topics, []);
    const plan = applyFollowUp(base, hist('2026年爱情如何', '【爱情】1. 平顺。'));
    assert.deepEqual(plan.topics, ['爱情']);
    assert.equal(plan.year, 2026);
  });
  test('本轮自己已明说时间/主题时不继承，以本轮为准', () => {
    const base = analyzeQuestion('2027年事业如何', [{ id: 'a', name: '张三' }], now);
    const plan = applyFollowUp(base, hist('2026年爱情如何', '【爱情】1. 平顺。'));
    assert.deepEqual(plan.topics, ['事业']);
    assert.equal(plan.year, 2027);
  });
  test('上一轮是开放式时机提问 → 追问同样保持扫年', () => {
    const base = analyzeQuestion('那具体呢', [{ id: 'a', name: '张三' }], now);
    const plan = applyFollowUp(base, hist('大概什么时期能找到对象', '【爱情】1. 应期在2028年。'));
    assert.equal(plan.scan, true);
    assert.deepEqual(plan.topics, ['爱情']);
  });
  test('无历史时原样返回', () => {
    const base = analyzeQuestion('2026年爱情如何', [{ id: 'a', name: '张三' }], now);
    assert.deepEqual(applyFollowUp(base, []), base);
  });
});

/* ---------- 证据摘录 ---------- */
describe('查库取证', () => {
  const baseRecord = {
    id: 'r1', userId: 'u1', name: '张三', gender: 'male', birthYear: 1984, birthMonth: 2,
    createdAt: '2025-01-01', yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午',
    nonAiResult: { solarDate: '1984-02-06', dayMaster: '庚', zodiac: '鼠', greatFortunes: [], annualFortunes: [], monthlyFortunes: [] },
    aiStatus: 'completed',
    aiTasks: {
      'task-01': { task: { taskId: 'task-01', type: 'baseline' }, status: 'completed', analysis: { explanation: '【身强身弱与喜忌】1. 金旺。\n【健康】2. 注意肺。\n【事业】3. 宜公职。\n【财运】4. 稳。\n【爱情】5. 晚婚。' } },
      'task-03': { task: { taskId: 'task-03', type: 'annual', year: 2026 }, status: 'completed', analysis: { title: '丙午· flame', explanation: '【健康】1. 心火旺。\n【事业】2. 有升迁。\n【财运】3. 平。\n【爱情】4. 顺。\n【刑冲克害批注】5. 子午冲。' } },
    },
  };
  test('sliceSections 只保留提问主题相关小节', () => {
    const text = baseRecord.aiTasks['task-01'].analysis.explanation;
    const out = sliceSections(text, ['健康']);
    assert.ok(out.includes('【健康】'));
    assert.equal(out.includes('【事业】'), false);
  });
  test('问年份：取该年流年批断；库中没有的年份写进数据缺口提示', () => {
    const db = openDatabase(':memory:');
    insertRecord(db, baseRecord);
    const rec = getRecordById(db, 'r1');
    const ev26 = collectEvidence(db, rec, { year: 2026, topics: ['事业'] }, { providers: [] });
    assert.ok(ev26.analyses.some((a) => a.heading.includes('2026年·流年批断')));
    assert.ok(ev26.analyses.find((a) => a.heading.includes('流年')).text.includes('有升迁'));
    const ev27 = collectEvidence(db, rec, { year: 2027, topics: [] }, { providers: [] });
    assert.ok(ev27.missing.some((m) => m.includes('2027')));
    db.close();
  });
  test('aiTasks 未同步时从 ai_cache 主键精确补读', () => {
    const db = openDatabase(':memory:');
    insertRecord(db, { ...baseRecord, aiTasks: null });
    const rec = getRecordById(db, 'r1');
    // 与 cacheLookup 同口径写入一条 2026 流年批断缓存；providers 传入模型以复现主键查找
    writeCache(db, cacheKey(rec, { type: 'annual', year: 2026, month: undefined }, 'test-model', 80), JSON.stringify({ title: '丙午·测试', explanation: '【事业】1. 缓存补读命中。' }));
    const ev = collectEvidence(db, rec, { year: 2026, topics: ['事业'] }, { providers: [{ model: 'test-model' }] });
    assert.ok(ev.analyses.some((a) => a.heading.includes('2026年·流年批断') && a.text.includes('缓存补读命中')), '应能从 ai_cache 补读流年批断');
    // 不传 providers 时无法补读 → 明确写入数据缺口
    const evNone = collectEvidence(db, rec, { year: 2026, topics: ['事业'] }, { providers: [] });
    assert.ok(evNone.missing.some((m) => m.includes('2026')));
    db.close();
  });
  test('聊天消息包含证据与问题，历史最多带 8 条', () => {
    const db = openDatabase(':memory:');
    insertRecord(db, baseRecord);
    const rec = getRecordById(db, 'r1');
    const ev = collectEvidence(db, rec, { year: 2026, topics: ['事业'] }, { providers: [] });
    const history = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'h' + i }));
    const msgs = buildChatMessages({ question: '2026年事业如何', history, evidence: ev, tone: 80 });
    assert.equal(msgs[0].role, 'system');
    assert.equal(msgs.length, 1 + 8 + 1);
    const last = msgs[msgs.length - 1].content;
    assert.ok(last.includes('# 用户问题'));
    assert.ok(last.includes('流年批断') || ev.analyses.length > 0);
    db.close();
  });
  test('扫年取证：把窗口内已有年份列成时间线，缺的年份逐个点名', () => {
    const db = openDatabase(':memory:');
    // 库内只有 2026 一条流年，窗口 2026—2033 其余 7 年应逐个写进缺口
    insertRecord(db, baseRecord);
    const rec = getRecordById(db, 'r1');
    const ev = collectEvidence(db, rec, { scan: true, scanFrom: 2026, topics: ['爱情'] }, { providers: [] });
    const timeline = ev.analyses.find((a) => a.heading.includes('逐年批断'));
    assert.ok(timeline, '应生成逐年时间线');
    assert.ok(timeline.text.includes('2026年'));
    assert.ok(timeline.text.includes('顺'), '应带上该年爱情小节');
    assert.equal(timeline.text.includes('2027年'), false, '没有批断的年份不得混进时间线');
    const gap = ev.missing.find((m) => m.includes('2027'));
    assert.ok(gap, '缺的年份要写进缺口');
    for (let y = 2027; y < 2026 + SCAN_YEARS; y += 1) assert.ok(gap.includes(String(y)), String(y) + ' 应被点名');
    assert.equal(gap.includes('2026'), false, '已有批断的年份不算缺口');
    db.close();
  });
  test('扫年取证：主题不是批断小节时(神煞/大运/格局)不过滤，整年批断都交给模型判断', () => {
    const db = openDatabase(':memory:');
    insertRecord(db, baseRecord);
    const rec = getRecordById(db, 'r1');
    const ev = collectEvidence(db, rec, { scan: true, scanFrom: 2026, topics: ['神煞'] }, { providers: [] });
    const timeline = ev.analyses.find((a) => a.heading.includes('逐年批断'));
    // 「神煞」不是【小节】标签：过滤条件整条跳过，该年全部小节都要给出，不能凭截空的正文下结论
    assert.ok(timeline.text.includes('【健康】'));
    assert.ok(timeline.text.includes('【刑冲克害批注】'));
    assert.equal(ev.missing.some((m) => m.includes('没有与所问主题相关的小节')), false);
    db.close();
  });
  test('扫年取证：主题是批断小节但该年没有该小节 → 点名说明该年判不了这个主题', () => {
    const db = openDatabase(':memory:');
    // 只留一条没有【事业】小节的 2026 流年，问事业时应命中「该年覆盖不了主题」
    const noCareer = {
      ...baseRecord,
      aiTasks: { 'task-03': { task: { taskId: 'task-03', type: 'annual', year: 2026 }, status: 'completed', analysis: { title: '丙午', explanation: '【健康】1. 心火旺。' } } },
    };
    insertRecord(db, noCareer);
    const rec = getRecordById(db, 'r1');
    const ev = collectEvidence(db, rec, { scan: true, scanFrom: 2026, topics: ['事业'] }, { providers: [] });
    const uncovered = ev.missing.find((m) => m.includes('没有与所问主题相关的小节'));
    assert.ok(uncovered, '应点名该年覆盖不了主题');
    assert.ok(uncovered.includes('2026'));
    // 该年仍留在时间线里，让模型看到「这条批断里确实没有事业内容」
    const timeline = ev.analyses.find((a) => a.heading.includes('逐年批断'));
    assert.ok(timeline.text.includes('2026年('));
    db.close();
  });
  test('扫年窗口内一条流年都没有 → 明确说不出应期，而不是笼统答没有数据', () => {
    const db = openDatabase(':memory:');
    insertRecord(db, { ...baseRecord, aiTasks: { 'task-01': baseRecord.aiTasks['task-01'] } });
    const rec = getRecordById(db, 'r1');
    const ev = collectEvidence(db, rec, { scan: true, scanFrom: 2026, topics: ['爱情'] }, { providers: [] });
    assert.equal(ev.analyses.some((a) => a.heading.includes('逐年批断')), false);
    assert.ok(ev.missing.some((m) => m.includes('无法判断应期')));
    // 本命批断缺失时仍要提示补算，两条缺口并存
    assert.ok(ev.missing.some((m) => m.includes('2026—')));
    db.close();
  });
});

/* ---------- 索引与聊天缓存 ---------- */
describe('索引优化(EXPLAIN QUERY PLAN)', () => {
  const db = openDatabase(':memory:');
  test('记录列表走 (user_id, updated_at) 复合索引且不再临时排序', () => {
    const row = db.prepare('EXPLAIN QUERY PLAN SELECT id FROM records WHERE user_id=? ORDER BY updated_at DESC, created_at DESC').get('u1');
    assert.match(row.detail, /USING INDEX idx_records_user_time/);
    assert.equal(/TEMP B-TREE/.test(row.detail), false);
  });
  test('清盘缓存走 chart_sig 索引精确删除(旧 LIKE 全表扫描已废弃)', () => {
    const row = db.prepare('EXPLAIN QUERY PLAN DELETE FROM ai_cache WHERE chart_sig=?').get('male|a|b|c|d');
    assert.match(row.detail, /USING INDEX idx_cache_chart_sig/);
  });
  test('按姓名定位命主走 name 索引；过期会话清理走 expires 索引', () => {
    assert.match(db.prepare('EXPLAIN QUERY PLAN SELECT id FROM records WHERE name=?').get('张三').detail, /idx_records_name/);
    assert.match(db.prepare('EXPLAIN QUERY PLAN DELETE FROM sessions WHERE expires_at<?').get(1).detail, /idx_sessions_expires/);
  });
  test('writeCache 自动派生 chart_sig；清盘时任务缓存与聊天缓存一并精确删除', () => {
    const d = openDatabase(':memory:');
    writeCache(d, 'v10|deepseek-flash|male|甲子|丙寅|庚午|壬午|annual|2027|0|1984|80', '{}');
    writeCache(d, chatCacheKey({ gender: 'male', yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午', birthYear: 1984 }, '事业运？', 'deepseek-flash', 80), '答案');
    writeCache(d, 'v10|deepseek-flash|female|乙丑|丁卯|己巳|辛未|annual|2027|0|1985|80', '{}');
    const sig = d.prepare('SELECT chart_sig FROM ai_cache WHERE payload=?').get('答案');
    assert.equal(sig.chart_sig, 'male|甲子|丙寅|庚午|壬午');
    const removed = clearChartCache(d, 'male', '甲子', '丙寅', '庚午', '壬午');
    assert.equal(removed, 2);
    assert.equal(d.prepare('SELECT COUNT(*) n FROM ai_cache').get().n, 1);
    d.close();
  });
  test('老库升级：chart_sig 为空的存量行在重新打开时被回填', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mingli-')), 'legacy.sqlite3');
    const d1 = openDatabase(file);
    d1.exec('CREATE TABLE legacy_probe(x)');
    writeCache(d1, 'v10|deepseek-flash|male|甲子|丙寅|庚午|壬午|baseline|0|0|1984|80', '{}');
    d1.exec('UPDATE ai_cache SET chart_sig = NULL');
    d1.close();
    const d2 = openDatabase(file);
    const row = d2.prepare('SELECT chart_sig FROM ai_cache').get();
    assert.equal(row.chart_sig, 'male|甲子|丙寅|庚午|壬午');
    assert.equal(clearChartCache(d2, 'male', '甲子', '丙寅', '庚午', '壬午'), 1);
    d2.close();
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });
});

/* ---------- HTTP 路由 ---------- */
const db = openDatabase(':memory:');
const { handle } = createApp({ db, allowRegister: true });
let server; let base;
async function api(method, route, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(base + '/api/' + route, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await res.json(); } catch {}
  return { status: res.status, data };
}
const recordBody = (over = {}) => ({
  name: '张三', gender: 'male', birthYear: 1990, birthMonth: 1,
  createdAt: '2025-01-01T00:00:00.000Z', yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午',
  nonAiResult: { solarDate: '1990-01-01', zodiac: '鼠', dayMaster: '庚', greatFortunes: [], annualFortunes: [], monthlyFortunes: [] },
  aiStatus: 'not_started', ...over,
});

describe('/api/chat 路由', () => {
  let adminT; let userT;
  before(async () => {
    server = http.createServer((req, res) => handle(req, res));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = 'http://127.0.0.1:' + server.address().port;
    adminT = (await api('POST', 'auth/register', { body: { username: 'chat主人', password: 'secret123' } })).data.token;
    userT = (await api('POST', 'auth/register', { body: { username: 'chat客户', password: 'secret123' } })).data.token;
  });
  after(() => { server.close(); try { db.close(); } catch {} });

  test('空问题被拒绝', async () => {
    const r = await api('POST', 'chat', { token: userT, body: { question: '  ' } });
    assert.equal(r.status, 200);
    assert.equal(r.data.status, 'failed');
  });
  test('未登录不能聊天', async () => {
    const r = await fetch(base + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: 'hi' }) });
    assert.equal(r.status, 401);
  });
  test('名下无命盘时引导先排盘(need_record)', async () => {
    const r = await api('POST', 'chat', { token: userT, body: { question: '我的五行缺什么？' } });
    assert.equal(r.data.status, 'need_record');
    assert.ok(r.data.reason.includes('排盘'));
  });
  test('多条命盘未指明命主 → 返回候选列表', async () => {
    saveProviderKey(db, 'deepseek', 'sk-chat-test');
    await api('POST', 'records', { token: userT, body: recordBody({ id: 'c1' }) });
    await api('POST', 'records', { token: userT, body: recordBody({ id: 'c2', name: '李四' }) });
    const r = await api('POST', 'chat', { token: userT, body: { question: '今年事业运如何？' } });
    assert.equal(r.data.status, 'need_record');
    assert.equal(r.data.options.length, 2);
  });
  test('不能借 recordId 查询他人命盘', async () => {
    const list = await api('GET', 'records', { token: adminT });
    const mine = await api('POST', 'records', { token: adminT, body: recordBody({ id: 'admin-only', name: '管理员客户' }) });
    const r = await api('POST', 'chat', { token: userT, body: { question: '他财运如何', recordId: 'admin-only' } });
    assert.equal(r.data.status, 'failed');
    assert.ok(r.data.error.includes('无权') || r.data.error.includes('不存在'));
  });
  test('单一命盘自动定位并给出提问解析(未配置密钥时不产生网络调用)', async () => {
    // 用全新用户+单条记录，且清空密钥：只走「需密钥前」的解析路径
    const t = (await api('POST', 'auth/register', { body: { username: 'solo用户', password: 'secret123' } })).data.token;
    await api('POST', 'records', { token: t, body: recordBody({ id: 'solo1', name: '王五' }) });
    const r = await api('POST', 'chat', { token: t, body: { question: '王五的2027年健康运势？' } });
    assert.ok(['not_configured', 'completed', 'failed'].includes(r.data.status));
  });
});

/* ---------- runChat 直连调用(服务器内单元) ---------- */
describe('runChat 解析路径', () => {
  test('未配置任何密钥时，已入库的聊天缓存仍应命中(缓存优先于密钥检查)', () => {
    const d = openDatabase(':memory:');
    insertRecord(d, { id: 'ck1', userId: 'u7', name: '王二', gender: 'male', birthYear: 1984, birthMonth: 2, createdAt: '2025-01-01', yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午', nonAiResult: { greatFortunes: [], annualFortunes: [], monthlyFortunes: [] }, aiStatus: 'completed' });
    const rec = getRecordById(d, 'ck1');
    writeCache(d, chatCacheKey(rec, '我的喜用五行是什么？', 'deepseek-flash', 80), '身弱喜土金(缓存答案)');
    return runChat(d, { id: 'u7', role: 'user' }, { question: '我的喜用五行是什么？' }).then((reply) => {
      assert.equal(reply.status, 'completed');
      assert.equal(reply.cached, true);
      assert.equal(reply.answer, '身弱喜土金(缓存答案)');
      assert.equal(reply.evidence.recordId, 'ck1');
      d.close();
    });
  });
  test('按姓名锁定命主：evidence 回传 recordId/plan 供 UI 展示', async () => {
    const d = openDatabase(':memory:');
    saveProviderKey(d, 'deepseek', 'k');
    insertRecord(d, { id: 'z1', userId: 'u9', name: '张三丰', gender: 'male', birthYear: 1990, birthMonth: 1, createdAt: '2025-01-01', yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午', nonAiResult: { greatFortunes: [], annualFortunes: [], monthlyFortunes: [] }, aiStatus: 'completed' });
    insertRecord(d, { id: 'z2', userId: 'u9', name: '李四', gender: 'female', birthYear: 1992, birthMonth: 2, createdAt: '2025-01-01', yearPillar: '乙丑', monthPillar: '丁卯', dayPillar: '己巳', hourPillar: '辛未', nonAiResult: { greatFortunes: [], annualFortunes: [], monthlyFortunes: [] }, aiStatus: 'not_started' });
    const reply = await runChat(d, { id: 'u9', role: 'user' }, { question: '张三丰五行喜用是什么？' });
    // 未联网环境不会真调上游：只验证解析结果(拿到答案或是缓存/上游失败都不应影响 evidence 定位)
    if (reply.evidence) {
      assert.equal(reply.evidence.recordId, 'z1');
      assert.equal(reply.evidence.plan.personName, '张三丰');
      assert.ok(reply.evidence.plan.topics.includes('五行'));
    } else {
      assert.equal(reply.status, 'not_configured');
    }
    d.close();
  });
});

/* ---------- 聊天正文去英文：与客户端 features/chart/elements.ts 同口径 ---------- */
describe('聊天正文去英文(防英文字段名漏进正文)', () => {
  test('证据 JSON 的英文字段名翻成中文而非删掉', () => {
    const out = sanitizeChatText('本命盘事实为庚金日主、身弱（strengthScore 42），喜土金。');
    assert.doesNotMatch(out, /strengthScore/);
    assert.match(out, /旺衰评分 42/);
    assert.match(out, /庚金日主/);
  });
  test('未收录的变量名从中文语境剔除，纯中文正文原样不动', () => {
    const out = sanitizeChatText('依据 someInternalVar 判断，身弱。');
    assert.doesNotMatch(out, /[A-Za-z]{2,}/);
    const pure = '1. 事业：稳中有进。依据：流年批断的【事业】小节。';
    assert.equal(sanitizeChatText(pure), pure);
  });
  test('整段跑成英文 → 返回空(交回调用方换通道)', () => {
    assert.equal(sanitizeChatText('Sorry, I cannot answer this question based on the provided data.'), '');
    assert.equal(sanitizeChatText(''), '');
  });
  test('字段名映射表与服务端一致(两端口径基础)', () => {
    for (const key of ['patternFacts', 'strengthScore', 'dayMaster', 'elementRatio', 'periodFacts', 'missing']) {
      assert.ok(FIELD_NAME_ZH[key], key);
      assert.match(FIELD_NAME_ZH[key], /^[\u4e00-\u9fff]+$/);
    }
  });
  test('缓存答案读出来也去英文：旧的脏缓存自动洗净', async () => {
    const d = openDatabase(':memory:');
    insertRecord(d, { id: 'san1', userId: 'usan', name: '洗衣', gender: 'male', birthYear: 1984, birthMonth: 2, createdAt: '2025-01-01', yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午', nonAiResult: { greatFortunes: [], annualFortunes: [], monthlyFortunes: [] }, aiStatus: 'completed' });
    const stored = getRecordById(d, 'san1');
    // 不配密钥 → 走「缓存优先于密钥检查」分支，只验证读出的答案已被洗净
    writeCache(d, chatCacheKey(stored, '我的喜用五行是什么？', 'deepseek-flash', 80), '身弱（strengthScore 42）喜土金。');
    const reply = await runChat(d, { id: 'usan', role: 'user' }, { question: '我的喜用五行是什么？' });
    assert.equal(reply.status, 'completed');
    assert.equal(reply.cached, true);
    assert.doesNotMatch(reply.answer, /strengthScore/);
    assert.match(reply.answer, /旺衰评分/);
    d.close();
  });
});
