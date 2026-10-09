/* 判据空白 #144：「这条失败值不值得再烧一次钱」是跨端契约，可两端各测各的字符串，
 * 中间那条链从来没人当整条链钉过。
 *
 * 消费方只有一个(client/src/data/baziOrchestrator.ts:81 isRetryableFailure)，它只认错误文本里的字样：
 *   · /not_configured|未配置|credential|keyring/  → 不可重试(密钥/配置类，重试也是白费)
 *   · /HTTP 40[0-9]|服务返回四[零一二三四五六七八九]/ → 不可重试(状态码类)
 * 生产方有三份实现(浏览器直连 deepseekAdapter.classifyFailure、服务器 ai.mjs:329 classifyFailure、
 * 桌面 lib.rs)。服务器那句 runOneTask(ai.mjs:441) 的「未配置」回执会经 app.mjs:133 →
 * runTaskOnServer(serverClient.ts:106) → analyzeBazi(deepseekAdapter.ts:119) →
 * baziOrchestrator:679-680 一路进到 record.aiError；而详情页排自动重试读的就是 saved.aiError
 * (PersonDetail:666)，早退闸门只有 scheduleAutoRetry(:557) 那一句 —— 控制器在 stopAnalysis 里已被
 * 置 null，所以 :579 那句 `!controllerRef.current?.signal.aborted` 恒真拦不住。
 *
 * 实测取证(node --test + vitest 2026-10-09)：把 server/ai.mjs:322 的文案改成
 * 「服务器尚未接入任何通道，请机主补凭据」之后，服务器 133 条与客户端全量**照旧全绿** ——
 * api.test.mjs:100 只断 r.data.result.status==='not_configured'(不碰文本)，
 * channel-error-text.test.mjs:123 只断那条回执「不含英文数字」(方向相反，看不出它喂不喂得动闸门)。
 * 于是网页版(线上默认走服务器这条路)对着一个根本没配密钥的中继会一轮接一轮地发请求。
 *
 * ⚠ 本文件刻意**不 import** 客户端源码：Node 的 --experimental-strip-types 不做路径重写，
 *   而 baziOrchestrator.ts 的运行时 import 全是无扩展名写法(deepseekAdapter:2)，直接 import 会
 *   ERR_MODULE_NOT_FOUND(实测)。所以闸门语句从产品源码逐字取，并在当场核对它的形状。 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import './netGuard.mjs'; // 上闸：本文件只在内存库上跑假通道调用，绝不该真连 AI
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, insertRecord } from '../db.mjs';
import { saveProviderKey, classifyFailure, cnCode, providerLabel, AI_SERVER_UNCONFIGURED } from '../ai.mjs';
import { createApp } from '../app.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const gateSource = fs.readFileSync(path.join(here, '../../client/src/data/baziOrchestrator.ts'), 'utf8').replace(/\r\n/g, '\n');

/** 逐字取出闸门里的两条正则，并按它现出真正的判定函数——两份实现分叉时本文件要红，
 *  而不是拿我复述的字符串自证。 */
function loadGate() {
  const configLine = gateSource.split('\n').find((l) => /^\s*if \(\/not_configured\|未配置/.test(l)) ?? '';
  const statusLine = gateSource.split('\n').find((l) => /HTTP 40\[0-9\]\|服务返回四\[/.test(l)) ?? '';
  assert.ok(configLine, '找不到 isRetryableFailure 的字样闸门行 ⇒ 本文件前提塌，判据空转');
  assert.ok(statusLine, '找不到 isRetryableFailure 的状态码闸门行 ⇒ 本文件前提塌，判据空转');
  const configRe = /\/([^/]*)\/i\.test\(error\)/.exec(configLine)?.[1];
  const statusRe = /\/([^/]*)\/\.test\(error\)/.exec(statusLine)?.[1];
  assert.ok(configRe && statusRe, `闸门行的形状变了：${configLine} | ${statusLine}`);
  return (error) => {
    if (!error) return false;
    if (new RegExp(configRe, 'i').test(error)) return false;
    if (new RegExp(statusRe).test(error)) return false;
    return true;
  };
}
const retryable = loadGate();

/** 起一台真服务器(内存库 + 注入假通道调用)，取该记录 /ai/task 的回执原文。 */
async function taskReceipt({ withKey, caller }) {
  const d = openDatabase(':memory:');
  insertRecord(d, {
    id: 'r144', userId: 'u144', name: '张三', gender: 'male', birthYear: 1990, birthMonth: 1,
    createdAt: '2025-01-01T00:00:00.000Z', yearPillar: '甲子', monthPillar: '丙寅',
    dayPillar: '庚午', hourPillar: '壬午',
    nonAiResult: { greatFortunes: [], annualFortunes: [], monthlyFortunes: [] }, aiStatus: 'pending',
  });
  if (withKey) saveProviderKey(d, 'deepseek', 'sk-ds');
  const { handle, setTaskCaller } = createApp({ db: d, allowRegister: true });
  if (caller) setTaskCaller(caller);
  const server = http.createServer((req, res) => handle(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const reg = await fetch('http://127.0.0.1:' + port + '/api/auth/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: '闸门读者', password: 'secret123' }),
    });
    assert.equal(reg.status, 200, '夹具注册失败');
    const token = String((await reg.json()).token);
    const res = await fetch('http://127.0.0.1:' + port + '/api/records/r144/ai/task', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ task: { taskId: 'task-01', type: 'baseline' }, tone: 80 }),
    });
    assert.equal(res.status, 200, '任务路由应回 200，实际 ' + res.status);
    const body = await res.json();
    assert.ok(body?.result, '回执里没有 result 字段：' + JSON.stringify(body));
    return { status: String(body.result.status), error: String(body.result.error ?? '') };
  } finally {
    await new Promise((resolve) => server.close(resolve));
    d.close();
  }
}

