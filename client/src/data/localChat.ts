/* =============================================================================
 * 本地规则问答（对话 A 层）—— 「问问 AI」的第四条回答通道
 *
 * 定位：本机已开通「本地系统」时，提问**不联网、不调模型、不消耗额度**，直接由规则在
 * 已有的排盘事实与已算批断里取话作答。它复用的正是大模型在本命/时段类问题上做的事：
 * 把确定性事实与小节结论排成编号白话 —— 差别只在这里是查表拼装，不是生成。
 *
 * ⚠ 三条口径约束（写死在这里，改动前先读）：
 *  1) **只搬运，不推算**：正文的每一句都来自 `localAnalysis` 已产出的小节或本命事实，
 *     本模块自己不得引入任何命理判断（不新增喜忌、不新断吉凶、不改档位）。
 *     于是它与批量分析那一路**同源**：详情页里看到的批断说什么，这里就答什么。
 *  2) **取不到就如实说缺**：宁肯回一句「这台设备上还没算过 2029 年的流年批断」，
 *     也不许用常识补一段。云端通道的【缺口处理】是同一精神，本机更没资格编。
 *  3) **默认零痕迹**：未开通本地系统的用户走不到这里（见 chatEngine 的闸门），
 *     界面上不会多出「本机规则回答」这种他看不见的东西。
 *
 * 覆盖的问题形态（用户 2026-09-26 定的验收清单）：
 *   喜用五行是什么 / 今年事业运如何 / 明年三月要注意什么 / 什么时候适合跳槽 / 我这个人怎么样
 * —— 分别对应「本命事实」「年度时段批断」「月度时段批断」「扫年应期」「泛问铺开」。
 * ========================================================================== */
import { countElements, ELEMENTS, STEMS, stemElementIndex } from '../features/chart/elements';
import type { BaziRecord } from '../types/domain';
import type { ChatPlan } from './chatEngine';

/** 引擎版本：与批断引擎同前缀，便于产物里核对「这一路确实跑的是本机规则」。 */
export const LOCAL_CHAT_VERSION = 'local-chat-v1';

/** 一次问答的产出。`partial` = 只答出了一部分（缺某段证据），仍算 completed，
 *  但界面与调用方要能分辨「全量取证」和「带缺口作答」。 */
export interface LocalChatAnswer {
  answer: string;
  partial: boolean;
  /** 实际引用的证据来源标题，逐条列出，供界面标注「依据哪几篇批断」。 */
  sources: string[];
  missing: string[];
}

/* ---------- 只读工具：从记录里取「已经算好的东西」，一律不写回 ---------- */
/** 本命批断的任务号。写成常量但**其余任务一律按 type 现找**：只有它是各条路径都保证存在的槽位，
 *  而全盘总结/后天调整在只跑了前 24 个任务的盘里压根不存在（见 `taskIdByType`）。 */
const BASELINE_TASK = 'task-01';
const tasksOf = (record: BaziRecord) => Object.values(record.aiTasks ?? {});
const resultOf = (record: BaziRecord, taskId: string) => record.aiTasks?.[taskId];
const isDone = (record: BaziRecord, taskId: string) => resultOf(record, taskId)?.status === 'completed'
  && !!resultOf(record, taskId)?.analysis?.explanation;
const bodyOf = (record: BaziRecord, taskId: string): string => String(resultOf(record, taskId)?.analysis?.explanation ?? '');

/** 按【小节】切批断正文（与 chatEngine.sliceSections 同构，但这里只要「标签 + 正文」对）。 */
function sections(text: string): Array<{ label: string; body: string }> {
  const out: Array<{ label: string; body: string }> = [];
  for (const part of String(text || '').split(/(?=【)/)) {
    const m = part.match(/^【([^】]+)】([\s\S]*)/);
    if (!m) continue;
    out.push({ label: m[1].trim(), body: m[2].trim() });
  }
  return out;
}
/** 取某个小节的正文：**精确匹配优先，包含匹配只作兜底**。
 *  ⚠ 为什么不能一遍 includes：同一主题在不同篇里标签不同 —— 本命/时段篇是【健康】，后天调整篇是【健康注意】，
 *     两者都含「健康」。一篇正文里同时有这两节时（存量盘、云端那几篇的标签集比本机宽），
 *     includes 先命中谁取决于小节先后 —— 于是问当期取向会拿到调理底稿。
 *   变异验证（S3）：删掉这一层优先、只留单遍 includes ⇒ 现测 23 条用例全绿。原因如实记下：
 *     本地引擎真实输出的本命篇标签是「身强身弱与喜忌/性格与十神/健康/事业/财运/爱情/刑冲克害批注/大运提点/神煞点缀/总评与行为建议」，
 *     【健康注意】只出现在另一篇（后天调整）里，**同一篇内不存在两节同含「健康」**，所以这条守卫在当前输出形态下无从触发。
 *     留着它是防「一篇正文里出现近名标签」（换源/存量），不是为通过某条用例；补强要先造那种夹具。 */
