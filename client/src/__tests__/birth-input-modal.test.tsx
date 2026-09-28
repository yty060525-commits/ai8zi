import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { BirthInputModal } from '../features/chart/BirthInputModal';

afterEach(cleanup);

describe('BirthInputModal', () => {
  it('collects four pillars as plain two-character values', () => {
    const onSubmit = vi.fn();
    render(<BirthInputModal open onClose={vi.fn()} onSubmit={onSubmit} />);

    expect(screen.getByRole('dialog', { name: '四柱八字' })).toBeTruthy();
    for (const [label, value] of [['年柱', '甲子'], ['月柱', '丙寅'], ['日柱', '庚午'], ['时柱', '壬午']] as const) {
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
    }
    fireEvent.click(screen.getByRole('button', { name: '提交' }));

    expect(onSubmit).toHaveBeenCalledWith({ yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午' });
  });

  it('rejects pillars that are not exactly one stem and one branch', () => {
    const onSubmit = vi.fn();
    render(<BirthInputModal open onClose={vi.fn()} onSubmit={onSubmit} />);
    for (const [label, value] of [['年柱', '甲'], ['月柱', '丙寅'], ['日柱', '庚午'], ['时柱', '壬午']] as const) {
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
    }
    fireEvent.click(screen.getByRole('button', { name: '提交' }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('四柱');
  });

  it('缺柱时点名缺哪一柱，不再静默无反应', () => {
    const onSubmit = vi.fn();
    render(<BirthInputModal open onClose={vi.fn()} onSubmit={onSubmit} />);
    fireEvent.change(screen.getByLabelText('年柱'), { target: { value: '甲子' } });
    fireEvent.submit(screen.getByRole('button', { name: '提交' }).closest('form')!);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('月柱');
  });

  it('不成柱(干支阴阳不合)当场指出是哪一柱', () => {
    const onSubmit = vi.fn();
    render(<BirthInputModal open onClose={vi.fn()} onSubmit={onSubmit} />);
    // 乙丑合法；甲丑(阳干配阴支)在六十甲子里不存在
    for (const [label, value] of [['年柱', '甲丑'], ['月柱', '丙寅'], ['日柱', '庚午'], ['时柱', '壬午']] as const) {
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
    }
    fireEvent.click(screen.getByRole('button', { name: '提交' }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toMatch(/年柱.*甲丑.*不成柱/);
  });

  it('整串录入自动拆分，且忽略粘贴进来的空格标点', () => {
    const onSubmit = vi.fn();
    render(<BirthInputModal open onClose={vi.fn()} onSubmit={onSubmit} />);
    fireEvent.change(screen.getByLabelText(/八字整串/), { target: { value: '甲子 丙寅、戊辰\n庚申' } });
    for (const [label, value] of [['年柱', '甲子'], ['月柱', '丙寅'], ['日柱', '戊辰'], ['时柱', '庚申']] as const) {
      expect((screen.getByLabelText(label) as HTMLInputElement).value).toBe(value);
    }
    fireEvent.click(screen.getByRole('button', { name: '提交' }));
    expect(onSubmit).toHaveBeenCalledWith({ yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '戊辰', hourPillar: '庚申' });
  });

  it('单柱输入只留合法干支字，多余的被过滤掉', () => {
    render(<BirthInputModal open onClose={vi.fn()} onSubmit={vi.fn()} />);
    const year = screen.getByLabelText('年柱') as HTMLInputElement;
    fireEvent.change(year, { target: { value: '甲a子99X' } });
    expect(year.value).toBe('甲子');
  });

  it('排盘引擎的校验错误显示在弹窗里(弹窗未关时页面级错误看不见)', () => {
    render(<BirthInputModal open onClose={vi.fn()} onSubmit={vi.fn()} error="该月找不到与这三部命盘对应的日期，请核对四柱或出生日期" />);
    expect(screen.getByRole('alert').textContent).toContain('该月找不到');
  });
});