describe('服务器造的失败文本必须喂得动客户端的重试闸门(#144)', () => {
  test('前提钉子：一条凭据都没配时回执是 not_configured 并带服务器自述，且不含机器字符', async () => {
    const r = await taskReceipt({ withKey: false });
    assert.equal(r.status, 'not_configured');
    assert.ok(r.error.length > 0, '回执没带原因文本，闸门无从判定(前提塌)');
    assert.equal(/[A-Za-z0-9]/.test(r.error), false, '回执带机器字符：' + r.error);
  });

  test('关键判据：服务器那句「未配置」回执不许被判成值得重试', async () => {
    const r = await taskReceipt({ withKey: false });
    assert.equal(retryable(r.error), false,
      '这句回执会被当成可重试 ⇒ 详情页对着一个根本没配密钥的中继排两次自动重试：' + r.error);
  });

  test('回执文本必须含「未配置」：下游兜底只在没有失败任务时才写', async () => {
    const r = await taskReceipt({ withKey: false });
    // 编排器(baziOrchestrator:680)那句含「未配置」的兜底是 failedTask 为空时的 fallback；
    // 一轮批断里只要有一条 failed，record.aiError 就是这条服务器自述 ⇒ 字样必须在源头就有。
    assert.match(r.error, /未配置/, '回执不含「未配置」：' + r.error);
    assert.equal(r.error, AI_SERVER_UNCONFIGURED, '回执不是那句固定说法：' + r.error);
  });

  test('服务器每个不可重试状态码的说法都要拦住闸门(callProvider 那条带状态码尾巴的出口)', async () => {
    for (const status of [400, 401, 402, 403, 404]) {
      const text = providerLabel('qwen') + '：' + classifyFailure(status, '') + '，服务返回' + cnCode(status);
      assert.equal(retryable(text), false, `状态码 ${status} 的说法会被当成可重试：${text}`);
    }
    // ⚠ 这里**不**断言「按文案命中的额度类」(如 exceeded your current quota)也要拦住闸门。
    // 实测读数(node --test 2026-10-09)：不带状态码尾巴的那句「余额不足或额度已用完」是**放行**的 ——
    // 闸门的第二句认的是形态(/HTTP 40[0-9]|服务返回四…/)而不是语义。这条现状由客户端
    // retry-gate-server-text.test.ts 的「现状如实登记 #145」逐字钉住(尾巴在→拦、尾巴没了→放行)，
    // 别在这里改成期望值把它盖掉。
  });

  test('反向钉子：真故障(五〇三)与超时仍须判为可重试，闸门不是见报错就停', async () => {
    assert.equal(retryable(providerLabel('deepseek') + '：' + classifyFailure(503, '') + '，服务返回' + cnCode(503)), true,
      '服务端故障应当允许重试');
    assert.equal(retryable('通道一深思：网络超时或不可达'), true, '超时应当允许重试');
    assert.equal(retryable(undefined), false, '空错误不该排重试(闸门第一句)');
  });

  test('聊天那条路同一句回执也要拦住闸门(chat.mjs:478 与任务共用文案)', async () => {
    // 聊天侧不排自动重试，但它拿的是同一个常量：两处出口一旦分叉，本条与第三条不会同时红。
    const chatSource = fs.readFileSync(path.join(here, '../chat.mjs'), 'utf8').replace(/\r\n/g, '\n');
    assert.match(chatSource, /AI_SERVER_UNCONFIGURED/, '聊天路由不再引用那句未配置文案 ⇒ 同源前提塌');
    assert.equal(retryable(AI_SERVER_UNCONFIGURED), false);
  });

  test('桌面那半仍未闭合如实登记：run_ai_chat 一条 session_cancelled 闸门都没有', () => {
    /* 【缺陷 #143 的另一半】任务通道有 Rust 三条闸门(lib.rs:712/741/748)，聊天通道一条也没有。
       客户端只能在自己这一侧预检(tauri-task-abort.test.ts 钉的那两条)，中止已经发出后那次上游调用
       仍然花得出去。这里用字节钉子把这个现状钉住：有人给 run_ai_chat 补上闸门时本条会红，
       提醒他同步删掉这段注释并把客户端那条反向钉子(desktopChatCacheWrites===1)改掉。 */
    const rust = fs.readFileSync(path.join(here, '../../client/src-tauri/src/lib.rs'), 'utf8').replace(/\r\n/g, '\n');
    const at = rust.indexOf('pub async fn run_ai_chat');
    assert.ok(at >= 0, '找不到 run_ai_chat ⇒ 本条前提塌');
    const body = rust.slice(at, at + 4000);
    assert.equal(/session_cancelled\(\)/.test(body), false,
      'run_ai_chat 已接上会话开关 ⇒ 请把这里的读数与 tauri-task-abort.test.ts 的反向钉子一起订正');
    // 兄弟命令确实接了：证明上面那句否读不是切片切短了造成的假阴性
    const taskAt = rust.indexOf('pub async fn run_ai_task');
    assert.ok(taskAt >= 0 && /session_cancelled\(\)/.test(rust.slice(taskAt, at)),
      'run_ai_task 那条路的闸门读不到 ⇒ 本文件的比对尺本身失效');
  });

  test('全通道失败句的现状读数：它被判为可重试(有意保留，不是缺陷)', async () => {
    const r = await taskReceipt({ withKey: true, caller: async () => ({ error: providerLabel('deepseek') + '：上游未返回可显示的原因' }) });
    assert.equal(r.status, 'failed');
    assert.equal(retryable(r.error), true, '上游抖动值得再试一次；若这条变红说明闸门被改宽了：' + r.error);
  });
});
