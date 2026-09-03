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
    expect(writeText.mock.calls.at(-1)?.[0]).toContain('【健康】');
    expect(writeText.mock.calls.at(-1)?.[0]).toContain('【爱情】');
    expect(writeText.mock.calls.at(-1)?.[0]).toContain('本命命局');

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

  it('清除按钮只清除结果与缓存，不重新调用 AI', async () => {
    render(<PersonDetail personId="copy-person" onBack={vi.fn()} />);
    await screen.findByRole('heading', { name: '人物详情' });
    fireEvent.click(screen.getByRole('button', { name: /清除AI结果与缓存/ }));
    await waitFor(() => expect(screen.getByText(/已清除该命盘的 AI 结果与命中缓存/)).toBeTruthy());
    const saved = await listBaziRecords();
    const record = saved.find((item) => item.id === 'copy-person');
    expect(record?.aiStatus).toBe('not_started');
    expect(record?.aiTasks).toBeUndefined();
    expect(record?.aiAnalysis).toBeUndefined();
  });
});

describe('大运标题去掉“起”前缀', () => {
  it('renders decade item as 干支 大运段(区间) without “X 起” prefix', async () => {
    const withDecade: BaziRecord = { ...mockPersonDetails[0].record, nonAiResult: { ...mockPersonDetails[0].record.nonAiResult!, greatFortunes: [{ ganZhi: '庚子', startYear: 2020, endYear: 2029, relationships: { sanHe: [], liuHe: [], chong: [], xing: [], hai: [], po: [], ke: [] } }] }, aiTasks: { 'task-01': { task: { taskId: 'task-01', type: 'decade', year: 2020 }, status: 'completed', analysis: { pattern: '', strength: '', usefulElements: [], avoidElements: [], explanation: '【事业】顺遂。' } } } };
    initializeMockSession(
      [{ id: 'copy-person', name: '复制测试', nameInitial: 'C', gender: 'male', birthSummary: 'x' }],
      [{ person: { id: 'copy-person', name: '复制测试', nameInitial: 'C', gender: 'male', birthSummary: 'x' }, record: withDecade, aiAnalysis: { status: 'completed' } }],
    );
    render(<PersonDetail personId="copy-person" onBack={vi.fn()} />);
    await screen.findByRole('heading', { name: '人物详情' });
    await waitFor(() => expect(document.body.textContent).toContain('庚子 大运段(2025-2029)'));
    expect(document.body.textContent).not.toMatch(/大运：2020|2020 起|2020年起|起（约十年）/);
  });
});