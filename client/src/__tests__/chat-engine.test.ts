import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BaziRecord } from '../types/domain';
import type { ChatPlan } from '../data/chatEngine';
import { analyzeQuestion, applyFollowUp, buildChatMessages, buildEvidence, buildPeriodFacts, extractWhen, sliceSections, cutAtBoundary, askChat, SCAN_YEARS } from '../data/chatEngine';
import { isServerMode, serverFetch, ServerError } from '../data/serverClient';
import { hydrateRecord, listBaziRecords } from '../data/clientRepository';
import { chatDirect } from '../data/deepseekAdapter';

/* 三通道共用的提问解析/证据组装(与服务端 chat.mjs 同口径)的单元测试。 */
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('../data/serverClient', () => ({
  isServerMode: vi.fn(() => false),
  serverFetch: vi.fn(),
  ServerError: class ServerError extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } },
}));
vi.mock('../data/clientRepository', () => ({ listBaziRecords: vi.fn(async () => []), hydrateRecord: vi.fn(async (r) => r) }));
vi.mock('../data/deepseekAdapter', () => ({
  chatDirect: vi.fn(),
  toneInstructionText: (t: number) => '语气(' + t + ')',
}));

afterEach(() => { vi.clearAllMocks(); vi.mocked(isServerMode).mockReturnValue(false); });

const rec = {
  id: 'r1', name: '张三', gender: 'male', birthYear: 1984, birthMonth: 2,
  yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午',
  nonAiResult: {
    dayMaster: '庚',
    annualFortunes: [{ year: 2026, ganZhi: '丙午', relationshipDetails: [{ type: 'chong', sourcePillar: '丙午', targetPillar: '甲子' }] }],
    greatFortunes: [{ ganZhi: '丁卯', startYear: 2020, endYear: 2029, relationshipDetails: [] }],
    monthlyFortunes: [{ year: 2026, month: 3, ganZhi: '庚辰', relationshipDetails: [] }],
  },
  aiTasks: {
    'task-01': { task: { type: 'baseline' }, status: 'completed', analysis: { explanation: '【身强身弱与喜忌】1. 金弱。\n【健康】2. 注意肺。' } },
    'task-03': { task: { type: 'annual', year: 2026 }, status: 'completed', analysis: { title: '丙午·测试', explanation: '【事业】1. 有升迁。\n【健康】2. 心火旺。' } },
    // 泛问取证要铺开这三份；fixture 里没有它们，就测不出「该给却没给」
    'task-05': { task: { type: 'overview' }, status: 'completed', analysis: { explanation: '【核心结论】甲.\n【值得关注的时间节点】乙.\n【行动建议】丙.' } },
    'task-06': { task: { type: 'adjustment' }, status: 'completed', analysis: { explanation: '【后天调整】丁.\n【事业适配】戊.\n【健康注意】己.' } },
  },
} as unknown as BaziRecord;

