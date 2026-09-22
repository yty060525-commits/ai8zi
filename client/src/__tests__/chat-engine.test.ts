import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BaziRecord } from '../types/domain';
import { analyzeQuestion, applyFollowUp, buildChatMessages, buildEvidence, buildPeriodFacts, extractWhen, sliceSections, askChat, SCAN_YEARS } from '../data/chatEngine';
import { isServerMode, serverFetch, ServerError } from '../data/serverClient';
import { listBaziRecords } from '../data/clientRepository';
import { chatDirect } from '../data/deepseekAdapter';

/* 三通道共用的提问解析/证据组装(与服务端 chat.mjs 同口径)的单元测试。 */
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('../data/serverClient', () => ({
  isServerMode: vi.fn(() => false),
  serverFetch: vi.fn(),
  ServerError: class ServerError extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } },
}));
vi.mock('../data/clientRepository', () => ({ listBaziRecords: vi.fn(async () => []) }));
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
});

describe('证据组装(查本地库)', () => {
  it('sliceSections 只留提问主题小节', () => {
    const out = sliceSections('【健康】1. a\n【事业】2. b', ['健康']);
    expect(out).toContain('【健康】');
    expect(out).not.toContain('【事业】');
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
    const BANNED = ['patternFacts', 'strengthScore', 'dayMaster', 'elementRatio', 'hiddenStems', 'tenGods', 'shenSha', 'periodFacts', 'analyses', 'missing', 'natal', 'plan'];
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
});
