import { describe, expect, it } from 'vitest';
import { buildBaziTasks, orchestrateBaziAnalysis, sanitizeAnalysis } from '../data/baziOrchestrator';
import { ELEMENT_GUIDES } from '../data/elementKnowledge';
import type { BaziRecord } from '../types/domain';

const record = { id: 'r1', name: '测试', gender: 'male', birthYear: 1984, birthMonth: 2, createdAt: '2025-01-01T00:00:00.000Z', yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午', nonAiResult: { forecastRange: [2025, 2026, 2027, 2028, 2029, 2030, 2031, 2032, 2033, 2034], greatFortunes: [], annualFortunes: [], monthlyFortunes: [] } as unknown as BaziRecord['nonAiResult'], aiStatus: 'not_started' } as BaziRecord;

const okAnalysis = { pattern: 'x', strength: '强', usefulElements: [], avoidElements: [], explanation: 'ok' };

describe('task layout: 本命 + 未来十年 + 滚动12个月(+大运)，无总评/总结', () => {
  it('builds 23 tasks without great fortunes', () => {
    const tasks = buildBaziTasks({ ...record, createdAt: '2025-06-30T23:00:00.000Z', nonAiResult: undefined });
    expect(tasks).toHaveLength(23);
    expect(tasks[0]).toEqual(expect.objectContaining({ taskId: 'task-01', type: 'baseline' }));
    expect(tasks.slice(1, 11).map((t) => [t.taskId, t.type, t.year])).toEqual(Array.from({ length: 10 }, (_, i) => [`task-${String(i + 2).padStart(2, '0')}`, 'annual', 2025 + i]));
    expect(tasks.some((t) => t.type === 'overview')).toBe(false);
    expect(tasks.some((t) => t.type === 'synthesis')).toBe(false);
  });

  it('monthly tasks are the next 12 calendar months starting at the record month', () => {
    const tasks = buildBaziTasks({ ...record, createdAt: '2025-01-01T00:00:00.000Z' });
    const months = tasks.filter((t) => t.type === 'monthly');
    expect(months).toHaveLength(12);
    expect(months.map((t) => [t.year, t.month])).toEqual(Array.from({ length: 12 }, (_, i) => [2025, i + 1]));
    // 起点跨年示例：2025-06 起 → 2025-06..2026-05
    const tasks2 = buildBaziTasks({ ...record, createdAt: '2025-06-15T00:00:00.000Z', nonAiResult: undefined });
    const months2 = tasks2.filter((t) => t.type === 'monthly');
    expect(months2[0]).toMatchObject({ year: 2025, month: 6 });
    expect(months2[11]).toMatchObject({ year: 2026, month: 5 });
  });

  it('adds one decade task per great-fortune covering the next ten years', () => {
    const withDecades: BaziRecord = { ...record, nonAiResult: { forecastRange: Array.from({ length: 10 }, (_, i) => 2025 + i), greatFortunes: [{ ganZhi: '辛未', startYear: 2017, endYear: 2026 }, { ganZhi: '壬申', startYear: 2027, endYear: 2036 }], annualFortunes: [], monthlyFortunes: [] } as unknown as BaziRecord['nonAiResult'] };
    const tasks = buildBaziTasks(withDecades);
    expect(tasks).toHaveLength(25);
    const decades = tasks.filter((t) => t.type === 'decade');
    expect(decades.map((t) => [t.taskId, t.year])).toEqual([['task-24', 2017], ['task-25', 2027]]);
  });

  it('runs baseline → years/months → decades and persists everything', async () => {
    const calls: string[] = [];
    const withDecades: BaziRecord = { ...record, nonAiResult: { forecastRange: Array.from({ length: 10 }, (_, i) => 2025 + i), greatFortunes: [{ ganZhi: '辛未', startYear: 2017, endYear: 2026 }], annualFortunes: [], monthlyFortunes: [] } as unknown as BaziRecord['nonAiResult'] };
    const result = await orchestrateBaziAnalysis(withDecades, async (task) => { calls.push(task.taskId); return { task, status: 'completed', analysis: okAnalysis }; });
    expect(calls.length).toBe(24);
    expect(calls[0]).toBe('task-01');
    expect(calls).toContain('task-24'); // 大运任务已跑
    expect(Object.keys(result.aiTasks ?? {})).toHaveLength(24);
    expect(result.aiAnalysis?.explanation).toBe('ok');
    expect(result.aiOverview).toBeUndefined();
    // 月度任务携带了干支行(供后端最小上下文)
    const monthTask = result.aiTasks?.['task-12']?.task;
    expect(monthTask?.type).toBe('monthly');
    expect(monthTask?.monthly?.ganZhi).toBeTruthy();
  });

  it('keeps genuinely completed tasks cached and re-runs stale empty ones', async () => {
    const calls: string[] = [];
    const good = { ...record, nonAiResult: undefined, aiTasks: { 'task-01': { task: { taskId: 'task-01', type: 'baseline' }, status: 'completed', analysis: okAnalysis } } as BaziRecord['aiTasks'] };
    await orchestrateBaziAnalysis(good, async (task) => { calls.push(task.taskId); return { task, status: 'completed', analysis: okAnalysis }; });
    expect(calls).not.toContain('task-01');

    const stale = { ...record, nonAiResult: undefined, aiTasks: { 'task-01': { task: { taskId: 'task-01', type: 'baseline' }, status: 'completed', analysis: { pattern: '', strength: '', usefulElements: [], avoidElements: [], explanation: '' } } } as BaziRecord['aiTasks'] };
    const calls2: string[] = [];
    await orchestrateBaziAnalysis(stale, async (task) => { calls2.push(task.taskId); return { task, status: 'completed', analysis: okAnalysis }; });
    expect(calls2).toContain('task-01');
  });

  it('reports progress once per task with dynamic total', async () => {
    const progressCalls: number[] = [];
    let lastDone = 0;
    await orchestrateBaziAnalysis({ ...record, nonAiResult: undefined }, async (task) => ({ task, status: 'completed', analysis: okAnalysis }), (p) => { progressCalls.push(p.done); lastDone = p.total; });
    expect(lastDone).toBe(23);
    expect(progressCalls[progressCalls.length - 1]).toBe(23);
    expect(progressCalls).toHaveLength(23);
  });

  it('appends one adjustment task after baseline when a favorite element is known', async () => {
    const called: string[] = [];
    const record2 = { ...record, nonAiResult: undefined };
    const result = await orchestrateBaziAnalysis(record2, async (task) => {
      called.push(task.taskId);
      if (task.type === 'baseline') return { task, status: 'completed', analysis: { pattern: '身弱', strength: '弱', usefulElements: ['木'], avoidElements: ['金'], explanation: 'ok' } };
      if (task.type === 'adjustment') {
        expect(task.guide?.element).toBe('木');
        expect(task.guide?.lifestyle).toContain('木');
        expect(task.guide?.career).toContain('木');
        expect(ELEMENT_GUIDES['木']).toBeDefined();
      }
      return { task, status: 'completed', analysis: { pattern: 'x', strength: 'x', usefulElements: [], avoidElements: [], explanation: 'ok' } };
    });
    expect(called).toContain('task-30');
    expect(result.aiTasks?.['task-30']?.task.type).toBe('adjustment');
    expect(result.aiTasks?.['task-30']?.task.guide?.element).toBe('木');
  });

  it('strips draft/comment/fence markers from model output', () => {
    const clean = sanitizeAnalysis({ pattern: '身弱', strength: '弱', usefulElements: [], avoidElements: [], explanation: '/*这是草稿*/正文内容\n\`\`\`json\n废稿\n\`\`\`<!--html注释-->结尾' } as never);
    expect(clean.explanation).toBe('正文内容\n结尾');
  });

  it('sanitizes malformed model output', async () => {
    const result = await orchestrateBaziAnalysis({ ...record, nonAiResult: undefined }, async (task) => {
      return { task, status: 'completed', analysis: (task.type === 'baseline' ? { pattern: 'p', strength: '强' } : { pattern: '总', strength: '强', usefulElements: 'bad', avoidElements: undefined, explanation: 42 }) as never };
    });
    expect(result.aiAnalysis).toEqual(expect.objectContaining({ pattern: 'p', usefulElements: [], avoidElements: [], explanation: '' }));
    expect((result.aiAnalysis?.usefulElements ?? []).join('、')).toBe('');
  });
});

describe('auto retry on failed tasks', () => {
  it('automatically retries a transient failure and completes the task', async () => {
    let calls = 0;
    const result = await orchestrateBaziAnalysis({ ...record, nonAiResult: undefined }, async (task) => {
      calls += 1;
      if (task.type === 'baseline' && calls <= 1) return { task, status: 'failed', error: 'HTTP 503' };
      return { task, status: 'completed', analysis: okAnalysis };
    });
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(result.aiTasks?.['task-01']?.status).toBe('completed');
    expect(result.aiStatus).toBe('completed');
  });

  it('repairs still-failing tasks with an automatic extra pass (失败不再直接停留)', async () => {
    let baselineCalls = 0;
    const result = await orchestrateBaziAnalysis({ ...record, nonAiResult: undefined }, async (task) => {
      if (task.type === 'baseline') {
        baselineCalls += 1;
        if (baselineCalls < 3) return { task, status: 'failed', error: 'HTTP 503' };
      }
      return { task, status: 'completed', analysis: okAnalysis };
    });
    expect(baselineCalls).toBeGreaterThanOrEqual(3); // 即时重试 + 整批后的自动补跑
    expect(result.aiTasks?.['task-01']?.status).toBe('completed');
    expect(result.aiStatus).toBe('completed');
  });

  it('does not retry credential/permission style failures', async () => {
    let calls = 0;
    const result = await orchestrateBaziAnalysis({ ...record, nonAiResult: undefined }, async (task) => {
      calls += 1;
      return { task, status: 'failed', error: 'HTTP 401' };
    });
    expect(calls).toBe(23); // 每个任务只试一次
    expect(result.aiStatus).toBe('failed');
  });

  it('aborts instantly even while a request is still in flight (stop mid-call)', async () => {
    const controller = new AbortController();
    controller.abort();
    const called: string[] = [];
    await expect(orchestrateBaziAnalysis(
      { ...record, nonAiResult: undefined },
      async (task) => { called.push(task.taskId); await new Promise<void>(() => {}); return { task, status: 'completed', analysis: okAnalysis }; },
      undefined,
      { signal: controller.signal },
    )).rejects.toThrow(/已停止/);
    expect(called).toEqual([]); // 没有任何任务被继续发出
  });

  it('stops immediately when 停止 fires while a request never returns', async () => {
    const controller = new AbortController();
    const started: string[] = [];
    const run = orchestrateBaziAnalysis(
      { ...record, nonAiResult: undefined },
      async (task) => {
        started.push(task.taskId);
        if (started.length === 1) setTimeout(() => controller.abort(), 0);
        await new Promise<void>(() => {}); // 永不返回的请求
        return { task, status: 'completed', analysis: okAnalysis };
      },
      undefined,
      { signal: controller.signal },
    );
    await expect(run).rejects.toThrow(/已停止/);
    expect(started.length).toBeLessThanOrEqual(3); // 未继续铺开任务
  });

  it('honors an aborted signal by throwing before writing the aborted task', async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    await expect(orchestrateBaziAnalysis(
      { ...record, nonAiResult: undefined },
      async (task) => {
        calls.push(task.taskId);
        if (calls.length === 1) controller.abort();
        return { task, status: 'failed', error: 'network failure' };
      },
      undefined,
      { signal: controller.signal, retries: 2, retryDelayMs: 0 },
    )).rejects.toThrow(/已停止/);
  });
});