function section(text: string, label: string): string {
  const list = sections(text);
  const exact = list.find((s) => s.label === label);
  if (exact) return exact.body;
  const hit = list.find((s) => s.label.includes(label));
  return hit ? hit.body : '';
}
/** 把「1. …\n2. …」的编号条目拆成数组，方便只引用其中与前问相关的几条。 */
function items(body: string): string[] {
  return String(body || '').split(/\n(?=\s*\d+[.、])|\n+/).map((s) => s.replace(/^\s*\d+[.、]\s*/, '').trim()).filter(Boolean);
}
const clean = (s: string): string => s.replace(/[。；]?\s*$/, '');

/** 全盘总结 / 后天调整**不靠固定任务号**（task-31 / task-30）定位 —— 那两个常量是编排器按
 *  「本命 + 未来十年 + 十二个月」排出来的槽位，一条只算了 24 个任务的盘里它们根本不存在。
 *  按 `task.type` 现找才是与批量分析同源、且不随任务数变化而漂移的读法。 */
const taskIdByType = (record: BaziRecord, type: 'overview' | 'adjustment'): string | undefined =>
  tasksOf(record).find((t) => t.task.type === type)?.task.taskId;

/* ---------- 各问型的组装 ---------- */
/** 「本期宜注意」小节：批断正文里刑冲那一段的标题**按时段类型变** —— 流年/流月篇写
 *  【刑冲克害批注】，大运篇（buildPeriodAnalysis）压根不用这个标签。所以取不到时退到本命批断
 *  的同名小节（见调用处），而不是让整条回答因为「没抓到这一节」而作废。 */
const NOTICE_SECTION = '刑冲克害批注';
const TOPIC_SECTION: Record<string, string> = {
  健康: '健康', 事业: '事业', 财运: '财运', 爱情: '爱情', 神煞: '神煞点缀', 刑冲克害批注: NOTICE_SECTION,
};

/** 由排盘事实现推喜忌（与批断引擎 `deriveUsefulAvoid` 同一扶抑口径）。
 *  ⚠ 这不是「本模块自己下判断」：判据完全取自引擎的档位/特殊格局，只是不依赖本命批断正文存在。
 *     于是**一条只重算了非 AI、还没生成任何批断的盘**也能答上「喜用五行是什么」——
 *     第一版在这里直接返回 null，界面上就成了「明明本机算得出来却说答不了」。 */
const GROUP_OFFSET: Record<string, number> = { 比劫: 0, 食伤: 1, 财: 2, 官杀: 3, 印: 4 };
const relFromDay = (dayIdx: number, delta: number): string => ELEMENTS[(dayIdx + delta) % 5];
function usefulAvoidFromFacts(record: BaziRecord): { useful: string[]; avoid: string[]; dayIdx: number } | null {
  const n = record.nonAiResult;
  const dayStem = n?.pillars?.day?.[0] ?? '';
  if (!n || !STEMS.includes(dayStem)) return null;
  const dayIdx = stemElementIndex(dayStem);
  const g = (group: string) => relFromDay(dayIdx, GROUP_OFFSET[group]);
  const uniq = (arr: string[]) => [...new Set(arr)];
  const label = n.strengthScore?.label;
  const special = n.patternFacts?.special;
  if (special?.startsWith('从格')) return { useful: uniq([g('财'), g('官杀'), g('食伤')]), avoid: uniq([g('印'), g('比劫')]), dayIdx };
  if (special?.startsWith('专旺')) return { useful: uniq([g('比劫'), g('印'), g('食伤')]), avoid: uniq([g('官杀')]), dayIdx };
  if (label === '身强' || label === '中和偏旺') return { useful: uniq([g('食伤'), g('财'), g('官杀')]), avoid: uniq([g('印'), g('比劫')]), dayIdx };
  return { useful: uniq([g('印'), g('比劫')]), avoid: uniq([g('财'), g('官杀'), g('食伤')]), dayIdx };
}

