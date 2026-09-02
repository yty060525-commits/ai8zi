import { afterEach, describe, expect, it, vi } from 'vitest';
import { analyzeBazi, buildAiRequestPayload, configureAiTaskRunner } from '../data/deepseekAdapter';
import { invoke } from '@tauri-apps/api/core';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
import type { BaziRecord } from '../types/domain';

const record: BaziRecord = {
  id: 'r1', name: '测试', gender: 'male', birthYear: 1984, birthMonth: 2,
  createdAt: '2025-01-01T00:00:00.000Z', yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午',
  nonAiResult: { forecastRange: [2025, 2026, 2027, 2028, 2029, 2030, 2031, 2032, 2033, 2034] } as BaziRecord['nonAiResult'],
  aiStatus: 'pending',
};

describe('DeepSeek adapter', () => {
  afterEach(() => { configureAiTaskRunner(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it('sends exactly the non-AI ten-year forecast range and scoped request', async () => {
    vi.stubEnv('VITE_DEEPSEEK_API_KEY', 'test-key');
    const payload = buildAiRequestPayload(record);
    expect(payload.forecastRange).toEqual(record.nonAiResult?.forecastRange);
    expect(payload.forecastScopes).toEqual(['大运', '流年', '流月']);
    expect(payload.messages[0].content).toContain('2025、2026、2027、2028、2029、2030、2031、2032、2033、2034');
    expect(payload.messages[0].content).toContain('大运、流年、流月');
    expect(payload.messages[0].content).toContain('不要生成范围外年份');
  });

  it('passes the complete non-AI result as structured facts', async () => {
    vi.stubEnv('VITE_DEEPSEEK_API_KEY', 'test-key');
    const payload = buildAiRequestPayload({ ...record, nonAiResult: { ...record.nonAiResult!, elements: { 木: 1 }, naYin: ['海中金'], hiddenStems: [['癸']], tenGods: ['正财'], shenSha: { auspicious: [], inauspicious: [] }, relationships: { sanHe: [], liuHe: [], chong: [], xing: [], hai: [], po: [], ke: [] }, greatFortunes: [], annualFortunes: [], monthlyFortunes: [], twelveLongevity: [] } });
    expect(payload.nonAiResult).toEqual(expect.objectContaining({ elements: { 木: 1 }, naYin: ['海中金'], hiddenStems: [['癸']], tenGods: ['正财'], shenSha: expect.any(Object), greatFortunes: [], annualFortunes: [], monthlyFortunes: [] }));
  });

  it('uses an injected browser runner and never reads an environment secret', async () => {
    const runner = vi.fn().mockResolvedValue({ task: undefined, status: 'completed', analysis: { pattern: '格局', strength: '身强', usefulElements: [], avoidElements: [], explanation: '安全结果' } });
    configureAiTaskRunner(runner);
    const result = await analyzeBazi(record);
    expect(result.status).toBe('completed');
    expect(runner).toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('serializes structured record fields before invoking the Tauri AI command', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} });
    vi.mocked(invoke).mockResolvedValue({ task: { taskId: 'task-01', type: 'baseline' }, status: 'completed', analysis: { pattern: '格局', strength: '身强', usefulElements: [], avoidElements: [], explanation: '结果' } });
    await analyzeBazi(record, { taskId: 'task-01', type: 'baseline' });
    expect(invoke).toHaveBeenCalledWith('run_ai_task', expect.objectContaining({ record: expect.objectContaining({ nonAiResult: JSON.stringify(record.nonAiResult) }) }));
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });
});
