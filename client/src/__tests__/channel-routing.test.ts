import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browserDirect } from '../data/deepseekAdapter';

/**
 * 回归：网页直连必须尊重“当前使用通道”，而不是写死 DeepSeek。
 * 曾经 browserDirect 硬编码 DeepSeek 端点与凭据，导致设置里切到 Qwen 也毫无作用。
 */
const record = {
  id: 'r1', name: '测试', gender: 'male', birthYear: 1990, birthMonth: 6,
  yearPillar: '庚午', monthPillar: '壬午', dayPillar: '甲子', hourPillar: '甲子',
  createdAt: '2026-01-01T00:00:00.000Z', aiStatus: 'not_started',
  nonAiResult: { dayMaster: '甲', zodiac: '马', solarDate: '1990-06-15', elements: {}, tenGods: [], hiddenStems: [], relationships: {} },
} as never;
const task = { taskId: 'task-01', type: 'baseline' } as never;
const okReply = { choices: [{ message: { content: JSON.stringify({ pattern: '正印格', strength: '身强', usefulElements: ['火'], avoidElements: ['水'], explanation: '【健康】1. 好。' }) } }] };

const calls: string[] = [];
beforeEach(() => {
  calls.length = 0;
  try { localStorage.clear(); } catch { /* ignore */ }
  vi.stubGlobal('fetch', vi.fn(async (url: string) => { calls.push(String(url)); return { ok: true, status: 200, json: async () => okReply } as never; }));
});
afterEach(() => { vi.unstubAllGlobals(); try { localStorage.clear(); } catch { /* ignore */ } });

describe('网页直连按当前使用通道路由', () => {
  it('选中 qwen 时打 DashScope 端点并带 qwen3.8-flash', async () => {
    localStorage.setItem('mingli.provider', 'qwen');
    localStorage.setItem('mingli.cred.qwen', 'qwen-key');
    const res = await browserDirect(record, task);
    expect(res.status).toBe('completed');
    expect(calls[0]).toContain('dashscope.aliyuncs.com');
    const body = JSON.parse(String((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body));
    expect(body.model).toBe('qwen3.8-flash');
    expect(body.enable_thinking).toBe(false); // 关闭思考，实测快约 3.8 倍
  });

  it('选中 deepseek 时打官方端点', async () => {
    localStorage.setItem('mingli.provider', 'deepseek');
    localStorage.setItem('mingli.cred.deepseek', 'ds-key');
    await browserDirect(record, task);
    expect(calls[0]).toContain('api.deepseek.com');
  });

  it('当前通道未配凭据时自动回退到其它已配置通道', async () => {
    localStorage.setItem('mingli.provider', 'qwen'); // 使用中但未配
    localStorage.setItem('mingli.cred.kimi', 'kimi-key');
    const res = await browserDirect(record, task);
    expect(res.status).toBe('completed');
    expect(calls[0]).toContain('moonshot.cn');
  });

  it('所有通道都未配置时给出可读原因', async () => {
    localStorage.setItem('mingli.provider', 'qwen');
    const res = await browserDirect(record, task);
    expect(res.status).toBe('failed');
    expect(String((res as { error?: string }).error)).toContain('未配置凭据');
  });
});