/** 本命事实行：日主/五行/格局/旺衰/喜忌 —— 全部现读 nonAiResult，不经模型。 */
function natalFacts(record: BaziRecord): string[] {
  const n = record.nonAiResult;
  if (!n?.pillars) return [];
  const counted = countElements([record.yearPillar, record.monthPillar, record.dayPillar, record.hourPillar]);
  const base = resultOf(record, BASELINE_TASK)?.analysis;
  /* elementRatio 是 0..1 的**比例**（见 elements.ts 的 countElements：counts/总数），不是百分数。
     ⚠ 别在已是小数的值上再乘一次 100：`countElements` 的 elementRatio 本身就是 counts/总数（见 features/chart/elements.ts），
     再乘一次会显示成「2500%」。
   变异验证（P1）：把这句改成**干脆不乘**（直接端出 0.25），现测 25 条用例全绿 —— 因为本盘四柱没有配比恰为 0 的五行，
     「缺 X」那半句两条路径都不出现，其余读数又相同，属**等价形态下的覆盖不足**，不是这行写错了。
     ⚠ 上面两段注释里「只删 Math.round 能杀掉」的说法是**没验过的推断，而且是错的**：本轮按它重跑 P1
     （整句去掉 Math.round，0.375 → 显示 37.5%）实测 `Tests 25 passed (25)`、VERDICT_FAILED=0_KILLED=false。
     ⇒ 当时缺口比原先记的更宽：`pct()` 这一整句在现有用例下**怎么改都不红**。
  ✅ 2026-09-26 该盲区已闭合：新增 `src/__tests__/local-chat-ratio.test.ts`（夹具 乙卯 丁亥 庚午 壬午，
     金=1/8、土=0），两种坏形态都实测杀得掉：
       · 不乘 100 → `五行配比：木 0.25%·火 0.375%·土 0%·金 0.125%…`，`Tests 1 failed | 19 passed (20)`；
       · 去掉 Math.round → 印 12.5%，`Tests 1 failed | 1 passed (2)`。
     ⚠ 那条用例的问句换成「泛问/喜用/带年份」就走不到这里（分支钉子见该文件注释），动分支顺序要连它一起看。 */
  const pct = (e: string): number => Math.round((counted.elementRatio?.[e] ?? 0) * 100);
  const ratio = ELEMENT_ORDER.map((e) => e + ' ' + pct(e) + '%').join('·');
  const lacking = ELEMENT_ORDER.filter((e) => pct(e) === 0);
  const lines = [
    '四柱 ' + [record.yearPillar, record.monthPillar, record.dayPillar, record.hourPillar].join(' · ')
      + '，日主' + (n.dayMaster ?? '') + '，生肖' + (n.zodiac ?? '') + '（' + (n.solarDate ?? '') + '）。',
    '五行配比：' + ratio + (lacking.length ? '，缺' + lacking.join('、') : '') + '。',
  ];
  let useful = base?.usefulElements ?? [];
  let avoid = base?.avoidElements ?? [];
  if (base?.pattern || base?.strength) {
    lines.push('格局' + (base.pattern ? '以' + base.pattern + '论' : '') + (base.strength ? '，判为' + base.strength : '') + '。');
  } else if (n.patternFacts?.name) {
    lines.push('格局以' + n.patternFacts.name + '论' + (n.strengthScore?.label ? '，判为' + n.strengthScore.label : '') + '。');
  }
  /* 没有本命批断正文时退到排盘事实现推 —— 但**只在确实推得出喜用时**才加这一句：
     缺旺衰档位的老盘会一律落到「身弱」分支，那句「喜用五行为…」就成了没根据的话。 */
  if (!useful.length) {
    const derived = usefulAvoidFromFacts(record);
    if (derived?.useful.length) { useful = derived.useful; avoid = derived.avoid; }
  }
  if (useful.length) lines.push('喜用五行为' + useful.join('、') + '，忌' + avoid.join('、') + '。');
  return lines;
}
const ELEMENT_ORDER = ['木', '火', '土', '金', '水'];

/** 「我这个人怎么样」这类泛问：本命结论 + 性格 + 已有小节清单，让用户知道还能往哪儿追问。 */
function answerGeneral(record: BaziRecord): LocalChatAnswer | null {
  /* ⚠ 这里**不写** `if (!isDone(record, taskId)) return null;` 这种形态的守卫（判据取自 BASELINE_TASK，
     且下面紧接着就是 gapAnswer 兜底）—— 变异桩 N1 的锚点靠「全文唯一」定位，
     若将来在本函数里插入一字不差的这句，那条变异会退成 hits=2、runner 直接不打落地。改动前跑
     `node .scratch/audit-anchors.cjs`（见该文件头注释）。 */
  if (!isDone(record, BASELINE_TASK)) return null;
  const baseline = bodyOf(record, BASELINE_TASK);
  const blocks: string[] = [];
  const conclusion = section(baseline, '身强身弱与喜忌');
  if (conclusion) blocks.push('1. ' + clean(items(conclusion)[0] ?? '') + '；' + clean(items(conclusion).slice(-1)[0] ?? ''));
  const sex = section(baseline, '性格与十神');
  if (sex) blocks.push(...items(sex).slice(0, 4).map((t) => '- ' + clean(t)));
  const overviewId = taskIdByType(record, 'overview');
  const hasOverview = !!overviewId && isDone(record, overviewId);
  const overview = hasOverview ? section(bodyOf(record, overviewId!), '核心结论') : '';
  if (overview) blocks.push(...items(overview).slice(0, 3).map((t) => '- ' + clean(t)));
  if (!blocks.length) return null;
  const labels = [...new Set([...sections(baseline), ...(overview ? sections(bodyOf(record, overviewId!)) : [])].map((s) => s.label))];
  const missing: string[] = [];
  if (!hasOverview) missing.push('全盘总结还没算，十年大势与关键节点这次没引到');
  const tail = labels.length
    ? '本盘已算出的小节有：' + labels.map((l) => '【' + l + '】').join('、') + '。想细问哪一块、或问某年某月，接着问就行。'
    : '';
  return { answer: ['就本机已算的批断，你的整体状况如下：', ...blocks, tail].filter(Boolean).join('\n'),
    partial: missing.length > 0, sources: ['本命批断', ...(hasOverview ? ['全盘总结'] : [])], missing };
}

