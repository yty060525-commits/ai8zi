import { describe, expect, it } from 'vitest';
import { derivePattern, scoreStrength } from '../features/chart/nonAiCalculator';
describe('用户盘复核', () => {
  it('丙戌 癸巳 甲寅 辛未', () => {
    const p = ['丙戌','癸巳','甲寅','辛未'], day = '甲';
    const r = derivePattern(p, day), s = scoreStrength(p, day);
    console.log('USERCHART', JSON.stringify({ pattern: r.name, basis: r.basis, index: s.index, label: s.label, inSeason: s.inSeason, sup: s.support, dr: s.drain }));
    for (const d of s.detail) console.log('  ', d.pillar, d.stem, d.tenGod, d.side, d.weight, d.note ?? '');
    expect(r.name).toBe('食神格');
  });
});
