import { describe, expect, it } from 'vitest';
import { derivePattern, scoreStrength } from '../features/chart/nonAiCalculator';

/* 取格与得令判例集 —— 每条注明传统依据，防止再出现「甲生巳月判建禄格」这类误判。
 * 口径：
 *   · 建禄/阳刃的判据是**月支本气与日主同类**(比劫)，不是月干的十神；
 *   · 常规取格按「月令所藏之神透出天干，本气→中气→余气」，皆不透才直取本气；
 *   · 「得令」＝月支本气为印或比(日主该月得气)，被冲则破令。 */
describe('取格判例', () => {
  const P = ['丙戌','癸巳','甲寅','辛未'];
  it('用户盘 丙戌 癸巳 甲寅 辛未 → 食神格、身弱、不得令', () => {
    const r = derivePattern(P, '甲'), s = scoreStrength(P, '甲');
    console.log('USER', JSON.stringify({ pattern: r.name, basis: r.basis, index: s.index, label: s.label, inSeason: s.inSeason }));
    // 甲生巳月：巳本气丙为甲之食神，年干丙透出 → 食神格。
    // 旧实现拿月干癸(正印)当"月令"参与取格，误判成建禄格(还写成「建筑禄格」)。
    expect(r.name).toBe('食神格');
    expect(s.inSeason).toBe(false);
    expect(s.label).toBe('身弱');
  });
  it('真建禄：甲生寅月，寅中戊土偏财透时干 → 建禄用偏财', () => {
    const r = derivePattern(['戊子','甲寅','甲子','戊辰'], '甲');
    console.log('JIANLU', r.name, '|', r.basis);
    // 寅藏甲丙戊：甲比肩不取，戊(余气偏财)透于年干 → 别取偏财
    expect(r.name).toBe('建禄用偏财');
    expect(/月建逢禄堂\(建禄\)/.test(r.basis)).toBe(true);
  });
  it('建禄无财官可倚 → 直以建禄论', () => {
    const r = derivePattern(['壬子','壬寅','甲子','乙亥'], '甲');
    console.log('JIANLU2', r.name, '|', r.basis);
    expect(r.name).toBe('建禄格');
  });
  it('阴干无刃：乙生寅月(长生表作帝旺)仍称建禄，不得写成阳刃', () => {
    const r = derivePattern(['戊子','甲寅','乙亥','丙子'], '乙');
    console.log('YIYIN', r.name, '|', r.basis);
    // 月干甲正是寅中本气透出，故走「建禄用…」别取分支；关键是不得称阳刃
    expect(r.name.startsWith('建禄')).toBe(true);
    expect(/阳刃/.test(r.basis)).toBe(false);
    expect(/帝旺/.test(r.basis)).toBe(false);
  });
  it('真阳刃：丙生午月，午中己土伤官透时干 → 阳刃用伤官', () => {
    const r = derivePattern(['壬子','丙午','丙寅','己亥'], '丙');
    console.log('YANGREN', r.name, '|', r.basis);
    expect(r.name).toContain('阳刃');
    expect(/禄前一位为阳刃/.test(r.basis)).toBe(true);
  });
  it('七杀格且失令：甲生申月透庚', () => {
    const p = ['戊申','庚申','甲辰','己巳'];
    const r = derivePattern(p, '甲'), s = scoreStrength(p, '甲');
    expect(r.name).toBe('七杀格');
    expect(s.inSeason).toBe(false);
    expect(s.index).toBeLessThan(0);
  });
  it('正官格：甲生酉月透辛', () => {
    expect(derivePattern(['戊子','辛酉','甲子','戊辰'], '甲').name).toBe('正官格');
  });
  it('非建禄盘不受影响：甲生丑月透癸 → 正印格', () => {
    expect(derivePattern(['癸亥','辛丑','甲子','乙亥'], '甲').name).toBe('正印格');
  });
  it('basis 里的禄刃措辞必须与月支状态一致', () => {
    for (const p of [P, ['戊子','甲寅','甲子','戊辰'], ['壬子','丙午','丙寅','己亥'], ['戊申','庚申','甲辰','己巳']]) {
      const r = derivePattern(p, p[2][0]);
      const claimsLu = /月建逢禄堂\(建禄\)/.test(r.basis), claimsRen = /禄前一位为阳刃/.test(r.basis);
      expect(claimsLu && claimsRen).toBe(false);
      if (/^建禄/.test(r.name)) expect(claimsLu).toBe(true);
      if (/^阳刃/.test(r.name)) expect(claimsRen).toBe(true);
    }
  });
});
