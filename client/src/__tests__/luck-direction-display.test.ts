/* =============================================================================
 * 【判据空白 #150】大运「顺排 / 逆排」这个方向读数：引擎算了，界面上从来没有。
 *
 * 取证(2026-10-10，实测而非推断)：
 *   · 引擎侧唯一真源 nonAiCalculator.ts:578 `fortuneDirection(yearStem, gender)`，
 *     消费点 :750 定 forward、:801 `step = forward ? 1 : -1`、:814 `gzAt(monthIndex + step*(k+1))`；
 *   · `grep -rn "顺排|逆排" client/src --include=*.tsx --include=*.ts | grep -v __tests__`
 *     命中 **0 处**(只有注释)，即整个展示层没有任何一处说出这一步的方向；
 *   · NonAiChart 里没有 direction 字段(types/domain.ts:39+)，详情表 fields(:230-236)也没有这一行。
 * 于是用户看到九步大运的干支序列，却读不出它是从月柱往后数还是往前数 ——
 * 「阳男阴女顺、阴男阳女逆」这条最基础的排法在页面上是隐形的。
 *
 * 本文件先钉**引擎真值**(十干×两性别的穷举方向)，再钉**界面文案**与它同源。
 * ⚠ 顺序要求：界面那两条必须渲染真实组件(PersonDetail)，不能只测我导出的纯函数 ——
 *   否则「函数对了但没铺进 fields」这一类丢失照样全绿(见 [[feedback-assertion-must-touch-the-component]])。
 * ========================================================================== */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { calculateNonAi, computePillarsFromDate } from '../features/chart/nonAiCalculator';
import { luckDirectionText } from '../features/person/PersonDetail';

const STEMS = '甲乙丙丁戊己庚辛壬癸'.split('');
const BRANCHES = '子丑寅卯辰巳午未申酉戌亥'.split('');
const YANG = '甲丙戊庚壬';

/** 逐年逐日找一个「年干 == 目标天干」的真实日期，取该日正午口径的完整四柱。
 *  必须这样造夹具：calculateNonAi 会校验年/月/日三柱能否在同一真实日期上成立(:733 抛错)，
 *  手拼的四柱大多会被它拒掉(实测：'甲'+自配地支直接 throw「该月找不到…」)。 */
const realPillarsFor = (stem: string) => {
  for (let year = 1975; year < 2005; year++) {
    for (let month = 1; month <= 12; month++) {
      const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
      for (let day = 1; day <= lastDay; day++) {
        const p = computePillarsFromDate({ year, month, day, hour: 10 });
        if (p.yearPillar[0] === stem) return { year, month, day, ...p };
      }
    }
  }
  throw new Error(`找不到年干为${stem}的真实日期`);
};

/** 沿六十甲子走一步(d=+1 顺、d=-1 逆)，用于从「首步运干支」反推引擎实际走的方向。 */
const stepOf = (gz: string, d: number) =>
  STEMS[(STEMS.indexOf(gz[0]) + d + 10) % 10] + BRANCHES[(BRANCHES.indexOf(gz[1]) + d + 12) % 12];

type Case = { stem: string; gender: 'male' | 'female'; forward: boolean; label: string };
const CASES: Case[] = STEMS.flatMap((stem) => [
  { stem, gender: 'male' as const, forward: YANG.includes(stem), label: `${YANG.includes(stem) ? '阳男顺排' : '阴男逆排'}(${stem})` },
  { stem, gender: 'female' as const, forward: !YANG.includes(stem), label: `${YANG.includes(stem) ? '阳女逆排' : '阴女顺排'}(${stem})` },
]);

describe('#150 大运方向：引擎真值(十干×两性别穷举)', () => {
  it.each(CASES)('$label', ({ stem, gender, forward }) => {
    const f = realPillarsFor(stem);
    const chart = calculateNonAi(
      { birthYear: f.year, birthMonth: f.month, birthDay: f.day, yearPillar: f.yearPillar, monthPillar: f.monthPillar, dayPillar: f.dayPillar, hourPillar: f.hourPillar },
      gender, '2026-06-01T04:00:00.000Z');
    const rows = chart.greatFortunes ?? [];
    expect(rows.length, '大运必须排出九步').toBeGreaterThan(0);
    // 方向是从**首步运干支**反推出来的读数，不是我另外算一遍的期望值。
    const head = stepOf(f.monthPillar, 1);
    const tail = stepOf(f.monthPillar, -1);
    expect([head, tail], `首步运 ${rows[0].ganZhi} 应是月柱 ${f.monthPillar} 的前一柱或后一柱`).toContain(rows[0].ganZhi);
    expect(rows[0].ganZhi === head, `${stem}${gender} 的方向` ).toBe(forward);
    // 整条序列同向：第二步相对第一步也走同一方向，不允许中途翻面。
    expect(rows[1]?.ganZhi).toBe(stepOf(rows[0].ganZhi, forward ? 1 : -1));
  });

  it('方向判定本身能被分叉(尺子预检：换性别必换方向)', () => {
    const f = realPillarsFor('甲');
    const base = { birthYear: f.year, birthMonth: f.month, birthDay: f.day, yearPillar: f.yearPillar, monthPillar: f.monthPillar, dayPillar: f.dayPillar, hourPillar: f.hourPillar };
    const m = calculateNonAi(base, 'male', '2026-06-01T04:00:00.000Z').greatFortunes?.[0]?.ganZhi;
    const w = calculateNonAi(base, 'female', '2026-06-01T04:00:00.000Z').greatFortunes?.[0]?.ganZhi;
    expect(m, '阳男与阳女的首步运不该相同').not.toBe(w);
  });
});

