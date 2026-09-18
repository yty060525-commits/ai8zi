import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PersonDetail } from '../features/person/PersonDetail';
import { initializeMockSession, resetMockSession } from '../data/clientRepository';
import type { BaziRecord, BaziTaskResult } from '../types/domain';

vi.mock('../data/deepseekAdapter', () => ({ analyzeBazi: vi.fn(), beginAiSession: vi.fn(), cancelAiSession: vi.fn() }));
import { analyzeBazi } from '../data/deepseekAdapter';

const mkTask = (type: BaziTaskResult['task']['type'], year?: number): BaziTaskResult => ({
  task: { taskId: 't-' + Math.random().toString(36).slice(2, 7), type, year },
  status: 'completed',
  analysis: { pattern: type === 'baseline' ? '身弱' : '', strength: '弱', usefulElements: ['水'], avoidElements: ['火'], explanation: '【健康】早睡早起。' },
});
const recordBase: BaziRecord = {
  id: 'tone-person', name: '语气测试', gender: 'male', birthYear: 1990, birthMonth: 1,
  createdAt: '2025-01-01T00:00:00.000Z', yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午',
  aiStatus: 'completed', toneUsed: 80,
  aiTasks: { a: mkTask('baseline'), b: mkTask('annual', 2030) },
};

beforeEach(() => {
  vi.mocked(analyzeBazi).mockResolvedValue({ status: 'completed', analysis: { pattern: '身弱', strength: '弱', usefulElements: ['水'], avoidElements: ['火'], explanation: '按新语气生成。' } });
  initializeMockSession(
    [{ id: 'tone-person', name: '语气测试', nameInitial: 'T', gender: 'male', birthSummary: 'x' }],
    [{ person: { id: 'tone-person', name: '语气测试', nameInitial: 'T', gender: 'male', birthSummary: 'x' }, record: structuredClone(recordBase), aiAnalysis: { status: 'completed' } }],
  );
});
afterEach(() => { cleanup(); resetMockSession(); vi.restoreAllMocks(); try { localStorage.clear(); } catch {} });

describe('拖动语气滑杆后仍可启动 AI 分析', () => {
  it('语气改变→自动清旧结果→点 AI 分析→重新调用', async () => {
    // 预置语气为 60(模拟拖动到 60)，再点 AI 分析
    try { localStorage.setItem('mingli.analysis.tone', '60'); } catch {}
    render(<PersonDetail personId="tone-person" onBack={vi.fn()} />);
    await screen.findByRole('heading', { name: '人物详情' });
    await screen.findByRole('button', { name: 'AI 分析' });

    fireEvent.click(screen.getByRole('button', { name: 'AI 分析' }));
    await waitFor(() => expect(analyzeBazi).toHaveBeenCalled(), { timeout: 5000 });
    const hits = await screen.findAllByText('按新语气生成。');
    expect(hits.length).toBeGreaterThan(0);
  });
});