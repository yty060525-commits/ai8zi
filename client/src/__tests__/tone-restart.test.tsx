import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PersonDetail } from '../features/person/PersonDetail';
import { getBaziRecord, initializeMockSession, resetMockSession } from '../data/clientRepository';
import type { BaziRecord, BaziTaskResult } from '../types/domain';

vi.mock('../data/deepseekAdapter', () => ({ analyzeBazi: vi.fn(), beginAiSession: vi.fn(), cancelAiSession: vi.fn() }));
import { analyzeBazi } from '../data/deepseekAdapter';

const ID = 'tone-person';
const ID2 = 'tone-person-2';
const TONE_GLOBAL = 'mingli.analysis.tone';
const prefKey = (id: string) => TONE_GLOBAL + '.' + id;
const ranKey = (id: string) => TONE_GLOBAL + '.' + id + '.ran';

const mkTask = (type: BaziTaskResult['task']['type'], year?: number): BaziTaskResult => ({
  task: { taskId: 't-' + Math.random().toString(36).slice(2, 7), type, year },
  status: 'completed',
  analysis: { pattern: type === 'baseline' ? '身弱' : '', strength: '弱', usefulElements: ['水'], avoidElements: ['火'], explanation: '【健康】早睡早起。' },
});
const recordBase: BaziRecord = {
  id: ID, name: '语气测试', gender: 'male', birthYear: 1990, birthMonth: 1,
  createdAt: '2025-01-01T00:00:00.000Z', yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午',
  aiStatus: 'completed',
  aiTasks: { a: mkTask('baseline'), b: mkTask('annual', 2030) },
};

/* 任务 id 由窗口算出(task-01 本命、task-02.. 流年、task-12.. 流月、task-24 大运)，
   缺一或错一位都会被当成「结果不完整」而重新调用 AI。用来构造「完整」的存盘结果。 */
const fullTasks = (): Record<string, BaziTaskResult> => {
  const now = new Date();
  const years = Array.from({ length: 10 }, (_, i) => now.getFullYear() + i);
  const done = (taskId: string, type: BaziTaskResult['task']['type'], year?: number): [string, BaziTaskResult] => [taskId, {
    task: { taskId, type, year } as BaziTaskResult['task'],
    status: 'completed',
    analysis: { pattern: '', strength: '', usefulElements: [], avoidElements: [], explanation: '【健康】早睡早起。' },
  }];
  return Object.fromEntries([
    done('task-01', 'baseline'),
    ...years.map((y, i) => done(`task-${String(i + 2).padStart(2, '0')}`, 'annual', y)),
    ...Array.from({ length: 12 }, (_, i) => { const off = now.getMonth() + i; return done(`task-${String(i + 12).padStart(2, '0')}`, 'monthly', now.getFullYear() + Math.floor(off / 12)); }),
    done('task-24', 'decade', years[9] + 1),
  ]);
};
const seed = (rec: BaziRecord) => initializeMockSession(
  [{ id: rec.id, name: rec.name, nameInitial: 'T', gender: rec.gender, birthSummary: 'x' }],
  [{ person: { id: rec.id, name: rec.name, nameInitial: 'T', gender: rec.gender, birthSummary: 'x' }, record: structuredClone(rec), aiAnalysis: { status: 'completed' } }],
);

beforeEach(() => {
  vi.mocked(analyzeBazi).mockResolvedValue({ status: 'completed', analysis: { pattern: '身弱', strength: '弱', usefulElements: ['水'], avoidElements: ['火'], explanation: '按新语气生成。' } });
});
afterEach(() => { cleanup(); resetMockSession(); vi.restoreAllMocks(); try { localStorage.clear(); } catch {} });

describe('语气滑杆跟本机走，不写进会同步的 record', () => {
  it('结果不完整时点 AI 分析会重算；且写回的记录不带 toneUsed(不污染同步)', async () => {
    seed(recordBase);   // 无 toneUsed
    render(<PersonDetail personId={ID} onBack={vi.fn()} />);
    await screen.findByRole('button', { name: 'AI 分析' });
    fireEvent.click(screen.getByRole('button', { name: 'AI 分析' }));
    await waitFor(() => expect(analyzeBazi).toHaveBeenCalled(), { timeout: 5000 });
    await screen.findAllByText('按新语气生成。');
    const saved = await getBaziRecord(ID);
    expect(saved?.toneUsed, '语气被写进了会同步的 record —— 这正是「这边调低、别人那也低」的通路').toBeUndefined();
  });

  it('同设备拖动甲的语气，不会串到乙的滑杆', async () => {
    seed(recordBase);
    render(<PersonDetail personId={ID} onBack={vi.fn()} />);
    const slider = await screen.findByRole('slider');
    fireEvent.change(slider, { target: { value: '30' } });
    expect(slider.getAttribute('aria-valuetext')).toContain('犀利');
    cleanup();
    // 乙是另一条盘、本机从没设过 → 仍显示全局默认 80，不受甲影响
    seed({ ...recordBase, id: ID2, name: '语气测试2' });
    render(<PersonDetail personId={ID2} onBack={vi.fn()} />);
    const s2 = await screen.findByRole('slider');
    expect((s2 as HTMLInputElement).value, '甲滑到 30 后乙被串成 30').toBe('80');
    expect(localStorage.getItem(TONE_GLOBAL), '拖动甲时不该再动全局键').toBeNull();
  });

  it('重跑判定读本机 ran 键，不看 record.toneUsed', async () => {
    try { localStorage.setItem(ranKey(ID), '55'); } catch {}
    seed({ ...recordBase, aiTasks: fullTasks() });   // 完整结果，record 无 toneUsed
    render(<PersonDetail personId={ID} onBack={vi.fn()} />);
    const slider = await screen.findByRole('slider');
    expect((slider as HTMLInputElement).value).toBe('55');   // 来自本机 ran，而非 record
    vi.mocked(analyzeBazi).mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'AI 分析' }));
    await waitFor(() => expect(screen.getByText(/已存在该语气下的完整分析结果/)).toBeTruthy());
    expect(analyzeBazi, '本机语气与上次一致却被重算').not.toHaveBeenCalled();
  });

  it('换设备/同步来的盘：进度条显示本机默认而非 record.toneUsed，且点分析不误清重算', async () => {
    try { localStorage.setItem(TONE_GLOBAL, '80'); } catch {}   // 本机全局偏好 80
    // 别的设备用 55 跑过、record.toneUsed=55 同步过来；本机从没跑过(无 ran/pref)
    seed({ ...recordBase, toneUsed: 55, aiTasks: fullTasks() });
    render(<PersonDetail personId={ID} onBack={vi.fn()} />);
    const slider = await screen.findByRole('slider');
    expect((slider as HTMLInputElement).value, '本机没选过的盘被同步来的 toneUsed 拽到 55 = 就是用户投诉的“别人那也调低”').toBe('80');
    vi.mocked(analyzeBazi).mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'AI 分析' }));
    await waitFor(() => expect(screen.getByText(/已存在该语气下的完整分析结果/)).toBeTruthy());
    expect(analyzeBazi, '本机没跑过却被当成“改语气”整轮清掉重算').not.toHaveBeenCalled();
  });
});
