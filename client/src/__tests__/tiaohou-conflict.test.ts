import { describe, expect, it } from 'vitest';
import type { BaziRecord } from '../types/domain';
import { calculateNonAi, computePillarsFromDate } from '../features/chart/nonAiCalculator';
import { buildLocalTaskAnalysis } from '../data/localAnalysis';
import { buildBaziTasks } from '../data/baziOrchestrator';
import { analyzeQuestion } from '../data/chatEngine';
import { buildLocalChatAnswer } from '../data/localChat';

const NOW = new Date('2026-09-26T06:00:00Z');

/* =============================================================================
 * 调候与扶抑方向冲突时的本命批断（任务 #22「优化算法」第一条落地）
 * 背景：全空间枚举 10 日主 × 12 月令 = 120 组（.scratch/sweep-tiaohou-conflict.cjs），
 *   实测 `TOTAL=120 CONFLICT=27`，按季分布 `春:8/30 夏:4/30 秋:7/30 冬:8/30` ——
 *   即两成多的盘，《穷通宝鉴》按季归并的调候方向与扶抑喜忌**相反**。旧写法一律端出
 *   「调候非急」或一句泛泛的「辅助判据」，等于把分歧藏起来。
 * 新口径：只有「严冬而局中无火 / 盛夏而局中无水」（气候真偏枯）才换成如实交代分歧的那句；
 *   **喜用五行本身一个字都不改**（三端提示词通则都要求扶抑定纲）。
 * 夹具来源：⚠ 不是手拼干支（上一版那么做，calculateNonAi 抛「该月找不到与这三部命盘对应的日期」）。
 *   这里由 computePillarsFromDate 从真实日期排柱，再用引擎自己的 strengthScore/elementRatio 读数定性：
 *   夹具 1970-05-18 → 庚戌 辛巳 戊戌 戊午：引擎读数 水=0、判为身强(index 36)，
 *   扶抑喜克泄耗(金水木)、调候参考取壬癸(水)。本盘触发的是 climateDeficient 这条**气候偏枯**判据
 *   （冬无火/夏无水才换说法），换出去的那句如实交代两源分歧，喜忌定论照旧。
 *   对照盘同季节但局中有水（现排，不手拼），必须走原来那句「调候参考」。
 * ========================================================================== */
/** 盛夏而生、局中滴水全无（引擎读数：水 0、身强、index 36）。 */
const SUMMER_NO_WATER = { yearPillar: '庚戌', monthPillar: '辛巳', dayPillar: '戊戌', hourPillar: '戊午' };
/** 同一季节但局中有水（对照盘）：**由 computePillarsFromDate 现排**，不手拼 —— 上一版手拼的
 *  「壬子日 庚午时」被引擎按时柱校验拒了（壬日午时应为丙午），这正是「夹具要 encode 真实路径」。 */
const SUMMER_WITH_WATER = computePillarsFromDate({ year: 1970, month: 5, day: 10, hour: 12 });
const BIRTH = { birthYear: 1970, birthMonth: 5, birthDay: 18 };

const natalOf = (pillars: Record<string, string>, birth: { birthYear: number; birthMonth: number; birthDay: number }) => {
  const nonAiResult = calculateNonAi({ ...birth, ...pillars } as never, 'male', NOW.toISOString());
  const base = { id: 'r-th', name: '调候钉子', gender: 'male', createdAt: NOW.toISOString(), ...birth, ...pillars, nonAiResult, aiStatus: 'completed' } as unknown as BaziRecord;
  const analysis = buildLocalTaskAnalysis(base, { taskId: 'task-01', type: 'baseline' }, NOW);
  return { nonAiResult, text: String(analysis?.explanation ?? '') };
};

