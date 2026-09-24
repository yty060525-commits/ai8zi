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
    fireEvent.click(screen.getByRole('button', { name: '手录四柱' })); // 手录路径：先切到「手录四柱」模式
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

  it('按生日自动排盘：填日期时辰即算出四柱并保存，无需手录', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-03-08T12:34:56.000Z'));
    const onRecordCreated = vi.fn();
    render(<ChartPage onRecordCreated={onRecordCreated} />); // 默认即「按生日排」模式
    fireEvent.change(screen.getByLabelText('姓名'), { target: { value: '自动命主' } });
    fireEvent.change(screen.getByLabelText('出生年'), { target: { value: '2000' } });
    fireEvent.change(screen.getByLabelText('出生月'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('出生日'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('时(0–23)'), { target: { value: '8' } });
    fireEvent.change(screen.getByLabelText('分(0–59)'), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: '排盘并保存' }));
    await act(async () => { for (let i = 0; i < 60; i += 1) await Promise.resolve(); });
    // 2000-02-05 立春后 08:00 辰时 → 庚辰 戊寅 癸巳 丙辰
    expect(onRecordCreated).toHaveBeenCalledWith(expect.objectContaining({
      name: '自动命主', birthYear: 2000, birthMonth: 2,
      yearPillar: '庚辰', monthPillar: '戊寅', dayPillar: '癸巳', hourPillar: '丙辰',
      nonAiResult: expect.objectContaining({ dayMaster: '癸' }),
    }));
    vi.useRealTimers();
  });

  it('按生日模式：该日期不存在时提示、且不落库', async () => {
    const onRecordCreated = vi.fn();
    render(<ChartPage onRecordCreated={onRecordCreated} />);
    fireEvent.change(screen.getByLabelText('姓名'), { target: { value: '某人' } });
    fireEvent.change(screen.getByLabelText('出生年'), { target: { value: '2001' } });
    fireEvent.change(screen.getByLabelText('出生月'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('出生日'), { target: { value: '30' } }); // 2 月无 30 日
    fireEvent.click(screen.getByRole('button', { name: '排盘并保存' }));
    await act(async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); });
    expect(screen.getByRole('alert').textContent).toContain('该日期不存在');
    expect(onRecordCreated).not.toHaveBeenCalled();
  });

  it('手录模式仍显示出生年月两栏、隐藏日/时/分', () => {
    render(<ChartPage />);
    expect(screen.getByLabelText('出生日')).toBeTruthy(); // 默认 auto 模式有日栏
    fireEvent.click(screen.getByRole('button', { name: '手录四柱' }));
    expect(screen.queryByLabelText('出生日')).toBeNull();
    expect(screen.queryByLabelText('时(0–23)')).toBeNull();
    expect(screen.getByLabelText('出生月')).toBeTruthy();
  });
});