/** 「喜用五行是什么」：优先取本命批断里的定论，退取排盘事实里的档位现推结论（仍是引擎原文）。 */
function answerUsefulElements(record: BaziRecord): LocalChatAnswer | null {
  const facts = natalFacts(record);
  const adjustmentId = taskIdByType(record, 'adjustment');
  const hasAdjustment = !!adjustmentId && isDone(record, adjustmentId);
  const adjustment = hasAdjustment ? bodyOf(record, adjustmentId!) : '';
  const blocks: string[] = [];
  const line = facts.find((f) => f.startsWith('喜用五行')) ?? facts.find((f) => f.startsWith('格局'));
  if (line) blocks.push('1. ' + clean(line) + '。');
  const principle = isDone(record, BASELINE_TASK) ? section(bodyOf(record, BASELINE_TASK), '身强身弱与喜忌') : '';
  const why = items(principle).find((t) => t.includes('喜用定为') || t.includes('扶抑'));
  if (why) blocks.push('2. ' + clean(why));
  /* 调候那一节有两种说法，必须都认：气候不偏枯时是「调候参考：…」，偏枯的盘(严冬无火/盛夏无水)
     由 localAnalysis 换成如实交代两源分歧的那句，**开头没有「调候参考」四字**。上一版只按前缀取，
     于是那 27/120 组盘问「喜用五行是什么」时调候一栏凭空消失 —— 批断里有、聊天里没有。 */
  const tiaohou = items(principle).find((t) => t.startsWith('调候参考') || t.includes('此系两源出入'));
  if (tiaohou) blocks.push('3. ' + clean(tiaohou));
  const direction = adjustment ? items(section(adjustment, '后天调整')).slice(0, 2) : [];
  if (direction.length) blocks.push('4. 方位与调理上：' + direction.map((d) => clean(d)).join('；'));
  if (!blocks.length) return null;
  const missing: string[] = [];
  if (!isDone(record, BASELINE_TASK)) missing.push('本命批断还没算，这里只能给排盘事实层面的档位结论');
  if (!hasAdjustment) missing.push('后天调整还没算，调理方向这次没引到');
  return { answer: ['按本机规则引擎的扶抑口径：', ...blocks].join('\n'), partial: missing.length > 0,
    sources: [isDone(record, BASELINE_TASK) ? '本命批断' : '排盘事实', ...(hasAdjustment ? ['后天调整与职业'] : [])], missing };
}

/** 「注意什么」这类说法命中的是主题「流月」（见 chatEngine 的 TOPIC_RULES），而它**不是一种断语主题**：
 *  批断正文里没有【流月】小节，按它过滤会得到空 → 整条回答作废、退成缺口回执（实测踩过）。
 *  所以把「时段类主题」从取话的主题里剔掉；剔空后 `answerPeriod` 会铺开四个主题 + 刑冲节。
 *  ⚠ 判据取自 `plan.month !== undefined` 而不是只看 topics：现测「2029年2月事业怎么样」会把
 *     topics 解成 ['事业','流月']，此时**不能**当成「没点到具体主题」去附一段健康向的冲克清单。 */
const PERIOD_TOPICS = new Set(['流月', '大运']);
const contentTopics = (topics: string[], month?: number): string[] =>
  (month === undefined ? topics : topics.filter((t) => !PERIOD_TOPICS.has(t)));

