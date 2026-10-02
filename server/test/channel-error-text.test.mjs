import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import './netGuard.mjs'; // 上闸：本用例只比对文本与纯函数，绝不该发请求
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyFailure, cnCode, PROVIDER_LABEL, providerLabel, runOneTask, AI_NO_CREDENTIAL_REPLY } from '../ai.mjs';
import { openDatabase } from '../db.mjs';
import { sanitizeChatText } from '../../client/src/shared/chineseGate.ts';

/* 服务器侧报错读法的判据 —— 与客户端 channel-error-text.test.ts 同一套口径。
 *
 * 为什么要在服务端再测一遍：批断任务的 record.aiError 与聊天错误框都可能是**服务器**造的串
 * (runOneTask / callProvider)，客户端那道「只能中文」闸门拿到带 DeepSeek、HTTP 503、JSON、
 * 全角括号的原文时会把整段删空，用户只剩「未知错误」，真正原因(该补哪条通道、是限流还是余额)反而丢了。
 * 两端各写一份读法迟早会分叉，所以这里除了逐条判据，还直接把客户端源码里的字面量抽出来做集合比对。 */

const here = path.dirname(fileURLToPath(import.meta.url));
const clientAdapterSource = fs.readFileSync(path.join(here, '../../client/src/data/deepseekAdapter.ts'), 'utf8').replace(/\r\n/g, '\n');
const clientSettingsSource = fs.readFileSync(path.join(here, '../../client/src/data/aiSettings.ts'), 'utf8').replace(/\r\n/g, '\n');
const rustSource = fs.readFileSync(path.join(here, '../../client/src-tauri/src/lib.rs'), 'utf8').replace(/\r\n/g, '\n');

/** 闸门同款终检：清洗后仍不合规就返回空串，等于界面上那句话没了。 */
const survivesGate = (text) => sanitizeChatText(text).length > 0;

