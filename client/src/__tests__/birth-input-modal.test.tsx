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

  it('composition 预编辑保留已输前缀和当前候选，并在确认后拆成四柱', () => {
    render(<BirthInputModal open onClose={vi.fn()} onSubmit={vi.fn()} />);
    const input = screen.getByLabelText(/八字整串/) as HTMLInputElement;
    let prefix = '';
    for (const pair of ['甲子', '丙寅', '戊辰', '庚申']) {
      fireEvent.compositionStart(input);
      const draft = prefix + pair[0] + 'p';
      fireEvent.change(input, { target: { value: draft } });
      expect(input.value).toBe(draft);
      const value = prefix + pair;
      fireEvent.compositionEnd(input, { data: pair });
      fireEvent.change(input, { target: { value } });
      prefix = value;
      expect(input.value).toBe(prefix);
    }
    for (const [label, value] of [['年柱', '甲子'], ['月柱', '丙寅'], ['日柱', '戊辰'], ['时柱', '庚申']] as const) {
      expect((screen.getByLabelText(label) as HTMLInputElement).value).toBe(value);
    }
    expect(input.maxLength).toBe(-1);
  });

  it('非 composition 分次录入整串和单柱时保留前缀与其他柱', () => {
    const onSubmit = vi.fn();
    render(<BirthInputModal open onClose={vi.fn()} onSubmit={onSubmit} />);
    const combined = screen.getByLabelText(/八字整串/) as HTMLInputElement;
    for (const value of ['甲子', '甲子丙寅', '甲子丙寅戊辰', '甲子丙寅戊辰庚申']) {
      fireEvent.change(combined, { target: { value } });
      expect(combined.value).toBe(value);
    }
    const year = screen.getByLabelText('年柱') as HTMLInputElement;
    fireEvent.change(year, { target: { value: '甲' } });
    expect(year.value).toBe('甲');
    fireEvent.change(year, { target: { value: '甲子' } });
    expect(year.value).toBe('甲子');
    expect(combined.value).toBe('');
    expect((screen.getByLabelText('月柱') as HTMLInputElement).value).toBe('丙寅');
    expect((screen.getByLabelText('日柱') as HTMLInputElement).value).toBe('戊辰');
    expect((screen.getByLabelText('时柱') as HTMLInputElement).value).toBe('庚申');
    fireEvent.click(screen.getByRole('button', { name: '提交' }));
    expect(onSubmit).toHaveBeenCalledWith({ yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '戊辰', hourPillar: '庚申' });
  });

  it('compositionEnd 的完整最终 target.value 过滤并截八字，无尾随 change 也拆柱且重复 change 幂等', () => {
    render(<BirthInputModal open onClose={vi.fn()} onSubmit={vi.fn()} />);
    const input = screen.getByLabelText(/八字整串/) as HTMLInputElement;
    const finalValue = '甲p子丙寅戊辰庚申乙丑';
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: '甲子丙寅' } });
    fireEvent.compositionEnd(input, { target: { value: finalValue }, data: finalValue });
    expect(input.value).toBe('甲子丙寅戊辰庚申');
    const expected = [['年柱', '甲子'], ['月柱', '丙寅'], ['日柱', '戊辰'], ['时柱', '庚申']] as const;
    for (const [label, value] of expected) expect((screen.getByLabelText(label) as HTMLInputElement).value).toBe(value);
    fireEvent.change(input, { target: { value: finalValue } });
    expect(input.value).toBe('甲子丙寅戊辰庚申');
    for (const [label, value] of expected) expect((screen.getByLabelText(label) as HTMLInputElement).value).toBe(value);
  });

  it('composition Enter 不提交，候选确认后仍可正常点击提交', () => {
    const onSubmit = vi.fn();
    render(<BirthInputModal open onClose={vi.fn()} onSubmit={onSubmit} initial={{ yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '戊辰', hourPillar: '庚申' }} />);
    const input = screen.getByLabelText(/八字整串/) as HTMLInputElement;
    const finalValue = '甲子丙寅戊辰庚申';
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: finalValue + 'p' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true, keyCode: 229 });
    fireEvent.submit(input.closest('form')!);
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.compositionEnd(input, { data: finalValue });
    fireEvent.change(input, { target: { value: finalValue } });
    fireEvent.click(screen.getByRole('button', { name: '提交' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('候选 Enter 先结束 composition 再触发表单仍被拦，结束后的普通 Enter 可提交', async () => {
    vi.useFakeTimers();
    const onSubmit = vi.fn();
    render(<BirthInputModal open onClose={vi.fn()} onSubmit={onSubmit} initial={{ yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '戊辰', hourPillar: '庚申' }} />);
    const input = screen.getByLabelText(/八字整串/) as HTMLInputElement;
    const finalValue = '甲子丙寅戊辰庚申';
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: finalValue + 'p' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true, keyCode: 229 });
    fireEvent.compositionEnd(input, { target: { value: finalValue }, data: finalValue });
    fireEvent.submit(input.closest('form')!);
    expect(onSubmit).not.toHaveBeenCalled();
    vi.runOnlyPendingTimers();
    fireEvent.keyDown(input, { key: 'Enter', isComposing: false, keyCode: 13 });
    fireEvent.submit(input.closest('form')!);
    expect(onSubmit).toHaveBeenCalledTimes(1);

    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: finalValue + 'p' } });
    fireEvent.compositionEnd(input, { target: { value: finalValue }, data: finalValue });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true, keyCode: 229 });
    fireEvent.submit(input.closest('form')!);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    vi.runOnlyPendingTimers();
    fireEvent.keyDown(input, { key: 'Enter', isComposing: false, keyCode: 13 });
    fireEvent.submit(input.closest('form')!);
    expect(onSubmit).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('整串按合法字过滤后最多保留八字，输入框不截断浏览器预编辑', () => {
    render(<BirthInputModal open onClose={vi.fn()} onSubmit={vi.fn()} />);
    const input = screen.getByLabelText(/八字整串/) as HTMLInputElement;
    expect(input.maxLength).toBe(-1);
    fireEvent.change(input, { target: { value: '甲子丙寅戊辰庚申乙丑' } });
    expect(input.value).toBe('甲子丙寅戊辰庚申');
  });

  it('单柱编辑允许完整 composition 草稿，确认后仍只保留一干一支', () => {
    render(<BirthInputModal open onClose={vi.fn()} onSubmit={vi.fn()} initial={{ yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '戊辰', hourPillar: '庚申' }} />);
    const year = screen.getByLabelText('年柱') as HTMLInputElement;
    expect(year.maxLength).toBe(-1);
    fireEvent.compositionStart(year);
    fireEvent.change(year, { target: { value: '乙p丑' } });
    expect(year.value).toBe('乙p丑');
    fireEvent.compositionEnd(year, { data: '乙丑' });
    fireEvent.change(year, { target: { value: '乙丑' } });
    expect(year.value).toBe('乙丑');
    expect((screen.getByLabelText('月柱') as HTMLInputElement).value).toBe('丙寅');
  });

  it('单柱 compositionEnd 即完成确认并清空整串栏，无需等待额外 change', () => {
    const onSubmit = vi.fn();
    render(<BirthInputModal open onClose={vi.fn()} onSubmit={onSubmit} initial={{ yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '戊辰', hourPillar: '庚申' }} />);
    const combined = screen.getByLabelText(/八字整串/) as HTMLInputElement;
    fireEvent.change(combined, { target: { value: '甲子丙寅戊辰庚申' } });
    const year = screen.getByLabelText('年柱') as HTMLInputElement;
    fireEvent.compositionStart(year);
    fireEvent.change(year, { target: { value: '乙p丑' } });
    fireEvent.compositionEnd(year, { data: '乙丑' });
    expect(year.value).toBe('乙丑');
    expect(combined.value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: '提交' }));
    expect(onSubmit).toHaveBeenCalledWith({ yearPillar: '乙丑', monthPillar: '丙寅', dayPillar: '戊辰', hourPillar: '庚申' });
  });

  it('关闭弹窗会结束未完成 composition，重开后不遗留提交屏障', () => {
    const onSubmit = vi.fn();
    const props = { onClose: vi.fn(), onSubmit, initial: { yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '戊辰', hourPillar: '庚申' } };
    const view = render(<BirthInputModal open {...props} />);
    const input = screen.getByLabelText(/八字整串/) as HTMLInputElement;
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: '甲子丙寅戊辰庚申p' } });
    view.rerender(<BirthInputModal open={false} {...props} />);
    view.rerender(<BirthInputModal open {...props} />);
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
