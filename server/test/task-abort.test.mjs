import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import './netGuard.mjs'; // 上闸：本文件一律走假通道调用，绝不该真连 AI
import http from 'node:http';
import { openDatabase, insertRecord, getRecordById, readCache } from '../db.mjs';
import { cacheKey, saveProviderKey, DEFAULT_TONE } from '../ai.mjs';
import { createApp } from '../app.mjs';

/* 缺陷 #140：批断任务路径上的中止传播整段缺失 —— 与 #139 同一类、同一个接缝。
 *
 * 客户端这一侧早就把信号发出来了：详情页「停止」→ controllerRef.abort() → orchestrator
 * 的 signal → adapter.analyzeBazi({signal}) → runTaskOnServer(…, signal) → serverFetch 的
 * fetch(signal)。浏览器断了，服务器那侧却既不 abort 上游、也照样把结果写进 ai_cache。
 * 一次批断是十几个任务 × 三条通道，浪费比聊天那一问大一个量级。
 *
 * 判据形态沿用 #139：createApp 注入假通道调用，直接观察第六参 callerSignal。 */

const TASK = 'natal-baseline';

function oneRecordDb(userId, recordId) {
  const d = openDatabase(':memory:');
  insertRecord(d, {
    id: recordId, userId, name: '张三', gender: 'male', birthYear: 1990, birthMonth: 1,
    createdAt: '2025-01-01T00:00:00.000Z', yearPillar: '甲子', monthPillar: '丙寅',
    dayPillar: '庚午', hourPillar: '壬午',
    nonAiResult: { greatFortunes: [], annualFortunes: [], monthlyFortunes: [] },
    aiStatus: 'pending',
  });
  return d;
}

async function startApp(d) {
  const seenSignals = [];
  const { handle, setTaskCaller } = createApp({ db: d, allowRegister: true });
  assert.equal(typeof setTaskCaller, 'function', 'createApp 没有导出 setTaskCaller ⇒ 这条判据无从下手');
  const server = http.createServer((req, res) => handle(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const reg = await fetch('http://127.0.0.1:' + port + '/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: '批断者', password: 'secret123' }),
  });
  const token = String((await reg.json()).token);
  const saved = await fetch('http://127.0.0.1:' + port + '/api/records', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ name: '张三', gender: 'male', birthYear: 1990, birthMonth: 1,
      createdAt: '2025-01-01T00:00:00.000Z', yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午',
      nonAiResult: { greatFortunes: [], annualFortunes: [], monthlyFortunes: [] }, aiStatus: 'pending' }),
  });
  assert.equal(saved.status, 200, '夹具没能建出记录');
  return { server, port, token, seenSignals, setTaskCaller };
}

/** 挂到断连为止再交出一个「迟到的批断结果」。 */
const hangingCaller = (seenSignals, analysis) => async (_db, _rec, _task, _tone, _preferred, callerSignal) => {
  seenSignals.push(callerSignal ?? null);
  return new Promise((resolve) => {
    const late = () => resolve(analysis);
    if (callerSignal) {
      if (callerSignal.aborted) late();
      else callerSignal.addEventListener('abort', late, { once: true });
    } else setTimeout(late, 300); // 接线缺失也要放行，否则只会挂在超时而不是报出「没传信号」
  });
};

