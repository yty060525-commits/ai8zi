import { describe, expect, it } from 'vitest';
import { calculateNonAi, scoreStrength } from '../features/chart/nonAiCalculator';
const run = (p: string[]) => scoreStrength(p, p[2][0]);

describe('旺衰评分(引擎算定，AI 不得重判)', () => {
  it('得令：甲生寅月(本气甲木)当令且身强', () => {
    const a = run(['丙寅','庚寅','甲子','乙亥']);
    expect(a.inSeason).toBe(true);
    expect(a.index).toBeGreaterThanOrEqual(25);
  });
  it('失令：甲生申月(本气庚金七杀) → 身弱；中余气帮扶不算当令', () => {
    const b = run(['戊申','庚申','甲辰','己巳']);
    expect(b.inSeason).toBe(false);
    expect(b.monthHasSupport).toBe(true);
    expect(b.index).toBeLessThan(0);
    expect(b.label).toBe('身弱');
  });
  it('破令：甲生寅月但年支申冲寅 → 不算得令并写明原因', () => {
    const s = run(['庚申','戊寅','甲子','壬午']);
    expect(s.inSeason).toBe(false);
    expect(s.detail.some((d) => d.pillar === '月令' && /破令/.test(d.note ?? ''))).toBe(true);
  });
  it('极旺与极弱方向正确、index 有界', () => {
    expect(run(['甲寅','丙寅','甲寅','乙亥']).index).toBeGreaterThanOrEqual(25);
    // 月令加倍只作用于日主通根后，此盘从「极端」回到明显偏弱(仍 <0)
    expect(run(['庚申','乙酉','甲辰','癸酉']).index).toBeLessThan(0);
    for (const p of [['甲子','甲子','甲子','甲子'],['庚午','庚午','庚午','庚午'],['壬子','壬子','壬子','壬子'],['丙午','丙午','丙午','丙午']]) {
      expect(Math.abs(run(p).index)).toBeLessThanOrEqual(100);
    }
  });
  it('通根项只在同类藏干上出现，且权重按长生调整', () => {
    const s = run(['乙酉','己卯','乙酉','癸未']);
    console.log('NOTES', JSON.stringify(s.detail.filter((d) => d.note).map((d) => [d.pillar, d.stem, d.tenGod, d.weight])));
    const zeroed = s.detail.filter((d) => d.side === 'support' && d.weight === 0);
    expect(zeroed.every((d) => /不为根|通根/.test(d.note ?? ''))).toBe(true);
  });
  it('calculateNonAi 输出 strengthScore，明细覆盖四干四支', () => {
    const r = calculateNonAi({ birthYear: 1990, birthMonth: 5, yearPillar: '庚午', monthPillar: '辛巳', dayPillar: '乙酉', hourPillar: '癸未' } as never, 'male') as never as
      { strengthScore: { detail: Array<{ pillar: string }>; index: number; label: string } };
    expect(r.strengthScore.detail.length).toBeGreaterThanOrEqual(9);
  });
  it('跨 60 甲子抽样：档位分布合理(不是一律同一档)', () => {
    const labels = new Set<string>();
    const G='甲乙丙丁戊己庚辛壬癸', Z='子丑寅卯辰巳午未申酉戌亥';
    const sixty = Array.from({length:60},(_,n)=>G[n%10]+Z[n%12]);
    for (let i=0;i<60;i+=7){
      const p=[sixty[i],sixty[(i+13)%60],sixty[(i+29)%60],sixty[(i+41)%60]];
      const s = run(p); labels.add(s.label);
      expect(Math.abs(s.index)).toBeLessThanOrEqual(100);
    }
    console.log('LABELS', [...labels].join(','));
    expect(labels.size).toBeGreaterThanOrEqual(3);
  });

  /* 提示词让 AI 同时引用「助身方得分 / 克泄耗方得分 / 净分」三项。逐项取整后再相减
     会出现 34.8 − 79.2 = −44.5 这种对不上的账，模型照抄就被用户当成算错。 */
  it('显示口径自洽：净分恒等于取整后的助身分减克泄耗分', () => {
    const G = '甲乙丙丁戊己庚辛壬癸', Z = '子丑寅卯辰巳午未申酉戌亥';
    const sixty = Array.from({ length: 60 }, (_, n) => G[n % 10] + Z[n % 12]);
    for (let i = 0; i < 60; i += 1) {
      const p = [sixty[i], sixty[(i + 13) % 60], sixty[(i + 29) % 60], sixty[(i + 41) % 60]];
      const s = run(p);
      expect(Math.round((s.support - s.drain) * 10) / 10).toBe(s.net);
    }
  });
});
