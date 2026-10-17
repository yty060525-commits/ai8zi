import { afterEach, describe, expect, it, vi } from 'vitest';
import * as LunarLibrary from 'lunar-javascript';
import { Solar } from 'lunar-javascript';
import { applyTrueSolar, calculateNonAi, computePillarsFromDate } from '../features/chart/nonAiCalculator';

const pillarsAt = (year: number, month: number, day: number, hour: number, minute = 0) => {
  return computePillarsFromDate({ year, month, day, hour, minute });
};

describe('出生时刻精度与排盘事实', () => {
  it('立春同日按出生时刻切换年柱和月柱', () => {
    const before = computePillarsFromDate({ year: 2026, month: 2, day: 4, hour: 3, minute: 0 });
    const after = computePillarsFromDate({ year: 2026, month: 2, day: 4, hour: 5, minute: 0 });
    expect(before).toMatchObject({ yearPillar: '乙巳', monthPillar: '己丑' });
    expect(after).toMatchObject({ yearPillar: '丙午', monthPillar: '庚寅' });
  });

  it('惊蛰同日按输入时刻切换月柱；calendarTime 可与修正时刻分开', () => {
    const before = computePillarsFromDate({ year: 2026, month: 3, day: 5, hour: 18, minute: 0 });
    const after = computePillarsFromDate({ year: 2026, month: 3, day: 5, hour: 23, minute: 0 });
    expect(before.monthPillar).toBe('庚寅');
    expect(after.monthPillar).toBe('辛卯');

    const corrected = computePillarsFromDate(
      { year: 2026, month: 3, day: 5, hour: 23, minute: 0 },
      { calendarTime: { year: 2026, month: 3, day: 5, hour: 18, minute: 0 } },
    );
    expect(corrected.monthPillar).toBe('庚寅');
    expect(corrected.hourPillar).toBe(after.hourPillar);
  });

  it('自动排盘保留原时刻，起运与库的精确出生时刻一致', () => {
    for (const [hour, minute] of [[0, 0], [12, 30], [23, 0], [23, 59]]) {
      const time = { year: 1990, month: 5, day: 15, hour, minute };
      const result = calculateNonAi({ birthYear: 1990, birthMonth: 5, birthDay: 15, ...pillarsAt(1990, 5, 15, hour, minute), birthTime: time }, 'male');
      const yun = Solar.fromYmdHms(time.year, time.month, time.day, time.hour, time.minute, 0).getLunar().getEightChar().getYun(1);
      expect(result.birthTime).toEqual(time);
      expect(result.luckStart, `${hour}:${minute}`).toMatchObject({
        years: Number(yun.getStartYear()), months: Number(yun.getStartMonth()), days: Number(yun.getStartDay()),
        date: String(yun.getStartSolar().toYmd()),
      });
    }
  });

  it('立春前后两性别的年干方向、月柱首步与库顺逆一致', () => {
    const cases = [
      { hour: 3, gender: 'male' as const, forward: false }, { hour: 3, gender: 'female' as const, forward: true },
      { hour: 5, gender: 'male' as const, forward: true }, { hour: 5, gender: 'female' as const, forward: false },
    ];
    const ganzhi = Array.from({ length: 60 }, (_, i) => '甲乙丙丁戊己庚辛壬癸'[i % 10] + '子丑寅卯辰巳午未申酉戌亥'[i % 12]);
    for (const c of cases) {
      const input = pillarsAt(2026, 2, 4, c.hour);
      const birthTime = { year: 2026, month: 2, day: 4, hour: c.hour, minute: 0 };
      const result = calculateNonAi({ birthYear: 2026, birthMonth: 2, birthDay: 4, birthTime, ...input }, c.gender);
      const yun = Solar.fromYmdHms(2026, 2, 4, c.hour, 0, 0).getLunar().getEightChar().getYun(c.gender === 'male' ? 1 : 0);
      expect(result.luckStart?.date).toBe(String(yun.getStartSolar().toYmd()));
      const monthIndex = ganzhi.indexOf(input.monthPillar);
      expect(result.greatFortunes[0].ganZhi).toBe(ganzhi[(monthIndex + (c.forward ? 1 : 59)) % 60]);
    }
  });

  it('跨子夜经度修正后，起运及跨度锚点仍使用原民用日期', () => {
    const birthTime = { year: 2025, month: 6, day: 21, hour: 0, minute: 30 };
    const corrected = applyTrueSolar(birthTime, 87.6);
    expect(corrected).toMatchObject({ year: 2025, month: 6, day: 20, hour: 22, minute: 20 });
    const result = calculateNonAi({
      birthYear: corrected.year, birthMonth: corrected.month, birthDay: corrected.day,
      birthTime, ...pillarsAt(corrected.year, corrected.month, corrected.day, corrected.hour, corrected.minute),
    }, 'male');
    const solar = Solar.fromYmdHms(birthTime.year, birthTime.month, birthTime.day, birthTime.hour, birthTime.minute, 0);
    const yun = solar.getLunar().getEightChar().getYun(1);
    const start = new Date(Date.UTC(birthTime.year + Number(yun.getStartYear()), birthTime.month - 1, birthTime.day));
    const totalMonths = (birthTime.month - 1) + Number(yun.getStartMonth());
    const month = ((totalMonths % 12) + 12) % 12;
    const year = start.getUTCFullYear() + Math.floor(totalMonths / 12);
    const day = Math.min(birthTime.day, new Date(Date.UTC(year, month + 1, 0)).getUTCDate());
    start.setUTCFullYear(year, month, day);
    start.setUTCDate(start.getUTCDate() + Number(yun.getStartDay()));
    expect(result.birthTime).toEqual(birthTime);
    expect(result.luckStart?.date).toBe(String(yun.getStartSolar().toYmd()));
    expect(result.luckOnset).toBe(`${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, '0')}-${String(start.getUTCDate()).padStart(2, '0')}`);
  });

  it('非法 birthTime 抛错，不能静默退回正午近似', () => {
    expect(() => calculateNonAi({
      birthYear: 1990, birthMonth: 5, birthDay: 15, ...pillarsAt(1990, 5, 15, 12),
      birthTime: { year: 1990, month: 5, day: 15, hour: 24, minute: 0 },
    }, 'male')).toThrow(/出生时刻/);
  });

  it('重复地支不构成自身三合', () => {
    const result = calculateNonAi({
      birthYear: 1990, birthMonth: 5, birthDay: 15,
      yearPillar: '庚午', monthPillar: '辛巳', dayPillar: '庚辰', hourPillar: '辛巳',
    }, 'male');
    expect(result.relationships.sanHe).not.toContain('辛巳与辛巳');
    expect(result.relationshipDetails.filter((hit) => hit.type === 'sanHe' && hit.sourcePillar === '辛巳' && hit.targetPillar === '辛巳')).toHaveLength(0);

    const half = calculateNonAi({ birthYear: 1984, birthMonth: 2, yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午' }, 'male');
    expect(half.relationships.sanHe).toContain('丙寅与庚午');
    expect(half.relationships.sanHe).not.toContain('庚午与壬午');
    const complete = calculateNonAi({ birthYear: 1950, birthMonth: 1, birthDay: 1, yearPillar: '己丑', monthPillar: '丙子', dayPillar: '丙申', hourPillar: '壬辰' }, 'male');
    expect(complete.relationshipDetails).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'sanHe', targetPillar: '申子辰', status: 'complete' }),
    ]));
  });

  it('原月失败后扩窗跳过原月候选；完全失败仅检查 71 个唯一日期', () => {
    const EightCharFactory = (LunarLibrary as unknown as { EightChar: { fromLunar: (...args: unknown[]) => unknown } }).EightChar;
    const fromLunar = vi.spyOn(EightCharFactory, 'fromLunar');
    try {
      expect(() => calculateNonAi({
        birthYear: 1900, birthMonth: 1, yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午',
      }, 'male')).toThrow(/找不到/);
      expect(fromLunar).toHaveBeenCalledTimes(71);
    } finally {
      fromLunar.mockRestore();
    }
  });

  it('扫描保持月内优先，再向左、向右扩展并返回匹配日期', () => {
    const left = calculateNonAi({
      birthYear: 1990, birthMonth: 6,
      ...pillarsAt(1990, 5, 15, 10),
    }, 'male');
    expect(left.solarDate).toBe('1990-05-15');

    const right = calculateNonAi({
      birthYear: 1984, birthMonth: 1,
      ...pillarsAt(1984, 2, 6, 10),
    }, 'male');
    expect(right.solarDate).toBe('1984-02-06');

    const lateDecember = calculateNonAi({
      birthYear: 1994, birthMonth: 12, ...pillarsAt(1994, 12, 26, 10),
    }, 'male');
    expect(lateDecember.solarDate).toBe('1994-12-26');
  });

  it('记录固定命盘的暖态耗时，不以机器抖动设毫秒门槛', () => {
    const sameMonth = { birthYear: 1984, birthMonth: 2, ...pillarsAt(1984, 2, 6, 10) };
    const leftWindow = { birthYear: 1990, birthMonth: 6, ...pillarsAt(1990, 5, 15, 10) };
    const rightWindow = { birthYear: 1984, birthMonth: 1, ...pillarsAt(1984, 2, 6, 10) };
    const noMatch = { birthYear: 1900, birthMonth: 1, yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午' };
    const fixtures = [
      ['month-hit', sameMonth], ['left-window', leftWindow], ['right-window', rightWindow], ['no-match', noMatch],
    ] as const;
    const elapsed: Record<string, number> = {};
    for (const [name, input] of fixtures) {
      const run = () => {
        try { calculateNonAi(input, 'male'); } catch { /* no-match is an expected benchmark fixture */ }
      };
      run(); run(); // warm up JIT and the calendar module
      const start = performance.now();
      for (let i = 0; i < 8; i += 1) run();
      elapsed[name] = Math.round((performance.now() - start) * 100) / 100;
    }
    console.info('CORE_CHART_WARM_MS_8=' + JSON.stringify(elapsed));
  });
});

afterEach(() => vi.restoreAllMocks());
