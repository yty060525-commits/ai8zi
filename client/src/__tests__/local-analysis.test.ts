import { describe, expect, it } from 'vitest';
import { calculateNonAi } from '../features/chart/nonAiCalculator';
import { buildLocalAnalysis, canBuildLocalAnalysis, LOCAL_ANALYSIS_ENGINE_VERSION } from '../data/localAnalysis';
import type { BaziRecord } from '../types/domain';

const asRecord = (input: Parameters<typeof calculateNonAi>[0], gender: 'male' | 'female'): BaziRecord => {
  const nonAiResult = calculateNonAi(input, gender, '2026-06-01T04:00:00.000Z');
  return {
    id: 'r1', name: '本地批断测', gender, birthYear: input.birthYear, birthMonth: input.birthMonth,
    createdAt: '2025-01-01T00:00:00.000Z', yearPillar: input.yearPillar, monthPillar: input.monthPillar,
    dayPillar: input.dayPillar, hourPillar: input.hourPillar, nonAiResult, aiStatus: 'not_started',
  } as unknown as BaziRecord;
};

describe('本地离线批断引擎(第四路)', () => {
  // 庚日主：金=日主，我克=财(木)、克我=官杀(火)、我生=食伤(水)、生我=印(土)、同我=比劫(金)
  const chart = asRecord({ birthYear: 1984, birthMonth: 2, yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午' }, 'male');

  it('有排盘数据即可生成，正文全中文(不掺拉丁字母/字段名)', () => {
    expect(canBuildLocalAnalysis(chart)).toBe(true);
    const r = buildLocalAnalysis(chart)!;
    expect(r).toBeTruthy();
    expect(r.engineVersion).toBe(LOCAL_ANALYSIS_ENGINE_VERSION);
    // 这是仓库硬约束：批断正文不得出现任何英文字母(否则又要走 sanitize 兜底)。
    expect(r.explanation).not.toMatch(/[A-Za-z]/);
    expect(r.explanation).toContain('【本命·日主】');
    expect(r.explanation).toContain('庚'); // 日主意象取的是日主天干
  });

  it('喜忌按扶抑确定性推导：比劫/印 与 财/官杀/食伤 必分居喜、忌两侧', () => {
    const r = buildLocalAnalysis(chart)!;
    const five = ['木', '火', '土', '金', '水'];
    // 集合合法：都是五行子集、互不重叠、二者合计恰为五行全体(扶抑必居一侧)
    expect(r.usefulElements.every((e) => five.includes(e))).toBe(true);
    expect(r.avoidElements.every((e) => five.includes(e))).toBe(true);
    const overlap = r.usefulElements.filter((e) => r.avoidElements.includes(e));
    expect(overlap).toHaveLength(0);
    expect([...new Set([...r.usefulElements, ...r.avoidElements])].sort()).toEqual([...five].sort());
    // 庚(金)日主：比劫金、印土 与 财木、官杀火、食伤水 必分属不同侧
    const helper = (side: string[]) => side.includes('金') === side.includes('土') && !side.includes('木') && !side.includes('火') && !side.includes('水');
    expect(helper(r.usefulElements) || helper(r.avoidElements)).toBe(true);
  });

  it('排出大运/流年/神煞各段(有该数据时)', () => {
    const r = buildLocalAnalysis(chart)!;
    expect(r.explanation).toContain('【大运】');
    expect(r.explanation).toContain('【未来流年提点】');
    expect(r.explanation).toContain('【结语】');
  });

  it('缺排盘数据时返回空、按钮应禁用(不编造批断)', () => {
    const bare = { ...chart, nonAiResult: undefined } as BaziRecord;
    expect(canBuildLocalAnalysis(bare)).toBe(false);
    expect(buildLocalAnalysis(bare)).toBeNull();
  });
});
