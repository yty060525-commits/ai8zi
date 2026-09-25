import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { PersonDetail } from '../features/person/PersonDetail';
import { RecordsPage } from '../features/records/RecordsPage';
import { configureBaziRepository, getBaziRecord, initializeMockSession, listBaziRecords, memoryBaziRepository, resetMockSession, saveBaziRecord } from '../data/clientRepository';
import { aiStatusText } from '../data/baziOrchestrator';
import { calculateNonAi } from '../features/chart/nonAiCalculator';
import type { BaziAIAnalysis, BaziRecord, BaziTaskResult } from '../types/domain';

/* 上一轮把「异地 pending 不许锁死按钮」修掉了，但这块状态本身还是只说「分析中」：
   编排器每跑完一条都会落库（PersonDetail 的 onProgress ⇒ saveBaziRecord(step.record)），
   所以「分析中」的盘其实已经有一批正文在库里了。用户看到的却仍是一个没有进度的词 ——
   不知道还要等多久、也不知道再点一次是接着跑还是从头再来。记录列表同理：手机上翻列表时
   只有这一处能看到全局，一行「AI：分析中」什么也没交代。 */

const chart = calculateNonAi(
  { birthYear: 1990, birthMonth: 5, birthDay: 15, yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午' },
  'male', '2025-01-01T00:00:00.000Z');

const analysis = (explanation: string): BaziAIAnalysis => ({ pattern: '正官格', strength: '身强', usefulElements: ['水'], avoidElements: ['火'], explanation });

const doneTask = (id: string): BaziTaskResult => ({ task: { taskId: id, type: 'baseline' }, status: 'completed', analysis: analysis('这一段已批') });

/** 一份「跑到一半」的盘：pending + 前几条已有正文。 */
const halfRun = (name: string, ids: string[]): BaziRecord => ({
  id: 'p1', name, gender: 'male', birthYear: 1990, birthMonth: 5,
  createdAt: '2025-01-01T00:00:00.000Z', yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午',
  nonAiResult: chart, aiStatus: 'pending',
  aiTasks: Object.fromEntries(ids.map((id) => [id, doneTask(id)])),
});

afterEach(() => { cleanup(); resetMockSession(); configureBaziRepository(memoryBaziRepository); });

describe('pending 态要把已完成的条数摆出来', () => {
  it('详情页状态行：分析中要带 x/y', async () => {
    const rec = halfRun('半程盘', ['task-01', 'task-02', 'task-03']);
    initializeMockSession([{ id: 'p1', name: '半程盘', nameInitial: 'B', gender: 'male', birthSummary: '甲子年' }],
      [{ person: { id: 'p1', name: '半程盘', nameInitial: 'B', gender: 'male', birthSummary: '甲子年' }, record: rec, aiAnalysis: { status: 'pending', result: '' } }]);
    render(<PersonDetail personId="p1" onBack={vi.fn()} />);
    const line = await screen.findByText(/^状态：/);
    expect(line.textContent).toMatch(/分析中（3\/\d+）/);
  });

  it('记录列表一行同样带进度，而不是光秃秃的「分析中」', async () => {
    configureBaziRepository({ ...memoryBaziRepository, listBaziRecords: async () => [halfRun('半程盘', ['task-01', 'task-02'])] });
    render(<RecordsPage onOpenPerson={vi.fn()} />);
    const row = await screen.findByRole('button', { name: '查看半程盘' });
    expect(row.textContent).toMatch(/AI：分析中（2\/\d+）/);
  });

  /* 反向钉子：没跑过任何一条时不许写成「（0/23）」——那会让人以为已经在排队了。 */
  it('一条都还没完成时保持原来的「分析中」，不加 0/xx', async () => {
    configureBaziRepository({ ...memoryBaziRepository, listBaziRecords: async () => [halfRun('刚起步', [])] });
    render(<RecordsPage onOpenPerson={vi.fn()} />);
    const row = await screen.findByRole('button', { name: '查看刚起步' });
    expect(row.textContent).toContain('AI：分析中');
    expect(row.textContent).not.toMatch(/分析中（0\//);
  });

  it('已完成/失败的盘不受影响：不出现进度括号', async () => {
    const finished: BaziRecord = { ...halfRun('跑完了', ['task-01']), aiStatus: 'completed' };
    configureBaziRepository({ ...memoryBaziRepository, listBaziRecords: async () => [finished] });
    render(<RecordsPage onOpenPerson={vi.fn()} />);
    const row = await screen.findByRole('button', { name: '查看跑完了' });
    expect(row.textContent).toContain('AI：已完成');
    expect(row.textContent).not.toMatch(/（\d+\/\d+）/);
  });

  /* 线上实测抓到过「列表 2/23、详情 2/24」同屏自相矛盾。根因不是文案各写一份，而是两处读到的
     数据厚薄不同：存储落库时派生数组被瘦身（greatFortunes 变空），详情页走 hydrate 重算补回来、
     分母含大运槽位，列表刻意不重算 ⇒ 少一条大运就少一个槽位。所以这条用例必须真的走一遍
     saveBaziRecord → 存储 → listBaziRecords / getBaziRecord，直接把 rec 递给两个组件是测不出来的。 */
  it('同一份盘存进库里之后：列表与详情的分数仍要逐字相同', async () => {
    const rec = halfRun('两头看', ['task-01', 'task-02', 'task-03', 'task-04']);
    await saveBaziRecord(rec);

    const fromList = await listBaziRecords();
    const fromDetail = await getBaziRecord('p1');
    expect(fromList.length, '前提：库里读得回这一条').toBe(1);
    expect(fromDetail?.nonAiResult?.greatFortunes?.length ?? 0, '前提：详情这条路拿到的是完整盘').toBeGreaterThan(0);
    expect(fromList[0].nonAiResult?.greatFortunes?.length ?? 0, '前提：列表这条路是瘦身后的大运数组').toBe(0);

    const listText = aiStatusText(fromList[0], new Date());
    const detailText = aiStatusText(fromDetail!, new Date());
    expect(detailText, '详情页没给出分数').toMatch(/分析中（4\/\d+）/);
    expect(listText, '两处分数不同源 ⇒ 用户会以为程序数错了').toBe(detailText);

    cleanup();
    render(<RecordsPage onOpenPerson={vi.fn()} />);
    const row = (await screen.findByRole('button', { name: '查看两头看' })).textContent ?? '';
    expect(row).toContain('AI：' + detailText);
  });
});
