/* 人物详情里「五行比例」的展示口径。
 * 引擎存的是 0~1 的占比，早先直接 mapText 打出来是 `木 0.25 · 火 0.375`，
 * 既不好读、也没提「缺哪一行」。这里锁死百分比 + 缺项提示两条。 */
import { describe, expect, it } from 'vitest';
import { formatElementRatio } from '../features/person/PersonDetail';

describe('五行比例展示', () => {
  it('按百分比展示，并去掉多余的 .0', () => {
    const text = formatElementRatio({ '水': 0.25, '土': 0, '木': 0.25, '火': 0.375, '金': 0.125 });
    expect(text).toContain('水 25%');
    expect(text).toContain('木 25%');
    expect(text).toContain('火 37.5%');
    expect(text).toContain('金 12.5%');
    expect(text).not.toContain('0.375');
  });

  it('点出缺失的五行，方便直接读盘', () => {
    expect(formatElementRatio({ '木': 0.5, '火': 0.5, '土': 0, '金': 0, '水': 0 })).toContain('（缺土、金、水）');
    // 五行齐全时不加这半句
    expect(formatElementRatio({ '木': 0.2, '火': 0.2, '土': 0.2, '金': 0.2, '水': 0.2 })).not.toContain('缺');
  });

  it('空比例不硬凑成 0%，直接给占位符', () => {
    expect(formatElementRatio({})).toBe('—');
    expect(formatElementRatio({ '木': 0, '火': 0, '土': 0, '金': 0, '水': 0 })).toBe('—');
  });

  it('样例盘 甲子 丙寅 庚午 壬午：水25% 且点名缺土', () => {
    const text = formatElementRatio({ '木': 2 / 8, '火': 3 / 8, '土': 0, '金': 1 / 8, '水': 2 / 8 });
    expect(text).toBe('木 25% · 火 37.5% · 土 0% · 金 12.5% · 水 25%（缺土）');
  });
});
