import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react';
import { App } from '../App';
import { ChartPage } from '../features/chart/ChartPage';
import '../features/chart/nonAiCalculator'; // 预载引擎(缓存)，让页面内的按需加载立即命中
import { initializeMockSession, listBaziRecords, resetMockSession } from '../data/clientRepository';
import { mockPeople, mockPersonDetails } from './fixtures/mockData';
import { analyzeBazi } from '../data/deepseekAdapter';

vi.mock('../data/deepseekAdapter', () => ({ analyzeBazi: vi.fn(), beginAiSession: vi.fn(), cancelAiSession: vi.fn() }));

describe('simplified chart application flow', () => {
  beforeEach(() => { initializeMockSession(mockPeople, mockPersonDetails); vi.mocked(analyzeBazi).mockResolvedValue({ status: 'not_configured' }); });
  afterEach(() => { cleanup(); resetMockSession(); });

  it('navigates between the empty chart form and records', () => {
    resetMockSession();
    render(<App />);
    expect(screen.queryByText(/额度|费用|排盘状态|基础排盘结果/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '记录' }));
    expect(screen.getByRole('status').textContent).toContain('还没有保存任何记录');
    fireEvent.click(screen.getByRole('button', { name: '排盘' }));
    expect(screen.getByRole('heading', { name: '排盘' })).toBeTruthy();
  });

  it('accepts only manually entered four pillars and emits a record', async () => {
    const onRecordCreated = vi.fn();
    render(<ChartPage onRecordCreated={onRecordCreated} />);
    fireEvent.change(screen.getByLabelText('姓名'), { target: { value: '测试用户' } });
    fireEvent.change(screen.getByLabelText('出生年'), { target: { value: '1984' } });
    fireEvent.change(screen.getByLabelText('出生月'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: '录入四柱八字' }));
    for (const [label, value] of [['年柱', '甲子'], ['月柱', '丙寅'], ['日柱', '庚午'], ['时柱', '壬午']] as const)
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
    fireEvent.click(screen.getByRole('button', { name: '提交' }));
    await act(async () => { for (let i = 0; i < 60; i += 1) await Promise.resolve(); });
    expect(onRecordCreated).toHaveBeenCalledWith(expect.objectContaining({ name: '测试用户', yearPillar: '甲子' }));
  });

  it('opens a person detail view with only record and AI sections', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '记录' }));
    fireEvent.click(await screen.findByRole('button', { name: '查看张伟' }));
    expect(await screen.findByRole('heading', { name: '人物详情' })).toBeTruthy();
    expect(await screen.findByRole('region', { name: '基础信息' })).toBeTruthy();
    expect(await screen.findByRole('region', { name: 'AI 分析' })).toBeTruthy();
    expect(await screen.findByText('状态：已完成')).toBeTruthy();
    expect(screen.getByText('适合稳步推进长期计划。')).toBeTruthy();
    expect(screen.getByText('出生年')).toBeTruthy();
    expect(screen.getByText('出生月')).toBeTruthy();
    expect(screen.getByText('年柱')).toBeTruthy();
    expect(screen.getByText('月柱')).toBeTruthy();
    expect(screen.getByText('日柱')).toBeTruthy();
    expect(screen.getByText('时柱')).toBeTruthy();
    expect(screen.getByText('日主')).toBeTruthy();
    expect(screen.getByText('五行')).toBeTruthy();
    expect(screen.getByText('公历日期')).toBeTruthy();
    expect(screen.getByText('五行比例')).toBeTruthy();
    expect(screen.getByText('藏干')).toBeTruthy();
    expect(screen.getByText('藏干十神')).toBeTruthy();
    expect(screen.getByText('十神')).toBeTruthy();
    expect(screen.getByText('纳音')).toBeTruthy();
    expect(screen.getByText('十二长生')).toBeTruthy();
    expect(screen.getByText('神煞')).toBeTruthy();
    expect(screen.queryByText('称骨')).toBeNull();
    expect(screen.queryByText('行动改变')).toBeNull();
    expect(screen.queryByText('运势')).toBeNull();
    expect(screen.queryByText('提问')).toBeNull();
  });

  it('copies the displayed basic record text without legacy detail fields', async () => {
    const writeText = vi.fn();
    Object.assign(navigator, { clipboard: { writeText } });
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '记录' }));
    fireEvent.click(await screen.findByRole('button', { name: '查看张伟' }));
    await screen.findByRole('button', { name: '复制基础信息' });
    fireEvent.click(screen.getByRole('button', { name: '复制基础信息' }));
    const copied = writeText.mock.lastCall?.[0] as string;
    expect(copied).toContain('姓名：张伟');
    expect(copied).toContain('出生年：1990');
    expect(copied).toContain('年柱：甲子');
    expect(copied).not.toContain('行动建议');
    expect(copied).not.toContain('甲戌大运');
  });

  it('saves a submitted record, refreshes records, and opens its stored detail', async () => {
    resetMockSession();
    render(<App />);
    fireEvent.change(screen.getByLabelText('姓名'), { target: { value: '新记录' } });
    fireEvent.change(screen.getByLabelText('出生年'), { target: { value: '1984' } });
    fireEvent.change(screen.getByLabelText('出生月'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: '录入四柱八字' }));
    for (const [label, value] of [['年柱', '甲子'], ['月柱', '丙寅'], ['日柱', '庚午'], ['时柱', '壬午']] as const)
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
    fireEvent.click(screen.getByRole('button', { name: '提交' }));

    await waitFor(() => expect(screen.getByRole('heading', { name: '记录' })).toBeTruthy());
    await screen.findByText('新记录');
    fireEvent.click(screen.getByRole('button', { name: '查看新记录' }));
    await screen.findByRole('heading', { name: '人物详情' });
    expect(screen.getByText('甲子')).toBeTruthy();
    expect(screen.getByText('状态：未开始')).toBeTruthy();
    expect(screen.getByText('日主')).toBeTruthy();
    expect(screen.getByText('生肖关系')).toBeTruthy();
    expect(screen.getByText('五行')).toBeTruthy();
    expect(screen.queryByText(/分类|运势|行动改变|提问/)).toBeNull();
    expect(screen.getByText('袁天罡称骨')).toBeTruthy();
  });

  it('does not call AI when a record is created', async () => {
    resetMockSession();
    render(<App />);
    fireEvent.change(screen.getByLabelText('姓名'), { target: { value: '仅保存记录' } });
    fireEvent.change(screen.getByLabelText('出生年'), { target: { value: '1984' } });
    fireEvent.change(screen.getByLabelText('出生月'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: '录入四柱八字' }));
    for (const [label, value] of [['年柱', '甲子'], ['月柱', '丙寅'], ['日柱', '庚午'], ['时柱', '壬午']] as const)
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
    fireEvent.click(screen.getByRole('button', { name: '提交' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: '记录' })).toBeTruthy());
    expect(analyzeBazi).not.toHaveBeenCalled();
    expect((await listBaziRecords())[0]?.aiStatus).toBe('not_started');
  });

  it('requests AI only from detail and deletes one record', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '记录' }));
    fireEvent.click(await screen.findByRole('button', { name: '查看张伟' }));
    expect(await screen.findByRole('button', { name: 'AI 分析' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '删除数据' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'AI 分析' }));
    await waitFor(() => expect(analyzeBazi).toHaveBeenCalledWith(expect.objectContaining({ id: 'zhang-wei' }), expect.objectContaining({ taskId: 'task-01' }), expect.anything()));
    fireEvent.click(screen.getByRole('button', { name: '删除数据' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: '记录' })).toBeTruthy());
    expect(screen.queryByText('张伟')).toBeNull();
  });

  it('shows completed AI analysis after the detail action finishes', async () => {
    vi.mocked(analyzeBazi).mockResolvedValue({ status: 'completed', analysis: { pattern: '从财格', strength: '身弱', usefulElements: ['木'], avoidElements: ['金'], explanation: '完成的分析结果' } });
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '记录' }));
    fireEvent.click(await screen.findByRole('button', { name: '查看张伟' }));
    fireEvent.click(await screen.findByRole('button', { name: 'AI 分析' }));

    expect((await screen.findAllByText('完成的分析结果')).length).toBeGreaterThan(0);
    expect(screen.getByText('状态：已完成')).toBeTruthy();
  });

  it('recalculates non-AI data in place and clears prior AI state without calling AI', async () => {
    vi.mocked(analyzeBazi).mockClear();
    initializeMockSession([mockPeople[0]], [{ ...mockPersonDetails[0], record: { ...mockPersonDetails[0].record, birthYear: 1984, birthMonth: 2, aiTasks: { old: { task: { taskId: 'old', type: 'baseline' }, status: 'completed' } } } }]);
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '记录' }));
    fireEvent.click(await screen.findByRole('button', { name: '查看张伟' }));
    fireEvent.click(await screen.findByRole('button', { name: '重新计算非 AI' }));

    expect(await screen.findByText('非 AI 已重新计算')).toBeTruthy();
    const saved = await listBaziRecords();
    const record = saved.find((item) => item.id === 'zhang-wei');
    expect(record?.nonAiResult).toBeDefined();
    expect(record?.aiStatus).toBe('not_started');
    expect(record?.aiAnalysis).toBeUndefined();
    expect(record?.aiOverview).toBeUndefined();
    expect(record?.aiTasks).toBeUndefined();
    expect(analyzeBazi).not.toHaveBeenCalled();
  });

  it('shows the saved safe reason when AI analysis fails', async () => {
    vi.mocked(analyzeBazi).mockResolvedValue({ status: 'failed', error: 'HTTP 503' });
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '记录' }));
    fireEvent.click(await screen.findByRole('button', { name: '查看张伟' }));
    fireEvent.click(await screen.findByRole('button', { name: 'AI 分析' }));

    expect(await screen.findByText('原因：HTTP 503')).toBeTruthy();
    expect(screen.queryByText(/API|DeepSeek|模型|Bearer|sk-/i)).toBeNull();
  });

  it('keeps detailed non-AI data but hides ten-year lists and separates zodiac relations', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '记录' }));
    fireEvent.click(await screen.findByRole('button', { name: '查看张伟' }));
    expect(await screen.findByText('公历日期')).toBeTruthy();
    expect(screen.queryByText('农历日期')).toBeNull();
    expect(screen.queryByText('未来十年')).toBeNull();
    expect(screen.getByRole('region', { name: '生肖关系' })).toBeTruthy();
    expect(screen.getByText('破')).toBeTruthy();
    expect(screen.getByRole('group', { name: '神煞' })).toBeTruthy();
    expect(screen.getByText('适合稳步推进长期计划。')).toBeTruthy();
  });

});