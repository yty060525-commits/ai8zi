import { describe, expect, it, vi } from 'vitest';
import { COOLDOWN_MS, fixedMapLimit, orchestrateBaziAnalysis } from '../data/baziOrchestrator';
import type { BaziRecord } from '../types/domain';

const record = { id: 'lifecycle', name: '测试', gender: 'male', birthYear: 1984, birthMonth: 2,
  createdAt: '2025-01-01T00:00:00.000Z', yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午', aiStatus: 'not_started' } as unknown as BaziRecord;
const within = async <T>(promise: Promise<T>, ms = 250): Promise<
  { status: 'resolved'; value: T } | { status: 'rejected'; reason: unknown } | { status: 'pending' }
> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    promise.then((value) => ({ status: 'resolved' as const, value }), (reason) => ({ status: 'rejected' as const, reason })),
    new Promise<{ status: 'pending' }>((resolve) => { timer = setTimeout(() => resolve({ status: 'pending' }), ms); }),
  ]);
  if (timer) clearTimeout(timer);
  return result;
};

describe('scheduler lifecycle regressions', () => {
  it('bounds main-pass calls by retries even when every result is failed', async () => {
    const counts = new Map<string, number>();
    const controller = new AbortController();
    const run = orchestrateBaziAnalysis(record, async (task) => {
      const count = (counts.get(task.taskId) ?? 0) + 1;
      counts.set(task.taskId, count);
      if (count > 3) controller.abort(); // harness upper bound: old infinite retry cannot hang the suite
      return { task, status: 'failed', error: '上游服务返回五百' };
    }, undefined, { retries: 2, retryDelayMs: 0, signal: controller.signal });
    const result = await within(run, 5000);
    expect(result.status).toBe('resolved');
    expect(counts.get('task-02')).toBe(3); //主跑两口，补跑独立一口
  }, 10000);

  it('retries completed output missing required sections only within the quota', async () => {
    const counts = new Map<string, number>();
    const controller = new AbortController();
    const run = orchestrateBaziAnalysis(record, async (task) => {
      const count = (counts.get(task.taskId) ?? 0) + 1;
      counts.set(task.taskId, count);
      if (count > 2) controller.abort();
      return { task, status: 'completed' as const, analysis: { pattern: '测试', strength: '强', usefulElements: [], avoidElements: [], explanation: '【健康】测试' } } as never;
    }, undefined, { retries: 2, retryDelayMs: 0, signal: controller.signal });
    const result = await within(run, 5000);
    expect(result.status).toBe('resolved');
    expect(counts.get('task-02')).toBe(2);
  }, 10000);

  it('allows exactly three main-pass calls when retries is three, plus the independent repair pass', async () => {
    const counts = new Map<string, number>();
    const controller = new AbortController();
    const run = orchestrateBaziAnalysis(record, async (task) => {
      const count = (counts.get(task.taskId) ?? 0) + 1;
      counts.set(task.taskId, count);
      if (count > 4) controller.abort();
      return { task, status: 'failed' as const, error: '上游服务返回五百' };
    }, undefined, { retries: 3, retryDelayMs: 0, signal: controller.signal });
    const result = await within(run, 5000);
    expect(result.status).toBe('resolved');
    expect(counts.get('task-02')).toBe(4);
  }, 10000);

  it('rejects on worker throw and leaves queued items unstarted', async () => {
    const calls: string[] = [];
    const run = fixedMapLimit([{ id: 'first' }, { id: 'queued' }], 1, async ({ id }) => {
      calls.push(id);
      if (id === 'first') throw new Error('worker failed');
    });
    const result = await within(run);
    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') expect(result.reason).toBeInstanceOf(Error);
    expect(calls).toEqual(['first']);
  });

  it('rejects falsey thrown values instead of resolving successfully', async () => {
    for (const reason of [undefined, null, 0]) {
      const result = await within(fixedMapLimit([{ id: 'first' }], 1, async () => { throw reason; }));
      expect(result.status).toBe('rejected');
      if (result.status === 'rejected') expect(result.reason).toBe(reason);
    }
  });

  it('aborts while workers are in flight and ignores their late throttle result', async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    let release!: (value: { status: string; error: string }) => void;
    const held = new Promise<{ status: string; error: string }>((resolve) => { release = resolve; });
    const run = fixedMapLimit([{ id: 'held' }, { id: 'second' }, { id: 'queued' }], 2, async ({ id }) => {
      calls.push(id);
      if (id === 'held') return held;
    }, undefined, controller.signal);
    while (calls.length < 2) await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    const result = await within(run);
    expect(result.status).toBe('rejected');
    release({ status: 'failed', error: 'HTTP 429 rate limit' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toEqual(['held', 'second']);
  });

  it('cancels a retry delay before another runner call', async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    const run = orchestrateBaziAnalysis(record, async (task) => {
      calls.push(task.taskId);
      return { task, status: 'failed', error: '上游服务返回五百' };
    }, undefined, { retries: 2, retryDelayMs: 1000, signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    const result = await within(run);
    expect(result.status).toBe('rejected');
    expect(calls).toEqual(['task-01']);
  });

  it('stops launching concurrent analysis tasks after a successful task is reported', async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    const progress: number[] = [];
    const run = orchestrateBaziAnalysis(record, async (task) => {
      calls.push(task.taskId);
      return { task, status: 'completed' as const, analysis: { pattern: '测试', strength: '强', usefulElements: [], avoidElements: [], explanation: '测试正文' } } as never;
    }, (event) => {
      progress.push(event.done);
      if (event.done === 3) controller.abort();
    }, { retries: 1, retryDelayMs: 0, signal: controller.signal });
    const result = await within(run, 5000);
    expect(result.status).toBe('rejected');
    expect(calls.length).toBeLessThan(23);
    expect(progress).toEqual([1, 2, 3]);
  }, 10000);

  it('aborts a pool during cooldown and never starts its queued item', async () => {
    const clearTimer = vi.spyOn(globalThis, 'clearTimeout');
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
    const calls: string[] = [];
    try {
      const run = fixedMapLimit([{ id: 'first' }, { id: 'queued' }], 1, async ({ id }) => {
        calls.push(id);
        return { status: 'failed', error: 'HTTP 429 rate limit' };
      }, undefined, controller.signal);
      await new Promise((resolve) => setTimeout(resolve, 20));
      controller.abort();
      expect(clearTimer).toHaveBeenCalled();
      expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
      const result = await within(run);
      expect(result.status).toBe('rejected');
      expect(calls).toEqual(['first']);
      expect(COOLDOWN_MS).toBeGreaterThan(20);
    } finally {
      clearTimer.mockRestore();
      removeListener.mockRestore();
    }
  });
});
