/* 【判据空白 #151 · 引擎半边】「修正四柱」必须走排盘引擎，而不是只把新字符串塞进 record。

   这条链的形状(实测于 nonAiCalculator.ts)：
     calculateNonAi(:690) 收 {birthYear, birthMonth, birthDay?, 四柱} + gender
       → 三柱在该月逐日反查定位日期(:736 scanRange)，查不到抛「该月找不到与这三部命盘对应的日期」
       → 时柱按**输入日干**五鼠遁校验(:748)，不合抛「时柱与出生日不合」
       → 阴阳不合抛「每柱天干和地支必须阴阳相同」
       → 五行/十神/藏干/纳音/十二长生按 pillars(用户输入)重算
       → 大运 forward 由**年干**定(:578 fortuneDirection)、步运从**月柱**序数 ±1(:814)
       → 起运 luckStart/computeLuckStart 也吃 gender(:755)
   所以「改了四柱但派生事实不动」＝界面自相矛盾；本项目同类缺陷已修过多次
   (见 [[feedback-assertion-must-touch-the-component]]、[[project-display-gap-class]])。
   本文件先钉住「只有整条重算才会变的东西」，再证明产品代码调的就是这条路。

   ⚠ 夹具口径：四柱一律由 computePillarsFromDate 反查真实日期得到，绝不手写干支串 ——
     引擎会把年月日三柱拿去和真实历法比对，手编的合法干支照样抛「该月找不到日期」
     (#150 踩过一次，教训记在 luck-direction-display.test.ts 顶部)。 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { calculateNonAi, computePillarsFromDate } from '../features/chart/nonAiCalculator';

const rel = (p: string) => resolve(dirname(fileURLToPath(import.meta.url)), p);
const norm = (s: string) => s.replace(/\r\n/g, '\n');

/** 取一个真实存在的生日，排出四柱。 */
const realChart = (year: number, month: number, day: number, hour: number, gender: 'male' | 'female') => {
  const pillars = computePillarsFromDate({ year, month, day, hour });
  return { pillars, chart: calculateNonAi({ birthYear: year, birthMonth: month, ...pillars }, gender) };
};

const BASE = realChart(1984, 2, 6, 10, 'male');
/** 换一柱的对照：同一年月内另找一个真实日期，让引擎能定位到新命盘。 */
const ALT = realChart(1984, 2, 14, 10, 'male');
/** 立春(1984-02-04)之前排出来的盘：年柱仍属上一干支年(癸亥)，与 BASE(甲丑/丙寅一带)不同年柱。
 *  「改年柱」这件事必须拿它当对照，不能拿同一年内的另一天 —— 实测同月两天的年支都是同一个，
 *  生肖自然不变(我第一版就想当然写成「换生日⇒生肖变」，被自己的判据打回)。 */
const PRE = realChart(1984, 1, 28, 10, 'male');