describe('批断任务被中止时服务器不得继续花钱(#140)', () => {
  test('前提钉子：不发 abort 时，任务确实调一次通道并落缓存(否则下面的断言全是空转)', async () => {
    const d = oneRecordDb('a140pre', 'r140pre');
    saveProviderKey(d, 'deepseek', 'sk-pre');
    const seenSignals = [];
    const { handle, setTaskCaller } = createApp({ db: d, allowRegister: true });
    setTaskCaller(async (_db, _rec, _task, _tone, _p, callerSignal) => {
      seenSignals.push(callerSignal ?? null);
      return { status: 'completed', analysis: { summary: '身弱喜土金。' } };
    });
    const server = http.createServer((req, res) => handle(req, res));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    try {
      const reg = await fetch('http://127.0.0.1:' + port + '/api/auth/register', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: '正例者', password: 'secret123' }),
      });
      const token = String((await reg.json()).token);
      const saved = await fetch('http://127.0.0.1:' + port + '/api/records', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ name: '张三', gender: 'male', birthYear: 1990, birthMonth: 1,
          createdAt: '2025-01-01T00:00:00.000Z', yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午',
          nonAiResult: { greatFortunes: [], annualFortunes: [], monthlyFortunes: [] }, aiStatus: 'pending' }),
      });
      const rec = await saved.json();
      const r = await fetch(`http://127.0.0.1:${port}/api/records/${rec.record.id}/ai/task`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ task: TASK, tone: 80 }),
      });
      const data = await r.json();
      assert.equal(r.status, 200, '正例没跑通：' + JSON.stringify(data));
      assert.equal(seenSignals.length, 1, '一次任务应只调一次通道');
      const recRow = getRecordById(d, 'r140pre');
      const hit = readCache(d, cacheKey(recRow, TASK, 'deepseek-flash', DEFAULT_TONE === undefined ? 80 : 80));
      assert.ok(hit, '任务结果应写入缓存(这条前提不成立，下面那条判据就是空转)');
    } finally {
      await new Promise((resolve) => server.close(resolve));
      d.close();
    }
  });

  test('真实断连：客户端在响应头之前关掉连接 → 通道调用收到中止信号', async () => {
    const d = oneRecordDb('a140', 'r140');
    saveProviderKey(d, 'deepseek', 'sk-ds');
    saveProviderKey(d, 'kimi', 'sk-km');
    saveProviderKey(d, 'qwen', 'sk-qw');
    const { server, port, token, seenSignals, setTaskCaller } = await startApp(d);
    setTaskCaller(hangingCaller(seenSignals, { status: 'completed', analysis: { summary: '迟到批断。' } }));
    try {
      const rec = getRecordById(d, 'r140');
      const how = await new Promise((resolve) => {
        const req = http.request({ host: '127.0.0.1', port, path: `/api/records/${rec.id}/ai/task`, method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token } },
        (res) => { res.resume(); });
        req.on('error', () => resolve('errored'));
        req.end(JSON.stringify({ task: TASK, tone: 80 }));
        setTimeout(() => { req.destroy(); resolve('destroyed'); }, 120);
      });
      assert.equal(how, 'destroyed');
      await new Promise((resolve) => setTimeout(resolve, 250));

      assert.equal(seenSignals.length, 1, '断连后仍继续调用通道，共发出 ' + seenSignals.length + ' 次');
      assert.ok(seenSignals[0], '通道调用没收到 callerSignal ⇒ 任务路由没把请求中止接到 runOneTask 上');
      assert.equal(seenSignals[0].aborted, true, '通道调用带着 signal，但断连没有让它中止');
      const written = ['deepseek-flash', 'kimi-k2.6', 'qwen3.8-flash']
        .filter((m) => !!readCache(d, cacheKey(getRecordById(d, 'r140'), TASK, m, 80)));
      assert.deepEqual(written, [], '没人读的批断结果进了缓存 ⇒ 下次点批断直接复用这份陈旧产物：' + written.join(','));
    } finally {
      await new Promise((resolve) => server.close(resolve));
      d.close();
    }
  });

  /* 反向钉子：批断正常跑完时不能被误判成已取消 —— 一次批断连着发十几个任务请求，
     若路由像 #139 早期设想那样直接盯 req 的 close，整条管线会全灭在「问了半天永远没答案」之前。 */
  test('正常跑完的任务不得被误判成已取消', async () => {
    const d = oneRecordDb('a140d', 'r140d');
    saveProviderKey(d, 'deepseek', 'sk-ds');
    const seenSignals = [];
    const { handle, setTaskCaller } = createApp({ db: d, allowRegister: true });
    setTaskCaller(async (_db, _rec, _task, _tone, _p, callerSignal) => {
      seenSignals.push(callerSignal ?? null);
      return { status: 'completed', analysis: { summary: '身弱喜土金，正常批断。' } };
    });
    const server = http.createServer((req, res) => handle(req, res));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    try {
      const reg = await fetch('http://127.0.0.1:' + port + '/api/auth/register', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: '跑完者', password: 'secret123' }),
      });
      const token = String((await reg.json()).token);
      const saved = await fetch('http://127.0.0.1:' + port + '/api/records', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ name: '张三', gender: 'male', birthYear: 1990, birthMonth: 1,
          createdAt: '2025-01-01T00:00:00.000Z', yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午',
          nonAiResult: { greatFortunes: [], annualFortunes: [], monthlyFortunes: [] }, aiStatus: 'pending' }),
      });
      const { record } = await saved.json();
      const r = await fetch(`http://127.0.0.1:${port}/api/records/${record.id}/ai/task`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ task: TASK, tone: 80 }),
      });
      const data = await r.json();
      assert.equal(data.result?.status, 'completed', '正常一次批断被服务器当成已取消：' + JSON.stringify(data));
      assert.equal(seenSignals.length, 1);
      assert.equal(seenSignals[0]?.aborted, false, 'keep-alive 的 close 被当成了断连');
    } finally {
      await new Promise((resolve) => server.close(resolve));
      d.close();
    }
  });

  /* 上一条用「挂到断连才交结果」的替身，循环压根走不到第二轮 —— provider 之间的闸门测不到。
     这一条把替身改成「立刻失败」：第一个通道一回来就进第二个通道的 for 迭代，
     此时连接早已断开，唯一拦住第二次上游调用的就是循环开头那句 abandoned()。
     实测：删掉那句闸门后本条必红(调用数 2)，其余三条照旧全绿。 */
  test('断连之后不得再换下一条通道重试', async () => {
    const d = oneRecordDb('a140r', 'r140r');
    saveProviderKey(d, 'deepseek', 'sk-ds');
    saveProviderKey(d, 'kimi', 'sk-km');
    saveProviderKey(d, 'qwen', 'sk-qw');
    const { server, port, token, seenSignals, setTaskCaller } = await startApp(d);
    setTaskCaller(async (_db, _rec, _task, _tone, _p, callerSignal) => {
      seenSignals.push(callerSignal ?? null);
      // 立刻失败 ⇒ 走到下一轮；但此刻 readJsonBody 还没返回，连接不可能已断。
      // 所以这一轮自己等断连信号，再把失败交出去，让「进入下一轮」发生在放弃之后。
      if (callerSignal && !callerSignal.aborted) {
        await new Promise((resolve) => callerSignal.addEventListener('abort', resolve, { once: true }));
      }
      return { error: '通道没有给出可显示的原因。' };
    });
    try {
      const rec = getRecordById(d, 'r140r');
      const how = await new Promise((resolve) => {
        const req = http.request({ host: '127.0.0.1', port, path: `/api/records/${rec.id}/ai/task`, method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token } },
        (res) => { res.resume(); });
        req.on('error', () => resolve('errored'));
        req.end(JSON.stringify({ task: TASK, tone: 80 }));
        setTimeout(() => { req.destroy(); resolve('destroyed'); }, 120);
      });
      assert.equal(how, 'destroyed');
      await new Promise((resolve) => setTimeout(resolve, 250));

      assert.ok(seenSignals.length >= 1, '夹具没跑起来：一次通道调用都没发生');
      assert.equal(seenSignals.length, 1,
        '已经断连还去调第二条通道，共发出 ' + seenSignals.length + ' 次 ⇒ 循环开头的中止闸门被删掉了');
      const written = ['deepseek-flash', 'kimi-k2.6', 'qwen3.8-flash']
        .filter((m) => !!readCache(d, cacheKey(getRecordById(d, 'r140r'), TASK, m, 80)));
      assert.deepEqual(written, [], '失败的批断进了缓存：' + written.join(','));
    } finally {
      await new Promise((resolve) => server.close(resolve));
      d.close();
    }
  });
});
