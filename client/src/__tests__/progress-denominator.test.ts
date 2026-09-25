import { describe, expect, it } from 'vitest';

import { aiStatusText, buildBaziTasks, expectedTaskIds, plannedTaskIds } from '../data/baziOrchestrator';
import { calculateNonAi } from '../features/chart/nonAiCalculator';
import type { BaziRecord, BaziTaskResult } from '../types/domain';

/* 线上实测抓到的自相矛盾：同一条盘，记录列表写「分析中（2/23）」、点进详情页写「状态：分析中（2/24）」。
   根因不在我新加的计数，而在分母本身有两个来源 —— buildBaziTasks 只排本命+流年+流月(+大运)，
   「后天调整」(task-30) 与「全盘总结」(task-31) 是编排器跑到中途才 push 进去的。于是任何一处拿
   buildBaziTasks 的长度当总数，都会少算这两条；用户对着两个数字会以为程序数错了。
   plannedTaskIds 把「这一轮最终会跑哪些」一次说清，两处展示都必须走它。 */

const mk = (over: Partial<BaziRecord> = {}): BaziRecord => {
  const pillars = { yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午' };
  const chart = calculateNonAi({ birthYear: 1990, birthMonth: 5, birthDay: 15, ...pillars }, 'male', '2025-01-01T00:00:00.000Z');
  return {
    id: 'p1', name: '分母盘', gender: 'male', birthYear: 1990, birthMonth: 5,
    createdAt: '2025-01-01T00:00:00.000Z', ...pillars, nonAiResult: chart, aiStatus: 'pending', ...over,
  };
};

describe('plannedTaskIds：进度分母的唯一来源', () => {
  /* 实测读数（1990-05-15 甲子/丙寅/庚午/壬午，2026 年看）：
       buildBaziTasks = 24、expectedTaskIds = 24、plannedTaskIds = 25。
     改动前详情页的总数用 buildBaziTasks().length + 2 ⇒ 26（多算一条），
     aiStatusText 第一版用 expectedTaskIds ⇒ 24（少算 task-30）。两个都不对，
     所以这里拼的是**真实清单本身**，不是「比谁多一」这种两头都能过的关系。 */
  it('等于必填清单补上 task-30，且不含总结槽时长度恰为 expected+1', () => {
    const rec = mk();
    const base = expectedTaskIds(rec, new Date());
    const planned = plannedTaskIds(rec, new Date());
    expect(base).not.toContain('task-30');
    expect(planned.filter((id) => id !== 'task-30')).toEqual(base);
    expect(planned).toContain('task-30');
    // 这条盘的时段任务确实排到了 task-24（本命1+流年10+流月12+大运1），不是空清单
    expect(base).toContain('task-24');
  });

  it('既不等于 buildBaziTasks().length，也不等于它 +2 —— 旧的两处猜测都错', () => {
    const rec = mk();
    const naive = buildBaziTasks(rec, new Date()).length;
    const planned = plannedTaskIds(rec, new Date()).length;
    expect(naive, '前提：这份盘没有总结槽').toBe(expectedTaskIds(rec, new Date()).length);
    expect(planned).not.toBe(naive);
    expect(planned).not.toBe(naive + 2);
  });

  it('已有全盘总结时两条都计入，且顺序是时段→调整→总结', () => {
    const rec = mk({ aiOverview: { pattern: '正官格', strength: '身强', usefulElements: [], avoidElements: [], explanation: '总结合成' } });
    const planned = plannedTaskIds(rec, new Date());
    expect(planned[planned.length - 1]).toBe('task-31');
    expect(planned[planned.length - 2]).toBe('task-30');
    expect(planned.length).toBe(expectedTaskIds(rec, new Date()).length + 1);
  });

  it('不重复：task-30 不会因为同时存在 aiTasks 里就出现两次', () => {
    const rec = mk({ aiTasks: { 'task-30': { task: { taskId: 'task-30', type: 'adjustment' }, status: 'completed', analysis: { pattern: '', strength: '', usefulElements: [], avoidElements: [], explanation: '已调整' } } } });
    const planned = plannedTaskIds(rec, new Date());
    expect(planned.filter((id) => id === 'task-30')).toHaveLength(1);
  });

  /* 反向钉子：早退判定必须继续用 expectedTaskIds。若有人图省事把两边都换成 plannedTaskIds，
     「完整就跑完」永远判不出来 ⇒ 每次点 AI 分析都整轮重算，那是真金白银。这条用例钉住差异。 */
  it('expectedTaskIds 仍不含 task-30：完整性早退判定不许改用带调整的清单', () => {
    expect(expectedTaskIds(mk(), new Date())).not.toContain('task-30');
  });

  /* 用户读到的是 aiStatusText 里那个数字，不是函数之间的相等关系。
     所以直接钉**字面量**：改动前它是 expectedTaskIds(24) —— 少算一条；
     再往前详情页用 buildBaziTasks+2 (26) —— 多算一条。两种都该被这条用例杀掉。 */
  it('界面上那句分数就是 2/25：分子是已完成条数，分母含 task-30', () => {
    const done = (id: string): [string, BaziTaskResult] => [id, { task: { taskId: id, type: 'baseline' }, status: 'completed', analysis: { pattern: '', strength: '', usefulElements: [], avoidElements: [], explanation: '有正文' } }];
    const rec = mk({ aiTasks: Object.fromEntries([done('task-01'), done('task-02')]) });
    expect(aiStatusText(rec, new Date())).toBe('分析中（2/25）');
  });
});
