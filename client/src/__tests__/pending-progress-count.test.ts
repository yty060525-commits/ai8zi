import { describe, expect, it } from 'vitest';

import { OVERVIEW_TASK_ID, buildBaziTasks, completedTaskCount, expectedTaskIds } from '../data/baziOrchestrator';
import { calculateNonAi } from '../features/chart/nonAiCalculator';
import type { BaziAIAnalysis, BaziRecord, BaziTaskResult } from '../types/domain';

/* 「分析中」是一个**会随 record 上行服务器**的状态，而编排器每跑完一个任务都会把整份快照
   saveBaziRecord 落库（PersonDetail 的 onProgress）。也就是说：状态写着「分析中」的时候，
   已完成的那几条正文其实已经在库里了 —— 可界面上无论详情页还是记录列表都只说「分析中」，
   一个字都不提已经跑到哪。刷新/换设备回来的人分不清「刚点下去」和「跑了 20 条还剩 4 条」。
   这条用例钉住计数口径本身：它必须与 PersonDetail 判定「结果完整、可以早退」用的是同一套谓词，
   否则进度会说谎（界面显示 3/23，实际重跑时却认为只剩 1 条）。 */

const chart = calculateNonAi(
  { birthYear: 1990, birthMonth: 5, birthDay: 15, yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午' },
  'male', '2025-01-01T00:00:00.000Z');

const analysis = (explanation: string): BaziAIAnalysis => ({ pattern: '正官格', strength: '身强', usefulElements: ['水'], avoidElements: ['火'], explanation });

const mk = (tasks: Record<string, BaziTaskResult>): BaziRecord => ({
  id: 'p1', name: '进度盘', gender: 'male', birthYear: 1990, birthMonth: 5,
  createdAt: '2025-01-01T00:00:00.000Z', yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午',
  nonAiResult: chart, aiStatus: 'pending', aiTasks: tasks,
});

const done = (id: string): BaziTaskResult => ({ task: { taskId: id, type: 'baseline' }, status: 'completed', analysis: analysis('本命已成') });

describe('completedTaskCount：与「结果完整」判定同源的进度计数', () => {
  const ids = expectedTaskIds(mk({}), new Date());

  it('前提：这份盘的必填清单确实不止一条（否则计数用例全是空转）', () => {
    expect(ids.length).toBeGreaterThan(20);
  });

  it('一条都没有 ⇒ 0', () => {
    expect(completedTaskCount(mk({}))).toBe(0);
  });

  it('completed 且有正文才计入；failed / 空正文都不算已跑完', () => {
    const rec = mk({
      'task-01': done('task-01'),
      'task-02': { task: { taskId: 'task-02', type: 'annual', year: 2026 }, status: 'completed', analysis: { pattern: '', strength: '', usefulElements: [], avoidElements: [], explanation: '' } },
      'task-03': { task: { taskId: 'task-03', type: 'annual', year: 2027 }, status: 'failed', error: '超时' },
    });
    expect(completedTaskCount(rec), '只有第一条真有正文').toBe(1);
  });

  it('全跑完时计数等于必填清单长度（这就是详情页敢早退的那个条件）', () => {
    const all: Record<string, BaziTaskResult> = {};
    for (const id of ids) all[id] = done(id);
    expect(Object.keys(all)).toHaveLength(ids.length);
    expect(completedTaskCount(mk(all))).toBe(ids.length);
  });

  it('不计窗口外的旧任务：残留一条上轮的 task-99 不该把分母撑大、也不该被算进进度', () => {
    const stale = mk({ 'task-01': done('task-01'), 'task-99': done('task-99') });
    expect(buildBaziTasks(stale).some((t) => t.taskId === 'task-99'), '前提：task-99 不在本轮窗口内').toBe(false);
    expect(completedTaskCount(stale)).toBe(1);
  });

  it('全盘总结有正文时才算一条必填项（与 expectedTaskIds 同口径）', () => {
    const withOverview = { ...mk({ [OVERVIEW_TASK_ID]: done(OVERVIEW_TASK_ID) }), aiOverview: analysis('值得注意的年份') };
    expect(expectedTaskIds(withOverview).includes(OVERVIEW_TASK_ID), '前提：总结进了必填清单').toBe(true);
    expect(completedTaskCount(withOverview)).toBe(1);
    // 反向：没写进 aiOverview 时，那条总结任务不算必填，也就不该出现在进度里
    expect(completedTaskCount(mk({ [OVERVIEW_TASK_ID]: done(OVERVIEW_TASK_ID) }))).toBe(0);
  });
});
