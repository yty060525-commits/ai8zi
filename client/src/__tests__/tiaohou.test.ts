import { describe, expect, it } from 'vitest';
import { deriveTiaohou, calculateNonAi } from '../features/chart/nonAiCalculator';

/* 调候：引擎按日主与月令季节算定的「辅助判据」(非硬结论)。这里锁三件事：
 *  1) 季节方向是古今公认的硬信号(冬→火为急、夏→水为急、春秋→非急)；
 *  2) 注入正文的那串值零拉丁字母(否则违反「正文禁英文」，模型会把字段名照抄给用户)；
 *  3) 逐日用神一律标注「参考」，与「保守子集」定位一致，不作唯一结论。 */
describe('调候(日主×月令季节)算定', () => {
  it('冬月：调候以火为急；夏月：以水为急；春秋：非急', () => {
    expect(deriveTiaohou('甲', '子')).toContain('冬');
    expect(deriveTiaohou('甲', '子')).toContain('调候以火为急');
    expect(deriveTiaohou('甲', '丑')).toContain('调候以火为急');
    expect(deriveTiaohou('甲', '亥')).toContain('调候以火为急');
    expect(deriveTiaohou('丙', '午')).toContain('调候以水为急');
    expect(deriveTiaohou('丙', '巳')).toContain('调候以水为急');
    expect(deriveTiaohou('庚', '寅')).toContain('调候非急');
    expect(deriveTiaohou('庚', '酉')).toContain('调候非急');
  });

  it('整串值不含任何拉丁字母(字段名走键名，正文只给中文)', () => {
    for (const gan of ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸']) {
      for (const zhi of ['寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥', '子', '丑']) {
        const s = deriveTiaohou(gan, zhi);
        expect(s.length, gan + zhi).toBeGreaterThan(0);
        expect(s, gan + zhi).not.toMatch(/[A-Za-z]/);
        // 每条都带季节、穷通出处与「参考」标注
        expect(s).toContain('《穷通宝鉴》');
        expect(s).toContain('参考');
      }
    }
  });

  it('未知日主或月支时返回空串，不硬凑', () => {
    expect(deriveTiaohou('', '寅')).toBe('');
    expect(deriveTiaohou('甲', '')).toBe('');
    expect(deriveTiaohou('甲', 'X')).toBe('');
  });

  it('calculateNonAi 把调候算进 nonAiResult，且为该盘季节的中文串', () => {
    // 庚午日、丙寅月：庚金生辰(寅月属春)→ 春、非急。
    const r = calculateNonAi(
      { birthYear: 1984, birthMonth: 2, yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午' },
      'male', '2026-01-05T02:00:00.000Z',
    );
    expect(typeof r.tiaohouFacts).toBe('string');
    expect((r.tiaohouFacts as string).length).toBeGreaterThan(0);
    expect(r.tiaohouFacts).toContain('春');
    expect(r.tiaohouFacts).not.toMatch(/[A-Za-z]/);
  });
});
