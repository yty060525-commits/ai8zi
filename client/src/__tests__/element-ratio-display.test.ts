/* 人物详情里「五行比例」的展示口径。
 * 引擎存的是 0~1 的占比，早先直接 mapText 打出来是 `木 0.25 · 火 0.375`：
 * 既不好读、也没提「缺哪一行」，而且小数点与中点在正式版口径下属于算法痕迹。
 * 现在锁死三条：成/厘中文成数 + 缺项提示 + 空值读「暂无」。 */
import { describe, expect, it } from 'vitest';
import { formatElementRatio } from '../features/person/PersonDetail';

describe('五行比例展示', () => {
  it('按成、厘读百分比，不留小数与半角符号', () => {
    const text = formatElementRatio({ '水': 0.25, '土': 0, '木': 0.25, '火': 0.375, '金': 0.125 });
    expect(text).toContain('水二成五厘');
    expect(text).toContain('木二成五厘');
    expect(text).toContain('火三成八厘'); // 0.375 → 三十七点五厘，四舍五入到整厘
    expect(text).toContain('金一成三厘');
    expect(text).not.toMatch(/[0-9.%·]/);
  });

  it('点出缺失的五行，方便直接读盘', () => {
    expect(formatElementRatio({ '木': 0.5, '火': 0.5, '土': 0, '金': 0, '水': 0 })).toContain('，缺土、金、水');
    // 五行齐全时不加这半句
    expect(formatElementRatio({ '木': 0.2, '火': 0.2, '土': 0.2, '金': 0.2, '水': 0.2 })).not.toContain('缺');
  });

  it('空比例不硬凑成〇，直接读「暂无」', () => {
    expect(formatElementRatio({})).toBe('暂无');
    expect(formatElementRatio({ '木': 0, '火': 0, '土': 0, '金': 0, '水': 0 })).toBe('暂无');
  });

  it('样例盘 甲子 丙寅 庚午 壬午：水二成五厘 且点名缺土', () => {
    const text = formatElementRatio({ '木': 2 / 8, '火': 3 / 8, '土': 0, '金': 1 / 8, '水': 2 / 8 });
    expect(text).toBe('木二成五厘、火三成八厘、土〇、金一成三厘、水二成五厘，缺土');
  });
});
