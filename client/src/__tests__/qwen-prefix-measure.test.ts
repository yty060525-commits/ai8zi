import { describe, expect, it } from 'vitest';
import { calculateNonAi } from '../features/chart/nonAiCalculator';
import { buildTaskPromptText, buildPromptSharedSeams, INSTRUCTION_TAIL_MARK, NATAL_SHARED_KEYS, SCOPE_PREFIX, type PromptTaskKind } from '../data/deepseekAdapter';
import { buildBaziTasks } from '../data/baziOrchestrator';
import type { BaziRecord } from '../types/domain';

/** Qwen 显式缓存能否命中，只取决于相邻请求「从哪一行开始分叉」(门槛约 1024 token，中文近似一字一 token)。
 *  这件事只能测，不能推：提示词分段一改结论就可能翻。本测试直接调真实拼装函数(不发请求)，锁住四条性质：
 *   1) 同一命盘的 natal 段逐字节一致；
 *   2) **所有**任务类型彼此共享一段长前缀 —— natal 排在任务指令之前才做得到；
 *   3) 同年「流年 ↔ 该年各流月」几乎整篇相同(年度段排在月度段之前)；
 *   4) 可变内容一律后置：目标行永远在最后，本命摘要永远在时段数据之前。
 *  旧写法把各自不同的任务指令放在 natal 前面，性质 2 直接不成立(实测公共前缀仅 9 字)，
 *  等于一轮 23 条请求各建一块缓存。谁把可变段挪回前面或让分支间标题不一致，这里会指出断在哪一对。 */

const CACHE_MIN_TOKENS = 1024;
const fixedNow = new Date('2026-09-24T08:00:00Z');
const summary = '格局：建禄格 · 强弱：身强　喜：木　忌：金';

function makeRecord(): BaziRecord {
  const nonAiResult = calculateNonAi({
    birthYear: 1984, birthMonth: 2, yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午',
  }, 'male', '2026-01-05T02:00:00.000Z');
  return {
    id: 'p-cache-prefix', name: '甲子日主', gender: 'male',
    birthYear: 1984, birthMonth: 2, birthDay: 15, birthHour: 10, birthMinute: 30, birthPlace: '', calendar: 'gregorian',
    yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午',
    aiStatus: 'not_started', createdAt: '2026-01-05T02:00:00.000Z', updatedAt: '2026-01-05T02:00:00.000Z',
    nonAiResult,
  } as unknown as BaziRecord;
}

const lcpChars = (a: string, b: string): number => {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
};

const record = makeRecord();
const tasks = buildBaziTasks(record, fixedNow);
const annuals = tasks.filter((t) => t.type === 'annual');
const monthlies = tasks.filter((t) => t.type === 'monthly');
const firstYear = annuals[0]?.year ?? 2026;

/** 按编排器的真实发射顺序取样：本命 → 同年流年+该年流月 → 其余年份 → 大运。
 *  时段任务都带本命摘要锚点(与真实流程一致)；本命任务本身没有。 */
const ordered: Array<{ key: string; kind: PromptTaskKind; year: number; month?: number; anchor?: string }> = [
  { key: 'baseline', kind: 'baseline', year: firstYear },
  ...annuals.filter((t) => t.year === firstYear).map((t) => ({ key: `annual-${t.year}`, kind: 'annual' as const, year: t.year!, anchor: summary })),
  ...monthlies.filter((t) => t.year === firstYear).map((t) => ({ key: `monthly-${t.year}-${t.month}`, kind: 'monthly' as const, year: t.year!, month: t.month!, anchor: summary })),
  ...annuals.filter((t) => t.year !== firstYear).map((t) => ({ key: `annual-${t.year}`, kind: 'annual' as const, year: t.year!, anchor: summary })),
  ...monthlies.filter((t) => t.year !== firstYear).map((t) => ({ key: `monthly-${t.year}-${t.month}`, kind: 'monthly' as const, year: t.year!, month: t.month!, anchor: summary })),
  ...tasks.filter((t) => t.type === 'decade').map((t) => ({ key: `decade-${t.year}`, kind: 'decade' as const, year: t.year!, anchor: summary })),
];

/** 后天调整与全盘总结各自换一条指令文本，只与同类型共享前缀，不参与「一轮彼此命中」的判定；
 *  但仍要单独确认它们自身够长、且 natal 仍在最前(否则这两条也各建一块缓存)。 */
const tailTasks: Array<{ key: string; kind: PromptTaskKind; year: number; anchor: string }> = [
  { key: 'adjustment', kind: 'adjustment', year: firstYear, anchor: summary },
  { key: 'overview', kind: 'overview', year: firstYear, anchor: summary },
];

// natal 段(本命事实数据)在所有任务里必须是同一段文本。它的结尾不能用「下一个标题」定位：
// 「# 本命事实数据」这个标题本身也会出现在任务指令正文里(如「必须照【本命事实数据】里『起运』一项说」)。
// 时段任务的指令是 SCOPE_PREFIX，所以拿它的开头作边界。
const NATAL_HEAD = '\n\n# 本命事实数据';
const SCOPE_INSTRUCTION_HEAD = SCOPE_PREFIX.slice(0, 24);
const promptOf = (t: (typeof ordered)[number]): string => buildTaskPromptText(record, t.kind, t.year, t.month, 2, t.anchor);

const texts = ordered.map(promptOf);
const scopeTexts = texts;