describe('提问理解(客户端 chatEngine)', () => {
  const now = new Date('2026-09-22T08:00:00');
  it('绝对/相对年月锚定与服务端一致', () => {
    expect(extractWhen('2027年运势', now)).toEqual({ year: 2027, month: undefined });
    expect(extractWhen('明年的事业', now)).toEqual({ year: 2027, month: undefined });
    expect(extractWhen('本月财运', now)).toEqual({ year: 2026, month: 9 });
    expect(extractWhen('下个月要注意什么', now)).toEqual({ year: 2026, month: 10 });
  });
  it('人名长名优先；主题抽取 健康/事业', () => {
    const plan = analyzeQuestion('张三丰2027年身体和事业怎么样', [{ id: 'a', name: '张三' }, { id: 'b', name: '张三丰' }], now);
    expect(plan.recordId).toBe('b');
    expect(plan.year).toBe(2027);
    expect(plan.topics).toEqual(['健康', '事业']);
  });
  it('开放式时机提问 → 标记扫年起点；有年份锚点则不扫', () => {
    const scan = analyzeQuestion('大概什么时期能找到对象', [{ id: 'a', name: '张三' }], now);
    expect(scan.year).toBeUndefined();
    expect(scan.scan).toBe(true);
    expect(scan.scanFrom).toBe(2026);
    const anchored = analyzeQuestion('明年什么时候适合换工作', [{ id: 'a', name: '张三' }], now);
    expect(anchored.scan).toBe(false);
    expect(anchored.year).toBe(2027);
  });
  /* 「我告诉他这个月失业，他回答我没有24年信息」——根因不在模型，在检索层：旧正则只吃 20\d{2}，
     「24年」解不出 → 继承上一轮年份 → 递给模型的证据全是另一年的批断。这几条锁住回推口径。 */
  it('两位年份缩写按当代区间回推：24年→2024、84年→1984，且不当成未来年', () => {
    expect(analyzeQuestion('24年我失业了', [], now).year).toBe(2024);
    expect(analyzeQuestion('那84年呢', [], now).year).toBe(1984);
    expect(analyzeQuestion('27年适合跳槽吗', [], now).year).toBe(2027);
    expect(analyzeQuestion('2024年我换工作', [], now).year).toBe(2024);
    // 四位数照原样取，不能被回推逻辑二次加工
    expect(analyzeQuestion('1998年出生的今年运势', [], now).year).toBe(2026);
  });
  it('汉字月份与「年+月」复合问法都要落地(旧写法整段丢掉月份)', () => {
    expect(extractWhen('明年三月运势如何', now)).toEqual({ year: 2027, month: 3 });
    expect(extractWhen('三月份要注意什么', now)).toEqual({ year: 2026, month: 3 });
    expect(extractWhen('十一月适合跳槽吗', now)).toEqual({ year: 2026, month: 11 });
    expect(extractWhen('去年11月被裁的', now)).toEqual({ year: 2025, month: 11 });
    // 「十一月」不得被 `一月` 抢先切成 十 + 残留
    expect(extractWhen('十一月财运', now).month).toBe(11);
  });
  it('时间锚点在从句里也能取到；年月解析先于 scan 判定(顺序即正确性)', () => {
    const plan = analyzeQuestion('我本月失业了，接下来财运怎么样', [], now);
    expect({ year: plan.year, month: plan.month }).toEqual({ year: 2026, month: 9 });
    // 句中有年份锚点时绝不转扫年，否则月份/年度段取证会被整个跳过
    expect(analyzeQuestion('明年三月什么时候发工资', [], now)).toMatchObject({ year: 2027, month: 3, scan: false });
    /* 真正的判别式：没有相对年份、却同时出现「开放式问时机」和明确月份。
       「明年三月…」那例 RELATIVE_YEAR 先填了 year，旧顺序的早退分支进不去，测不出顺序。 */
    expect(analyzeQuestion('什么时候三月能见分晓', [], now)).toMatchObject({ year: 2026, month: 3, scan: false });
    expect(analyzeQuestion('我下个月什么时候能脱单', [], now)).toMatchObject({ year: 2026, month: 10, scan: false });
    // 反例：确实只有开放式时机词 → 仍须转扫年
    expect(analyzeQuestion('什么时候能升职', [], now)).toMatchObject({ scan: true, scanFrom: 2026 });
  });
  it('泛问识别：没主题词但在问整体 → general；点了具体主题则不算泛问', () => {
    expect(analyzeQuestion('我这个人整体怎么样', [], now).general).toBe(true);
    expect(analyzeQuestion('接下来运势如何', [], now).general).toBe(true);
    // 「命格」本身是格局主题的关键词 → 走精确取证，不该按泛问铺开三份长证据
    const mingge = analyzeQuestion('我的命格如何', [], now);
    expect(mingge.topics).toEqual(['格局']);
    expect(mingge.general).toBe(false);
    expect(analyzeQuestion('我适合做什么工作', [], now).topics).toContain('事业');
    expect(analyzeQuestion('那具体呢', [], now).general).toBe(false);
  });
});

