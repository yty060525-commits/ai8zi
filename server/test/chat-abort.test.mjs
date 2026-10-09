import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import './netGuard.mjs'; // 上闸：本文件一律走假 fetch，绝不该真连 AI
import http from 'node:http';
import { openDatabase, insertRecord, getRecordById, readCache } from '../db.mjs';
import { runChat, chatCacheKey } from '../chat.mjs';
import { saveProviderKey } from '../ai.mjs';
import { createApp } from '../app.mjs';

/* 缺陷 #139：客户端「停止 / 清空对话」之后，服务器那侧的通道调用与写缓存不会停。
 *
 * 为什么这不只是浪费：聊天答案一旦过闸门就按 (record, question, model, tone) 写进缓存(chat_cache)，
 * 而首轮追问才缓存(cacheable = history.length === 0)。用户点停止往往正因为模型在跑偏 ——
 * 那份没人读过的跑偏答案就此占住这个键；下次重问同一句直接命中缓存、原样返回，
 * 用户既等了一次钱又拿回同一个坏答案。
 *
 * 判据形态是「发送方自报回执」：假 fetch 把每次收到的 init.signal 记下来，
 * 用例 abort 之后再逐个读 .aborted。网络层拦不住「谁发的请求」，但信号对象本身能。 */

const fakeReply = (text) => ({
  ok: true,
  status: 200,
  json: async () => ({ choices: [{ message: { content: text } }] }),
  text: async () => '',
});

/** 装一个假 fetch：记录每次调用的 signal，并按 signals 数组回填。 */
function stubFetch(signals, text = '身弱喜土金，假答案。') {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    signals.push(init?.signal ?? null);
    return fakeReply(text);
  };
  return () => { globalThis.fetch = real; };
}

function oneRecordDb(userId, recordId) {
  const d = openDatabase(':memory:');
  insertRecord(d, {
    id: recordId, userId, name: '张三', gender: 'male', birthYear: 1990, birthMonth: 1,
    createdAt: '2025-01-01T00:00:00.000Z', yearPillar: '甲子', monthPillar: '丙寅',
    dayPillar: '庚午', hourPillar: '壬午',
    nonAiResult: { greatFortunes: [], annualFortunes: [], monthlyFortunes: [] },
    aiStatus: 'completed',
  });
  return d;
}

