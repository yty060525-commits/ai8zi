import { afterEach, describe, expect, it } from 'vitest';
import type { BaziRecord } from '../types/domain';
import { calculateNonAi } from '../features/chart/nonAiCalculator';
import { buildLocalTaskAnalysis } from '../data/localAnalysis';
import { buildBaziTasks } from '../data/baziOrchestrator';
import { analyzeQuestion } from '../data/chatEngine';
import { buildLocalChatAnswer } from '../data/localChat';

/* =============================================================================
 * 对话 A 层（本机规则问答）—— 用**真引擎产出的真批断**当夹具，而不是手搓的假正文。
 * 原因：这一路的承诺是「只搬运已算好的话」。夹具若是我自己写的字符串，用例就只能证明
 * 「我的解析器认得我写的格式」，证明不了它认得引擎真实输出的格式（§13.266 那条教训：
 * 夹具必须读产品实际消费的那一列）。所以这里跑 buildBaziTasks + buildLocalTaskAnalysis。
 * ========================================================================== */

const NOW = new Date('2026-09-26T06:00:00Z');

/** 一条时段事实齐全、且每个任务都由本地引擎算过正文的盘（= 机主点过「生成本地批断」之后的样子）。 */
function fullLocalChart(): BaziRecord {
  const pillars = { yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午' };
  // ⚠ 生日字段单列，别 `...input` 摊进对象里又手写一遍同名键：那样后者会覆盖前者，
  //   而 tsc 的 TS2783 会直接报出来（上一版就是这么写的，读起来还像「顺手展开更保险」）。
  const birth = { birthYear: 1984, birthMonth: 2 };
  const nonAiResult = calculateNonAi({ ...birth, ...pillars }, 'male', NOW.toISOString());
  const base = {
    id: 'r-full', name: '测试甲', gender: 'male', createdAt: NOW.toISOString(),
    ...birth, ...pillars, nonAiResult, aiStatus: 'completed',
  } as unknown as BaziRecord;
  const aiTasks: Record<string, BaziRecord['aiTasks'] extends infer _ ? any : never> = {};
  for (const task of buildBaziTasks(base, NOW)) {
    const analysis = buildLocalTaskAnalysis(base, task, NOW);
    if (analysis) aiTasks[task.taskId] = { task, status: 'completed', analysis, source: 'local' };
  }
  return { ...base, aiTasks } as unknown as BaziRecord;
}

const record = fullLocalChart();

/** 问一句，按 chatEngine 的同一套提问解析出计划，再交给 A 层。 */
function ask(question: string, rec: BaziRecord = record) {
  const plan = analyzeQuestion(question, [rec], NOW);
  return { plan, answer: buildLocalChatAnswer({ record: rec, plan, question, history: [] }, NOW) };
}

afterEach(() => { /* 本文件不碰 localStorage，仅占位以显式表明无残留状态 */ });

describe('对话 A 层：五条验收问题都要答到点上', () => {
  it('① 喜用五行是什么 —— 给出确定的五行，并带上扶抑依据与调候参考', () => {
    const { answer } = ask('喜用五行是什么');
    expect(answer).toBeTruthy();
    const text = answer!.answer;
    // 判据取自引擎口径本身：庚金身弱 → 喜土金、忌木火水
    expect(text).toMatch(/喜用五行为土、金/);
    expect(text).toMatch(/忌木、火、水/);
    expect(text).toContain('扶抑');
    expect(text).toContain('调候参考');
    expect(text).not.toMatch(/[A-Za-z]/);   // 仓库硬约束：正文零拉丁字母
  });

  it('② 今年事业运如何 —— 锚到今年的流年批断，引的是【事业】小节原文', () => {
    const { plan, answer } = ask('今年事业运如何');
    expect(plan.year).toBe(2026);
    expect(answer).toBeTruthy();
    expect(answer!.answer).toContain('2026年');
    // 与详情页那篇流年批断逐字同源：取该年正文里【事业】小节的第一条，比对回答确实含它
    const annualTaskId = Object.values(record.aiTasks ?? {}).find((t: any) => t.task.type === 'annual' && Number(t.task.year) === 2026)!.task.taskId;
    const annualBody = String((record.aiTasks as any)[annualTaskId].analysis.explanation);
    const firstCareerLine = annualBody.split('【事业】')[1].split('\n').filter((l) => /^\s*1\./.test(l))[0].replace(/^\s*1\.\s*/, '').replace(/。$/, '');
    expect(answer!.answer).toContain(firstCareerLine);
    expect(answer!.sources).toEqual(['2026年流年批断']);
    expect(answer!.partial).toBe(false);
  });

  it('③ 明年三月要注意什么 —— 汉字月名要落到具体月份，不能退化成整年', () => {
    const { plan, answer } = ask('明年三月要注意什么');
    expect(plan.year).toBe(2027);
    expect(plan.month).toBe(3);              // 「三月」解不出就会静默按全年答（历史缺陷形态）
    expect(answer).toBeTruthy();
    expect(answer!.answer).toContain('2027年3月');
    expect(answer!.answer).toContain('流月');
    expect(answer!.sources).toEqual(['2027年3月流月批断']);
  });

  it('④ 什么时候适合跳槽 —— 扫年后只列本机真的算过批断的年份，且不超过四年', () => {
    const { plan, answer } = ask('什么时候适合跳槽');
    expect(plan.scan).toBe(true);
    expect(plan.topics).toEqual(['事业']);
    expect(answer).toBeTruthy();
    const years = [...answer!.answer.matchAll(/(20\d{2})年/g)].map((m) => Number(m[1]));
    expect(years.length).toBeGreaterThan(0);
    // 上限判据：这条盘只算了 2026..2035 十年，回答不得把没正文的年份列进来；最多四条
    const listed = [...new Set(years)];
    expect(listed.length).toBeLessThanOrEqual(4);
    const computedYears = Object.values(record.aiTasks ?? {})
      .filter((t: any) => t.task.type === 'annual').map((t: any) => Number(t.task.year));
    for (const y of listed) expect(computedYears).toContain(y);
    expect(listed[0]).toBe(2026);            // 从当前年起算
  });

  /* ⚠ 上面那条**测不到「只列真有正文的年份」这半句**：本夹具每个流年任务都有正文（机主点过
     「生成本地批断」之后的样子），所以把窗口上界改成固定八年（S1 变异）也照样全绿。
     真正会踩到的是另一类盘：`ensureLocalChartComplete` 只补**排盘时段数组**，不生成批断正文 ⇒
     往后几年有干支、无正文。下面这条专门钉它。 */
  it('④b 扫年时后面几年只有排盘事实没有批断 → 不把没正文的老年份列进答案', () => {
    const thin = { ...record, aiTasks: Object.fromEntries(Object.entries(record.aiTasks ?? {})
      .filter(([, v]: [string, any]) => !(v.task.type === 'annual' && Number(v.task.year) >= 2033))) } as unknown as BaziRecord;
    const { answer } = ask('接下来几年哪年适合换工作', thin);
    expect(answer).toBeTruthy();
    const listed = [...new Set([...answer!.answer.matchAll(/(20\d{2})年/g)].map((m) => Number(m[1])))];
    expect(listed.length).toBeGreaterThan(0);
    const hasBody = new Set(Object.values(thin.aiTasks ?? {})
      .filter((t: any) => t.task.type === 'annual' && String(t.analysis?.explanation ?? '').length > 0)
      .map((t: any) => Number(t.task.year)));
    for (const y of listed) expect(hasBody.has(y), `${y} 年压根没有流年批断，不该出现在扫年答案里`).toBe(true);
    for (const y of [2033, 2034, 2035]) expect(listed).not.toContain(y);
    /* 无正文的那几年**也不算缺失证据**：机主可以只生成一部分时段的批断，往后那些年份不是「本该有而没有」。
       ⚠ 这条判据是 S1 那一类变异的唯一杀手 —— 前四条已经填满答案，多扫/少扫几年在正文里一个字都看不出来。 */
    expect(answer!.partial, '把没生成批断的年份报成「缺证据」并不如实').toBe(false);
    expect(answer!.missing.join('')).not.toContain('2033');
    expect(answer!.missing).toEqual([]);
  });

  /* 收尾那句是**教用户怎么继续问**的示范，写错等于给用户一个不存在的年份写法：
     `lines[0]` 形如「2026年（丙午流年·七杀当戒）：…」，按字符截前四位会得到「2026年（丙」。 */
  it('④c 扫年的收尾示范给的是完整年份，不是截了一半的括号', () => {
    const { answer } = ask('什么时候适合跳槽');
    const hint = answer!.answer.split('\n').find((l) => l.includes('接着问'));
    expect(hint).toBeTruthy();
    expect(hint).toContain('「2026年事业」');
    expect(hint).not.toMatch(/[（(][^）)]*$/);        // 句尾不留半个括号
    expect(hint).not.toContain('（丙');
  });

  it('⑤ 我这个人怎么样 —— 泛问铺开本命结论与性格，并报出已算小节清单', () => {
    const { plan, answer } = ask('我这个人怎么样');
    expect(plan.general).toBe(true);
    expect(answer).toBeTruthy();
    expect(answer!.answer).toContain('偏财格');
    expect(answer!.answer).toContain('庚为刀剑顽金');   // 性格小节原文
    expect(answer!.answer).toContain('本盘已算出的小节有');
    // 这条盘没跑全盘总结/后天调整 ⇒ 必须如实点名缺了什么，而不是假装答全了
    expect(answer!.partial).toBe(true);
    expect(answer!.missing.join('')).toContain('全盘总结');
  });

  /* 「注意什么」这类问法解析出来的主题是「流月」，而批断正文里**没有【流月】小节**：
     拿它当取话的节名去过滤会得到空，整条回答作废、退成缺口回执（实测踩过）。所以时段类主题要剔掉。 */
  it('⑤b 纯「注意什么」的问法 → 铺开四个主题并附本期宜注意，不因为主题叫「流月」而落空', () => {
    const { plan, answer } = ask('明年三月要注意什么');
    expect(plan.topics).toEqual([]);          // 现测：只解出「流月」，而它已被当作没点到具体断语主题
    expect(answer!.answer).toContain('【健康】');
    expect(answer!.answer).toContain('【事业】');
    expect(answer!.answer).toContain('【本期宜注意】');
  });

  /* ⚠ 上面那条把 topics 判成空，因而**测不到过滤函数本身**（T1 变异那样写照样全绿）。
     真正会踩到的是「年份 + 月份 + 具体主题」：topics = ['事业','流月']，此时引流月正文里的
     【事业】节，且**不该**再附一段健康向的冲克清单（用户问的不是「要注意什么」）。 */
  it('⑤c 问句同时点到具体主题和月份 → 只引该主题，并把「流月」这个时段标签剔掉', () => {
    const { plan, answer } = ask('2027年3月事业怎么样');
    expect(plan.topics).toEqual(['事业', '流月']);
    expect(answer).toBeTruthy();
    expect(answer!.answer).toContain('【事业】');
    expect(answer!.answer).not.toContain('【健康】');
    expect(answer!.answer).not.toContain('【本期宜注意】');
    expect(answer!.answer).not.toContain('【流月】');
  });

  it('每条回答都交代来源，且不出现英文', () => {
    for (const q of ['喜用五行是什么', '今年事业运如何', '明年三月要注意什么', '什么时候适合跳槽', '我这个人怎么样']) {
      const { answer } = ask(q);
      expect(answer, q + ' 组不出答案').toBeTruthy();
      expect(answer!.sources.length, q + ' 没标注来源').toBeGreaterThan(0);
      expect(answer!.answer, q + ' 正文掺了拉丁字母').not.toMatch(/[A-Za-z]/);
    }
  });
});

describe('对话 A 层：取不到就如实说缺，绝不推测', () => {
  it('问一条没算过批断的年份 → 回执里点名缺哪一年，并给出补算路径', () => {
    // 只留本命 + 前两年的批断，模拟「刚生成完本地批断就问很远的一年」
    const thin = { ...record, aiTasks: Object.fromEntries(Object.entries(record.aiTasks ?? {}).filter(([, v]: [string, any]) => !(v.task.type === 'annual' && v.task.year >= 2029))) } as unknown as BaziRecord;
    const { answer } = ask('2030年事业运如何', thin);
    expect(answer).toBeTruthy();
    expect(answer!.answer).toContain('这台设备上还没有');
    expect(answer!.answer).toContain('2030 年的流年批断');
    expect(answer!.answer).toContain('生成本地批断');
    expect(answer!.partial).toBe(true);
    // 关键：缺数据时不许把别年的结论搬过来充数
    expect(answer!.answer).not.toContain('七杀临期');
  });

  it('某月只有流年没有流月/大运 → 老实说缺，不拿别的时间段冒充', () => {
    /* ⚠ 这条夹具的取舍要说清：本地引擎只在「未来第 9、10 年」那两步才建大运任务（见 buildBaziTasks
       与 FIRST_DECADE_TASK_INDEX），所以删掉流月后 2027 年**确实没有大运批断可退**。
       第一版把它写成「用大运答但明说流月缺失」，那是我以为存在的一条退路 —— 实测拿到的是缺口回执。
       「有流月→引流月」的正例由验收问题⑤钉住；这里钉的是反面：**没有就说不缺了别的都不许搬**。 */
    const noMonthly = { ...record, aiTasks: Object.fromEntries(Object.entries(record.aiTasks ?? {}).filter(([, v]: [string, any]) => v.task.type !== 'monthly')) } as unknown as BaziRecord;
    const { answer } = ask('明年三月要注意什么', noMonthly);
    expect(answer).toBeTruthy();
    expect(answer!.answer).toContain('这台设备上还没有');
    expect(answer!.answer).toContain('2027年3月 的流月批断');
    expect(answer!.partial).toBe(true);
    // 反证：不许把 2027 全年批断或 2027年3月之外的话当成该月的答案端出来
    expect(answer!.answer).not.toContain('正官临期');
  });

  it('补上一步大运批断 → 同一句问话改引大运，并明说流月没算（不退化成缺口回执）', () => {
    /* 上一条是「什么都没有 ⇒ 如实说缺」；这一条才是我原本以为的那条退路的真身：
       有大运批断时它顶上，且必须自报「这是覆盖这一年的大运，不是那个流月」。 */
    const decTask = buildBaziTasks(record, NOW).find((t) => t.type === 'decade');
    expect(decTask, '夹具里没有大运任务槽位').toBeTruthy();
    const decadeAnalysis = buildLocalTaskAnalysis(record, decTask!, NOW);
    expect(decadeAnalysis, '引擎没能算出大运批断，本用例前提不成立').toBeTruthy();
    const withDecade = {
      ...record,
      aiTasks: { ...(record.aiTasks ?? {}), [decTask!.taskId]: { task: decTask!, status: 'completed', analysis: decadeAnalysis, source: 'local' } },
      // 只留 2027 年 + 该大运，删掉全部流月：让「流月缺、大运在」这个组合真的成立
    } as unknown as BaziRecord;
    const noMonthly = { ...withDecade, aiTasks: Object.fromEntries(Object.entries(withDecade.aiTasks ?? {}).filter(([, v]: [string, any]) => v.task.type !== 'monthly')) } as unknown as BaziRecord;
    const { answer } = ask('2033年3月要注意什么', noMonthly);   // 2033 正是那条大运的起运年
    expect(answer).toBeTruthy();
    expect(answer!.answer).not.toContain('这台设备上还没有2033年3月 的流月批断');   // 走的是退路，不是缺口回执
    expect(answer!.answer).toContain('大运');
    expect(answer!.partial).toBe(true);
    expect(answer!.missing.join('')).toContain('流月批断还没算');
  });

  it('大运槽位在但正文没算（pending）→ 仍出缺口回执，不端一句「像批断的话」充数', () => {
    /* 这一条钉的是 `answerPeriod` 开头的 `if (!isDone(...)) return null`：
       「有任务号」和「本机真算出过话」是两件事。变异 N1b（把大运退路换成不看正文、直接端一句
       「本期以守成为主…」）在删掉全部流月的盘上照样能走到这里 —— 界面读起来与真批断无异，
       而这条盘压根没有该时段的任何结论，属于最坏的一类假回执。 */
    const decTask = buildBaziTasks(record, NOW).find((t) => t.type === 'decade')!;
    const pendingOnly = {
      ...record,
      aiTasks: Object.fromEntries(Object.entries(record.aiTasks ?? {}).filter(([, v]: [string, any]) => v.task.type !== 'monthly')) as any,
    } as unknown as BaziRecord;
    (pendingOnly.aiTasks as any)[decTask.taskId] = { task: decTask, status: 'pending', source: 'local' };   // 槽位在、无 analysis
    const { answer } = ask('2033年3月要注意什么', pendingOnly);
    expect(answer).toBeTruthy();
    expect(answer!.answer).toContain('这台设备上还没有');
    expect(answer!.answer).toContain('2033年3月 的流月批断');
    expect(answer!.sources).toEqual([]);          // 一条证据都没引
    expect(answer!.partial).toBe(true);
    // 反证：不许出现任何该时段没有过的断语口吻句子
    expect(answer!.answer).not.toContain('本期以守成');
    expect(answer!.answer).not.toMatch(/宜早睡|饮食作息须规律/);
  });

  it('流年篇正文没算（只有排盘事实）→ 该年问题出缺口回执，别拿本命健康向的话冒充当期结论', () => {
    /* 同一处守卫的另一条可达路径：`plan.year` 命中流年任务槽位、但该槽位没有正文。
       ⚠ 为什么必须走「只有本命正文」这条路：若整条盘一篇正文都没有，变异版会落到最后的泛问兜底，
          两句问话读数相同（实测），杀不掉；只有**本命在、流年在槽位上但没正文**时，
          变异才会把本命【健康】那半句端成「2030 年的答案」。 */
    const natalOnly = {
      ...record,
      aiTasks: Object.fromEntries(Object.entries(record.aiTasks ?? {}).filter(([, v]: [string, any]) => v.task.type !== 'annual' && v.task.type !== 'monthly' && v.task.type !== 'decade')),
    } as unknown as BaziRecord;
    const annualTask = buildBaziTasks(record, NOW).find((t) => t.type === 'annual' && Number(t.year) === 2030)!;
    (natalOnly.aiTasks as any)[annualTask.taskId] = { task: annualTask, status: 'pending', source: 'local' };
    const base = ask('今年事业运如何', natalOnly);         // 2026 年连槽位都没有 → 缺口回执
    const probe = ask('2030年事业运如何', natalOnly);      // 槽位在、正文没算 → 判据在这里
    expect(base.answer).toBeTruthy();
    expect(probe.answer).toBeTruthy();
    expect(probe.answer!.answer).toContain('这台设备上还没有');
    expect(probe.answer!.answer).toContain('2030 年的流年批断');
    expect(probe.answer!.sources).toEqual([]);
    expect(probe.answer!.answer).not.toContain('七杀临期');   // 不许把别的时间段/别的小节搬来
    expect(probe.answer!.answer).not.toMatch(/本期以守成|宜早睡养正/);
  });

  it('完全没有批断（只有排盘事实）→ 喜用类问题仍能给档位结论，其他问题老实说没算过', () => {
    const bare = { ...record, aiTasks: {} } as unknown as BaziRecord;
    const five = ask('喜用五行是什么', bare);
    expect(five.answer).toBeTruthy();
    expect(five.answer!.answer).toContain('喜用五行为土、金');
    expect(five.answer!.partial).toBe(true);
    const yearly = ask('今年事业运如何', bare);
    expect(yearly.answer!.answer).toContain('这台设备上还没有');
  });

  it('没有排盘数据的记录直接返回 null（交回上层走原有通道）', () => {
    const noChart = { id: 'x', name: '空', gender: 'male', birthYear: 1990, birthMonth: 1, aiTasks: {} } as unknown as BaziRecord;
    expect(buildLocalChatAnswer({ record: noChart, plan: analyzeQuestion('喜用五行是什么', [noChart], NOW), question: '喜用五行是什么', history: [] }, NOW)).toBeNull();
  });

  it('多盘且本轮没点名字 → 不猜命主（选择列表由上层给）', () => {
    // 这一条钉的是 tryLocalChat 的行为边界：pickTarget 认不出人时必须返回 null 落回原路径。
    const two = [record, { ...record, id: 'r2', name: '测试乙' }];
    const plan = analyzeQuestion('今年事业运如何', two, NOW);
    expect(plan.recordId).toBeNull();       // 提问理解层面就没定到人
    expect(two.find((r) => r.id === plan.recordId)).toBeUndefined();
  });
});
