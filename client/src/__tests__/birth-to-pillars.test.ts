import { describe, expect, it } from 'vitest';
import { applyTrueSolar, calculateNonAi, computePillarsFromDate, equationOfTimeMinutes, lunarToSolar } from '../features/chart/nonAiCalculator';

/* 首页「按生日自动排四柱」的正向换算：公历日期时刻 → 年月日时四柱。
   口径要点：年/月/日三柱取该日正午(与 calculateNonAi 定位日期一致，避子夜换日歧义)；
   时柱按当日日干五鼠遁(晚子时不换日)，不用历法库 getTime()——它在 23 点后按早子时换日，
   会与 calculateNonAi 的时柱校验冲突，令自动排出的命盘保存即报错。 */
describe('computePillarsFromDate 生日→四柱(与命盘引擎同口径)', () => {
  it('已知向量：普通日/立春前/立春后/跨年/当前年', () => {
    expect(computePillarsFromDate({ year: 1990, month: 5, day: 15, hour: 10, minute: 30 }))
      .toEqual({ yearPillar: '庚午', monthPillar: '辛巳', dayPillar: '庚辰', hourPillar: '辛巳' });
    // 立春前(2/3)年柱属上一干支年己卯；立春后(2/5)起算新一年庚辰。
    expect(computePillarsFromDate({ year: 2000, month: 2, day: 3, hour: 8 }).yearPillar).toBe('己卯');
    expect(computePillarsFromDate({ year: 2000, month: 2, day: 5, hour: 8 }).yearPillar).toBe('庚辰');
    expect(computePillarsFromDate({ year: 1984, month: 2, day: 2, hour: 23 }))
      .toEqual({ yearPillar: '癸亥', monthPillar: '乙丑', dayPillar: '丙寅', hourPillar: '戊子' });
    // 2024-01-01 在立春前，年柱归 2023 的癸卯。
    expect(computePillarsFromDate({ year: 2024, month: 1, day: 1, hour: 0 }))
      .toEqual({ yearPillar: '癸卯', monthPillar: '甲子', dayPillar: '甲子', hourPillar: '甲子' });
  });

  it('子夜 23 点后按时柱归当日：得「丙子」而非库 getTime 的「戊子」(晚子时不换日)', () => {
    const p = computePillarsFromDate({ year: 1990, month: 5, day: 15, hour: 23, minute: 30 });
    expect(p.dayPillar).toBe('庚辰');
    expect(p.hourPillar).toBe('丙子');
  });

  it('零点钟点也落子时、且用当日日干起时(与 23 点同为子时)', () => {
    const p = computePillarsFromDate({ year: 1990, month: 5, day: 15, hour: 0, minute: 30 });
    expect(p.hourPillar).toBe('丙子');
  });

  it('回灌 calculateNonAi：自动排出的四柱一律通过引擎自身校验(不抛「时柱与出生日不合」)', () => {
    const cases = [
      { year: 1990, month: 5, day: 15, hour: 10, minute: 30 },
      { year: 1990, month: 5, day: 15, hour: 23, minute: 30 },
      { year: 1990, month: 5, day: 15, hour: 0, minute: 30 },
      { year: 2000, month: 2, day: 3, hour: 8 },
      { year: 2000, month: 2, day: 5, hour: 8 },
      { year: 2024, month: 1, day: 1, hour: 0 },
      { year: 2026, month: 9, day: 24, hour: 15 },
    ];
    for (const c of cases) {
      const pillars = computePillarsFromDate(c);
      expect(() => calculateNonAi(
        { birthYear: c.year, birthMonth: c.month, ...pillars },
        'male',
        new Date().toISOString(),
      ), `${c.year}-${c.month}-${c.day} ${c.hour}:00 四柱 ${JSON.stringify(pillars)} 应通过校验`).not.toThrow();
    }
  });
});

/* 农历(夏历)→公历：闰月传负数月，非法农历日由 lunar-javascript 抛错。
   向量取自库实测(见 scripts 探针)，非臆测。 */
