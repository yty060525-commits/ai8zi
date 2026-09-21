import { describe, expect, it } from 'vitest';
import { STEM_LU, YANG_REN, luRenOf } from '../features/chart/nonAiCalculator';

/* 禄与刃的表 —— 依《子平真诠》论刃「阳刃者…禄前一位，惟五阳有之」及通行禄位表。
 * 关键：取禄一律用「阴阳同宫」(乙禄在寅、丁己禄在巳、辛禄在申、癸禄在亥)，
 * 不是十二长生逆行表里阴干的「临官」(那会把乙说成卯、辛说成酉)。 */
describe('禄刃表', () => {
  it('禄位：甲乙寅 丙戊巳 丁己午? 校验传统口径', () => {
    // 通行禄神表：甲寅 乙卯 丙巳 丁午 戊巳 己午 庚申 辛酉 壬亥 癸子 —— 这是「禄神」神煞的查法
    // 而「建禄格」的禄按五行临官：甲乙寅 丙丁戊己巳 庚辛申 壬癸亥 —— 两者不可混用
    console.log('STEM_LU', JSON.stringify(STEM_LU));
    expect(STEM_LU['甲']).toBe('寅');
    expect(STEM_LU['丙']).toBe('巳');
    expect(STEM_LU['庚']).toBe('申');
    expect(STEM_LU['壬']).toBe('亥');
  });
  it('阳刃＝禄前一位，且只有五阳干', () => {
    console.log('YANG_REN', JSON.stringify(YANG_REN));
    for (const [d, b] of Object.entries(YANG_REN)) {
      expect(STEM_LU[d]).toBeTruthy();
      const li = '子丑寅卯辰巳午未申酉戌亥'.indexOf(b);
      const lu = '子丑寅卯辰巳午未申酉戌亥'.indexOf(STEM_LU[d]);
      expect(li).toBe((lu + 1) % 12);   // 壬禄在亥、刃在子(回环)
      void d;
    }
    expect(['甲','丙','戊','庚','壬'].every((s) => s in YANG_REN)).toBe(true);
    expect(['乙','丁','己','辛','癸'].some((s) => s in YANG_REN)).toBe(false);
  });
  it('luRenOf 对阴干禄支仍判建禄、不判阳刃', () => {
    expect(luRenOf('乙', '寅')).toBe('建禄');
    expect(luRenOf('丁', '巳')).toBe('建禄');
    expect(luRenOf('甲', '卯')).toBe('阳刃');
    expect(luRenOf('甲', '巳')).toBe(null);
  });
});
