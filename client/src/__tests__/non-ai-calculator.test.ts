import { describe, expect, it, vi } from 'vitest';
import { calculateNonAi, chinaYear } from '../features/chart/nonAiCalculator';
import { zodiacOfBranch } from '../utils/interpersonal';

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
    expect(result.twelveLongevity).toHaveLength(3);
    expect(result.shenSha).toEqual(expect.objectContaining({ auspicious: expect.any(Array), inauspicious: expect.any(Array) }));
  });

  it('does not silently use a candidate from a different birth year', () => {
    // 四柱与该月对不上必须报错，绝不能悄悄借用别的年份的候选日
    expect(() => calculateNonAi({ birthYear: 1900, birthMonth: 1, yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午' }, 'male')).toThrow(/找不到|不合/);
  });

  it('时柱回显用户所填，不被库按「正午近似」重算覆盖', () => {
    // 定位出生日期只用年/月/日三柱，eight.getTime() 因此几乎恒为「午」。
    // 旧实现把它当作时柱输出：输入癸未 → 界面显示壬午，与同页藏干/十神/纳音全不一致。
    const r = calculateNonAi({ birthYear: 1990, birthMonth: 5, yearPillar: '庚午', monthPillar: '辛巳', dayPillar: '乙酉', hourPillar: '癸未' }, 'male');
    expect(r.pillars.hour).toBe('癸未');
    expect(r.pillars).toEqual({ year: '庚午', month: '辛巳', day: '乙酉', hour: '癸未' });
    // 十二长生只给年/月/日三支(时支不列)，且顺序与前三柱对齐
    expect(r.twelveLongevity).toHaveLength(3);
    expect(r.twelveLongevity[2]).toBe('绝'); // 乙日主坐酉＝绝
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

  it('大运按经典起运排定：起点＝起运年，且必覆盖当前年与预测窗口', () => {
    const result = calculateNonAi({ birthYear: 1984, birthMonth: 2, yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午' }, 'male', '2025-03-08T12:34:56.000Z');
    expect((result as unknown as Record<string, unknown>).fortuneMethod).toBeUndefined();
    expect((result as unknown as Record<string, unknown>).fortuneStart).toBeUndefined();
    // 干支仍按「阳男顺排」从月柱起进：丙寅 → 丁卯(与 lunar-javascript getYun 的首步大运一致)
    expect(result.greatFortunes[0].ganZhi).toBe('丁卯');
    // 年份连续、每步 +10，且第一步覆盖当前年 → 未来十年必有可分析的大运段
    expect(result.greatFortunes.every((g, i, arr) => i === 0 || g.startYear === arr[i - 1].startYear + 10)).toBe(true);
    const currentYear = new Date(result.currentTime!).getUTCFullYear();
    const covering = result.greatFortunes.filter((g) => g.startYear <= currentYear && currentYear <= g.endYear);
    expect(covering).toHaveLength(1);
    // 预测窗口 [currentYear, currentYear+9] 与大运集合有重叠（编排器按重叠挑选大运任务）
    const overlapsWindow = result.greatFortunes.filter((g) => g.startYear <= currentYear + 9 && g.endYear >= currentYear);
    expect(overlapsWindow.length).toBeGreaterThanOrEqual(1);
    // 起点不再是「十年整数边界」：那等于把每个人的大运都对齐到墙上时钟，谁都是同一套。
    // 1984-02-06 生男，距下一节约 9 年余 → 起运 1993，首柱丁卯即从 1993 起。
    expect(result.luckStart).not.toBeNull();
    expect(result.luckStart!.years).toBeGreaterThan(0);
    expect(result.greatFortunes[0].startYear).toBe(1993);
    expect(result.tenGodDetails!.heavenly).toHaveLength(4);
    expect(result.tenGodDetails!.hidden).toHaveLength(4);
    expect(result.tenGodDetails!.hidden[1]).toHaveLength(3);
    expect(result.relationshipDetails).toEqual(expect.arrayContaining([expect.objectContaining({ type: expect.any(String), sourceLayer: expect.any(String), targetPillar: expect.any(String), status: expect.any(String) })]));
    expect(result.annualFortunes[0].relationshipDetails).toEqual(expect.any(Array));
    expect(result.monthlyFortunes[0].relationshipDetails).toEqual(expect.any(Array));
    expect(result.shenSha.ruleVersion).toBeTruthy();
    // 择日神煞(daySha/dayTianShen/timeTianShen)已移除：界面不显示、提示词不用，属纯浪费计算
    expect(result.shenSha).not.toHaveProperty('daySha');
    expect(result.shenSha).not.toHaveProperty('dayTianShen');
    expect(result.shenSha.source).toContain('local');
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

  it('本命生肖按立春年柱(非春节)：立春后·春节前出生与年支一致，不再自相矛盾', () => {
    // 2024 立春≈2/4、春节 2/10。2024-02-06 生 → 年柱甲辰(辰=龙)，但库 getYearShengXiao()
    // 按正月初一仍算「兔(卯)」→ 详情页「本命生肖 兔」与「年支 辰」/「我属龙」互相打架(线上实测复现)。
    const r = calculateNonAi({ birthYear: 2024, birthMonth: 2, yearPillar: '甲辰', monthPillar: '丙寅', dayPillar: '庚子', hourPillar: '壬午' }, 'male');
    expect(r.pillars.year).toBe('甲辰');
    expect(r.zodiac).toBe('龙');
    // 不变式：本命生肖恒等于年柱地支的属相(与命理「年柱/大运同以立春为界」一致)
    expect(r.zodiac).toBe(zodiacOfBranch(r.pillars.year[1]));
  });

  /* 大运曾经压根不做起运推算：第 0 步对齐到「当前公历十年」，于是干支↔年份的对应
     随时间漂移，任何人的「丁卯运 2020-2029」都不是他自己的那一运。
     这里拿 lunar-javascript 自己的 getYun().getDaYun() 当外部真值来核，
     顺带把阳男/阴男/阳女/阴女四种顺逆都覆盖一遍。 */
  describe('大运与起运(对照 lunar-javascript)', () => {
    const cases: Array<{ label: string; input: Parameters<typeof calculateNonAi>[0]; gender: 'male' | 'female'; yunGender: number }> = [
      { label: '阳男顺排', input: { birthYear: 1984, birthMonth: 2, yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午' }, gender: 'male', yunGender: 1 },
      { label: '阳女逆排', input: { birthYear: 1984, birthMonth: 2, yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午' }, gender: 'female', yunGender: 0 },
      { label: '阴男逆排', input: { birthYear: 1990, birthMonth: 1, yearPillar: '己巳', monthPillar: '丙子', dayPillar: '庚午', hourPillar: '壬午' }, gender: 'male', yunGender: 1 },
      { label: '阴女顺排', input: { birthYear: 1990, birthMonth: 1, yearPillar: '己巳', monthPillar: '丙子', dayPillar: '庚午', hourPillar: '壬午' }, gender: 'female', yunGender: 0 },
    ];
    for (const c of cases) {
      it(`${c.label}：起运年与每柱干支/起始年都与库一致`, async () => {
        const { Solar } = await import('lunar-javascript');
        const result = calculateNonAi(c.input, c.gender, '2026-06-01T04:00:00.000Z');
        expect(result.luckStart).not.toBeNull();
        // 出生日由「年月+三柱」定位而来，用它向库要起运与大运序列作为真值
        const y = Number(/^(\d{4})/.exec(result.solarDate)![1]);
        const mo = Number(/^(\d{4})-(\d{2})/.exec(result.solarDate)![2]);
        const dd = Number(/^(\d{4})-(\d{2})-(\d{2})/.exec(result.solarDate)![3]);
        const born = Solar.fromYmdHms(y, mo, dd, 12, 30, 0);
        const yun = born.getLunar().getEightChar().getYun(c.yunGender);
        expect(result.luckStart!.date).toBe(String(yun.getStartSolar().toYmd()));
        // 库的第 1..N 步大运(第 0 项是出生到起运那段，无干支)就是我们的九柱
        const da = yun.getDaYun(1 + result.greatFortunes.length).slice(1);
        expect(da).toHaveLength(result.greatFortunes.length);
        result.greatFortunes.forEach((row, i) => {
          expect(row.ganZhi).toBe(da[i].getGanZhi());
          // 库按「起运日期所在公历年」给区间；我们按干支年(立春)归整，最多差 1 年。
          expect(Math.abs(row.startYear - da[i].getStartYear())).toBeLessThanOrEqual(1);
        });
        // 相邻两柱必相差整 10 年、且方向沿六十甲子单调顺/逆
        expect(result.greatFortunes.every((g, i) => i === 0 || g.startYear === result.greatFortunes[i - 1].startYear + 10)).toBe(true);
        const deltas = result.greatFortunes.map((g) => GZ60.indexOf(g.ganZhi));
        const step = deltas[1] - deltas[0];
        expect(deltas.every((v, i) => i === 0 || v === ((deltas[0] + step * i) % 60 + 60) % 60)).toBe(true);
        expect(step === 1 || step === -1).toBe(true);
      });
    }
  });
});

const GZ60 = Array.from({ length: 60 }, (_, n) => '甲乙丙丁戊己庚辛壬癸'[n % 10] + '子丑寅卯辰巳午未申酉戌亥'[n % 12]);