describe('lunarToSolar 农历→公历', () => {
  it('普通农历日期换算为对应公历日', () => {
    expect(lunarToSolar(1990, 5, 15)).toEqual({ year: 1990, month: 6, day: 7 });
    expect(lunarToSolar(2024, 1, 1)).toEqual({ year: 2024, month: 2, day: 10 }); // 正月初一
  });

  it('闰月用负数月：2023 闰二月初一 → 公历 2023-03-22', () => {
    expect(lunarToSolar(2023, -2, 1)).toEqual({ year: 2023, month: 3, day: 22 });
  });

  it('非法农历(该年无此闰月 / 月只 29 天却填 30)一律抛错，交上层兜中文提示', () => {
    expect(() => lunarToSolar(2023, -5, 1)).toThrow(); // 2023 无闰五月
    expect(() => lunarToSolar(2024, 9, 30)).toThrow(); // 该农历九月只有 29 天
    expect(() => lunarToSolar(2024, 1, 30)).toThrow(); // 该农历正月只有 29 天
  });

  it('农历→公历后接 computePillarsFromDate：与直接按该公历日排柱一致，且过引擎校验', () => {
    const solar = lunarToSolar(1990, 5, 15); // 1990-6-7
    const fromLunar = computePillarsFromDate({ ...solar, hour: 10, minute: 30 });
    const fromSolar = computePillarsFromDate({ year: 1990, month: 6, day: 7, hour: 10, minute: 30 });
    expect(fromLunar).toEqual(fromSolar);
    expect(() => calculateNonAi(
      { birthYear: solar.year, birthMonth: solar.month, ...fromLunar }, 'male', new Date().toISOString(),
    )).not.toThrow();
  });
});

describe('applyTrueSolar / equationOfTimeMinutes 真太阳时修正', () => {
  it('均时差极值(仅独立工具，修正已不启用 EoT)：2 月中旬约 −14.6 分、11 月初约 +16.4 分', () => {
    expect(equationOfTimeMinutes(2025, 2, 12)).toBeGreaterThan(-15.5);
    expect(equationOfTimeMinutes(2025, 2, 12)).toBeLessThan(-13.5);
    expect(equationOfTimeMinutes(2025, 11, 3)).toBeGreaterThan(15);
    expect(equationOfTimeMinutes(2025, 11, 3)).toBeLessThan(17.5);
  });

  it('北京(116.4°E) 10:00 → 经度差 −14.4 分 = 09:45，仍属巳时(改分钟不改时辰)', () => {
    const r = applyTrueSolar({ year: 2025, month: 6, day: 21, hour: 10, minute: 0 }, 116.4);
    expect(r).toMatchObject({ year: 2025, month: 6, day: 21, hour: 9, minute: 45 });
  });

  it('乌鲁木齐(87.6°E) 同一 10:00 → −129.6 分 ≈ 07:50：与北京差一个时辰(辰 vs 巳)', () => {
    const bj = computePillarsFromDate(applyTrueSolar({ year: 2025, month: 6, day: 21, hour: 10, minute: 0 }, 116.4)).hourPillar[1];
    const wlq = computePillarsFromDate(applyTrueSolar({ year: 2025, month: 6, day: 21, hour: 10, minute: 0 }, 87.6)).hourPillar[1];
    expect(bj).toBe('巳');
    expect(wlq).toBe('辰');
  });

  it('跨子夜：乌鲁木齐 00:30 修正后回退到前一日 22:20 → 日柱/命盘随之改变', () => {
    const naive = { year: 2025, month: 6, day: 21, hour: 0, minute: 30 };
    const corrected = applyTrueSolar(naive, 87.6);
    expect(corrected).toMatchObject({ day: 20, hour: 22, minute: 20 });
    const pUncorrected = computePillarsFromDate(naive);
    const pCorrected = computePillarsFromDate(corrected);
    expect(pCorrected.dayPillar).not.toBe(pUncorrected.dayPillar); // 换日 → 日柱不同
    expect(pCorrected.hourPillar[1]).toBe('亥');
  });

  it('修正后的任意日期时刻回灌 calculateNonAi 仍不抛错(时柱口径自洽)', () => {
    for (const lng of [87.6, 116.4, 121.5, 126.6]) {
      const dt = applyTrueSolar({ year: 2025, month: 6, day: 21, hour: 0, minute: 20 }, lng);
      const pillars = computePillarsFromDate(dt);
      expect(() => calculateNonAi(
        { birthYear: dt.year, birthMonth: dt.month, ...pillars }, 'female', new Date().toISOString(),
      ), `经度 ${lng} → ${JSON.stringify(dt)}`).not.toThrow();
    }
  });
});