describe('泛问取证铺开(答不到点子上的主因)', () => {
  it('topics 为空但判为泛问 → 本命+全盘总结+后天调整都给，并附小节清单', () => {
    const ev = buildEvidence(rec, { recordId: 'r1', personName: '张三', matchedCount: 0, topics: [], general: true, question: '我这个人整体怎么样' } as ChatPlan);
    expect(ev.analyses.map((a) => a.heading)).toEqual(['本命批断', '后天调整与职业', '全盘总结']);
    expect(ev.sectionIndex?.length).toBeGreaterThan(0);
    // 本例已有本命批断，不该冒出「尚未生成」这类缺口
    expect(ev.missing.join()).not.toContain('本命批断尚未生成');
  });
  it('非泛问的空主题(纯追问残句)不给小节清单', () => {
    const ev = buildEvidence(rec, { recordId: 'r1', personName: '张三', matchedCount: 0, topics: [], general: false } as ChatPlan);
    expect(ev.sectionIndex).toBeUndefined();
  });
  it('小节清单进消息、且排在语气要求之前(不进可缓存前缀)', () => {
    const ev = buildEvidence(rec, { recordId: 'r1', personName: '张三', matchedCount: 0, topics: [], general: true } as ChatPlan);
    const last = buildChatMessages({ question: '我这个人整体怎么样', history: [], evidence: ev, tone: 80 }).slice(-1)[0].content;
    expect(last).toContain('# 本盘已算出的批断小节');
    expect(last.indexOf('本盘已算出的批断小节')).toBeLessThan(last.indexOf('# 语气要求'));
  });
});

describe('追问继承上文(客户端同口径)', () => {
  const now = new Date('2026-09-22T08:00:00');
  const hist = [{ role: 'user' as const, content: '2026年爱情如何' }, { role: 'assistant' as const, content: '【爱情】1. 平顺。' }];
  it('本轮没提主题/时间时从上一轮继承', () => {
    const base = analyzeQuestion('那具体呢', [rec], now);
    expect(base.topics).toEqual([]);
    const plan = applyFollowUp(base, hist);
    expect(plan.topics).toEqual(['爱情']);
    expect(plan.year).toBe(2026);
  });
  it('本轮自己已明说则以本轮为准', () => {
    const plan = applyFollowUp(analyzeQuestion('2027年事业如何', [rec], now), hist);
    expect(plan.topics).toEqual(['事业']);
    expect(plan.year).toBe(2027);
  });
  /* 人名继承：不传 records 时整段对话会锁死在第一个命主上，「那她呢」也答的是上一个人。 */
  const people = [{ id: 'r1', name: '张三' }, { id: 'r9', name: '张三丰' }];
  const personHist = [{ role: 'user' as const, content: '张三丰2026年爱情如何' }, { role: 'assistant' as const, content: '【爱情】平顺。' }];
  it('短追问没点人名 → 沿用上一轮命主(往前找最近一条点过名字的消息)', () => {
    const plan = applyFollowUp(analyzeQuestion('那她呢', people, now), personHist, people);
    expect({ recordId: plan.recordId, personName: plan.personName }).toEqual({ recordId: 'r9', personName: '张三丰' });
    expect(plan.topics).toEqual(['爱情']);
    expect(plan.year).toBe(2026);
  });
  it('本轮自己点了别人的名字 → 换人，不被上文锁住', () => {
    const plan = applyFollowUp(analyzeQuestion('换成张三的事业呢', people, now), personHist, people);
    expect({ recordId: plan.recordId, personName: plan.personName }).toEqual({ recordId: 'r1', personName: '张三' });
    expect(plan.topics).toEqual(['事业']);
  });
  it('继承了具体主题后不再按泛问铺开(否则一句「那她呢」塞三份长证据)', () => {
    const generalPlan = analyzeQuestion('她整体怎么样', people, now);
    expect(generalPlan.general).toBe(true);
    // 上一轮必须是**带主题词**的提问，继承才会生效；用无主题的泛问上文测不出这条互斥
    const careerHist = [{ role: 'user' as const, content: '张三丰2026年爱情如何' }, { role: 'assistant' as const, content: '【爱情】平顺。' }];
    const plan = applyFollowUp(generalPlan, careerHist, people);
    expect(plan.topics).toEqual(['爱情']);
    expect(plan.general).toBe(false);
    // 反例：上文本身也是泛问 → 没有主题可继承，才保持泛问。
    // 追问句自己也要含泛问线索(「那她整体呢」)：只说「那她呢」时本轮没有任何泛问信号，
    // 按设计不铺开三份长证据 —— 那是「指代不清」该走澄清，不是该把全盘端出来。
    const generalHist = [{ role: 'user' as const, content: '他这个人整体如何' }, { role: 'assistant' as const, content: '【核心结论】稳。' }];
    expect(applyFollowUp(analyzeQuestion('那她整体呢', people, now), generalHist, people).general).toBe(true);
    expect(applyFollowUp(analyzeQuestion('那她呢', people, now), generalHist, people).general).toBe(false);
  });
});

