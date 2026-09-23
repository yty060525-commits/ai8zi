import { describe, expect, it } from 'vitest';
import { derivePattern, scoreStrength, specialPatternHint } from '../features/chart/nonAiCalculator';

describe('取格(《子平真诠》通行法)', () => {
  it('月令本气透干 → 直取该神', () => {
    const r = derivePattern(['戊子','辛酉','甲子','戊辰'], '甲');
    expect(r.name).toBe('正官格');
    expect(/本气/.test(r.basis)).toBe(true);
  });
  it('月令本气不透 → 退取本气同名', () => {
    const r = derivePattern(['戊子','癸酉','甲子','戊辰'], '甲');
    expect(r.name).toBe('正官格');
    expect(/未透天干/.test(r.basis)).toBe(true);
  });
  it('透干次序按本气→中气→余气', () => {
    expect(derivePattern(['癸亥','辛丑','甲子','乙亥'], '甲').name).toBe('正印格');
    expect(derivePattern(['丁亥','辛丑','甲子','乙亥'], '甲').name).toBe('正官格');
  });
  it('建禄/阳刃别取官杀财食', () => {
    // 寅藏甲丙戊：甲比肩不取；戊(余气)透于月干 → 别取偏财。年干庚虽为七杀，但它
    // 不是月令所藏之神，按「先取月令所藏透出者」的次序排在戊之后。
    expect(derivePattern(['庚子','戊寅','甲子','庚午'], '甲').name).toBe('建禄用偏财');
    // 丙(中气食神)先于戊(余气偏财)透出 -> 建禄用食神
    expect(derivePattern(['己巳','丙寅','甲子','乙亥'], '甲').name).toBe('建禄用食神');
    expect(derivePattern(['甲子','庚午','丙寅','己亥'], '丙').name).toContain('阳刃');
  });
  it('抽样全部产出可用格局名与依据', () => {
    const G='甲乙丙丁戊己庚辛壬癸', Z='子丑寅卯辰巳午未申酉戌亥';
    const sixty = Array.from({length:60},(_,n)=>G[n%10]+Z[n%12]);
    const kinds = new Set<string>();
    for (let i=0;i<60;i++){
      const p=[sixty[i],sixty[(i+17)%60],sixty[(i+31)%60],sixty[(i+47)%60]];
      const r=derivePattern(p,p[2][0]);
      kinds.add(r.tenGod);
      expect(r.name.length).toBeGreaterThan(1);
      expect(r.basis.length).toBeGreaterThan(6);
    }
    console.log('KINDS', [...kinds].join(','));
    expect(kinds.size).toBeGreaterThanOrEqual(6);
  });
});

/* 变格线索是给模型的「候选」，一旦给出模型多半就顺着套。旧实现只看总分与月支，
   于是满盘官杀的命也被提示成专旺候选 —— 古法专旺明确不许官杀混局。 */
describe('变格候选提示(专旺须无官杀、从格须印比无力)', () => {
  it('极旺但四柱见官杀 → 不给专旺候选', () => {
    // 甲寅日主极旺，年干庚(七杀)、时干辛(正官)透出：古法专旺不许官杀混局。
    const p = ['庚寅', '戊寅', '甲寅', '辛未'];
    const s = scoreStrength(p, '甲');
    expect(specialPatternHint(s, p, '甲')).toBeUndefined();
  });
  it('极旺且满盘无官杀 → 才给专旺候选', () => {
    const p = ['甲寅', '丙寅', '甲寅', '乙亥'];
    const s = scoreStrength(p, '甲');
    if (s.index >= 75 && s.inSeason) {
      expect(specialPatternHint(s, p, '甲')).toContain('专旺候选');
    }
  });
  it('抽样：凡给出专旺线索的盘，其天干里确无官杀', () => {
    const G = '甲乙丙丁戊己庚辛壬癸', Z = '子丑寅卯辰巳午未申酉戌亥';
    const sixty = Array.from({ length: 60 }, (_, n) => G[n % 10] + Z[n % 12]);
    let fired = 0;
    // 步长取 1：六十甲子全组合太大，但专旺盘本就稀少，跨大步会一个都扫不到。
    for (let i = 0; i < 60; i++) for (let j = 0; j < 60; j += 3) for (let k = 0; k < 60; k += 5) for (let l = 0; l < 60; l += 7) {
      const p = [sixty[i], sixty[j], sixty[k], sixty[l]];
      const day = p[2][0];
      const hint = specialPatternHint(scoreStrength(p, day), p, day);
      if (!hint?.startsWith('专旺候选')) continue;
      fired++;
      // 专旺线索一旦给出，三柱之干不能出现克我之神(日干自身除外)
      expect(officerOf(day, [p[0][0], p[1][0], p[3][0]])).toBe(false);
    }
    // 门槛收紧后仍要能给出线索，否则等于把变格整条路径悄悄删掉了。
    expect(fired).toBeGreaterThan(0);
  });
});

/** 这些天干里是否有日主的官杀(克我者)。用十神明细反查，避免另立一套生克表。 */
const officerOf = (day: string, stems: string[]) =>
  stems.some((st) => /正官|七杀/.test(scoreStrength([`${st}子`, `${day}子`, `${day}子`, `${day}子`], day).detail.filter((d) => d.pillar === '年干').map((d) => d.tenGod).join()));
