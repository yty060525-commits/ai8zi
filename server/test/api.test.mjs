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
