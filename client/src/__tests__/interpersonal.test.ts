import { describe, expect, it } from 'vitest';
import { interpersonalZodiac, zodiacOfBranch } from '../utils/interpersonal';

describe('interpersonal zodiac (人际关系版 三合六合)', () => {
  it('属狗(戌)：三合 虎·马，六合 兔，六冲 龙，六害 鸡', () => {
    const r = interpersonalZodiac('戌');
    expect(r.sanHe.sort()).toEqual(['虎', '马'].sort());
    expect(r.liuHe).toEqual(['兔']);
    expect(r.chong).toEqual(['龙']);
    expect(r.hai).toEqual(['鸡']);
    expect(zodiacOfBranch('戌')).toBe('狗');
  });
  it('属鼠(子)：三合 猴·龙，六合 牛，六冲 马，六害 羊', () => {
    const r = interpersonalZodiac('子');
    expect(r.sanHe.sort()).toEqual(['猴', '龙'].sort());
    expect(r.liuHe).toEqual(['牛']);
    expect(r.chong).toEqual(['马']);
    expect(r.hai).toEqual(['羊']);
  });
});