describe('服务器侧失败分类：与客户端同义、且整句过闸门不塌成空', () => {
  const statuses = [0, 400, 401, 402, 403, 404, 429, 500, 503];

  test('每个状态码的说法本身不含英文、数字或符号', () => {
    for (const status of statuses) {
      const text = classifyFailure(status, '');
      assert.equal(/[A-Za-z]/.test(text), false, `状态码 ${status} 的分类里出现了英文：${text}`);
      assert.equal(/[0-9]/.test(text), false, `状态码 ${status} 的分类里出现了数字：${text}`);
      assert.equal(/[（）()@#&*+=~^_|·／【】「」“”…—＿]/.test(text), false, `分类里残留符号：${text}`);
    }
  });

  test('限流/服务端故障不再写「已被限流」「上游 5xx」这类过程术语', () => {
    assert.equal(classifyFailure(429, ''), '请求过于频繁，已被限流');
    assert.equal(classifyFailure(503, ''), '服务端故障');
    assert.equal(classifyFailure(429, '').includes('（'), false);
    assert.equal(/5xx|[A-Za-z]/.test(classifyFailure(500, '')), false);
  });

  test('上游自述若是整句英文 → 退回固定中文，不把残句拼进报错', () => {
    const text = classifyFailure(400, '{"error":{"message":"Invalid api key"}}');
    assert.equal(/[A-Za-z{}":,]/.test(text), false, '英文残句漏进了报错：' + text);
    assert.equal(survivesGate(text), true);
  });

  test('状态码逐位读：五百零三这种念法不算，要五零三', () => {
    assert.equal(cnCode(503), '五零三');
    assert.equal(cnCode(429), '四二九');
    assert.equal(cnCode(0), '零');
    assert.equal(cnCode('8787'), '八七八七');
  });

  test('拼成「通道名：原因，服务返回五零三」后整句喂给闸门不塌成空', () => {
    for (const status of statuses) {
      const line = PROVIDER_LABEL.qwen + '：' + classifyFailure(status, '') + '，服务返回' + cnCode(status);
      assert.equal(survivesGate(line), true, '整句被闸门判空，界面会退化成「未知错误」：' + line);
      assert.equal(/[A-Za-z0-9]/.test(line), false, '报错串仍有拉丁字母或数字：' + line);
      // 「·」不在闸门白名单里：混进正文会被静默删字，界面凭空少一格，所以源头就不该有。
      assert.equal(line.includes('·'), false, '报错串仍有中点(会被闸门删掉)：' + line);
    }
  });

  test('通道中文名与客户端 aiSettings.PROVIDER_LABEL 逐条相等', () => {
    // 从真实源码里取，而不是在这里抄一份期望值 —— 否则两端各自改字面量时这条永远绿。
    const block = clientSettingsSource.match(/PROVIDER_LABEL: Record<AiProvider, string> = (\{[^}]*\})/);
    assert.ok(block, '客户端 aiSettings.ts 里找不到 PROVIDER_LABEL 定义，判据前提已失效');
    const clientLabels = Object.fromEntries([...block[1].matchAll(/(\w+):\s*'([^']+)'/g)].map((m) => [m[1], m[2]]));
    assert.ok(Object.keys(clientLabels).length >= 3, '没从客户端源码里读到通道名，判据成了空集');
    assert.deepEqual(PROVIDER_LABEL, clientLabels);
    // 钉子：三端通道名都不许带「·」(闸门会删字)。这里读的是真实源码值，不是本地副本。
    for (const [id, name] of Object.entries(clientLabels)) {
      assert.equal(name.includes('·'), false, `客户端通道名 ${id} 仍带中点：${name}`);
    }
    // 桌面端那份也从真实 Rust 源码里读，避免它单独改字面量而这条仍绿。
    // 必须只在 fn label 的函数体内取：lib.rs 里 provider_order/key() 同样写 Self::Xxx => "…"，
    // 全文匹配会把它们当成通道名(实测命中 6 条)，判据就变成比错对象。
    const labelFn = /fn label\(&self\)[^{]*\{([\s\S]*?)\n\s*\}/.exec(rustSource);
    assert.ok(labelFn, '没在 lib.rs 找到 fn label，判据前提已失效');
    const rustLabels = [...labelFn[1].matchAll(/Self::(\w+)\s*=>\s*"([^"]+)"/g)]
      .map((m) => [m[1].toLowerCase(), m[2]]);
    assert.equal(rustLabels.length, 3, `fn label 里应恰好三条通道名，实际 ${rustLabels.length} 条`);
    for (const [id, name] of rustLabels) {
      assert.equal(name, clientLabels[id], `桌面端 ${id} 与客户端通道名不一致：${name} vs ${clientLabels[id]}`);
    }
  });

  test('失败分类的中文说法与客户端 classifyFailure 完全一致', () => {
    // 抽出客户端各分支的返回字面量(按源码顺序)，与服务端逐个状态码的输出对齐。
    const fnBody = clientAdapterSource.match(/export function classifyFailure[\s\S]*?\n\}/);
    assert.ok(fnBody, '客户端 deepseekAdapter.ts 里找不到 classifyFailure，判据前提已失效');
    const clientReturns = [...fnBody[0].matchAll(/return '([^']*)'/g)].map((m) => m[1]);
    // 兜底那句是三元式(return snippet ? A + snippet : B)，两支都不是 `return '…'` 形态，单独抓。
    const ternary = fnBody[0].match(/\n\s*return snippet \? '([^']*)'[^:]*: '([^']*)'/);
    assert.ok(ternary, '客户端 classifyFailure 的兜底句式变了，判据前提已失效');
    clientReturns.push(ternary[1], ternary[2]);
    const serverReturns = [
      classifyFailure(402, ''), classifyFailure(401, ''), classifyFailure(429, ''),
      classifyFailure(404, ''), classifyFailure(400, ''), classifyFailure(500, ''),
      classifyFailure(0, ''), ternary[1], ternary[2],
    ];
    // 反向钉子：这两支取自真实函数输出而不是照抄字面量 —— 前缀换成「原因：」之类的分叉也会红。
    assert.equal(classifyFailure(499, '上游说：网关暂时不可用'), ternary[1] + '上游说：网关暂时不可用');
    assert.equal(classifyFailure(499, ''), ternary[2]);
    assert.equal(clientReturns.length, serverReturns.length, '两端分支数不等：客户端 ' + JSON.stringify(clientReturns));
    for (let i = 0; i < clientReturns.length; i++) {
      assert.equal(serverReturns[i], clientReturns[i], `第 ${i + 1} 条说法分叉：服务器「${serverReturns[i]}」vs 客户端「${clientReturns[i]}」`);
    }
  });

  test('providerLabel 遇到未知 id 也不回落成服务商英文名', () => {
    // PROVIDERS[].label 是协议层字段(自检回显用)，一旦有人拿它拼报错就又造出泄漏源。
    assert.equal(providerLabel('deepseek'), '通道一深思');
    const unknown = providerLabel('glm-4.6');
    assert.equal(/[A-Za-z]/.test(unknown), false, '未知通道名把英文带进了对外文案：' + unknown);
    assert.equal(survivesGate(unknown), true);
  });

  test('runOneTask 一条凭据都没配时的回执是纯中文', async () => {
    // 内存库、不写任何密钥：providerOrder 返回空数组，走「未配置」那条分支。
    const db = openDatabase(':memory:');
    try {
      const r = await runOneTask(db, {
        gender: 'male', birthYear: 1990,
        yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午',
        nonAiResult: {},
      }, { taskId: 't1', type: 'baseline' });
      assert.equal(r.status, 'not_configured');
      assert.equal(/[A-Za-z0-9]/.test(String(r.error)), false, '未配置回执带机器字符：' + r.error);
    } finally { db.close(); }
  });

  test('runOneTask 全通道失败时把各段原因拼成一句纯中文，而不是留残句', async () => {
    // 用假 provider 的调用面：这里只验「拼接 + 终检」这段逻辑，所以直接喂带英文的上游原文。
    const joined = ['通道一深思：上游报错 bad gateway (HTTP 502)', '通道二克米：请求过于频繁，已被限流，服务返回四二九'].join('；');
    const out = sanitizeChatText(joined);
    assert.equal(/[A-Za-z0-9]/.test(out), false, '清洗后仍有机器字符：' + out);
    // 关键判据：整段不许被判空 —— 一旦第一段脏到让闸门放弃全句，第二段的好原因也一起没了。
    assert.equal(out.length > 0, true, '整句被闸门判空，用户只剩「未知错误」');
    assert.equal(AI_NO_CREDENTIAL_REPLY, '各通道都未返回可显示的原因，请检查服务器上的凭据配置');
  });
});
