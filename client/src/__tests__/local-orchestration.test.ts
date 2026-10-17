import { afterEach, describe, expect, it, vi } from 'vitest';
import * as adapter from '../data/deepseekAdapter';
import { orchestrateBaziAnalysis, type TaskRunner } from '../data/baziOrchestrator';
import * as localEngine from '../data/localAnalysis';
import * as calculator from '../features/chart/nonAiCalculator';
import { flushPendingPruneWrites, hydrateRecord, pruneRecord } from '../data/clientRepository';
import { resetAiSettingsForTests } from '../data/aiSettings';
import { resetLocalSystemForTests, unlockLocalSystem } from '../data/localSystem';
import { LOCAL_ANALYSIS_ENGINE_VERSION } from '../data/localAnalysis';
import { calculateNonAi } from '../features/chart/nonAiCalculator';
import type { BaziRecord } from '../types/domain';

afterEach(() => { vi.restoreAllMocks(); resetAiSettingsForTests(); resetLocalSystemForTests(); });

const now = new Date('2026-06-15T00:00:00.000Z');
const record = (): BaziRecord => ({
  id: 'local-orchestration', name: '本地编排', gender: 'male', birthYear: 1984, birthMonth: 2,
  createdAt: '2025-01-01T00:00:00.000Z', yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午',
  nonAiResult: calculateNonAi({ birthYear: 1984, birthMonth: 2, yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午' }, 'male', now.toISOString()),
  aiStatus: 'not_started',
} as BaziRecord);
const cloudRunner: TaskRunner = async (task) => ({ task, status: 'completed', source: 'cloud', analysis: { pattern: '身强', strength: '身强', usefulElements: ['木'], avoidElements: ['金'], explanation: '【身强身弱与喜忌】一、命局清晰。【健康】一、注意作息。【事业】一、稳步发展。【财运】一、量入为出。【爱情】一、多沟通。【刑冲克害批注】一、无明显冲克。' } });

describe('本地引擎编排与来源复用', () => {
  it('真实本地输出标记版本且不调用云端；同版续跑复用，来源切换双向重算', async () => {
    const network = vi.spyOn(adapter, 'analyzeBazi');
    const input = record();
    const local = await orchestrateBaziAnalysis(input, undefined, undefined, { local: true, now, retryDelayMs: 0 });
    expect(network).not.toHaveBeenCalled();
    expect(local.aiTasks?.['task-01']?.source).toBe('local');
    expect(local.aiTasks?.['task-01']?.analysis?.engineVersion).toBe(LOCAL_ANALYSIS_ENGINE_VERSION);
    let localCalls = 0;
    await orchestrateBaziAnalysis(local, async (task) => { localCalls += 1; return { task, status: 'completed', source: 'local', analysis: local.aiTasks?.[task.taskId]?.analysis }; }, undefined, { local: true, now, retryDelayMs: 0 });
    expect(localCalls).toBe(0);
    const cloud = await orchestrateBaziAnalysis(local, cloudRunner, undefined, { now, retryDelayMs: 0 });
    expect(Object.values(cloud.aiTasks ?? {}).every((task) => task.source === 'cloud')).toBe(true);
    let cloudCalls = 0;
    const localAgain = await orchestrateBaziAnalysis(cloud, async (task) => { cloudCalls += 1; return { task, status: 'completed', source: 'local', analysis: local.aiTasks?.[task.taskId]?.analysis }; }, undefined, { local: true, now, retryDelayMs: 0 });
    expect(cloudCalls).toBeGreaterThan(0);
    expect(Object.values(localAgain.aiTasks ?? {}).filter((task) => task.status === 'completed').every((task) => task.source === 'local')).toBe(true);
    network.mockRestore();
  });
});


describe('本地计算与版本读取的真实边界', () => {
  it('瘦身盘只补算一次，未来建盘与固定北京时间窗口一致，同版完整盘续跑零补算', async () => {
    unlockLocalSystem('mingli-local-2026');
    const input = pruneRecord({ ...record(), createdAt: '2027-12-31T16:00:00.000Z' });
    const calculate = vi.spyOn(calculator, 'calculateNonAi');
    const network = vi.spyOn(adapter, 'analyzeBazi');
    const output = await orchestrateBaziAnalysis(input, undefined, undefined, { local: true, now });
    expect(calculate).toHaveBeenCalledTimes(1);
    expect(network).not.toHaveBeenCalled();
    expect(output.aiStatus).toBe('completed');
    expect(output.nonAiResult?.annualFortunes[0].year).toBe(2028);
    const annuals = Object.values(output.aiTasks ?? {}).filter((item) => item.task.type === 'annual');
    expect(annuals.map((item) => item.task.year)).toEqual(Array.from({ length: 10 }, (_, i) => 2028 + i));
    expect(annuals.every((item) => item.status === 'completed')).toBe(true);
    expect(Object.values(output.aiTasks ?? {}).some((item) => item.task.type === 'decade')).toBe(true);
    expect(output.aiOverview?.explanation).toContain('二零二八');
    const expected = calculator.calculateNonAi({ ...input, birthDay: input.nonAiResult?.birthDay }, input.gender, input.createdAt);
    expect(output.nonAiResult?.annualFortunes[0].ganZhi).toBe(expected.annualFortunes[0].ganZhi);
    calculate.mockClear();
    await orchestrateBaziAnalysis(output, undefined, undefined, { local: true, now });
    expect(calculate).not.toHaveBeenCalled();
  });

  it('缺时段数据明确失败，一项只算一次且不回退到云端', async () => {
    const input = pruneRecord(record());
    const build = vi.spyOn(localEngine, 'buildLocalTaskAnalysis');
    const network = vi.spyOn(adapter, 'analyzeBazi');
    const output = await orchestrateBaziAnalysis(input, undefined, undefined, { local: true, now, retries: 3 });
    const annual = output.aiTasks?.['task-02'];
    expect(annual?.status).toBe('failed');
    expect(annual?.error).toContain('本地数据不足');
    expect(annual?.source).toBe('local');
    expect(build.mock.calls.filter(([, task]) => task.taskId === 'task-02')).toHaveLength(1);
    expect(network).not.toHaveBeenCalled();
  });

  it('读取清除旧版与无版本本地正文，保留当前版本和云端别名并回写', async () => {
    const cloud = (await cloudRunner({ taskId: 'cloud', type: 'baseline' }, { nonAiResult: undefined, task: { taskId: 'cloud', type: 'baseline' } })).analysis!;
    const item = (version?: string) => ({ task: { taskId: 'old', type: 'annual' as const, year: 2026 }, status: 'completed' as const, source: 'local' as const, analysis: { ...cloud, explanation: '旧本地正文', engineVersion: version } });
    const input = { ...record(), aiAnalysis: cloud, aiOverview: cloud, aiTasks: { 'task-01': item('local-rules-v6'), 'task-31': item(), current: item(LOCAL_ANALYSIS_ENGINE_VERSION), cloud: { task: { taskId: 'cloud', type: 'baseline' as const }, status: 'completed' as const, analysis: cloud } } };
    const cleaned = await hydrateRecord(input);
    expect(Object.keys(cleaned.aiTasks ?? {}).sort()).toEqual(['cloud', 'current']);
    expect(cleaned.aiAnalysis).toBe(cloud);
    expect(cleaned.aiOverview).toBe(cloud);
    expect(cleaned.aiStatus).toBe('not_started');
    await flushPendingPruneWrites();
    const again = await hydrateRecord(cleaned);
    expect(again.aiTasks).toEqual(cleaned.aiTasks);
    const matching = item('local-rules-v6');
    const cleared = await hydrateRecord({ ...record(), aiAnalysis: { ...matching.analysis }, aiOverview: { ...matching.analysis }, aiTasks: { 'task-01': matching, 'task-31': matching } });
    expect(cleared.aiAnalysis).toBeUndefined();
    expect(cleared.aiOverview).toBeUndefined();
    await flushPendingPruneWrites();
  });
});