/** 时段问题（有年份，可选月份）：取该年/该月的流年流月批断里对应主题的小节。 */
function answerPeriod(record: BaziRecord, plan: ChatPlan, taskId: string, heading: string, year: number): LocalChatAnswer | null {
  if (!isDone(record, taskId)) return null;
  const text = bodyOf(record, taskId);
  /* 剔掉「流月／大运」这类**时段类主题**：它们不是断语小节的标签，正文里没有【流月】一节，
     按它取话只会得到一条「该篇没有这个小节」的假缺口（实测踩过）。剔空了才铺开四主题。
     ⚠ 必须在过滤后的列表上判空 —— 拿原始 plan.topics 判，['事业','流月'] 会被当成「没点到具体主题」，
     于是给一句问事业的话附上一段健康向的冲克清单。
   变异验证：把这两处一起换成不剔时段主题（T1），现测 23 条用例全绿 —— 因为引擎真实输出的本命/时段篇里
     压根没有【流月】【大运】这两节（实测标签只有 健康/事业/财运/爱情/刑冲克害批注），而含时段的两句问话
     （明年三月要注意什么、2027年3月事业怎么样）一条 topics 为空、另一条过滤前后都只剩「事业」。
     也就是说这一层在当前输出形态下是**防御性**的：它防的是将来正文真出现这两个标签，不是现在某条用例。
     留着但不假装它被钉住了。 */
  const content = contentTopics(plan.topics, plan.month);
  const topics = content.length ? content : ['健康', '事业', '财运', '爱情'];
  const blocks: string[] = [];
  const used: string[] = [];
  const missing: string[] = [];
  for (const topic of topics) {
    const label = TOPIC_SECTION[topic];
    const body = label ? section(text, label) : '';
    if (!body) { missing.push('该篇批断里没有与「' + topic + '」直接相关的小节'); continue; }
    used.push(topic);
    blocks.push('【' + topic + '】');
    blocks.push(...items(body).slice(0, 3).map((t, i) => (i + 1) + '. ' + clean(t)));
  }
  const notice = section(text, NOTICE_SECTION) || (isDone(record, BASELINE_TASK) ? section(bodyOf(record, BASELINE_TASK), NOTICE_SECTION) : '');
  /* 刑冲节只在**本轮确实没点到具体断语主题**时才铺开：问「明年三月要注意什么」会被解析成时段主题
     （见 `contentTopics`），那正是「要一句注意清单」的问法；而问「2033年3月事业」不该再附一段健康向的冲克。 */
  if (!content.length && notice) { blocks.push('【本期宜注意】'); blocks.push(...items(notice).slice(0, 2).map((t, i) => (i + 1) + '. ' + clean(t))); }
  if (!blocks.length) return null;
  const verdict = record.aiTasks?.[taskId]?.analysis?.strength ?? '';
  const head = year + '年' + (plan.month !== undefined ? plan.month + '月' : '') + '（' + String(record.aiTasks?.[taskId]?.analysis?.title ?? '') + '）'
    + (verdict ? '，' + verdict : '') + '：';
  return { answer: [head, ...blocks].join('\n'), partial: missing.length > 0, sources: [heading], missing };
}

/** 扫年应期（「什么时候适合跳槽」）：优先逐年比对已算流年批断里与该主题相关的话；
 *  一年都对不上时退取全盘总结点名的时间节点 —— **不是**按加减力硬分类。 */
