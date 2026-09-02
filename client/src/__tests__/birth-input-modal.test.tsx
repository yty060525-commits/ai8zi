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
    expect(screen.getByRole('alert').textContent).toContain('四柱必须是两个天干地支汉字');
  });
});
