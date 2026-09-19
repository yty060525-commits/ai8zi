import { describe, expect, it } from 'vitest';
import { Solar } from 'lunar-javascript';
import { calculateNonAi } from '../features/chart/nonAiCalculator';

/**
 * 立春前出生：年柱属上一个干支年，但用户填的是公历年月。
 * 旧实现用 Solar.fromBaZi 反查并要求公历年份相等，导致这类生日**永远找不到日期**、排盘直接抛错。
 */
describe('立春前出生的排盘(回归)', () => {
  const dates = ['2028-02-14', '2027-02-14', '2025-01-20', '2000-02-03', '1984-01-31'];
  for (const iso of dates) {
    it(iso + ' 能完整排盘且三运数组齐全', () => {
      const [y, m, d] = iso.split('-').map(Number);
      const solar = Solar.fromYmdHms(y, m, d, 12, 30, 0);
      const eight = solar.getLunar().getEightChar();
      const pillars = [eight.getYear(), eight.getMonth(), eight.getDay(), eight.getTime()];
      const chart = calculateNonAi({
        birthYear: y, birthMonth: m,
        yearPillar: pillars[0], monthPillar: pillars[1], dayPillar: pillars[2], hourPillar: pillars[3],
      }, 'male', iso + 'T00:00:00.000Z');
      expect(chart.greatFortunes.length).toBeGreaterThan(0);
      expect(chart.annualFortunes.length).toBeGreaterThan(0);
      expect(chart.chenggu?.totalText).toBeTruthy();
      // 年柱确实与公历年不同侧立春(即真属于“立春前”场景)时才要求干支年错位
      const lunarYearGz = solar.getLunar().getYearInGanZhiExact();
      expect(pillars[0]).toBe(lunarYearGz);
    });
  }

  it('四柱与出生日期不合时报错，不静默借用别的日子', () => {
    expect(() => calculateNonAi({ birthYear: 1988, birthMonth: 4, yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午' }, 'male')).toThrow(/找不到|不合/);
  });

  it('时柱与日干不合(五鼠遁)时报错', () => {
    const solar = Solar.fromYmdHms(1988, 4, 15, 10, 30, 0);
    const e = solar.getLunar().getEightChar();
    // 把时柱换成同支不同干(辛巳 → 己巳)，应当被五鼠遁校验拦下
    expect(() => calculateNonAi({
      birthYear: 1988, birthMonth: 4,
      yearPillar: e.getYear(), monthPillar: e.getMonth(), dayPillar: e.getDay(), hourPillar: '己巳',
    }, 'male')).toThrow(/不合/);
  });
});