function answerScan(record: BaziRecord, plan: ChatPlan, now: Date): LocalChatAnswer | null {
  const from = Number(plan.scanFrom ?? now.getFullYear());
  const topic = plan.topics[0];
  const overviewId = taskIdByType(record, 'overview');
  const nodes = overviewId && isDone(record, overviewId) ? items(section(bodyOf(record, overviewId), '值得关注的时间节点')) : [];
  /* 「本机真的算过批断」的年份集合 —— **不是**「有没有这个流年任务」。补算会把时段数组填到十年，
     任务槽位于是照数组排出来；一条只生成到 2032 年的盘往后三年有任务号、没正文。 */
  const answeredYears = new Set<number>();
  for (const t of tasksOf(record)) {
    if (t.task.type !== 'annual') continue;
    const y = Number(t.task.year);
    if (Number.isFinite(y) && isDone(record, t.task.taskId)) answeredYears.add(y);
  }
  /* ⚠ 扫描必须**走完整个窗口**，不能凑满四条就 break：早先版本在 append 之后 `break`，于是
     「本盘只算到 2032 年」时第 5..7 年既不进答案、也不进 `missing`，回答被报成 `partial=false`
     （什么都没缺）——而这条判据在文本上完全看不出来，前四条本来就填满了（实测两版假绿）。
     收尾那句改用「实际列出的最后一年 vs 本轮扫到的最后一年」现算。 */
  const lastAnswered = answeredYears.size ? Math.max(...answeredYears) : from - 1;
  const lines: Array<{ year: number; text: string }> = [];
  const missing: string[] = [];
  let scannedThrough = from - 1;
  for (let y = from; y < from + SCAN_WINDOW; y += 1) {
    /* 「该有而没有」只算到本盘算过的那一年为止：往后那几年不是缺证据，是压根没生成过批断。 */
    if (y > lastAnswered) break;
    scannedThrough = y;
    const taskId = annualTaskId(record, y);
    if (!taskId || !isDone(record, taskId)) { missing.push(y + ' 年的流年批断还没算'); continue; }
    const text = bodyOf(record, taskId);
    const label = topic ? TOPIC_SECTION[topic] : undefined;
    const body = label ? section(text, label) : text;
    if (!body) { missing.push(y + ' 年那篇里没有「' + (topic ?? '相关') + '」小节'); continue; }
    const relevant = items(body).filter((t) => !topic || (KEY_PHRASES[topic] ?? []).some((p) => t.includes(p))).slice(0, 2);
    if (!relevant.length) { missing.push(y + ' 年的「' + topic + '」小节里没有可直接回答这个问题的话'); continue; }
    lines.push({ year: y, text: String(y) + '年（' + String(record.aiTasks?.[taskId]?.analysis?.title ?? '') + '）：' + relevant.map((t) => clean(t)).join('；') });
  }
  const shown = lines.slice(0, SCAN_ANSWER_MAX);
  /* 截断/还有余下年份两句都按读数现算：`shown` 最后一年与「本轮扫到的最后一年」比较。
     ⚠ 别拿行数推断（上一版就是这么错的：没截断时也会冒出一句「余下年份同理」）。 */
  const scanCutOff = lines.length > shown.length;
  const hasRemainder = shown.length > 0 && Number(shown[shown.length - 1].year) < scannedThrough;
  if (!shown.length && !nodes.length) return null;
  const answer: string[] = [];
  if (shown.length) {
    answer.push('就本机已算的逐年批断，与' + (topic ? '「' + topic + '」' : '所问') + '最相关的是这几年：');
    answer.push(...shown.map((l, i) => (i + 1) + '. ' + l.text));
    answer.push(nextYearHint(shown.map((l) => l.text), topic, scanCutOff, hasRemainder));
  } else if (nodes.length) {
    answer.push('逐年批断里没能直接对上「' + (topic ?? '') + '」的话，只能引全盘总结里点名的时间节点：');
    answer.push(...nodes.slice(0, 4).map((t, i) => (i + 1) + '. ' + clean(t)));
  }
  return { answer: answer.join('\n'), partial: missing.length > 0 || !shown.length,
    sources: shown.length ? ['未来各年流年批断'] : ['全盘总结'], missing: [...new Set(missing)].slice(0, 6) };
}

/** ⚠ 扫年**必须只看「本盘真的算过批断」的那几年**（`answeredYears`），窗口上限另算：
 *  `ensureLocalChartComplete` 只补排盘数组（流年/流月/大运），**不会替这条盘生成批断正文**。
 *  一条只跑过前 24 个任务的盘里，往后第 9、10 年有干支却没正文 —— 早先版本一路列到 2035 年，
 *  其中后两年无话可引（那次实测抓到的）。 */
const SCAN_WINDOW = 8;
/** 扫年回答最多列几年：再多就把「问答」变成「刷屏」。截断与否由 `scanCutOff` 显式记录。 */
const SCAN_ANSWER_MAX = 4;

/** 「什么时候适合跳槽」这类应期问句的收尾。⚠ 那句「接着问某一年」的示范**必须按年份取**：
 *  `lines[0]` 形如「2026年（丙午流年·七杀当戒）：…」，用 `slice(0, 4)` 截出来是「2026年（丙」——
 *  一个不存在的年份写法，等于把错误示例教给用户（第一版实测就印出了这句）。
 *  `cutOff`=本轮候选被四条上限砍掉了；`hasRemainder`=没砍但本盘往后还有算过的年份，两句分开说。 */
function nextYearHint(lines: string[], topic: string | undefined, cutOff: boolean, hasRemainder: boolean): string {
  const first = String(lines[0] ?? '').match(/^(20\d{2})年/)?.[1];
  const tail = cutOff ? '更靠后的年份本机没逐条列出来，同样按年份问即可。' : hasRemainder ? '本机这条盘往后几年也算过，同样按年份问即可。' : '';
  if (!first) return '以上是批断原文里的取向，具体怎么选还得结合你现实中的条件。' + tail;
  return '以上是批断原文里的取向，具体怎么选还得结合你现实中的条件；要细看某一年，接着问「' + first + '年' + (topic ?? '') + '」就行。' + tail;
}

