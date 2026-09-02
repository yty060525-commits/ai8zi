import { describe, expect, it, vi } from 'vitest';
import { calculateNonAi, chinaYear } from '../features/chart/nonAiCalculator';

describe('non-AI calculator', () => {
  it('calculates the year in China Standard Time', () => {
    expect(chinaYear('2024-12-31T16:30:00.000Z')).toBe(2025);
    expect(chinaYear('2025-12-31T15:59:59.000Z')).toBe(2025);
  });
  it('derives deterministic lunar and bazi facts from the supplied pillars', () => {
    const result = calculateNonAi({ birthYear: 1984, birthMonth: 2, yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午' }, 'male');
    expect(result.pillars).toEqual({ year: '甲子', month: '丙寅', day: '庚午', hour: '壬午' });
    expect(result.lunarDate).toBeTruthy();
    expect(result.zodiac).toBe('鼠');
    expect(result.dayMaster).toBe('庚');
    expect(result.elements).toEqual(expect.objectContaining({ 金: expect.any(Number), 木: expect.any(Number) }));
    expect(result.elementRatio).toEqual(expect.objectContaining({ 金: expect.any(Number) }));
    expect(result.hiddenStems).toHaveLength(4);
    expect(result.tenGods).toHaveLength(4);
    expect(result.naYin).toHaveLength(4);
    expect(result.greatFortunes.length).toBeGreaterThan(0);
    const currentYear = new Date().getFullYear();
    expect(result.forecastRange).toHaveLength(10);
    expect(result.forecastRange[0]).toBe(currentYear);
    expect(result.forecastRange[9]).toBe(currentYear + 9);
    expect(result.solarDate).toBe('1984-02-06');
    expect(result.twelveLongevity).toHaveLength(4);
    expect(result.shenSha).toEqual(expect.objectContaining({ auspicious: expect.any(Array), inauspicious: expect.any(Array) }));
  });

  it('does not silently use a candidate from a different birth year', () => {
    expect(() => calculateNonAi({ birthYear: 1900, birthMonth: 1, yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午' }, 'male')).toThrow(/未找到/);
  });

  it('never calls the network', () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    calculateNonAi({ birthYear: 1984, birthMonth: 2, yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午' }, 'female');
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockRestore();
  });

  it('returns deterministic relationship and Gregorian ten-year forecasts', () => {
    const result = calculateNonAi({ birthYear: 1984, birthMonth: 2, yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午' }, 'male', '2025-03-08T12:34:56.000Z');
    expect(result.relationships).toEqual(expect.objectContaining({ sanHe: expect.any(Array), liuHe: expect.any(Array), chong: expect.any(Array), xing: expect.any(Array), hai: expect.any(Array), po: expect.any(Array), ke: expect.any(Array) }));
    expect(result.annualFortunes).toHaveLength(10);
    expect(result.annualFortunes[0]).toEqual(expect.objectContaining({ year: 2025, month: 1, ganZhi: expect.any(String), relationships: expect.anything() }));
    expect(result.monthlyFortunes).toHaveLength(120);
    expect(result.monthlyFortunes[0]).toEqual(expect.objectContaining({ year: 2025, month: 1, ganZhi: expect.any(String), relationships: expect.anything() }));
    expect(result.monthlyFortunes[119].year).toBe(2034);
    expect(result.greatFortunes[0]).toEqual(expect.objectContaining({ relationships: expect.anything() }));
    expect(result.greatFortunes[0].ganZhi).toBe('丁卯');
    expect(result.greatFortunes[0].tenGod).toBe('正官');
    expect(result.annualFortunes[0].tenGod).toEqual(expect.any(String));
  });

  it('uses an auditable estimated three-days-one-year start and structured facts', () => {
    const result = calculateNonAi({ birthYear: 1984, birthMonth: 2, yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午' }, 'male', '2025-03-08T12:34:56.000Z');
    expect(result.fortuneMethod).toEqual(expect.objectContaining({ method: 'three-days-one-year', estimated: true, components: expect.anything(), boundary: expect.any(String) }));
    expect(result.tenGodDetails!.heavenly).toHaveLength(4);
    expect(result.tenGodDetails!.hidden).toHaveLength(4);
    expect(result.tenGodDetails!.hidden[1]).toHaveLength(3);
    expect(result.relationshipDetails).toEqual(expect.arrayContaining([expect.objectContaining({ type: expect.any(String), sourceLayer: expect.any(String), targetPillar: expect.any(String), status: expect.any(String) })]));
    expect(result.annualFortunes[0].relationshipDetails).toEqual(expect.any(Array));
    expect(result.monthlyFortunes[0].relationshipDetails).toEqual(expect.any(Array));
    expect(result.shenSha.ruleVersion).toBeTruthy();
    expect(result.shenSha).toEqual(expect.objectContaining({ daySha: expect.any(String), dayTianShen: expect.any(String), source: expect.stringContaining('only') }));
    expect(result.relationshipDetails.filter((item) => item.type === 'sanHe')).toHaveLength(1);
    expect(result.annualFortunes[0].relationshipDetails).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceLayer: 'annual', status: expect.stringMatching(/complete|half-combination/) }),
    ]));
  });

  it('keeps lunar hidden-stem order aligned with lunar ten-god order', () => {
    const result = calculateNonAi({ birthYear: 1984, birthMonth: 2, yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午' }, 'male');
    expect(result.hiddenStems[1]).toEqual(['甲', '丙', '戊']);
    expect(result.tenGodDetails.hidden[1]).toEqual([
      { stem: '甲', tenGod: '偏财', position: 'root' },
      { stem: '丙', tenGod: '七杀', position: 'middle' },
      { stem: '戊', tenGod: '偏印', position: 'residual' },
    ]);
  });

  it('uses the library ordering for the 巳 hidden stems golden case', () => {
    const result = calculateNonAi({ birthYear: 1984, birthMonth: 5, yearPillar: '甲子', monthPillar: '己巳', dayPillar: '庚子', hourPillar: '壬午' }, 'male');
    expect(result.hiddenStems[1]).toEqual(['丙', '庚', '戊']);
    expect(result.tenGodDetails.hidden[1].map((item) => item.tenGod)).toEqual(['七杀', '比肩', '偏印']);
  });
});
