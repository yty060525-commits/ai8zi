import { describe, expect, it } from 'vitest';
import { calculateNonAi } from '../features/chart/nonAiCalculator';
import { buildLocalAnalysis, buildLocalTaskAnalysis, canBuildLocalAnalysis, LOCAL_ANALYSIS_ENGINE_VERSION } from '../data/localAnalysis';
import { REQUIRED_SECTIONS } from '../data/baziOrchestrator';
import type { BaziAnalysisTask, BaziRecord } from '../types/domain';

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
    // 与云端本命正文同构：小节标题、编号点、日主天干取象
    expect(r.explanation).toContain('【身强身弱与喜忌】');
    expect(r.explanation).toContain('【事业】');
    expect(r.explanation).toContain('【爱情】');
    expect(r.explanation).toContain('【总评与行为建议】');
    expect(r.explanation).toContain('1. ');
    expect(r.explanation).toContain('庚'); // 日主意象取的是日主天干
  });

  it('旺衰评分写成中文白话并引用格局依据/病处/方位颜色(向云端事实密度对齐)', () => {
    const r = buildLocalAnalysis(chart)!;
    // 得分用中文数字(含「点」小数)，不出现阿拉伯数字与拉丁字母混排
    expect(r.explanation).toMatch(/助身方（比劫与印）合计[一二三四五六七八九十零]+(?:点[一二三四五六七八九])?/);
    expect(r.explanation).toMatch(/净分[负一二三四五六七八九十零点]+，档位判为/);
    // 扶抑喜忌 + 方位颜色(行为建议)是确定性推导，须与喜用五行一致
    expect(r.explanation).toMatch(/喜用定为[木火土金水、]+，忌[木火土金水、]+/);
    expect(r.explanation).toContain('日常方位宜向');
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

  it('排出大运/神煞/刑冲各段(有该数据时)', () => {
    const r = buildLocalAnalysis(chart)!;
    expect(r.explanation).toContain('【大运提点】');
    expect(r.explanation).toContain('【神煞点缀】');
    expect(r.explanation).toContain('【刑冲克害批注】');
  });

  it('缺排盘数据时返回空、按钮应禁用(不编造批断)', () => {
    const bare = { ...chart, nonAiResult: undefined } as BaziRecord;
    expect(canBuildLocalAnalysis(bare)).toBe(false);
    expect(buildLocalAnalysis(bare)).toBeNull();
  });
});

describe('本地分时段批断(流年/流月/大运/后天调整/全盘总结)', () => {
  const n = asRecord({ birthYear: 1984, birthMonth: 2, yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午' }, 'male').nonAiResult!;
  const rec = { gender: 'male', nonAiResult: n } as unknown as BaziRecord;
  const now = new Date('2026-06-01T00:00:00Z');
  const decade = n.greatFortunes.find((g) => g.startYear > 2026) ?? n.greatFortunes[0];
  const cases: Array<[string, BaziAnalysisTask]> = [
    ['annual', { taskId: 'a', type: 'annual', year: 2026, annual: n.annualFortunes.find((a) => a.year === 2026) }],
    ['monthly', { taskId: 'm', type: 'monthly', year: 2026, month: 1, monthly: n.monthlyFortunes.find((x) => x.year === 2026 && x.month === 1) }],
    ['decade', { taskId: 'd', type: 'decade', year: decade.startYear, decade }],
    ['adjustment', { taskId: 'adj', type: 'adjustment' }],
    ['overview', { taskId: 'ov', type: 'overview' }],
  ];
  for (const [label, task] of cases) {
    it(`${label} 产出该篇全部必需小节、正文零拉丁字母`, () => {
      const a = buildLocalTaskAnalysis(rec, task, now);
      expect(a, `${label} 应有正文`).not.toBeNull();
      const text = a!.explanation;
      expect(text).not.toMatch(/[A-Za-z]/);
      expect(text).not.toMatch(/模型|API|DeepSeek|Kimi|Qwen|通义|Bearer|sk-/);
      for (const sec of REQUIRED_SECTIONS[task.type] ?? []) expect(text).toContain('【' + sec + '】');
    });
  }
  it('流年/流月/大运带标题，且喜忌与本命一致', () => {
    const a = buildLocalTaskAnalysis(rec, { taskId: 'a', type: 'annual', year: 2026, annual: n.annualFortunes.find((x) => x.year === 2026) }, now)!;
    expect(a.title).toBeTruthy();
    const base = buildLocalAnalysis(rec, now)!;
    expect(a.usefulElements).toEqual(base.usefulElements);
  });
  it('缺该时段排盘数据时该任务返回空(不编造)', () => {
    expect(buildLocalTaskAnalysis(rec, { taskId: 'z', type: 'annual', year: 3000 }, now)).toBeNull();
  });
});