/** 每个主题在批断句子里的可见标记词：只用批断本身会出现的措辞，不引入新的命理词。 */
const KEY_PHRASES: Record<string, string[]> = {
  事业: ['事业', '进取', '开拓', '岗位', '管理', '团队', '平台', '创业', '变动', '转岗', '责任', '进气', '乘势', '拓展人脉'],
  /* 「什么时候适合跳槽」实测只列出 2026、2031 两年（扫的是八年窗口）：判据里压根没有「跳槽」这个词，
     而【事业】节讲机会的那几句写的是「进气／乘势推进／拓展人脉与平台／宜进取」——全被挡在门外，
     于是最该答上的几年反而空着（`missing` 会如实记「没有可直接回答这个问题的话」，界面上仍像答非所问）。
     ⚠ 加进来的必须**全部是批断正文里真的出现的措辞**（取自 localAnalysis 的 add('事业') 与 buildOverview 节点句），
        不是我们自己新造的命理词 —— 否则等于在本模块里下判断。 */
  财运: ['财', '求财', '投资', '开支', '聚财', '收入'],
  健康: ['健康', '作息', '体检', '体质', '养护', '透支'],
  爱情: ['感情', '配偶', '婚恋', '桃花', '伴侣'],
  神煞: ['贵人', '神煞'],
  大运: ['运', '气势'],
};

/** 流年任务号：不能按「第几年」硬算偏移 —— 存量记录的流年任务是按当时时刻排的，
 *  跨年后再按偏移取会错位一年（这正是历史上「第 10 年无干支」那一类的根因）。
 *  所以按 task.year 现找，找不到就是真没算过。 */
function annualTaskId(record: BaziRecord, year: number): string | undefined {
  const hit = tasksOf(record).find((t) => t.task.type === 'annual' && Number(t.task.year) === Number(year));
  return hit?.task.taskId;
}
function monthlyTaskId(record: BaziRecord, year: number, month: number): string | undefined {
  const hit = tasksOf(record).find((t) => t.task.type === 'monthly' && Number(t.task.year) === Number(year) && Number(t.task.month) === Number(month));
  return hit?.task.taskId;
}
function decadeTaskIdCovering(record: BaziRecord, year: number): string | undefined {
  const hit = tasksOf(record).find((t) => t.task.type === 'decade' && t.task.decade
    && Number(t.task.decade.startYear) <= Number(year) && Number(year) <= Number(t.task.decade.endYear));
  if (hit) return hit.task.taskId;
  /* 退路：任务里没带 decade 对象（存量/手搓结果）时，按排盘数组找出覆盖该年的那步运的**起运年**再对号。
     ⚠ 这条分支不是防御性冗余 —— 用例真会走到它（补一条只带 `{type:'decade', year}` 的结果即可复现）。 */
  const rows = record.nonAiResult?.greatFortunes ?? [];
  const g = rows.find((r) => Number(r.startYear) <= Number(year) && Number(year) <= Number(r.endYear));
  if (!g) return undefined;
  const byStart = tasksOf(record).find((t) => t.task.type === 'decade' && Number(t.task.year) === Number(g.startYear));
  return byStart?.task.taskId;
}

/** 追问里「换个时间问同一件事」的常见说法。本轮没点主题时才用上轮的主题补，
 *  且**只补主题、不补年份**：年份交给 chatEngine 的 applyFollowUp，避免两处各改一半。
 *  ⚠ 这个正则刻意**不吃汉字内容**（`.{0,6}?` 只在整句都是语气词/空白时才可能匹配到空）：
 *     上一版写成「那她呢」也能命中，于是带指代的追问被本机拒答；更糟的是它把
 *     「明年呢」「那2029年呢」这类**该由 A 层按继承计划作答**的短句也挡在外面（实测红过一次）。
 *     所以判据只看：整句除了语气词和标点之外没有别的字。 */
const FOLLOW_UP_RE = /^[呢吧啊吗哦呀哈嗯\s]*[？?。！\s]*$/;
function isEllipsisOnly(text: string): boolean {
  const stripped = String(text || '').replace(/^(?:那|那么)/, '');
  return stripped.trim() !== '' && FOLLOW_UP_RE.test(stripped);
}

/* ---------- 主入口 ---------- */
export interface LocalChatInput { record: BaziRecord; plan: ChatPlan; question: string; history?: Array<{ role: string; content: string }> }

