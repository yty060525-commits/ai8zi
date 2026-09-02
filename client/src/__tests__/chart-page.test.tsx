import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ChartPage } from '../features/chart/ChartPage';
import '../features/chart/nonAiCalculator'; // 预载引擎(缓存)，让页面内的按需加载立即命中

afterEach(cleanup);

describe('ChartPage simplified form', () => {
  it('only exposes name, gender, birth year, and birth month', () => {
    render(<ChartPage />);
    expect(screen.getByLabelText('姓名')).toBeTruthy();
    expect(screen.getByLabelText('出生年')).toBeTruthy();
    expect(screen.getByLabelText('出生月')).toBeTruthy();
    expect(screen.getByRole('group', { name: '性别' })).toBeTruthy();
    expect(screen.queryByText('分类')).toBeNull();
    expect(screen.queryByRole('button', { name: /公历|农历/ })).toBeNull();
    expect(screen.queryByText(/额度|费用|基础排盘结果|排盘状态/)).toBeNull();
  });

  it('submits a typed record, closes the modal, and requests records navigation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-03-08T12:34:56.000Z'));
    const onRecordCreated = vi.fn();
    render(<ChartPage onRecordCreated={onRecordCreated} />);
    fireEvent.change(screen.getByLabelText('姓名'), { target: { value: '测试用户' } });
    fireEvent.change(screen.getByLabelText('出生年'), { target: { value: '1984' } });
    fireEvent.change(screen.getByLabelText('出生月'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: '录入四柱八字' }));
    for (const [label, value] of [['年柱', '甲子'], ['月柱', '丙寅'], ['日柱', '庚午'], ['时柱', '壬午']] as const) {
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
    }
    fireEvent.click(screen.getByRole('button', { name: '提交' }));
    await act(async () => { for (let i = 0; i < 60; i += 1) await Promise.resolve(); }); // 等待按需加载引擎的微任务完成
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onRecordCreated).toHaveBeenCalledWith(expect.objectContaining({ name: '测试用户', gender: 'male', birthYear: 1984, birthMonth: 2, yearPillar: '甲子', createdAt: '2025-03-08T12:34:56.000Z', nonAiResult: expect.objectContaining({ dayMaster: '庚' }) }));
    vi.useRealTimers();
  });
});