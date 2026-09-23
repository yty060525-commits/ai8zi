import { describe, expect, it } from 'vitest';
import { allowNetwork, blockedAttempts, disableNetworkGuard, enableNetworkGuard, isLocalTarget } from '../test-setup/netGuard';

/* 闸口自身也要被测试：它一旦被改坏就会静默失效，测试重新开始烧真钱。 */
describe('测试网络闸口(防真实 API 调用)', () => {
  it('三家 AI 服务都判为外连', () => {
    for (const url of [
      'https://api.deepseek.com/chat/completions',
      'https://api.moonshot.cn/v1/chat/completions',
      'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    ]) expect(isLocalTarget(url), url).toBe(false);
  });

  it('本机与相对地址放行', () => {
    expect(isLocalTarget('http://127.0.0.1:8787/api/chat')).toBe(true);
    expect(isLocalTarget('http://localhost:5173/')).toBe(true);
    expect(isLocalTarget('/api/records')).toBe(true);
  });

  it('setupFiles 已上闸：直接 fetch 外部地址会抛错且不发请求', async () => {
    await expect(fetch('https://api.deepseek.com/chat/completions', { method: 'POST' })).rejects.toThrow(/测试环境禁止访问外部接口/);
    expect(blockedAttempts().some((e) => e.url.includes('api.deepseek.com'))).toBe(true);
  });

  it('allowNetwork 需要理由，出作用域后自动重新上闸', async () => {
    await expect(allowNetwork('', async () => 1)).rejects.toThrow(/必须给出理由/);
    await allowNetwork('自检：验证可临时放行', async () => null);
    await expect(fetch('https://api.moonshot.cn/v1/chat/completions')).rejects.toThrow(/测试环境禁止访问外部接口/);
  });

  it('关闸后恢复原生 fetch(不残留包装函数)', () => {
    disableNetworkGuard();
    try {
      expect(fetch.name).not.toBe('guardedFetch');
    } finally {
      enableNetworkGuard();
    }
    // 重新上闸后仍然拦得住
    return expect(fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions')).rejects.toThrow(/测试环境禁止访问外部接口/);
  });
});
