import { describe, expect, it } from 'vitest';
import { computeShenSha } from '../features/chart/shenSha';
import { calculateNonAi } from '../features/chart/nonAiCalculator';

// 经典干支神煞 classic-v1 的确定性回归(逐柱定位、可核验口诀)。
describe('classic shensha rules (classic-v1)', () => {
  it('locates each god on the exact pillar/position with a verifiable basis', () => {
    // 甲子 丙寅 乙巳 庚申：日主乙 → 天乙在子/申；驿马(子局)在寅；劫煞等逐条核验
    const items = computeShenSha(['甲子', '丙寅', '乙巳', '庚申']);
    const byName = (name: string) => items.filter((item) => item.name === name);
    expect(byName('天乙贵人')).toHaveLength(2);          // 年支子、时支申(乙己鼠猴乡)
    expect(byName('天乙贵人').map((i) => i.pillarIndex).sort()).toEqual([0, 3]);
    expect(byName('驿马')).toHaveLength(1);
    expect(byName('驿马')[0].pillarIndex).toBe(1);        // 申子辰马在寅 → 月支寅
    expect(byName('将星')).toHaveLength(1);               // 申子辰将星在子 → 年支
    expect(byName('将星')[0].pillarIndex).toBe(0);
    expect(byName('劫煞')).toHaveLength(2);               // 年支子局劫煞在巳(日)、日支巳局劫煞在寅(月)
    expect(byName('亡神')).toHaveLength(1);               // 巳酉丑亡神在申 → 时支
    expect(byName('月德贵人')).toHaveLength(1);           // 寅午戌月德在丙 → 月干
    expect(byName('空亡')).toHaveLength(1);               // 乙巳旬空寅卯 → 月支寅
    expect(byName('空亡')[0].pillarIndex).toBe(1);
    expect(byName('孤辰')).toHaveLength(1);               // 亥子丑年孤辰在寅 → 月支
    expect(items.every((item) => item.basis.length > 0)).toBe(true);
    expect(items.every((item) => ['吉', '凶', '中'].includes(item.category))).toBe(true);
  });

  it('applies yang-day-master 羊刃 only for 阳干 and skips 阴干', () => {
    expect(computeShenSha(['甲子', '丙寅', '甲午', '丁卯']).some((i) => i.name === '羊刃')).toBe(true); // 甲羊刃在卯(时支)
    const female = computeShenSha(['乙丑', '戊寅', '乙巳', '丙子']);
    expect(female.some((i) => i.name === '羊刃')).toBe(false); // 乙为阴干
  });

  it('integrates into the chart result with structured items', () => {
    const result = calculateNonAi({ birthYear: 1984, birthMonth: 2, yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午' }, 'male', '2025-03-08T12:34:56.000Z');
    expect(Array.isArray(result.shenSha.items)).toBe(true);
    expect(result.shenSha.items!.length).toBeGreaterThan(0);
    expect(result.shenSha.auspicious).toEqual(expect.any(Array));
    expect(result.shenSha.inauspicious).toEqual(expect.any(Array));
    expect(result.shenSha.ruleVersion).toContain('classic-v1');
  });
});