/** 组不出答案就返回 null —— 让调用方（chatEngine）继续按原有优先级往下落，绝不硬凑。 */
export function buildLocalChatAnswer(input: LocalChatInput, now: Date = new Date()): LocalChatAnswer | null {
  const { record, plan } = input;
  if (!record?.nonAiResult?.pillars) return null;
  const question = String(input.question ?? '');
  // 纯语气词句（「呢」「那她呢」）本机没有可取的话，交回上层走原有通道/选择列表。
  if (isEllipsisOnly(question)) return null;

  const wantsFiveElements = /喜用|用神|忌神|五行/.test(question) && plan.year === undefined && !plan.scan;
  const wantsSelf = plan.general === true && !wantsFiveElements;

  if (plan.scan) {
    const scanned = answerScan(record, plan, now);
    if (scanned) return scanned;
  }
  if (plan.year !== undefined) {
    const y = Number(plan.year);
    if (plan.month !== undefined) {
      const mid = monthlyTaskId(record, y, Number(plan.month));
      const monthly = mid ? answerPeriod(record, plan, mid, y + '年' + plan.month + '月流月批断', y) : null;
      if (monthly) return monthly;
      const did = decadeTaskIdCovering(record, y);
      /* ⚠ `answerPeriod` 返回 null **不等于「没有大运批断」**：也可能是有那篇正文、却没有本轮要的
         小节（实测删掉全部流月后问「2033年3月要注意什么」，大运正文里压根没有【流月】节）。
         第一版在这里直接落到缺口回执，于是把明明存在的大运结论整段丢掉。补一次「无主题过滤」的取话。 */
      const dec = did ? (answerPeriod(record, { ...plan, month: undefined }, did, '所处大运批断', y)
        ?? answerPeriod(record, { ...plan, month: undefined, topics: [] }, did, '所处大运批断', y)) : null;
      if (dec) {
        return { ...dec, answer: dec.answer + '\n\n（这台设备上还没算 ' + y + '年' + plan.month + '月 的流月批断，上面引的是覆盖这一年的大运批断。）', partial: true,
          missing: [y + '年' + plan.month + '月 的流月批断还没算', ...dec.missing] };
      }
      return gapAnswer(['' + y + '年' + plan.month + '月 的流月批断', '' + y + ' 年的大运批断'], record);
    }
    const aid = annualTaskId(record, y);
    const annual = aid ? answerPeriod(record, plan, aid, y + '年流年批断', y) : null;
    if (annual) {
      const did = decadeTaskIdCovering(record, y);
      if (did && isDone(record, did)) {
        const extra = items(section(bodyOf(record, did), '事业')).slice(0, 1);
        if (extra.length && plan.topics.includes('事业')) {
          return { ...annual, answer: annual.answer + '\n【所处大运】\n1. ' + clean(extra[0]), sources: [...annual.sources, '所处大运批断'] };
        }
      }
      return annual;
    }
    const did = decadeTaskIdCovering(record, y);
    if (did) return answerPeriod(record, plan, did, '所处大运批断', y) ?? gapAnswer(['' + y + ' 年的流年批断'], record);
    return gapAnswer(['' + y + ' 年的流年批断'], record);
  }
  if (wantsFiveElements) {
    const direct = answerUsefulElements(record);
    if (direct) return direct;
  }
  if (wantsSelf) {
    const general = answerGeneral(record);
    if (general) return general;
  }
  /* 落到通用一条：按主题取本命批断里的小节（如「我适合什么行业」→ 事业 / 后天调整）。 */
  const baseline = isDone(record, BASELINE_TASK) ? bodyOf(record, BASELINE_TASK) : '';
  const blocks: string[] = [];
  const missing: string[] = [];
  for (const topic of plan.topics) {
    const label = TOPIC_SECTION[topic];
    const body = label ? section(baseline, label) : '';
    if (!body) { missing.push('本命批断里没有「' + topic + '」小节'); continue; }
    blocks.push('【' + topic + '】');
    blocks.push(...items(body).slice(0, 3).map((t, i) => (i + 1) + '. ' + clean(t)));
  }
  if (plan.topics.includes('五行') || plan.topics.includes('格局')) {
    const five = answerUsefulElements(record);
    if (five) return five;
  }
  if (!blocks.length) {
    if (baseline) {
      const first = items(baseline).slice(0, 4);
      return { answer: ['就本机已算的本命批断：', ...first.map((t, i) => (i + 1) + '. ' + clean(t)),
        '（这条问句里没点到具体主题，上面是本命批断的开头结论；想问某年某月请把年份说出来。）'].join('\n'),
      partial: false, sources: ['本命批断'], missing: [] };
    }
    return gapAnswer(['本命批断'], record);
  }
  const facts = natalFacts(record).slice(0, 2);
  return { answer: ['就本机已算的本命批断：', ...facts, ...blocks].join('\n'),
    partial: missing.length > 0, sources: ['本命批断'], missing };
}

/** 一条都取不到时的如实回执：说清缺什么、怎么补，绝不推测。 */
function gapAnswer(what: string[], record: BaziRecord): LocalChatAnswer {
  const list = what.filter(Boolean);
  return {
    answer: '这台设备上还没有' + list.join('、') + '，所以这个问题本机规则答不了（本机只做取用，不替你推测）。\n'
      + '补一下就能问：在这条命盘的详情页点「生成本地批断」（本机规则、不联网、不消耗额度），或点「AI 分析」由云端补齐后再来。',
    partial: true, sources: [], missing: list,
  };
}