describe('聊天请求被中止时服务器不得继续花钱(#139)', () => {
  test('前提钉子：不发 abort 时，通道确实被调用且答案进了缓存(否则下面的断言全是空转)', async () => {
    const d = oneRecordDb('a139pre', 'r139pre');
    saveProviderKey(d, 'deepseek', 'sk-pre');
    const signals = [];
    const restore = stubFetch(signals);
    try {
      const reply = await runChat(d, { id: 'a139pre', role: 'user' }, { question: '我的喜用五行是什么？' });
      assert.equal(reply.status, 'completed', '正例没答上来，夹具本身有问题：' + JSON.stringify(reply));
      assert.equal(signals.length, 1, '一轮问答应只发一次上游调用');
      const rec = getRecordById(d, 'r139pre');
      const hit = readCache(d, chatCacheKey(rec, '我的喜用五行是什么？', 'deepseek-flash', 80));
      assert.ok(hit, '首轮答案应写入缓存(这条前提不成立，下面那条判据就是空转)');
    } finally { restore(); d.close(); }
  });

  test('客户端在响应头回来之前就中止 → 不再试其它通道，也不把迟到答案写进缓存', async () => {
    const d = oneRecordDb('a139', 'r139');
    // 三条通道全部配好密钥：没有中止闸门时，第一条失败会连着再打两条。
    saveProviderKey(d, 'deepseek', 'sk-ds');
    saveProviderKey(d, 'kimi', 'sk-km');
    saveProviderKey(d, 'qwen', 'sk-qw');
    const signals = [];
    const real = globalThis.fetch;
    globalThis.fetch = async (_url, init) => {
      signals.push(init?.signal ?? null);
      // 模拟「浏览器已经断开」：Node 在这一刻才把 close 事件排队，所以先让出一轮宏任务。
      controller.abort();
      await new Promise((resolve) => setImmediate(resolve));
      throw Object.assign(new Error('client aborted'), { name: 'AbortError' });
    };
    const controller = new AbortController();
    try {
      const reply = await runChat(d, { id: 'a139', role: 'user' }, { question: '我的喜用五行是什么？' }, { signal: controller.signal });
      assert.equal(signals.length, 1, '中止后仍换通道重试，发出了 ' + signals.length + ' 次上游调用');
      assert.equal(controller.signal.aborted, true, '前提：这一问确实已被中止');
      const rec = getRecordById(d, 'r139');
      const models = ['deepseek-flash', 'kimi-k2.6', 'qwen3.8-flash'];
      const written = models.filter((m) => !!readCache(d, chatCacheKey(rec, '我的喜用五行是什么？', m, 80)));
      assert.deepEqual(written, [], '没人读的答案进了缓存 ⇒ 下次重问直接命中这份陈旧结果：' + written.join(','));
      assert.ok(String(reply.error || '').length > 0, '中止也要给人一句可读的失败原因');
    } finally { globalThis.fetch = real; d.close(); }
  });

  test('真实断连：客户端在响应头之前关掉连接 → 服务器停止后续通道调用', async () => {
    /* 前一条用例手工传 opts.signal，只证明 runChat 认这个信号；这一条走 HTTP，
       证明 app.mjs 那条 res.on('close') 接线真的会触发它。
       ⚠ 这里不能直接盯 req/res 的 close：Node 16+ 的 keep-alive 会在「请求读完」那一刻就把
       req 标成 closed 并发出 close，而连接还活着 —— 那样每条正常聊天都会被当成已放弃。
       所以路由里用 writableEnded 做探针，本条用例同时钉住这个误判不会发生。 */
    const d = oneRecordDb('a139c', 'r139c');
    saveProviderKey(d, 'deepseek', 'sk-ds');
    saveProviderKey(d, 'kimi', 'sk-km');
    saveProviderKey(d, 'qwen', 'sk-qw');
    const seenSignals = [];
    /* 注入假通道调用：真实 callProvider 内部自己 new AbortController，从外面只能间接观察到
       「它转发给 fetch 的那个 signal 被 abort」。要直接钉住「路由有没有把请求的中止接到
       通道调用上」(第六参 callerSignal 到底传没传)，就得让 runChat 调到一个能记录它的替身。 */
    const { handle, setProviderCaller } = createApp({ db: d, allowRegister: true });
    assert.equal(typeof setProviderCaller, 'function', 'createApp 没有导出 setProviderCaller ⇒ 这条判据无从下手');
    setProviderCaller(async (_provider, _key, _messages, _effort, _mode, callerSignal) => {
      seenSignals.push(callerSignal ?? null);
      // 挂住不返回，等断连把 abort 传进来之后再交出一个「迟到的答案」。
      return new Promise((resolve) => {
        const answer = () => resolve({ text: '身弱喜土金，迟到答案。' });
        if (callerSignal) {
          if (callerSignal.aborted) answer();
          else callerSignal.addEventListener('abort', answer, { once: true });
        }
        // 没有信号可等时(接线缺失)也要放行，否则用例只会挂在超时而不是报出「没传信号」。
        else setTimeout(answer, 300);
      });
    });
    const server = http.createServer((req, res) => handle(req, res));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    try {
      const reg = await fetch('http://127.0.0.1:' + port + '/api/auth/register', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: '断连者', password: 'secret123' }),
      });
      const token = String((await reg.json()).token);
      const saved = await fetch('http://127.0.0.1:' + port + '/api/records', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ name: '张三', gender: 'male', birthYear: 1990, birthMonth: 1,
          createdAt: '2025-01-01T00:00:00.000Z', yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午',
          nonAiResult: { greatFortunes: [], annualFortunes: [], monthlyFortunes: [] }, aiStatus: 'completed' }),
      });
      assert.equal(saved.status, 200, '夹具没能建出记录');

      // 发起聊天并在收到响应头之前销毁连接 —— 这就是界面上「停止」那一刻发生的事。
      const aborted = await new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: '/api/chat', method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token } },
        (res) => { res.resume(); });
        req.on('error', reject);
        req.end(JSON.stringify({ question: '我的喜用五行是什么？' }));
        setTimeout(() => { req.destroy(); resolve(true); }, 120);
      });
      assert.ok(aborted);
      // 给服务器一点时间把 abort 传播到通道调用
      await new Promise((resolve) => setTimeout(resolve, 200));

      assert.equal(seenSignals.length, 1, '断连后仍继续调用通道，共发出 ' + seenSignals.length + ' 次');
      assert.ok(seenSignals[0], '通道调用没收到 callerSignal ⇒ app 路由没把请求中止接到 runChat 上');
      assert.equal(seenSignals[0].aborted, true, '通道调用带着 signal，但断连没有让它中止');
      const rec = getRecordById(d, 'r139c');
      const written = ['deepseek-flash', 'kimi-k2.6', 'qwen3.8-flash']
        .filter((m) => !!readCache(d, chatCacheKey(rec, '我的喜用五行是什么？', m, 80)));
      assert.deepEqual(written, [], '断连后的迟到答案写进了缓存：' + written.join(','));
    } finally {
      await new Promise((resolve) => server.close(resolve));
      d.close();
    }
  });

  /* 「答案已经写出、正文还没读完」这一刻的断连，服务器**测不到**，也不该由缓存来兜。
     实测(Node 24，两份探针)：res.end(大正文) 之后客户端取消响应体或读一格就毁掉连接，
     close 事件里的 writableEnded 已经是 true —— 与「正常读完」长得一模一样。而写缓存发生在
     json() 之前，所以这条路径上既观察不到放弃、也来不及回滚。
     ⚠ 我上一轮把这条当成缺陷写了一个「不该进缓存」的断言，实测是红的，但红得没有道理：
        判据要求的是产品原理上做不到的事。现在改钉可观察的那一半 —— 这种断连必须被认成
        「已送达」，答案照常返回并落缓存，绝不能因为一次收尾期的 close 被误判成已取消。 */
  test('答案已写出、客户端没读完就断开：这一问按已完成处理(此路测不到断连)', async () => {
    const d = oneRecordDb('a139f', 'r139f');
    saveProviderKey(d, 'deepseek', 'sk-ds');
    const seenSignals = [];
    const { handle, setProviderCaller } = createApp({ db: d, allowRegister: true });
    // 正文故意做大，保证客户端有机会在写完之后的流上掐断。
    setProviderCaller(async (_p, _k, _m, _e, _mode, callerSignal) => {
      seenSignals.push(callerSignal ?? null);
      return { text: '身弱喜土金。' + '详'.repeat(400 * 1024) };
    });
    const server = http.createServer((req, res) => handle(req, res));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    try {
      const reg = await fetch('http://127.0.0.1:' + port + '/api/auth/register', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: '半读者', password: 'secret123' }),
      });
      const token = String((await reg.json()).token);
      await fetch('http://127.0.0.1:' + port + '/api/records', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ name: '张三', gender: 'male', birthYear: 1990, birthMonth: 1,
          createdAt: '2025-01-01T00:00:00.000Z', yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午',
          nonAiResult: { greatFortunes: [], annualFortunes: [], monthlyFortunes: [] }, aiStatus: 'completed' }),
      });

      const how = await new Promise((resolve) => {
        const req = http.request({ host: '127.0.0.1', port, path: '/api/chat', method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token } },
        (res) => {
          res.once('data', () => {
            // 收到第一个字节(响应头已回来、runChat 也已返回并写过缓存)后立刻掐断
            req.destroy();
            resolve('destroyed');
          });
        });
        req.on('error', () => resolve('errored'));
        req.end(JSON.stringify({ question: '我的喜用五行是什么？' }));
      });
      assert.equal(how, 'destroyed', '夹具没能构造出「答完但没读完」的断连');
      await new Promise((resolve) => setTimeout(resolve, 200));

      assert.equal(seenSignals.length, 1, '这一问应当只调一次通道');
      assert.equal(seenSignals[0]?.aborted, false, '收尾期的 close 被当成了放弃 ⇒ 会把已送达的回答误报成已取消');
      const rec = getRecordById(d, 'r139f');
      const hit = readCache(d, chatCacheKey(rec, '我的喜用五行是什么？', 'deepseek-flash', 80));
      assert.ok(hit, '已送达的答案应留在缓存里(下一句同题重问直接复用)');
    } finally {
      await new Promise((resolve) => server.close(resolve));
      d.close();
    }
  });

  /* keep-alive 误判闸门：Node 16+ 在「请求读完」那一刻就把 req 标成 closed 并发 close，
     连接其实还活着。若路由直接盯 req.on('close') 就 abort，每一条正常聊天都会在
     模型答完前被当成已放弃 —— 表现为「问了半天永远没答案」。这条是反向钉子。 */
  test('正常走完的聊天不得被误判成已取消(keep-alive 的 close 不算断连)', async () => {
    const d = oneRecordDb('a139d', 'r139d');
    saveProviderKey(d, 'deepseek', 'sk-ds');
    const seenSignals = [];
    const { handle, setProviderCaller } = createApp({ db: d, allowRegister: true });
    setProviderCaller(async (_p, _k, _m, _e, _mode, callerSignal) => {
      seenSignals.push(callerSignal ?? null);
      return { text: '身弱喜土金，正常答案。' };
    });
    const server = http.createServer((req, res) => handle(req, res));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    try {
      const reg = await fetch('http://127.0.0.1:' + port + '/api/auth/register', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: '正常者', password: 'secret123' }),
      });
      const token = String((await reg.json()).token);
      await fetch('http://127.0.0.1:' + port + '/api/records', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ name: '张三', gender: 'male', birthYear: 1990, birthMonth: 1,
          createdAt: '2025-01-01T00:00:00.000Z', yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午',
          nonAiResult: { greatFortunes: [], annualFortunes: [], monthlyFortunes: [] }, aiStatus: 'completed' }),
      });
      const r = await fetch('http://127.0.0.1:' + port + '/api/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ question: '我的喜用五行是什么？' }),
      });
      const data = await r.json();
      assert.equal(data.status, 'completed', '正常一问被服务器当成已取消：' + JSON.stringify(data));
      assert.equal(seenSignals.length, 1);
      assert.equal(seenSignals[0]?.aborted, false, 'keep-alive 的 close 被当成了断连');
    } finally {
      await new Promise((resolve) => server.close(resolve));
      d.close();
    }
  });

  /* 探针摘除判据：路由给 res 挂了 close 监听器，正常答完必须摘掉它。
     响应正常结束时 Node 自己会清监听器(res.on('close') 在 writableEnded 后移除)，
     所以「同一连接上问第二句、第一句的探针把第二句判成已取消」这种形态在本端构造不出来 ——
     上面那条 keep-alive 用例也就测不到这一层。这里只钉能真实观察到的那一半：
     走通的一问结束后不得留下挂着的监听器(泄漏)。删掉 finally 里的 removeListener 会红。 */
  test('聊天结束后不得在同一响应上留下 close 监听器', async () => {
    const d = oneRecordDb('a139e', 'r139e');
    saveProviderKey(d, 'deepseek', 'sk-ds');
    let observed = null;
    const { handle, setProviderCaller } = createApp({ db: d, allowRegister: true });
    setProviderCaller(async () => ({ text: '身弱喜土金，正常答案。' }));
    const server = http.createServer((req, res) => {
      // 必须在路由之前记录引用：res 对象与请求结束后的监听器数量都从这里读。
      observed = res;
      handle(req, res);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    try {
      const reg = await fetch('http://127.0.0.1:' + port + '/api/auth/register', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: '收尾者', password: 'secret123' }),
      });
      const token = String((await reg.json()).token);
      await fetch('http://127.0.0.1:' + port + '/api/records', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ name: '张三', gender: 'male', birthYear: 1990, birthMonth: 1,
          createdAt: '2025-01-01T00:00:00.000Z', yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午',
          nonAiResult: { greatFortunes: [], annualFortunes: [], monthlyFortunes: [] }, aiStatus: 'completed' }),
      });
      const r = await fetch('http://127.0.0.1:' + port + '/api/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ question: '我的喜用五行是什么？' }),
      });
      assert.equal((await r.json()).status, 'completed');
      // 等一轮宏任务，让 Node 自身的清理落地后再读数
      await new Promise((resolve) => setImmediate(resolve));
      const left = observed.listenerCount('close');
      assert.equal(left, 0, '聊天路由结束后该响应上还挂着 ' + left + ' 个 close 监听器 ⇒ finally 没摘探针(基线：正常结束时 Node 自己清到 0)');
    } finally {
      await new Promise((resolve) => server.close(resolve));
      d.close();
    }
  });
});
