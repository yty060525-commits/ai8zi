import { describe, expect, it } from 'vitest';
import { orchestrateBaziAnalysis, FIXED_CONCURRENCY } from '../data/baziOrchestrator';
import type { BaziRecord } from '../types/domain';

const record = { id: 'r1', name: '测试', gender: 'male', birthYear: 1984, birthMonth: 2, createdAt: '2025-01-01T00:00:00.000Z',
  yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午', nonAiResult: undefined, aiStatus: 'not_started' } as unknown as BaziRecord;
const ok = { pattern: 'x', strength: '强', usefulElements: [], avoidElements: [], explanation: 'ok' };

/**
 * 回归：并发池在“限流冷却”期间不得提前收尾。
 * 旧实现以 running===0 作为结束条件，冷却时队列里剩下的任务会被静默丢弃(实测 23 个只跑 20 个)。
 */
describe('并发池冷却期不丢任务', () => {
  it('一批任务同时被限流时，全部任务仍被处理', async () => {
    const called = new Set<string>();
    let failBudget = FIXED_CONCURRENCY.scope; // 让一整批并发任务同时命中限流，触发冷却
    const result = await orchestrateBaziAnalysis(record, async (task) => {
      called.add(task.taskId);
      if ((task.type === 'annual' || task.type === 'monthly') && failBudget > 0) {
        failBudget -= 1;
        return { task, status: 'failed', error: '请求过于频繁（已被限流）（HTTP 429 · DeepSeek）' };
      }
      return { task, status: 'completed', analysis: ok };
    }, undefined, { retries: 0, retryDelayMs: 0 });
    const entries = Object.keys(result.aiTasks ?? {});
    expect(entries.length).toBeGreaterThanOrEqual(23);
    expect(called.size).toBeGreaterThanOrEqual(23);
  }, 30000);
});
