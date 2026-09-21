import { describe, expect, it } from 'vitest';
import { derivePattern } from '../features/chart/nonAiCalculator';

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
