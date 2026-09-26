import { describe, expect, it } from 'vitest';
import type { BaziRecord } from '../types/domain';
import { calculateNonAi } from '../features/chart/nonAiCalculator';
import { countElements } from '../features/chart/elements';
import { buildLocalTaskAnalysis } from '../data/localAnalysis';
import { buildBaziTasks } from '../data/baziOrchestrator';
import { analyzeQuestion } from '../data/chatEngine';
import { buildLocalChatAnswer } from '../data/localChat';

const NOW = new Date('2026-09-26T06:00:00Z');

/* =============================================================================
 * 五行配比那一行的读数钉子（补 P1 变异盲区）
 * 为什么单独立一个文件、且夹具与 local-chat.test.ts 不同：主夹具那盘四柱**没有配比恰为 0 的五行**，
 * 于是「少乘一次 100」和「干脆不取整」两种坏形态在 25 条用例下都不改变任何输出字符 ——
 * 实测两次都 `Tests 25 passed (25)` / VERDICT_FAILED=0_KILLED=false。那是**覆盖盲区**，不是等价变异。
 * ⇒ 判据要落在「只有正确公式才给得出」的读数上：1/8 → 13%（不乘会成 0.125%/0%，不取整会成 12.5%），
 *   再配一个零配比五行钉住「缺 X」那半句。
 * 夹具来源：由引擎自己排柱枚举得到（乙卯 丁亥 庚午 壬午 = 1975-11-20 午时），不是我手挑的「能算出比例的值」。
 * ========================================================================== */
const PILLARS = { yearPillar: '乙卯', monthPillar: '丁亥', dayPillar: '庚午', hourPillar: '壬午' };

describe('本命事实行的五行配比读数', () => {
  it('elementRatio 是 0..1 的比例（钉口径，防止下面的 13% 断言建在错前提上）', () => {
    const r = countElements(Object.values(PILLARS)).elementRatio;
    expect(r['金']).toBeCloseTo(0.125, 10);
    expect(r['土']).toBe(0);
  });

  it('配比 1/8 → 文案必须是「金 13%」；零配比 → 必须进「缺土」名单', async () => {
    const birth = { birthYear: 1975, birthMonth: 11, birthDay: 20 };
    const nonAiResult = calculateNonAi({ ...birth, ...PILLARS }, 'male', NOW.toISOString());
    const base = {
      id: 'r-ratio', name: '配比钉子', gender: 'male', createdAt: NOW.toISOString(),
      ...birth, ...PILLARS, nonAiResult, aiStatus: 'completed',
    } as unknown as BaziRecord;
    // ⚠ 问句必须**同时**满足四件事，才走得到 `natalFacts(record).slice(0, 2)` 那一行（配比就在这里印）：
    //   1) 不含「喜用/用神/忌神/五行」——否则 wantsFiveElements 抢先进 answerUsefulElements，那里只取 facts 的
    //      「喜用五行/格局」单行，压根不印配比；
    //   2) 不带年、不带月、不是开放式问时机——否则进 answerPeriod / answerScan；
    //   3) topics **非空**且至少命中 TOPIC_SECTION（健康/事业/财运/爱情/神煞）之一——
    //      泛问（general=true）会先被 answerGeneral 拿走（实测「我一生怎么样」正是如此），
    //      topics 全空又落到「本命批断开头四条」那条兜底，同样没有配比行；
    //   4) 不触发第 451 行的 五行/格局 短路。
    //   「适合/行业/方向」这类适配问法在 TOPIC_RULES 里**没有**对应词（实测 topics=[]），只会落到泛问；
    //   所以这里用「我的事业方面整体看下」——事业命中、其余空，才能真的走到那一行。
    const question = '我的事业方面整体看下';
    const tasks: Record<string, any> = {};
    for (const task of buildBaziTasks(base, NOW)) {
      const analysis = buildLocalTaskAnalysis(base, task, NOW);
      if (analysis) tasks[task.taskId] = { task, status: 'completed', analysis, source: 'local' };
    }
    const rec = { ...base, aiTasks: tasks } as unknown as BaziRecord;
    const plan = analyzeQuestion(question, [rec], NOW);
    // 前提钉子：走不到印配比的那条分支，本用例测的就不是 pct()（上一版静悄悄走了 answerGeneral）。
    // ⚠ 这里**不**断言 general —— analyzeQuestion 的 general 定义是「topics 为空 且 命中泛问词」，
    //   而目标分支要求 blocks 非空（即 topics 至少命中 TOPIC_SECTION 之一），两者互斥；
    //   上一版把 general=true 当成落点条件就是没读这行定义。真正的分支钉子是下面的「五行配比：」。
    expect(plan.topics, '这句没命中具体主题，走不到本命事实行').toContain('事业');
    expect(plan.year).toBeUndefined();
    expect(plan.month).toBeUndefined();
    expect(plan.scan).toBe(false);
    expect(/喜用|用神|忌神|五行/.test(question), '这句含喜用词，会短路进 answerUsefulElements').toBe(false);
    const answer = buildLocalChatAnswer({ record: rec, plan, question, history: [] }, NOW);
    expect(answer, 'A 层答不出这句，本用例前提不成立').toBeTruthy();
    const text = answer!.answer;
    // 分支钉子：只有那条印 natalFacts 前两行的分支才会带「五行配比：」；兜底分支的尾巴是那句括号。
    expect(text).toContain('五行配比：');
    expect(text).not.toContain('这条问句里没点到具体主题');
    expect(text).toContain('金 13%');
    // 反证三种坏形态：少乘 100 / 不取整 / 把比例当百分数直接印
    expect(text).not.toMatch(/金 12\.5%|金 0\.125%|金 0%/);
    expect(text).toContain('缺土');
    expect(text).not.toMatch(/[A-Za-z]/);   // 仓库硬约束：正文零拉丁字母
  });
});