describe('#151 引擎语义：改四柱必须带动全部派生事实', () => {
  it('前提：两个夹具都能排出来，且确实是不同的命盘', () => {
    expect(BASE.pillars.yearPillar).toMatch(/^[甲乙丙丁戊己庚辛壬癸][子丑寅卯辰巳午未申酉戌亥]$/);
    expect(ALT.pillars.yearPillar).toMatch(/^[甲乙丙丁戊己庚辛壬癸][子丑寅卯辰巳午未申酉戌亥]$/);
    // 若两条盘完全一样，下面所有「会变」的判据都是空谈 —— 先把前提钉住。
    expect(ALT.pillars.dayPillar).not.toBe(BASE.pillars.dayPillar);
  });

  it('改日柱 ⇒ 日主跟着变（不是只换个显示字）', () => {
    expect(ALT.chart.dayMaster).toBe(ALT.pillars.dayPillar[0]);
    expect(ALT.chart.dayMaster).not.toBe(BASE.chart.dayMaster);
  });

  it('改年柱 ⇒ 生肖与本命运序列跟着变（forward 由年干定）', () => {
    // 前提：这两个夹具的年柱必须真的不同，否则下面两句都是空谈。
    expect(PRE.pillars.yearPillar).not.toBe(BASE.pillars.yearPillar);
    expect(PRE.chart.zodiac).not.toBe(BASE.chart.zodiac);
    expect(PRE.chart.greatFortunes.map((g) => g.ganZhi).join()).not.toBe(BASE.chart.greatFortunes.map((g) => g.ganZhi).join());
  });

  it('性别翻转 ⇒ 大运方向翻面，且首步运是月柱的前一柱而非后一柱', () => {
    const F = realChart(1984, 2, 6, 10, 'female');
    const gzIndex = (gz: string) => {
      const S = '甲乙丙丁戊己庚辛壬癸', B = '子丑寅卯辰巳午未申酉戌亥';
      const i = (S.indexOf(gz[0]) % 10), j = B.indexOf(gz[1]);
      // 六十甲子序数：满足 n≡i(10)、n≡j(12) 的最小非负 n
      for (let n = 0; n < 60; n += 1) if (n % 10 === i && n % 12 === j) return n;
      return -1;
    };
    const m = gzIndex(BASE.pillars.monthPillar);
    const step = (a: number, b: number) => ((b - a) % 60 + 60) % 60;
    // 男(阳年干)顺排：首步 = 月柱 +1；女(同年干)逆排：首步 = 月柱 −1
    expect(step(m, gzIndex(BASE.chart.greatFortunes[0].ganZhi))).toBe(1);
    expect(step(m, gzIndex(F.chart.greatFortunes[0].ganZhi))).toBe(59);
  });

  it('非法修正会被引擎拒绝：阴阳不合 / 时柱不合 / 该月找不到日期', () => {
    expect(() => calculateNonAi({ birthYear: 1984, birthMonth: 2, ...BASE.pillars, yearPillar: '甲丑' }, 'male'))
      .toThrow(/阴阳相同/);
    expect(() => calculateNonAi({ birthYear: 1984, birthMonth: 2, ...BASE.pillars, hourPillar: '甲子' }, 'male'))
      .toThrow(/时柱与出生日不合/);
    // 把月柱换成该月不可能出现的柱：定位失败必须抛，不能静默排出一张错盘
    expect(() => calculateNonAi({ birthYear: 1984, birthMonth: 2, ...BASE.pillars, monthPillar: '壬午' }, 'male'))
      .toThrow(/找不到/);
  });

  it('早子时换日的盘：修正时必须带 birthDay，否则公历日被日柱反查带偏到次日', () => {
    const shifted = computePillarsFromDate({ year: 1984, month: 2, day: 6, hour: 23 }, { ziShiftDay: true });
    const withDay = calculateNonAi({ birthYear: 1984, birthMonth: 2, birthDay: 6, ...shifted }, 'male');
    const withoutDay = calculateNonAi({ birthYear: 1984, birthMonth: 2, ...shifted }, 'male');
    // 这一条不是「产品有 bug」的断言，而是交代 birthDay 为什么不能丢：丢了就换一天。
    expect(withDay.solarDate).toBe('1984-02-06');
    expect(withoutDay.solarDate).not.toBe(withDay.solarDate);
  });
});

describe('#151 同源钉子：详情页的修正确实走引擎', () => {
  const view = norm(readFileSync(rel('../features/person/PersonDetail.tsx'), 'utf8'));

  it('applyPillarEdit 里调的是 calculateNonAi，不是只替换字符串', () => {
    // 锚点唯一性当场自证：这两句在本文件各只出现一次，命中数≠1 说明锚点选坏了。
    expect(count(view, 'async function applyPillarEdit')).toBe(1);
    const start = view.indexOf('async function applyPillarEdit');
    const body = view.slice(start, start + 2200);
    expect(body, '修正四柱必须重新调用排盘引擎').toContain('calculateNonAi({');
    expect(body, '必须把新的四柱展开进去，否则存的还是旧柱').toContain('...loadedRecord, ...pillars, nonAiResult');
    expect(body, '必须带上真实出生日，否则换日盘重算会漂到次日').toContain('birthDay: loadedRecord.nonAiResult?.birthDay');
    expect(body, '落库后要走 refreshRecord，与「重新排盘」同一读取侧清洗').toContain('refreshRecord(updated)');
  });

  it('弹窗挂在 PersonDetail 层，且预填的是当前命盘四柱', () => {
    expect(count(view, '<BirthInputModal')).toBe(1);
    expect(view).toContain('initial={{ yearPillar: loadedRecord.yearPillar');
    expect(view).toContain('submitLabel="保存修正"');
    // 引擎的拒绝必须显示在弹窗内(遮罩后面看不见＝用户以为没反应)，这是 #143 那条老教训。
    expect(view).toContain('error={notice && editOpen ? notice : undefined}');
  });

  it('反向钉子：不存在「只改 record 四柱、不重算」的第二条路', () => {
    // 把四柱写进 saveBaziRecord 的地方必须都带着 nonAiResult，否则界面会出现新柱配旧派生事实。
    const saves = [...view.matchAll(/saveBaziRecord\(\{[^)]*\}/g)].map((m) => m[0]);
    const pillarWrites = saves.filter((s) => /\.\.\.pillars/.test(s));
    expect(pillarWrites.length, '应至少有一条修正写入').toBeGreaterThan(0);
    for (const s of pillarWrites) expect(s, '写四柱却不写 nonAiResult ⇒ 界面自相矛盾').toContain('nonAiResult');
  });
});

function count(hay: string, needle: string): number {
  let n = 0, i = hay.indexOf(needle);
  while (i !== -1) { n += 1; i = hay.indexOf(needle, i + needle.length); }
  return n;
}