/** 打印真实数字，便于改分段后复核(与断言同源，不另算一份)。 */
const report = (): void => {
  let minPair = Infinity;
  for (let i = 1; i < scopeTexts.length; i++) minPair = Math.min(minPair, lcpChars(scopeTexts[i - 1], scopeTexts[i]));
  const globalPrefix = (() => {
    let n = Math.min(...scopeTexts.map((s) => s.length)), i = 0;
    while (i < n && scopeTexts.every((s) => s[i] === scopeTexts[0][i])) i++;
    return i;
  })();
  const shortest = Math.min(...scopeTexts.map((s) => s.length));
  console.log(`[前缀实测] 任务 ${texts.length} 条；全文 ${shortest}..${Math.max(...texts.map((s) => s.length))} 字；`
    + `全局公共前缀 ${globalPrefix} 字(占最短全文 ${((globalPrefix / shortest) * 100).toFixed(0)}%)；相邻最小 ${minPair} 字`);
};

describe('Qwen 显式缓存：真实提示词的前缀复用', () => {
  it('打印实测前缀数字', () => {
    report();
    expect(scopeTexts.length).toBeGreaterThan(20);
  });

  it('natal 段逐字节一致', () => {
    const natalSlice = (s: string): string => {
      const start = s.indexOf(NATAL_HEAD);
      const end = s.indexOf(SCOPE_INSTRUCTION_HEAD, start);
      expect(end, '时段任务正文里应能找到指令边界').toBeGreaterThan(start);
      return s.slice(start, end);
    };
    const scopeTexts = texts.filter((_t, i) => ordered[i].kind === 'annual' || ordered[i].kind === 'monthly');
    expect(scopeTexts.length).toBeGreaterThan(20);
    const parts = new Set(scopeTexts.map(natalSlice));
    expect(parts.size).toBe(1);
    expect([...parts][0].length).toBeGreaterThan(1000);
  });

  it('本命与全部时段任务共享过门槛的公共前缀(natal 必须排在指令之前)', () => {
    for (let i = 1; i < scopeTexts.length; i++) {
      expect(lcpChars(scopeTexts[0], scopeTexts[i]), `${ordered[i].key} 与本命没有共同前缀`).toBeGreaterThanOrEqual(CACHE_MIN_TOKENS);
    }
    for (let i = 1; i < scopeTexts.length; i++) {
      expect(lcpChars(scopeTexts[i - 1], scopeTexts[i]), `${ordered[i].key} 的前缀不足`).toBeGreaterThanOrEqual(CACHE_MIN_TOKENS);
    }
    // 全局公共前缀本身也要过门槛：它是这一轮唯一需要建缓存的那段。
    let n = Math.min(...scopeTexts.map((s) => s.length)), k = 0;
    while (k < n && scopeTexts.every((s) => s[k] === scopeTexts[0][k])) k++;
    expect(k).toBeGreaterThanOrEqual(CACHE_MIN_TOKENS);
  });

  it('同年流年与该年流月几乎整篇相同(年度段先于月度段)', () => {
    const idx = (k: string) => ordered.findIndex((x) => x.key === k);
    const annual = texts[idx(`annual-${firstYear}`)];
    for (const m of monthlies.filter((x) => x.year === firstYear)) {
      const other = texts[idx(`monthly-${m.year}-${m.month}`)];
      expect(lcpChars(annual, other) / Math.min(annual.length, other.length)).toBeGreaterThanOrEqual(0.95);
    }
    const nextYearAnnual = texts.find((_t, i) => ordered[i].key.startsWith('annual-') && ordered[i].key !== `annual-${firstYear}`) ?? '';
    expect(lcpChars(annual, nextYearAnnual)).toBeLessThan(annual.length * 0.9);
  });

  it('可变内容一律后置：目标行在末尾、本命摘要在时段数据之前', () => {
    for (let i = 0; i < texts.length; i++) {
      const c = texts[i];
      if (ordered[i].kind !== 'baseline') {
        expect(c.lastIndexOf('# 当前分析目标'), ordered[i].key).toBeGreaterThan(c.length - 60);
      }
      if (c.includes('# 本年度运势数据')) {
        expect(c.indexOf('# 本命结论'), ordered[i].key).toBeLessThan(c.indexOf('# 本年度运势数据'));
      }
    }
  });

  it('每条正文自身都够长，可独立建缓存块', () => {
    for (let i = 0; i < texts.length; i++) expect(texts[i].length, ordered[i].key).toBeGreaterThanOrEqual(CACHE_MIN_TOKENS);
    for (const t of tailTasks) {
      const s = promptOf(t);
      expect(s.length, t.key).toBeGreaterThanOrEqual(CACHE_MIN_TOKENS);
      // natal 仍在最前：这两类任务换了指令文本，若把指令挪回 natal 之前就连这一段也保不住
      expect(s.indexOf(NATAL_HEAD)).toBeLessThan(s.indexOf(SCOPE_INSTRUCTION_HEAD.slice(0, 0) + '你是资深子平命理师'));
    }
  });

  it('natal 只带跨通道约定的那几项键(服务器多带的键不得在客户端漏出)', () => {
    // 与 server/test/prompt-parity.test.mjs 同一份键清单：客户端 natal 一旦多出键，
    // 两端的公共前缀就会在那个键的位置分叉，而常量比对查不出来。
    for (const kind of ['baseline', 'annual', 'monthly', 'decade'] as PromptTaskKind[]) {
      const seams = buildPromptSharedSeams(record, kind, firstYear);
      expect(seams.natalKeys, kind).toEqual([...NATAL_SHARED_KEYS]);
      expect(seams.natalHead).toBe('\n\n# 本命事实数据(JSON，只依据此数据)\n');
      expect(seams.rules.startsWith(INSTRUCTION_TAIL_MARK)).toBe(true);
      expect(seams.instruction.length, kind).toBeGreaterThan(100);
    }
  });
});