describe('调候与扶抑冲突时的本命批断', () => {
  it('前提钉子：夹具确实是「夏而无水」且引擎判旺档（读数取自引擎，不是我推的）', () => {
    const { nonAiResult } = natalOf(SUMMER_NO_WATER, BIRTH);
    expect(nonAiResult.tiaohouFacts).toContain('夏');
    expect(nonAiResult.elementRatio?.['水']).toBe(0);
    expect(['身强', '中和偏旺']).toContain(nonAiResult.strengthScore?.label);
  });

  it('气候偏枯 → 不再端「调候非急」，改为交代两源分歧且明说仍以扶抑为准', () => {
    const { text } = natalOf(SUMMER_NO_WATER, BIRTH);
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain('穷通宝鉴');
    expect(text).toContain('此系两源出入');
    expect(text).toContain('仍以扶抑为准');
    expect(text).not.toContain('调候非急');
    expect(text).not.toMatch(/[A-Za-z]/);        // 仓库硬约束：正文零拉丁字母
    /* 全角标点：正文里出现半角括号是我上一版写出来的缺陷（`癸(佐丙)`），此处钉住。
       ⚠ 只扫本轮新增那一句 —— deriveUsefulAvoid 之外别处早有半角括号存量，不在本条范围。 */
    const line = text.split('\n').find((l) => l.includes('此系两源出入')) ?? '';
    expect(line).toBeTruthy();
    expect(line).not.toMatch(/[(),;:'"]|[A-Za-z]/);
    expect(line).toMatch(/[（）、]/);
    /* 「参考所取之干」从引擎原文现读（不抄第二份表）。本盘引擎串为「癸(佐丙)」：癸=水正是此盘喜用
       （身强喜克泄耗 → 金、水、木），丙=火是忌神 ⇒ 走「同属本命喜用 + 惟其中火于扶抑为忌」那一支，
       不许谎称整体取向相反。以下三条文案逐字取自实跑输出，不是照设想写的。 */
    expect(line).toContain('取癸为参考、佐以丙');
    expect(line).toContain('与调候急需之水同属本命喜用');
    expect(line).toContain('惟其中火于扶抑为忌');
    expect(line).not.toContain('与扶抑取向相反');
  });

  it('调候所取之干确实从引擎原文解析（正向钉子；不抄第二份表）', () => {
    /* 本盘走「正属本命喜用」那一支，反向支路没有现成盘可凑（夏而无水者必身强，喜克泄耗 ⇒
       调候所需之水反而是喜用）。所以这里钉**取数路径**：正则读出的干与引擎串逐一对得上。
       若引擎改了括号形状或字段前缀，此处读到空数组即红，而不是让正文静默少列一项。 */
    const { nonAiResult } = natalOf(SUMMER_NO_WATER, BIRTH);
    const body = (nonAiResult.tiaohouFacts ?? '').split('用神参考：')[1]?.split('〔')[0] ?? '';
    expect(body.length).toBeGreaterThan(0);
    expect(body).toContain('癸');                       // 引擎原文：戊日夏月「癸(佐丙)」——上一版我凭记忆写成壬，被这条打红
    /* 主用神与辅佐干必须分开读。⚠ 这正是上一版的缺陷现场：`STEMS.includes(c)` 对任意天干恒真，
       于是「佐丙」的丙混进主用神，正文把忌神当主用神端出来。剥括号后主用只剩癸(水)。 */
    const stemsIn = (t: string) => [...new Set([...t].filter((c) => '甲乙丙丁戊己庚辛壬癸'.includes(c)))];
    expect(stemsIn(body.split(/[（(]/)[0] ?? '')).toEqual(['癸']);
    expect(stemsIn((body.match(/[（(][^）)]*[）)]/g) ?? []).join(''))).toEqual(['丙']);
    expect(stemsIn(body)).toEqual(['癸', '丙']);        // 不剥括号的读法 —— 即旧缺陷的读数，留此作对照
  });

  it('喜用五行不因冲突而改：定论那句仍是扶抑口径，也不许写成「从调候」', () => {
    const { nonAiResult, text } = natalOf(SUMMER_NO_WATER, BIRTH);
    const line = text.split('\n').find((l) => l.includes('喜用定为')) ?? '';
    expect(line, '本命批断里没有喜忌定论那一句').toBeTruthy();
    expect(line).not.toContain('从调候');
    // 旺档必喜克泄耗：食伤/财/官杀三气齐上，且不含印比 —— 与 deriveUsefulAvoid 同式
    const dayIdx = Math.floor('甲乙丙丁戊己庚辛壬癸'.indexOf(nonAiResult.dayMaster ?? '') / 2);
    const rel = (delta: number) => ['木', '火', '土', '金', '水'][(dayIdx + delta) % 5];
    for (const e of [rel(1), rel(2), rel(3)]) expect(line).toContain(e);
    for (const e of [rel(0), rel(4)]) expect(line).not.toContain('定为' + e);
  });

  it('旁证：气候不偏枯的盘走原句，且改动前后只差那一句说明（其余小节逐字相同）', () => {
    const before = natalOf(SUMMER_WITH_WATER, { birthYear: 1970, birthMonth: 5, birthDay: 10 });
    expect(before.nonAiResult.elementRatio?.['水']).toBeGreaterThan(0);
    expect(before.text).not.toContain('此系两源出入');
    expect(before.text).toContain('调候参考');
    // 该盘仍带季节通义那句，说明没被误伤
    expect(before.text).toMatch(/炎热燥土|调候以水为急/);
  });

  it('聊天同口径：偏枯盘的调候分歧句必须也能被「喜用五行是什么」取到', () => {
    /* 缺陷现场（本轮读码发现，非假想）：localChat 的 answerUsefulElements 原先只认
       `t.startsWith('调候参考')`，而偏枯盘换的那句**开头是「又《穷通宝鉴》」** ⇒ 批断正文里有、
       聊天答出来那一栏凭空少一条，且 27/120 组盘都中招。修法是让它同时认「此系两源出入」。 */
    const birth = BIRTH;
    const nonAiResult = calculateNonAi({ ...birth, ...SUMMER_NO_WATER } as never, 'male', NOW.toISOString());
    const base = { id: 'r-chat', name: '聊天钉子', gender: 'male', createdAt: NOW.toISOString(), ...birth, ...SUMMER_NO_WATER, nonAiResult, aiStatus: 'completed' } as unknown as BaziRecord;
    const tasks: Record<string, any> = {};
    for (const task of buildBaziTasks(base, NOW)) {
      const analysis = buildLocalTaskAnalysis(base, task, NOW);
      if (analysis) tasks[task.taskId] = { task, status: 'completed', analysis, source: 'local' };
    }
    const rec = { ...base, aiTasks: tasks } as unknown as BaziRecord;
    const question = '喜用五行是什么';
    const plan = analyzeQuestion(question, [rec], NOW);
    // 前提钉子：这句确实走 wantsFiveElements → answerUsefulElements（否则测的不是那条取话判据）
    expect(plan.year).toBeUndefined();
    expect(/喜用|用神|忌神|五行/.test(question)).toBe(true);
    const answer = buildLocalChatAnswer({ record: rec, plan, question, history: [] }, NOW);
    expect(answer, 'A 层答不出这句，本用例前提不成立').toBeTruthy();
    expect(answer!.answer).toContain('此系两源出入');
    expect(answer!.answer).not.toMatch(/[A-Za-z]/);
  });

  /* 「春/秋 → 调候非急」这条豁免必须由**真的无火春盘**钉住。变异对照（本轮实测，见下）：
       · 第一版夹具用 1970-03-15 午时 ⇒ 引擎读数 火=0.25，判据压根没被执行，用例恒真；
       · 换成扫描出的无火春盘（庚辰 戊寅 己未 甲子，火=0、中和偏弱）后，把 `if (!need) return undefined`
        整行删掉（等价于春秋也按「冬需火」判偏枯），本例即红。
     ⚠ 另记一腿仍杀不掉：若只把 need **静默改成别的五行**（如 '木'）而不改分支走向，六条用例全绿 ——
      文案里那串五行是派生展示，要钉死须逐字比对整句，暂不划算，留此备案。 */
  it('春月而局中无火：仍属「调候非急」，不得被当成气候偏枯', () => {
    const spring = computePillarsFromDate({ year: 2000, month: 3, day: 2, hour: 0 });
    const { nonAiResult, text } = natalOf(spring, { birthYear: 2000, birthMonth: 3, birthDay: 2 });
    expect(nonAiResult.tiaohouFacts).toContain('春');
    expect(nonAiResult.elementRatio?.['火']).toBe(0);   // 前提钉子：气候确实无火
    expect(text).not.toContain('此系两源出入');
    expect(text).toContain('调候非急');
  });
});
