/* 网络闸口自身的校验：确认「外部拦、本机放」这两件事都真的成立。
 * 这个文件存在的意义是防止闸口被改坏后静默失效 —— 那样测试就会重新开始烧真钱。 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { enableNetworkGuard, disableNetworkGuard, blockedAttempts, isLocalTarget, allowNetwork } from './netGuard.mjs';

describe('测试网络闸口(防真实 API 调用)', () => {
  test('外部 AI 域名判定为外连', () => {
    for (const url of [
      'https://api.deepseek.com/chat/completions',
      'https://api.moonshot.cn/v1/chat/completions',
      'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    ]) assert.equal(isLocalTarget(url), false, url + ' 应判为外部');
  });

  test('本机测试服务与相对地址判定为放行', () => {
    assert.equal(isLocalTarget('http://127.0.0.1:8787/api/chat'), true);
    assert.equal(isLocalTarget('http://localhost:4173/'), true);
    assert.equal(isLocalTarget('/api/records'), true);
  });

  test('开着闸时，对外部地址的 fetch 直接抛错且不发请求', async () => {
    enableNetworkGuard();
    try {
      await assert.rejects(
        () => fetch('https://api.deepseek.com/chat/completions', { method: 'POST' }),
        /测试环境禁止访问外部接口/,
      );
      assert.ok(blockedAttempts().some((e) => e.url.includes('api.deepseek.com')), '应留下拦截记录');
    } finally {
      disableNetworkGuard();
    }
  });

  test('关闸后行为恢复正常(不吞掉真实 fetch)', () => {
    disableNetworkGuard();
    assert.equal(typeof fetch, 'function');
    // 不能是还在抛测试错的包装版本
    assert.notEqual(fetch.name, 'guardedFetch');
  });

  test('allowNetwork 必须给理由，且放行后恢复上闸', async () => {
    enableNetworkGuard();
    try {
      await assert.rejects(() => allowNetwork('', async () => 1), /必须给出理由/);
      const before = blockedAttempts().length;
      await allowNetwork('自检用：确认可临时放行', async () => null);
      // 放行记录本身可审计
      assert.ok(blockedAttempts().length > before);
      // 出作用域后重新上闸
      await assert.rejects(() => fetch('https://api.moonshot.cn/v1/chat/completions'), /测试环境禁止访问外部接口/);
    } finally {
      disableNetworkGuard();
    }
  });
});