describe('#150 大运方向：界面文案与引擎同源', () => {
  /* 前缀字节钉的是「这句话怎么来的」：年干阴阳 + 性别 → 顺/逆，四段一个都不能少。
     只断言 endsWith('顺排') 的话，把整句改成硬编码「顺排」也能活(实测同类缺陷 #147 B2 的教训)。 */
  it('阳男/阴女读成顺排，且句式带得出依据', () => {
    expect(luckDirectionText('甲', 'male')).toBe('顺排(阳男阴女顺行)');
    expect(luckDirectionText('乙', 'female')).toBe('顺排(阳男阴女顺行)');
  });
  it('阴男/阳女读成逆排', () => {
    expect(luckDirectionText('乙', 'male')).toBe('逆排(阴男阳女逆行)');
    expect(luckDirectionText('甲', 'female')).toBe('逆排(阴男阳女逆行)');
  });
  it('十干×两性别穷举：文案说的方向必须就是引擎排出来的方向', () => {
    for (const c of CASES) {
      const f = realPillarsFor(c.stem);
      const chart = calculateNonAi(
        { birthYear: f.year, birthMonth: f.month, birthDay: f.day, yearPillar: f.yearPillar, monthPillar: f.monthPillar, dayPillar: f.dayPillar, hourPillar: f.hourPillar },
        c.gender, '2026-06-01T04:00:00.000Z');
      const text = luckDirectionText(chart.pillars.year[0], c.gender);
      const saysForward = /\(阳男阴女顺行\)$/.test(text);
      expect(saysForward, `${c.stem}${c.gender} 文案「${text}」与引擎首步运 ${chart.greatFortunes?.[0]?.ganZhi} 不同源`).toBe(c.forward);
    }
  });
  it('缺年柱时如实返回「暂无」而不是蒙一个方向', () => {
    expect(luckDirectionText('', 'male')).toBe('暂无');
    expect(luckDirectionText(undefined as unknown as string, 'male')).toBe('暂无');
  });

  /* 【源字节钉子】上面那条穷举比对是**结果型**判据：实测变异 M4(把引擎 fortuneDirection 的
     `=== (gender === 'male')` 翻成 `!==`)让十条真值用例全红，而这条穷举比对**照旧绿** ——
     因为文案与引擎同时翻面，两者仍然一致。这不算错(它钉的就是「同源」)，但意味着单靠它挡不住
     「引擎口径被改、界面跟着一起错」这种整体翻转。所以这里直接读两端源文件的字节，把「同一句话」
     钉死：谁只改一边、或者两边一起改成别的规则，这句都会红。
     ⚠ 必须读字节而不是调函数：调用方拿到的永远是改后的行为，只有源串能证明两处用的是同一条规则
     (同类教训见 #148 的 M2 存活)。 */
  it('两端源字节确实写着同一条规则(防止整句被换成硬编码或另一套规则)', () => {
    const rel = (p: string) => fileURLToPath(new URL(p, import.meta.url));
    const norm = (s: string) => s.replace(/\r\n/g, '\n');
    const engine = norm(readFileSync(rel('../features/chart/nonAiCalculator.ts'), 'utf8'));
    const view = norm(readFileSync(rel('../features/person/PersonDetail.tsx'), 'utf8'));
    expect(engine, '引擎那行方向判定被改写 ⇒ 本文件的比对基准已经变了').toContain(
      "return YANG.includes(yearStem) === (gender === 'male');");
    expect(view, '展示层那句方向判定被改写 ⇒ 与引擎不再同源').toContain(
      "const forward = ('甲丙戊庚壬'.includes(yearStem)) === (gender === 'male');");
    // 反向钉子：这两句必须是**各自文件里唯一**的一处写法，否则将来有人复制一份出去漂移。
    expect(engine.split("=== (gender === 'male');").length - 1, '引擎里出现多处同形判定').toBe(1);
  });
});
