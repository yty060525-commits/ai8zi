import { describe, expect, it } from 'vitest';
import { Solar } from 'lunar-javascript';
import { calculateNonAi } from '../features/chart/nonAiCalculator';
import type { Gender } from '../types/domain';

/**
 * 本地化查表(藏干/纳音/十二长生/十神)必须与 lunar-javascript 完全一致。
 * 这些计算已从「问库」改为「查本地表」，此测试是防止两边漂移的唯一护栏。
 */
describe('本地查表与 lunar-javascript 等价', () => {
  const GENDERS: Gender[] = ['male', 'female'];

  it('连续多年份、逐柱比对：藏干 / 纳音 / 十二长生 / 透干十神', () => {
    let checked = 0;
    for (let y = 1950; y <= 2030; y += 3) {
      for (const month of [2, 5, 8, 11]) {
        // 避开 23 点(晚子时换日)与节气交界导致的四柱反查歧义：取当日正中时段
        for (const hour of [8, 12, 16, 21]) {
          const solar = Solar.fromYmdHms(y, month, 14, hour, 30, 0);
          const eight = solar.getLunar().getEightChar();
          const pillars = [eight.getYear(), eight.getMonth(), eight.getDay(), eight.getTime()];
          const gender = GENDERS[(y + month + hour) % 2];
          const chart = calculateNonAi({
            birthYear: y, birthMonth: month,
            yearPillar: pillars[0], monthPillar: pillars[1], dayPillar: pillars[2], hourPillar: pillars[3],
          }, gender, solar.toYmd() + 'T00:00:00.000Z');
          checked += 1;

          // 藏干(本→中→余)
          const libHide = [eight.getYearHideGan(), eight.getMonthHideGan(), eight.getDayHideGan(), eight.getTimeHideGan()];
          expect(chart.hiddenStems.map((stems) => stems.join(''))).toEqual(libHide.map((stems) => (stems as string[]).join('')));

          // 纳音
          const libNayin = [eight.getYearNaYin(), eight.getMonthNaYin(), eight.getDayNaYin(), eight.getTimeNaYin()];
          expect(chart.naYin).toEqual(libNayin);

          // 十二长生(日主对年/月/日三支；时支不列，见 nonAiCalculator 注释)
          const libDiShi = [eight.getYearDiShi(), eight.getMonthDiShi(), eight.getDayDiShi()];
          expect(chart.twelveLongevity).toEqual(libDiShi);

          // 透干十神
          const libGan = [eight.getYearShiShenGan(), eight.getMonthShiShenGan(), eight.getDayShiShenGan(), eight.getTimeShiShenGan()];
          expect(chart.tenGodDetails.heavenly).toEqual(libGan);
          // 日柱本身必须标「日主」，其余柱同干标「比肩」
          expect(chart.tenGodDetails.heavenly[2]).toBe('日主');
        }
      }
    }
    expect(checked).toBeGreaterThan(300);
  });

  it('藏干中与日主同干者标比肩而非日主(旧实现会误标)', () => {
    // 戊辰 丙辰 庚子 辛巳：日主庚，申宫藏庚 → 应为比肩
    const solar = Solar.fromYmdHms(1988, 4, 15, 10, 30, 0);
    const eight = solar.getLunar().getEightChar();
    const pillars = [eight.getYear(), eight.getMonth(), eight.getDay(), eight.getTime()];
    const chart = calculateNonAi({
      birthYear: 1988, birthMonth: 4,
      yearPillar: pillars[0], monthPillar: pillars[1], dayPillar: pillars[2], hourPillar: pillars[3],
    }, 'male', solar.toYmd() + 'T00:00:00.000Z');
    const flat = chart.tenGodDetails.hidden.flat().map((h) => h.stem + ':' + h.tenGod);
    expect(flat.some((f) => f === '庚:比肩')).toBe(true);
    // 除日柱本气外不得出现任何「日主」标签
    const nonDay = chart.tenGodDetails.hidden.flatMap((list, pi) => list.map((h, si) => (pi === 2 && si === 0 ? null : h.tenGod))).filter(Boolean);
    expect(nonDay).not.toContain('日主');
  });
});