describe('证据组装(查本地库)', () => {
  it('sliceSections 只留提问主题小节', () => {
    const out = sliceSections('【健康】1. a\n【事业】2. b', ['健康']);
    expect(out).toContain('【健康】');
    expect(out).not.toContain('【事业】');
  });
  it('cutAtBoundary：超长正文退到句末/换行收口，不腰斩半句(与服务器同口径)', () => {
    const out = cutAtBoundary('1. 今年是机会窗口，宜主动争取。\n2. 明年有变动之象需要谨慎应对以防破财失', 20);
    expect(out.length).toBeLessThanOrEqual(20);
    expect(out).toContain('机会窗口');
    expect(out).not.toContain('明年');
    expect(out.endsWith('。')).toBe(true);
  });
  it('cutAtBoundary：无句读才切满；小节体也走同一收口', () => {
    expect(cutAtBoundary('甲'.repeat(30), 10)).toBe('甲'.repeat(10));
    const out = sliceSections('【身强身弱与喜忌】1. 得令，助身方六十分。\n2. 此条一直写到远超上限仍不见标点啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊', ['身强身弱与喜忌'], 24);
    expect(out).toContain('1. 得令');
    expect(out).not.toContain('啊啊');
  });
  it('问流年：命中该年批断，periodFacts 带引擎现算时段行', () => {
    const plan = analyzeQuestion('2026年事业如何', [rec]);
    const ev = buildEvidence(rec, plan);
    const annual = ev.analyses.find((a) => a.heading.includes('2026年·流年批断'));
    expect(annual?.text).toContain('有升迁');
    expect(annual?.text).not.toContain('心火旺'); // 未问健康则不带该节
    const pf = buildPeriodFacts(rec, plan) as Record<string, any>;
    expect(pf.annual.ganZhi).toBe('丙午');
    expect(pf.annualHits).toEqual(['六冲(甲子)']);
    expect(pf.decade?.ganZhi).toBe('丁卯');
    expect(pf.age).toBe(42);
  });
  it('问未分析的年份 → 数据缺口提示', () => {
    const ev = buildEvidence(rec, analyzeQuestion('2027年财运如何', [rec]));
    expect(ev.missing.some((m) => m.includes('2027'))).toBe(true);
  });
  it('扫年取证：主题不是批断小节时(神煞/大运)不过滤，整年批断交给模型判断', () => {
    const plan = applyFollowUp(analyzeQuestion('大概什么时期神煞转好', [rec]), []);
    expect(plan.topics).toEqual(['神煞']);
    const ev = buildEvidence(rec, plan);
    const timeline = ev.analyses.find((a) => a.heading.includes('逐年批断'));
    // 「神煞」不是【小节】标签：过滤条件整条跳过，该年全部小节都要给出
    expect(timeline?.text).toContain('【事业】');
    expect(timeline?.text).toContain('【健康】');
    expect(ev.missing.some((m) => m.includes('没有与所问主题相关的小节'))).toBe(false);
  });
  it('扫年取证：主题是批断小节但该年没有该小节 → 点名说明该年判不了这个主题', () => {
    const noLove = {
      ...rec,
      aiTasks: { 'task-03': { task: { type: 'annual', year: 2026 }, status: 'completed', analysis: { title: '丙午·测试', explanation: '【事业】1. 有升迁。' } } },
    } as unknown as BaziRecord;
    const plan = applyFollowUp(analyzeQuestion('大概什么时期能找到对象', [noLove]), []);
    const ev = buildEvidence(noLove, plan);
    const coverage = ev.missing.find((m) => m.includes('没有与所问主题相关的小节'));
    expect(coverage).toBeTruthy();
    expect(coverage).toContain('2026');
  });
  it('扫年取证：主题对得上时逐年列出，缺的年份逐个点名', () => {
    const plan = applyFollowUp(analyzeQuestion('大概什么时期事业能起来', [rec]), []);
    const ev = buildEvidence(rec, plan);
    const timeline = ev.analyses.find((a) => a.heading.includes('逐年批断'));
    expect(timeline?.text).toContain('2026年');
    expect(timeline?.text).toContain('有升迁');
    const gap = ev.missing.find((m) => m.includes('2027'));
    expect(gap).toBeTruthy();
    for (let y = 2027; y < 2026 + SCAN_YEARS; y += 1) expect(gap).toContain(String(y));
  });  it('buildChatMessages：system 在最前，历史最多 8 条，尾块含证据与问题', () => {
    const ev = buildEvidence(rec, analyzeQuestion('2026年事业如何', [rec]));
    const history = Array.from({ length: 12 }, (_, i) => ({ role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant', content: 'h' + i }));
    const msgs = buildChatMessages({ question: '事业？', history, evidence: ev, tone: 80 });
    expect(msgs[0].role).toBe('system');
    expect(msgs).toHaveLength(1 + 8 + 1);
    expect(msgs[msgs.length - 1].content).toContain('# 用户问题');
    expect(msgs[msgs.length - 1].content).toContain('# 所问时段运势数据');
  });
  it('大运按「覆盖年」取证：问起运年以外的中段年份也要端出所处大运批断', () => {
    // fixture 的丁卯大运覆盖 2020-2029；大运任务按「起运年 2020」存，旧代码问中段年会静默丢失。
    const withDecade = { ...rec, aiTasks: { ...rec.aiTasks, 'task-24': { task: { type: 'decade', year: 2020 }, status: 'completed', analysis: { explanation: '【事业】丁卯运十年稳中有升。' } } } } as unknown as BaziRecord;
    for (const y of [2020, 2026, 2029]) {
      const ev = buildEvidence(withDecade, analyzeQuestion(y + '年事业如何', [withDecade]));
      const dec = ev.analyses.find((a) => a.heading.includes('大运'));
      expect(dec, y + ' 年应取到所处大运批断(覆盖该年的 2020-2029 运)').toBeTruthy();
      expect(dec!.text).toContain('丁卯运');
    }
  });
});

describe('askChat 通道分流', () => {
  it('服务器模式：附带本机引擎算出的 periodFacts 与 recordId 调 /chat', async () => {
    vi.mocked(isServerMode).mockReturnValue(true);
    vi.mocked(listBaziRecords).mockResolvedValue([rec]);
    vi.mocked(serverFetch).mockResolvedValue({ status: 200, data: { status: 'completed', answer: '服务器答案' } } as never);
    const reply = await askChat({ question: '2026年事业如何？' });
    expect(reply.answer).toBe('服务器答案');
    const call = vi.mocked(serverFetch).mock.calls[0];
    expect(call[0]).toBe('/chat');
    const body = (call[1] as { body: Record<string, any> }).body;
    expect(body.recordId).toBe('r1');
    expect(body.periodFacts?.annual?.ganZhi).toBe('丙午');
  });
  it('取证前先还原瘦身数组：列表给的是清空过大运/流年的存储版', async () => {
    // 落库时 pruneRecord 把派生数组清成空，listBaziRecords 又不重算。聊天若直接拿它算证据，
    // buildPeriodFacts 的三行查找恒为空，模型只剩一个年龄 —— 问「某年运势」就答不出东西。
    const slimmed: BaziRecord = { ...rec, nonAiResult: { ...rec.nonAiResult!, annualFortunes: [], greatFortunes: [], monthlyFortunes: [] } };
    vi.mocked(isServerMode).mockReturnValue(true);
    vi.mocked(listBaziRecords).mockResolvedValue([slimmed]);
    vi.mocked(hydrateRecord).mockResolvedValue(rec);
    vi.mocked(serverFetch).mockResolvedValue({ status: 200, data: { status: 'completed', answer: '服务器答案' } } as never);
    await askChat({ question: '2026年事业如何？' });
    expect(hydrateRecord).toHaveBeenCalledWith(slimmed);
    const body = (vi.mocked(serverFetch).mock.calls[0][1] as { body: Record<string, any> }).body;
    expect(body.periodFacts?.annual?.ganZhi).toBe('丙午');
  });
  it('服务器断线(status 0) → 落本机直连并回传命主定位', async () => {
    vi.mocked(isServerMode).mockReturnValue(true);
    vi.mocked(listBaziRecords).mockResolvedValue([rec]);
    vi.mocked(serverFetch).mockRejectedValue(new ServerError(0, '无法连接服务器（网络不可达）'));
    vi.mocked(chatDirect).mockResolvedValue({ status: 'completed', answer: '本机答案' } as never);
    const reply = await askChat({ question: '2026年事业如何？' });
    expect(reply.status).toBe('completed');
    expect(reply.answer).toBe('本机答案');
    expect(reply.evidence?.recordId).toBe('r1');
    expect(chatDirect).toHaveBeenCalled();
  });
  it('本机无命盘 → need_record；多条未指明 → 候选列表', async () => {
    vi.mocked(listBaziRecords).mockResolvedValue([]);
    expect((await askChat({ question: '我五行缺什么？' })).status).toBe('need_record');
    vi.mocked(listBaziRecords).mockResolvedValue([rec, { ...rec, id: 'r2', name: '李四' }]);
    const r = await askChat({ question: '今年事业如何？' });
    expect(r.status).toBe('need_record');
    expect(r.evidence?.options).toHaveLength(2);
    expect(chatDirect).not.toHaveBeenCalled();
  });
  it('问题为空/超长在入口即拒绝', async () => {
    expect((await askChat({ question: '  ' })).status).toBe('failed');
    expect((await askChat({ question: '长'.repeat(501) })).status).toBe('failed');
  });
});

/* ---------- 与服务端 chat.mjs 的口径一致性 ---------- */
describe('聊天提示词与主题规则 服务器/客户端一致', () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../') + '/';
  const read = (p: string) => readFileSync(root + p, 'utf8').replace(/\r\n/g, '\n');
  const grab = (src: string, name: string) => {
    const s = src.indexOf(`const ${name} = '`);
    if (s < 0) throw new Error('missing ' + name);
    let acc = '';
    for (const ln of src.slice(s).split('\n')) { acc += (acc ? '\n' : '') + ln; if (ln.endsWith(';')) break; }
    return [...acc.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]).join('').replace(/\\n/g, '\n').replace(/\\'/g, "'");
  };
  it('CHAT_SYSTEM 逐字节一致', () => {
    expect(grab(read('client/src/data/chatEngine.ts'), 'CHAT_SYSTEM')).toBe(grab(read('server/chat.mjs'), 'CHAT_SYSTEM'));
  });
  it('CHAT_SYSTEM 正文不得出现英文字段名(截图事故的根因：提示词点名了英文，模型就照抄)', () => {
    const text = grab(read('server/chat.mjs'), 'CHAT_SYSTEM');
    const BANNED = ['patternFacts', 'strengthScore', 'tiaohouFacts', 'dayMaster', 'elementRatio', 'hiddenStems', 'tenGods', 'shenSha', 'periodFacts', 'analyses', 'missing', 'natal', 'plan'];
    for (const word of BANNED) expect(text).not.toContain(word);
    // 只允许格式说明用的 JSON 与 AI 两个拉丁词，其余连续拉丁词一律不允许
    const latin = text.match(/[A-Za-z]+/g) ?? [];
    expect(latin.filter((w) => w !== 'AI' && w !== 'JSON')).toEqual([]);
  });
  it('追问与时机规则写进了提示词(两端口径)', () => {
    const text = grab(read('server/chat.mjs'), 'CHAT_SYSTEM');
    expect(text).toContain('先看历史');
    expect(text).toContain('时机提问');
    expect(text).toContain('逐年批断');
  });
  it('主题标签集合一致', async () => {
    const serverTopics = [...read('server/chat.mjs').matchAll(/topic: '([^']+)'/g)].map((m) => m[1]);
    const { TOPIC_RULES } = await import('../data/chatEngine');
    expect(TOPIC_RULES.map((r) => r.topic)).toEqual(serverTopics);
  });
  /* 提问解析的正则/常量此前**完全没有**跨端测试(旧 parity 只比 CHAT_SYSTEM 与主题标签)，
     所以两端各自漂移了很久都没人发现：服务器 applyFollowUp 有人名护栏、客户端没有。
     这几条把「解析口径」也纳入逐字节比对 —— 改一端忘了另一端会当场红。 */
  const grabRe = (src: string, name: string): string => {
    const m = src.match(new RegExp('(?:export )?const ' + name + ' = (/.*/);'));
    expect(m, '两端都应定义正则常量 ' + name).not.toBeNull();
    return m![1];
  };
  /** CN_MONTH_ALT 是字符串常量而非正则字面量(要拼进 new RegExp)，单独取。 */
  const grabStr = (src: string, name: string): string => {
    const m = src.match(new RegExp("(?:export )?const " + name + " = '([^']*)';"));
    expect(m, '两端都应定义字符串常量 ' + name).not.toBeNull();
    return m![1];
  };
  it('时间解析的规则两端逐字节相同', () => {
    const s = read('server/chat.mjs'), c = read('client/src/data/chatEngine.ts');
    for (const name of ['OPEN_TIMING_RE', 'GENERAL_QUESTION_RE']) expect(grabRe(c, name), name).toBe(grabRe(s, name));
    expect(grabStr(c, 'CN_MONTH_ALT'), 'CN_MONTH_ALT').toBe(grabStr(s, 'CN_MONTH_ALT'));
    // 相对年份表：键序即匹配优先级，两端必须同序同值
    const rel = (src: string) => (src.match(/RELATIVE_YEAR[^=]*= \{([^}]*)\}/)?.[1] ?? '').replace(/\s/g, '');
    expect(rel(c)).toBe(rel(s));
    expect(rel(c)).toContain('今年:0');
    // 扫年窗口两端同值：不同源就会出现「本机答 8 年、服务器答别的年数」
    expect((c.match(/SCAN_YEARS = (\d+)/)?.[1])).toBe((s.match(/SCAN_YEARS = (\d+)/)?.[1]));
  });
  it('两位年份回推阈值两端相同(30 为界：>30 归 19xx)', () => {
    const bound = (src: string) => (src.match(/raw > (\d+) \? 1900 \+ raw : 2000 \+ raw/)?.[1]);
    expect(bound(read('client/src/data/chatEngine.ts'))).toBe(bound(read('server/chat.mjs')));
    expect(bound(read('server/chat.mjs'))).toBe('30');
  });
  it('汉字月表两端同序同值(长名在前，否则「十一月」被切成十+一月)', () => {
    const table = (p: string) => (read(p).match(/CN_MONTHS[^=]*= \{(.*)\}/)?.[1] ?? '').replace(/["' ]/g, '');
    const s = table('server/chat.mjs');
    expect(table('client/src/data/chatEngine.ts')).toBe(s);
    // 判据取自真正决定匹配顺序的那份候选串：十一/十二 必须排在单字 `[一二…十]` 之前。
    // 注意用 indexOf 比较位置，别拿正则去匹配这段「本身就是正则片段」的字符串。
    const alt = grabStr(read('server/chat.mjs'), 'CN_MONTH_ALT');
    expect(alt.indexOf('十一')).toBeGreaterThanOrEqual(0);
    expect(alt.indexOf('十二')).toBeGreaterThan(alt.indexOf('十一'));
    expect(alt.indexOf('[一')).toBeGreaterThan(alt.indexOf('十二'));
    expect(s).toContain('十一:11');
    expect(s).toContain('十二:12');
  });
});
