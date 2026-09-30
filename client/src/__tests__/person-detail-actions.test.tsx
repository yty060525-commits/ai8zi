import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PersonDetail } from '../features/person/PersonDetail';
import { initializeMockSession, listBaziRecords, resetMockSession } from '../data/clientRepository';
import { mockPersonDetails } from './fixtures/mockData';
import type { BaziRecord, BaziTaskResult } from '../types/domain';

const task = (taskId: string, type: BaziTaskResult['task']['type'], explanation: string): BaziTaskResult => ({
  task: { taskId, type },
  status: 'completed',
  analysis: { pattern: '', strength: '', usefulElements: [], avoidElements: [], explanation, title: type === 'annual' ? '鸳鸯戏水' : undefined },
});

const baseRecord: BaziRecord = {
  id: 'copy-person', name: '复制测试', gender: 'male', birthYear: 1990, birthMonth: 1,
  createdAt: '2025-01-01T00:00:00.000Z', yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午',
  aiStatus: 'completed',
  aiTasks: {
    'task-01': task('task-01', 'baseline', '【健康】注意睡眠。\n【爱情】长久相合。'),
    'task-02': task('task-02', 'annual', '【健康】作息规律。\n【爱情】红鸾星动。'),
  },
};

beforeEach(() => {
  initializeMockSession(
    [{ id: 'copy-person', name: '复制测试', nameInitial: 'C', gender: 'male', birthSummary: '甲子年' }],
    [{ person: { id: 'copy-person', name: '复制测试', nameInitial: 'C', gender: 'male', birthSummary: '甲子年' }, record: structuredClone(baseRecord), aiAnalysis: { status: 'completed', result: 'x' } }],
  );
});
afterEach(() => { cleanup(); resetMockSession(); });

describe('PersonDetail AI 复制筛选/清除交互', () => {
  it('copies selected scope results filtered by checked dimensions', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<PersonDetail personId="copy-person" onBack={vi.fn()} />);
    await screen.findByRole('heading', { name: '人物详情' });
    await screen.findByRole('button', { name: /复制勾选内容/ });

    // 默认全勾：范围(2) x 维度(全部) → 复制含【健康】【爱情】
    fireEvent.click(screen.getByRole('button', { name: /复制勾选内容/ }));
    const first = writeText.mock.calls.at(-1)?.[0] as string;
    expect(first).toContain('【健康】');
    expect(first).toContain('【爱情】');
    expect(first).toContain('本命命局');
    // 正式版口径：导出的文档整篇只许中文 —— 应用自己拼的分组表头/范围标题也不能留数字与半角符号。
    expect(first).not.toMatch(/[A-Za-z]/);
    expect(first).not.toMatch(/[0-9０-９•·()（）《》\/\\@#%&*+=<>{}|~^—\-]/);
    expect(first).toContain('未来十年每年流年');
    // 「本命命局」那行带着清洗后的范围标题，末尾正好是「…格局喜忌」；断句判据要精确到行首。
    expect(first.split('\n')).not.toContain('年流年');

    // 取消勾选“爱情”维度 → 复制不再含【爱情】
    fireEvent.click(screen.getAllByRole('button', { name: '爱情' })[0]);
    fireEvent.click(screen.getByRole('button', { name: /复制勾选内容/ }));
    const second = writeText.mock.calls.at(-1)?.[0] as string;
    expect(second).toContain('【健康】');
    expect(second).not.toContain('【爱情】');

    // 范围全清 → 0 项提示
    fireEvent.click(screen.getAllByRole('button', { name: '清空' })[0]);
    fireEvent.click(screen.getByRole('button', { name: /复制勾选内容/ }));
    await waitFor(() => expect(screen.getByText(/已复制 0 项结果/)).toBeTruthy());
  });

  it('带年份的范围标题复制出去翻成中文读法，不留阿拉伯数字与断句', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const dated = structuredClone(baseRecord);
    (dated.aiTasks as Record<string, BaziTaskResult>)['task-02'].task.year = 2026;
    initializeMockSession(
      [{ id: 'copy-person', name: '复制测试', nameInitial: 'C', gender: 'male', birthSummary: '甲子年' }],
      [{ person: { id: 'copy-person', name: '复制测试', nameInitial: 'C', gender: 'male', birthSummary: '甲子年' }, record: dated, aiAnalysis: { status: 'completed' } }],
    );
    render(<PersonDetail personId="copy-person" onBack={vi.fn()} />);
    await screen.findByRole('button', { name: /复制勾选内容/ });
    fireEvent.click(screen.getByRole('button', { name: /复制勾选内容/ }));
    const out = writeText.mock.calls.at(-1)?.[0] as string;
    expect(out).toContain('二零二六年流年');
    expect(out).not.toMatch(/[0-9]/);
    expect(out.split('\n')).not.toContain('年流年');
    // 屏幕上的 <summary> 仍按原样显示年份，两种写法各归各路：
    expect(document.body.textContent).toContain('2026 年流年');
  });

  it('清除按钮只清除结果与缓存，不重新调用 AI', async () => {
    render(<PersonDetail personId="copy-person" onBack={vi.fn()} />);
    await screen.findByRole('heading', { name: '人物详情' });
    fireEvent.click(screen.getByRole('button', { name: /清除AI结果与缓存/ }));
    await waitFor(() => expect(screen.getByText(/已清除该命盘的 AI 结果/)).toBeTruthy());
    const saved = await listBaziRecords();
    const record = saved.find((item) => item.id === 'copy-person');
    expect(record?.aiStatus).toBe('not_started');
    expect(record?.aiTasks).toBeUndefined();
    expect(record?.aiAnalysis).toBeUndefined();
  });
});

describe('大运标题去掉“起”前缀', () => {
  it('renders decade item as 干支 大运段(区间) without “X 起” prefix', async () => {
    const withDecade: BaziRecord = { ...mockPersonDetails[0].record, createdAt: new Date(Date.UTC(2025, 0, 1)).toISOString(), nonAiResult: { ...mockPersonDetails[0].record.nonAiResult!, greatFortunes: [{ ganZhi: '庚子', startYear: 2020, endYear: 2029, relationships: { sanHe: [], liuHe: [], chong: [], xing: [], hai: [], po: [], ke: [] } }] }, aiTasks: { 'task-01': { task: { taskId: 'task-01', type: 'decade', year: 2020 }, status: 'completed', analysis: { pattern: '', strength: '', usefulElements: [], avoidElements: [], explanation: '【事业】顺遂。' } } } };
    initializeMockSession(
      [{ id: 'copy-person', name: '复制测试', nameInitial: 'C', gender: 'male', birthSummary: 'x' }],
      [{ person: { id: 'copy-person', name: '复制测试', nameInitial: 'C', gender: 'male', birthSummary: 'x' }, record: withDecade, aiAnalysis: { status: 'completed' } }],
    );
    render(<PersonDetail personId="copy-person" onBack={vi.fn()} />);
    await screen.findByRole('heading', { name: '人物详情' });
    await waitFor(() => expect(document.body.textContent).toContain('庚子 大运段(2026-2029)'));
    // 起止只显示「未来十年」窗口内的范围：本运 2020-2029 与窗口 [2026,2035] 的交集是 2026-2029。
    expect(document.body.textContent).not.toMatch(/大运：2020|2020 起|2020年起|起（约十年）/);
  });
});