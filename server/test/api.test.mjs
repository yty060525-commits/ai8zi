import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { openDatabase } from '../db.mjs';
import { createApp } from '../app.mjs';

let server;
let base;
const db = openDatabase(':memory:');
const { handle } = createApp({ db, allowRegister: true });

before(async () => {
  server = http.createServer((req, res) => handle(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
});
after(() => { server.close(); try { db.close(); } catch {} });

async function api(method, route, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(base + '/api/' + route, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}
const recordBody = (over = {}) => ({
  name: '张三', gender: 'male', birthYear: 1990, birthMonth: 1,
  createdAt: '2025-01-01T00:00:00.000Z', yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午',
  nonAiResult: { solarDate: '1990-01-01', zodiac: '鼠', dayMaster: '庚', annualFortunes: [], monthlyFortunes: [], greatFortunes: [] },
  aiStatus: 'not_started', ...over,
});

describe('账号体系', () => {
  test('首个注册者为管理员，第二个为普通用户', async () => {
    const a = await api('POST', 'auth/register', { body: { username: '主人', password: 'secret123' } });
    assert.equal(a.status, 200);
    assert.equal(a.data.user.role, 'admin');
    const b = await api('POST', 'auth/register', { body: { username: '客户a', password: 'secret123' } });
    assert.equal(b.status, 200);
    assert.equal(b.data.user.role, 'user');
  });
  test('重复用户名被拒 / 密码错误登录被拒', async () => {
    const dup = await api('POST', 'auth/register', { body: { username: '主人', password: 'secret123' } });
    assert.equal(dup.status, 409);
    const bad = await api('POST', 'auth/login', { body: { username: '主人', password: 'wrong' } });
    assert.equal(bad.status, 401);
  });
  test('登录返回长期 token，me 可验证', async () => {
    const l = await api('POST', 'auth/login', { body: { username: '客户a', password: 'secret123' } });
    assert.equal(l.status, 200);
    const me = await api('GET', 'auth/me', { token: l.data.token });
    assert.equal(me.status, 200);
    assert.equal(me.data.user.username, '客户a');
    // 保存的 token(记忆设备) 后续仍有效
    const me2 = await api('GET', 'auth/me', { token: l.data.token });
    assert.equal(me2.status, 200);
  });
});

describe('记录隔离', () => {
  let adminT; let userT;
  before(async () => {
    adminT = (await api('POST', 'auth/login', { body: { username: '主人', password: 'secret123' } })).data.token;
    userT = (await api('POST', 'auth/login', { body: { username: '客户a', password: 'secret123' } })).data.token;
  });
  test('每个账号只能看到自己的八字', async () => {
    const c1 = await api('POST', 'records', { token: adminT, body: recordBody({ name: '管理员客户' }) });
    assert.equal(c1.status, 200);
    const c2 = await api('POST', 'records', { token: userT, body: recordBody({ name: '用户自己的客户' }) });
    assert.equal(c2.status, 200);
    const listUser = await api('GET', 'records', { token: userT });
    assert.equal(listUser.status, 200);
    assert.ok(listUser.data.records.every((r) => r.name === '用户自己的客户'));
    assert.equal(listUser.data.records.length, 1);
  });
  test('普通用户不能读取/删除他人记录', async () => {
    const all = await api('GET', 'records', { token: adminT });
    const adminRec = all.data.records.find((r) => r.name === '管理员客户');
    const read = await api('GET', 'records/' + adminRec.id, { token: userT });
    assert.equal(read.status, 403);
    const del = await api('DELETE', 'records/' + adminRec.id, { token: userT });
    assert.equal(del.status, 403);
  });
  test('管理员能看到全部八字', async () => {
    const all = await api('GET', 'admin/records', { token: adminT });
    assert.equal(all.status, 200);
    assert.equal(all.data.records.length, 2);
    assert.ok(all.data.records.some((r) => r.name === '用户自己的客户'));
    assert.ok(all.data.records.every((r) => r.username));
  });
  test('非管理员不能访问管理接口', async () => {
    const denied = await api('GET', 'admin/records', { token: userT });
    assert.equal(denied.status, 403);
  });
});

describe('AI 与配置', () => {
  test('未配置密钥时 ai/task 返回 not_configured(不发网络请求)', async () => {
    const adminT = (await api('POST', 'auth/login', { body: { username: '主人', password: 'secret123' } })).data.token;
    const list = await api('GET', 'records', { token: adminT });
    const rec = list.data.records[0];
    const r = await api('POST', 'records/' + rec.id + '/ai/task', { token: adminT, body: { task: { taskId: 'task-01', type: 'baseline' } } });
    assert.equal(r.status, 200);
    assert.equal(r.data.result.status, 'not_configured');
  });
  test('管理员可读取/保存 AI 配置', async () => {
    const adminT = (await api('POST', 'auth/login', { body: { username: '主人', password: 'secret123' } })).data.token;
    const cfg = await api('GET', 'admin/config', { token: adminT });
    assert.equal(cfg.status, 200);
    assert.ok(cfg.data.providers.length >= 2);
    const save = await api('POST', 'admin/config', { token: adminT, body: { provider: 'deepseek', key: 'sk-test-not-real' } });
    assert.equal(save.status, 200);
  });
});

describe('记录更新', () => {
  test('PUT 更新保留 owner 并落库', async () => {
    const userT = (await api('POST', 'auth/login', { body: { username: '客户a', password: 'secret123' } })).data.token;
    const list = await api('GET', 'records', { token: userT });
    const rec = list.data.records[0];
    const upd = await api('PUT', 'records/' + rec.id, { token: userT, body: { ...rec, name: '改名客户', aiStatus: 'completed' } });
    assert.equal(upd.status, 200);
    assert.equal(upd.data.record.name, '改名客户');
    const again = await api('GET', 'records', { token: userT });
    assert.equal(again.data.records[0].aiStatus, 'completed');
  });
});

describe('通道首选(客户端“当前使用”)', () => {
  test('带 provider 的 ai/task 请求会被正常受理(不会因未知通道 500)', async () => {
    const reg = await api('POST', 'auth/register', { body: { username: 'qwen-admin', password: 'pw123456' } });
    const token = reg.data.token;
    const saved = await api('POST', 'records', { token, body: recordBody({ id: 'rq1' }) });
    const id = saved.data.record.id;
    // 共享内存库里前面的用例可能已写入密钥，所以只断言被正常受理且返回合法状态
    const r = await api('POST', 'records/' + id + '/ai/task', { token, body: { task: { type: 'baseline' }, tone: 80, provider: 'qwen' } });
    assert.equal(r.status, 200);
    assert.ok(['completed', 'failed', 'not_configured'].includes(r.data.result.status));
  });


  test('providerOrder 优先使用传入的 preferred 通道', async () => {
    const { providerOrder, saveProviderKey } = await import('../ai.mjs');
    const d = openDatabase(':memory:');
    saveProviderKey(d, 'deepseek', 'k1');
    saveProviderKey(d, 'kimi', 'k2');
    saveProviderKey(d, 'qwen', 'k3');
    assert.equal(providerOrder(d, 'qwen')[0].id, 'qwen');
    assert.equal(providerOrder(d, 'kimi')[0].id, 'kimi');
    // preferred 通道未配置密钥时，自动跳过并回退到已配置的通道
    const d2 = openDatabase(':memory:');
    saveProviderKey(d2, 'deepseek', 'k1');
    const order = providerOrder(d2, 'qwen');
    assert.equal(order.length, 1);
    assert.equal(order[0].id, 'deepseek');
    d.close(); d2.close();
  });
});

describe('提示词结构(前缀缓存与年龄字段)', () => {
  const rec = {
    gender: 'male', birthYear: 1984, birthMonth: 2, yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午',
    nonAiResult: { solarDate: '1984-02-06', dayMaster: '庚', greatFortunes: [{ ganZhi: '丁卯', startYear: 2020, endYear: 2029 }], annualFortunes: [{ year: 2026, ganZhi: '丙午' }], monthlyFortunes: [] },
  };
  const anchor = { summary: '格局：正印格 · 强弱：身强　喜：火、土　忌：水、木' };

  test('时段任务把“当前分析目标”放在最末，共同前缀在前(利于前缀缓存命中)', async () => {
    const { buildTaskPayload } = await import('../ai.mjs');
    for (const task of [{ type: 'annual', year: 2026, baseline: anchor }, { type: 'monthly', year: 2026, month: 3, baseline: anchor }, { type: 'decade', year: 2020, baseline: anchor }]) {
      const c = buildTaskPayload(rec, task, 80).messages[1].content;
      assert.ok(c.includes('# 当前分析目标'), task.type + ' 缺少分析目标段');
      assert.ok(c.lastIndexOf('# 当前分析目标') > c.lastIndexOf('# 本时段数据'), task.type + ' 目标应在时段数据之后(变化后置)');
      assert.ok(c.indexOf('# 本命事实数据') < c.indexOf('# 本时段数据'), task.type + ' 本命事实应先于可变部分');
    }
  });

  test('大运不再带年龄，流年流月仍带', async () => {
    const { buildTaskPayload } = await import('../ai.mjs');
    const dec = buildTaskPayload(rec, { type: 'decade', year: 2020, baseline: anchor }, 80).messages[1].content;
    assert.equal(dec.includes('年龄约'), false);
    const ann = buildTaskPayload(rec, { type: 'annual', year: 2026, baseline: anchor }, 80).messages[1].content;
    assert.equal(ann.includes('年龄约'), true);
  });

  test('记录已瘦身时，流年/流月/大运仍从任务内联行拿到本柱数据', async () => {
    const { buildTaskPayload } = await import('../ai.mjs');
    // 与真实存储一致：三个数组都被 prune 清空
    const slim = { ...rec, nonAiResult: { solarDate: '1984-02-06', dayMaster: '庚', greatFortunes: [], annualFortunes: [], monthlyFortunes: [] } };
    const cases = [
      ['annual', { type: 'annual', year: 2026, baseline: anchor, annual: { year: 2026, ganZhi: '丙午', relationshipDetails: [] } }, '丙午'],
      ['monthly', { type: 'monthly', year: 2026, month: 3, baseline: anchor, monthly: { year: 2026, month: 3, ganZhi: '庚辰', relationshipDetails: [] } }, '庚辰'],
      ['decade', { type: 'decade', year: 2020, baseline: anchor, decade: { ganZhi: '丁卯', startYear: 2020, endYear: 2029, relationshipDetails: [] } }, '丁卯'],
    ];
    for (const [type, task, needle] of cases) {
      const c = buildTaskPayload(slim, task, 80).messages[1].content;
      assert.ok(c.includes(needle), type + ' 丢失了本柱干支数据(内联行未被采用)');
    }
  });
});

describe('全盘总结任务(服务器通道)', () => {
  const rec2 = { gender: 'male', birthYear: 1984, yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午',
    nonAiResult: { solarDate: '1984-02-06', dayMaster: '庚', greatFortunes: [], annualFortunes: [], monthlyFortunes: [] } };
  const findings = { horizon: { from: 2026, to: 2035 }, baselineSummary: '', decades: [{ key: 'task-24', heading: '丁卯 大运段(2020-2029)', text: '【健康】1. 注意心血管。' }], annuals: [{ key: 'task-03', heading: '2027年(丙午)', text: '【事业】1. 官星得力，有升迁机会。' }], monthlies: [{ key: 'task-14', heading: '2027年3月(辛卯)', text: '【财运】1. 六冲，忌大额投资。' }] };
  const anchor = { summary: '格局：正印格 · 强弱：身强　喜：火、土　忌：水、木' };

  test('要点与三段要求齐备，且变化部分后置', async () => {
    const { buildTaskPayload } = await import('../ai.mjs');
    const p = buildTaskPayload(rec2, { type: 'overview', baseline: anchor, findings }, 80);
    const c = p.messages[1].content;
    for (const needle of ['全盘总结', '本命结论', '正印格', '各时段分析要点', '官星得力', '注意心血管', '忌大额投资', '核心结论', '值得关注的时间节点', '行动建议']) {
      assert.ok(c.includes(needle), '总结提示词缺少 ' + needle);
    }
    assert.ok(c.indexOf('# 各时段分析要点') > c.indexOf('# 本命事实数据'), '要点应在本命事实之后');
    assert.ok(c.lastIndexOf('# 当前分析目标') > c.indexOf('# 各时段分析要点'), '目标应排在最后(变化后置)');
    assert.equal(p.effort, 'high'); // 判断类任务用高思考力度
  });

  test('缓存键区分总结任务，不会与本命任务串味', async () => {
    const { cacheKey } = await import('../ai.mjs');
    const kOverview = cacheKey(rec2, { type: 'overview' }, 'deepseek-flash', 80);
    const kBaseline = cacheKey(rec2, { type: 'baseline' }, 'deepseek-flash', 80);
    assert.notEqual(kOverview, kBaseline);
    assert.ok(kOverview.includes('overview'));
  });
});
