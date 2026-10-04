import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import './netGuard.mjs'; // import 即上闸：本文件任何用例都不许真连外部 AI 服务
import { openDatabase, insertRecord, writeCache, readCache, chartSigFromKey } from '../db.mjs';
import { cacheKey } from '../ai.mjs';
import { createApp } from '../app.mjs';
import http from 'node:http';

/* 「清掉这盘的 AI 缓存」这个按钮在网页版走的是 HTTP：
     PersonDetail → storageInfo.clearChartCache → serverClient.apiRecords.clearChartCache
       → POST /api/records/<id>/ai/cache-clear → app.mjs → db.clearChartCache
   客户端那条用例(server-client.test.ts)把 fetch 整个桩掉了，只证明「请求发出去了、URL 长这样」；
   服务器这边此前一次都没从这个入口进来过 —— 路由字符串写错一个字母(比如 ai/cache-clear 写成
   ai/clear-cache)，两端各自都「测试全绿」，用户点下去只是看到「清掉 0 条缓存」，
   旧结果原地不动，下次批断照旧命中旧缓存。这类缺陷没有报错，只能靠一条真的走 HTTP 的判据。 */

const CHART = { gender: 'male', birthYear: 1984, birthMonth: 2, yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午' };
const OTHER = { ...CHART, id: undefined, yearPillar: '乙丑' };

/** 给一盘预置两条缓存：本命 + 2026 流年。键一律用 ai.mjs 自己的 cacheKey 现算 ——
 *  在测试里手抄一份 'v15|…' 的话，提示词版本一升(v15→v16)夹具就悄悄写成过期键，
 *  清缓存照样「删到 2 条」全绿，真实请求却一条都命中不了。 */
const seedCache = (chart, model = 'deepseek-flash') => {
  const rec = { ...chart };
  const keys = [
    cacheKey(rec, { type: 'baseline' }, model, 80),
    cacheKey(rec, { type: 'annual', year: 2026 }, model, 80),
  ];
  for (const k of keys) {
    assert.ok(k.includes([chart.gender, chart.yearPillar, chart.monthPillar, chart.dayPillar, chart.hourPillar].join('|')),
      'cacheKey 的列序变了(第 2..6 段不再是性别+四柱)，本文件的判据要跟着改：' + k);
    assert.ok(chartSigFromKey(k), '夹具键形如不合规：' + k);
    writeCache(db, k, '{"正文":"预置缓存"}');
  }
  return keys;
};

let server; let base;
const db = openDatabase(':memory:');
const { handle } = createApp({ db, allowRegister: true });

await new Promise((resolve) => { server = http.createServer((req, res) => handle(req, res)); server.listen(0, '127.0.0.1', resolve); });
base = 'http://127.0.0.1:' + server.address().port;

async function api(method, route, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(base + '/api/' + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = null; try { data = await res.json(); } catch {}
  return { status: res.status, data };
}
/** 每次现注册一个账号(node --test 会跑多次，用户名不能写死)，并当场核对回执 ——
 *  「拿 undefined 当 token」会让后面全是 401，看着像权限判据坏了。 */
let seq = 0;
const owner = async () => {
  const reg = await api('POST', 'auth/register', { body: { username: '清盘人' + (++seq), password: 'pw123456' } });
  assert.equal(reg.status, 200, '注册失败，后面的用例都会拿 undefined 当 token：' + JSON.stringify(reg.data));
  return reg.data.token;
};

/** POST /records 之后当场核对回包里的列 —— 「id 我传了所以一定在」正是上一版踩的坑：
 *  建盘被 400 拒了也照样往下跑，报成 yearPillar undefined，看着像产品读不到数据。 */
async function newRecord(token, body) {
  const saved = await api('POST', 'records', { token, body });
  assert.equal(saved.status, 200, '建盘未被受理：' + JSON.stringify(saved.data));
  assert.ok(saved.data.record, '建盘回执里没有 record：' + JSON.stringify(saved.data));
  assert.ok(saved.data.record.yearPillar, '回包里读不回年柱：' + JSON.stringify(saved.data.record));
  return saved.data.record;
}

describe('按盘清缓存走真实 HTTP(app.mjs 路由 ↔ 客户端 URL)', () => {
  test('POST records/<id>/ai/cache-clear 命中路由，删掉的正是这一盘的缓存', async () => {
    const token = await owner();
    const saved = await api('POST', 'records', { token, body: { ...CHART, name: '甲', createdAt: '2025-01-01T00:00:00.000Z', aiStatus: 'not_started' } });
    assert.equal(saved.status, 200);
    const id = saved.data.record.id;
    const keys = seedCache(CHART);
    for (const k of keys) assert.ok(readCache(db, k), '夹具没落进库：' + k);

    const r = await api('POST', `records/${id}/ai/cache-clear`, { token, body: {} });
    // 这一条是整件事的核心：路由没匹配上时这里会是 404「unknown records action」。
    assert.equal(r.status, 200, '清缓存请求没被受理(路由不匹配？)：' + JSON.stringify(r.data));
    assert.equal(r.data.removed, 2, '说删了两条却返回别的数：回执与实删不符');
    for (const k of keys) assert.equal(readCache(db, k), null, '回执说清了，库里还留着：' + k);
  });

  test('只清这一盘：另一盘的缓存一条都不许动', async () => {
    const token = await owner();
    /* 两盘必须四柱不同(签名才不同)，但**不能撞主键** —— 服务器 POST /records 对已存在的 id
       是 INSERT OR REPLACE，第二条会把第一条整行盖掉。实测传 id:'c-other' 去建「别人的盘」，
       结果库里只剩一盘、清缓存删掉 4 条，判据看着像实现错了，其实是夹具造了个重复主键。 */
    const mine = await newRecord(token, { ...CHART, name: '甲', createdAt: '2025-01-01T00:00:00.000Z', aiStatus: 'completed' });
    const other = await newRecord(token, { ...OTHER, name: '乙', createdAt: '2025-01-01T00:00:00.000Z', aiStatus: 'completed' });
    assert.notEqual(mine.id, other.id, '两盘拿到同一个 id：后面全是假数据');
    assert.notEqual(mine.yearPillar, other.yearPillar, '两盘签名相同，这条判据什么也证明不了');
    const mineKeys = seedCache(CHART);
    const otherKeys = seedCache(other, 'qwen-turbo');
    const r = await api('POST', `records/${mine.id}/ai/cache-clear`, { token, body: {} });
    assert.equal(r.status, 200);
    assert.equal(r.data.removed, 2, '清掉的条数应只含本盘：' + r.data.removed);
    for (const k of mineKeys) assert.equal(readCache(db, k), null, '本盘没清干净：' + k);
    for (const k of otherKeys) assert.ok(readCache(db, k), '误删了另一盘的缓存：' + k);
  });

  test('记录不存在时如实 404；拼错动作名也是 404 —— 两者都别被当成「清了 0 条」的成功回执', async () => {
    const token = await owner();
    const rec = await newRecord(token, { ...CHART, name: '丙', createdAt: '2025-01-01T00:00:00.000Z', aiStatus: 'completed' });
    const keys = seedCache(rec, 'kimi-k2');
    // 路由漂移的真实形状：客户端把动作名写错 → 404，而不是 200 + removed:0。
    const typo = await api('POST', `records/${rec.id}/ai/clear-cache`, { token, body: {} });
    assert.equal(typo.status, 404, '拼错的动作名被受理了：' + JSON.stringify(typo.data));
    for (const k of keys) assert.ok(readCache(db, k), '404 的那一趟不该已经删了缓存');
    const ghost = await api('POST', 'records/r-bucuozai/ai/cache-clear', { token, body: {} });
    assert.equal(ghost.status, 404);
    for (const k of keys) assert.ok(readCache(db, k), '查无此盘却动了数据');
    // 真路径此时仍然通：证明上面两个 404 是路由/记录的问题，不是整个入口坏了。
    const ok = await api('POST', `records/${rec.id}/ai/cache-clear`, { token, body: {} });
    assert.equal(ok.status, 200, '正例走不通，那两个 404 就成了假绿：' + JSON.stringify(ok.data));
    assert.equal(ok.data.removed, 2);
  });

  test('chart_sig 为空的历史缓存行也要清得掉(索引删除之外的 LIKE 兜底)', async () => {
    /* ai_cache.chart_sig 是后加的一列(db.mjs 的 migrateChartSig 负责回填)。在「补列之后、
       回填之前」这个窗口里写进去的行，chart_sig 就是 NULL：clearChartCache 主路径按签名
       精确删，看不见它们；界面显示「清掉 N 条」、旧正文原地不动，下次批断照旧命中。
       那一步兜底只有塞进真 NULL 行才杀得掉 —— 上面三条用例全绿也证明不了它还在。 */
    const token = await owner();
    const rec = await newRecord(token, { ...CHART, name: '丁', createdAt: '2025-01-01T00:00:00.000Z', aiStatus: 'completed' });
    const sig = [rec.gender, rec.yearPillar, rec.monthPillar, rec.dayPillar, rec.hourPillar].join('|');
    const legacyKey = 'v9|deepseek-flash|' + sig + '|baseline|0|0|' + rec.birthYear + '|80';
    // 直接写成 NULL 签名，模拟迁移窗口里的存量行(writeCache 会自己派生，绕不过去)
    db.prepare('INSERT OR REPLACE INTO ai_cache (cache_key, chart_sig, payload, created_at) VALUES (?, NULL, ?, ?)')
      .run(legacyKey, '{"正文":"旧口径缓存"}', new Date().toISOString());
    assert.equal(db.prepare('SELECT chart_sig AS v FROM ai_cache WHERE cache_key=?').get(legacyKey).v, null,
      '夹具没造出 NULL 签名的行：这条判据会变成恒真');

    const r = await api('POST', `records/${rec.id}/ai/cache-clear`, { token, body: {} });
    assert.equal(r.status, 200);
    assert.equal(r.data.removed, 1, '回执说清了但那条旧行不在计数里：' + r.data.removed);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ai_cache WHERE cache_key=?').get(legacyKey).n, 0,
      'chart_sig 为 NULL 的历史缓存没被清掉：删掉 clearChartCache 里那段 LIKE 兜底就是这个形状');
  });
});

// 服务与库都由顶层开合：用例里各自 close 会让后面的 fetch 撞上 ECONNREFUSED，看着像产品缺陷。
after(() => { server.close(); try { db.close(); } catch {} });
