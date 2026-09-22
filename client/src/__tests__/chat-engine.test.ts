import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BaziRecord } from '../types/domain';
import { analyzeQuestion, buildChatMessages, buildEvidence, buildPeriodFacts, extractWhen, sliceSections, askChat } from '../data/chatEngine';
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
  it('buildChatMessages：system 在最前，历史最多 8 条，尾块含证据与问题', () => {
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
  it('主题标签集合一致', async () => {
    const serverTopics = [...read('server/chat.mjs').matchAll(/topic: '([^']+)'/g)].map((m) => m[1]);
    const { TOPIC_RULES } = await import('../data/chatEngine');
    expect(TOPIC_RULES.map((r) => r.topic)).toEqual(serverTopics);
  });
});
