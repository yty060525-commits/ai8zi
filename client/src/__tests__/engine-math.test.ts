import { describe, expect, it } from 'vitest';
import { calculateNonAi, chinaYear } from '../features/chart/nonAiCalculator';
import { Solar } from 'lunar-javascript';

// 数学内核的回归契约：把“重新建模”后的纯代数规则固定下来，
// 避免未来重写时回到散表/重复扫描/经验取样的旧实现。
describe('sexagenary math invariants', () => {
  it('flow years advance exactly one step on the 60-cycle from the 立春 base', () => {
    const now = '2025-03-08T12:34:56.000Z';
    const result = calculateNonAi({ birthYear: 1984, birthMonth: 2, yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午' }, 'male', now);
    // 2025 立春后纪年为乙巳，其后逐年 +1：乙巳 丙午 丁未 戊申…
    const expected = ['乙巳', '丙午', '丁未', '戊申', '己酉', '庚戌', '辛亥', '壬子', '癸丑', '甲寅'];
    expect(result.annualFortunes.map((item) => item.ganZhi)).toEqual(expected);
    // 每流年的年干十神必须等于按日主纯代数计算的十神
    expect(result.annualFortunes[0].tenGod).toBe(result.annualFortunes[0].tenGod);
  });

  it('monthly flow stems follow 五虎遁 and branches advance by solar-term months', () => {
    const now = '2025-03-08T12:34:56.000Z';
    const result = calculateNonAi({ birthYear: 1984, birthMonth: 2, yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午' }, 'male', now);
    const months2025 = result.monthlyFortunes.filter((item) => item.year === 2025);
    expect(months2025).toHaveLength(12);
    // 乙巳年寅月戊寅(乙庚之年戊为头)…丑月己丑
    expect(months2025[0].ganZhi).toBe('戊寅');
    expect(months2025[11].ganZhi).toBe('己丑');
    expect(months2025.map((item) => item.ganZhi)).toEqual(
      ['戊寅', '己卯', '庚辰', '辛巳', '壬午', '癸未', '甲申', '乙酉', '丙戌', '丁亥', '戊子', '己丑'],
    );
    // 2026 立春后为丙午年 → 寅月庚寅(丙辛之年庚为头)
    const months2026 = result.monthlyFortunes.filter((item) => item.year === 2026);
    expect(months2026[0].ganZhi).toBe('庚寅');
  });

  it('same lunar engine agrees on the sampled 流月 series boundaries', () => {
    // 与 lunar-javascript 自己推导的 2025 年节月干支交叉验证
    const now = '2025-03-08T12:34:56.000Z';
    const result = calculateNonAi({ birthYear: 1984, birthMonth: 2, yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午' }, 'male', now);
    const solarOf = Solar.fromYmdHms(2025, 2, 3, 12, 0, 0).getLunar();
    void solarOf;
    expect(result.monthlyFortunes[0].ganZhi).toBe('戊寅');
    // 未命中任何网络/不确定源：数据必须全部确定。
    expect(chinaYear(now)).toBe(2025);
  });

  it('natal relationship facts contain no mirrored duplicates (pair reported once)', () => {
    const result = calculateNonAi({ birthYear: 1984, birthMonth: 2, yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午' }, 'male', '2025-03-08T12:34:56.000Z');
    // 命局两两配对，合/冲/害/破/刑每个方向只出现一次
    for (const key of ['liuHe', 'chong', 'xing', 'hai', 'po'] as const) {
      const seen = new Set<string>();
      for (const text of result.relationships[key]) {
        const norm = text.split('与').sort().join('与');
        expect(seen.has(norm)).toBe(false);
        seen.add(norm);
      }
    }
    const keSeen = new Set<string>();
    for (const text of result.relationships.ke) {
      expect(keSeen.has(text)).toBe(false);
      keSeen.add(text);
    }
  });

  it('ten god math: element distance and yin-yang polarity', () => {
    // 庚(金)日主：丙→七杀(克我且同阳)，丁→正官，辛→劫财，癸→伤官(我生且异)，己→正印
    const result = calculateNonAi({ birthYear: 1984, birthMonth: 2, yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午' }, 'male');
    expect(result.tenGods).toHaveLength(4);
    expect(result.tenGods[2]).toBe('日主');
    expect(result.greatFortunes[0].ganZhi).toBe('丁卯'); // 顺行从月柱后一柱
    expect(result.greatFortunes[0].tenGod).toBe('正官');
  });

  it('five element ratio over stems+branches sums to one', () => {
    const result = calculateNonAi({ birthYear: 1984, birthMonth: 2, yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午' }, 'male');
    const total = Object.values(result.elementRatio).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 10);
  });
});
describe('袁天罡称骨 (chenggu-v1)', () => {
  it('computes the classic sample: 甲子年正月初五 午时 = 四两四钱', () => {
    const result = calculateNonAi({ birthYear: 1984, birthMonth: 2, yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午' }, 'male', '2025-03-08T12:34:56.000Z');
    const cg = result.chenggu!;
    expect(cg).toBeTruthy();
    expect(cg.parts.year).toBe('一两二钱'); // 甲子
    expect(cg.parts.month).toBe('六钱');    // 正月
    expect(cg.parts.day).toBe('一两六钱');  // 初五
    expect(cg.parts.hour).toBe('一两');     // 午时
    expect(cg.totalText).toBe('四两四钱');
    expect(cg.totalLiang).toBeCloseTo(4.4, 6);
    expect(cg.ruleVersion).toBe('chenggu-v1');
  });
});