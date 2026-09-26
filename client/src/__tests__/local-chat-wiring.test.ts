import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BaziRecord } from '../types/domain';
import { calculateNonAi } from '../features/chart/nonAiCalculator';
import { askChat, analyzeQuestion, localChatAnswerFor, shouldUseLocalChat } from '../data/chatEngine';
import { listBaziRecords } from '../data/clientRepository';
import { isServerMode, serverFetch } from '../data/serverClient';
import { chatDirect } from '../data/deepseekAdapter';
import { unlockLocalSystem, resetLocalSystemForTests, markLocalChartHydrated, localChartNeedsHydrate } from '../data/localSystem';

/* =============================================================================
 * 对话 A 层的**接线与闸门**（chatEngine 侧）。
 * 与 local-chat.test.ts 的分工：那边钉「拼出来的话对不对」，这边钉「这条路真的被走到、
 * 且只在开通时走到」。删掉 askChat 里那两行接线，这边必须红 —— 所以判据读的是
 * `localChatAnswerFor` 这个导出入口的调用次数与入参（同 orchestration.test.ts 那条的模式）。
 * ========================================================================== */
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('../data/serverClient', () => ({
  isServerMode: vi.fn(() => false),
  serverFetch: vi.fn(),
  ServerError: class ServerError extends Error { status: number; constructor(s: number, m: string) { super(m); this.status = s; } },
}));
vi.mock('../data/clientRepository', () => ({
  listBaziRecords: vi.fn(async () => []),
  hydrateRecord: vi.fn(async (r: unknown) => r),
  unsyncedRecordIds: vi.fn(() => []),
}));
vi.mock('../data/deepseekAdapter', () => ({
  chatDirect: vi.fn(async () => ({ status: 'not_configured', error: '未配置凭据' })),
  toneInstructionText: (t: number) => '语气(' + t + ')',
}));

const NOW = new Date('2026-09-26T06:00:00Z');

/** 一条「瘦身存储里的样子」：时段数组清空、批断正文**一条都没有**。
 *  ⚠ 两个条件缺一不可，H1 变异（不补算直接取话）才杀得掉：
 *     · 数组为空 ⇒ 未补算时 `findAnnual(2027)` 找不到该年事实；
 *     · 正文为空 ⇒ 未补算时压根无话可引。
 *  上一版在这里预置了本命 + 2026 年两条正文，于是问「今年事业运」**带着旧正文也答得对**，
 *  判据退化成「任务号对不对」而不再是「补没补算」—— H1 删掉 `ensureLocalChartComplete` 全绿存活就是这么来的。 */
function slimRecord(): BaziRecord {
  const pillars = { yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午' };
  const full = calculateNonAi({ birthYear: 1984, birthMonth: 2, ...pillars }, 'male', NOW.toISOString());
  return {
    id: 'r-slim', name: '测试甲', gender: 'male', birthYear: 1984, birthMonth: 2, createdAt: NOW.toISOString(),
    ...pillars, aiStatus: 'not_started', aiTasks: {},
    nonAiResult: { ...full, greatFortunes: [], annualFortunes: [], monthlyFortunes: [], decadeSlots: 0 },
  } as unknown as BaziRecord;
}

/** 机主真的点过「生成本地批断」之后的样子：走**编排器那一路**（补算 → 逐任务喂规则引擎），
 *  而不是在测试里手搓 aiTasks —— 手搓会把「任务号从哪来」变成测试自己的假设。
 *  ⚠ 必须先开通再跑：`ensureLocalChartComplete` 对未开通的人原样返回，于是时段数组仍是空的。 */
async function chartWithLocalAnalyses(): Promise<BaziRecord> {
  expect(unlockLocalSystem('mingli-local-2026')).toBe(true);
  const orch = await import('../data/baziOrchestrator');
  return orch.orchestrateBaziAnalysis(slimRecord(), undefined, undefined, { local: true, now: NOW });
}

afterEach(() => {
  vi.clearAllMocks();
  resetLocalSystemForTests();
  vi.mocked(isServerMode).mockReturnValue(false);
  vi.mocked(listBaziRecords).mockResolvedValue([] as never);
});

describe('对话 A 层接线：已开通才走本机，未开通零痕迹', () => {
  it('未开通本地系统 → 一次都不进本机问答，也不做补算；照旧落到原有通道', async () => {
    const orch = await import('../data/chatEngine');
    const seen: unknown[] = [];
    const spy = vi.spyOn(orch, 'localChatAnswerFor').mockImplementation(async (input: any) => { seen.push(input.question); return null; });
    try {
      vi.mocked(listBaziRecords).mockResolvedValue([slimRecord()] as never);
      const reply = await askChat({ question: '喜用五行是什么', history: [] });
      expect(seen.length, '未开通的人不该走本机这一路').toBe(0);
      expect(shouldUseLocalChat()).toBe(false);
      expect(reply.status).toBe('not_configured');   // 原路径的报错形态没被改写
    } finally { spy.mockRestore(); }
  });

  it('已开通 → 走本机并直接给出答案，不触网、不调任何云端通道', async () => {
    expect(unlockLocalSystem('mingli-local-2026')).toBe(true);       // 界面上唯一的开通方式：地址栏那条
    const orch = await import('../data/chatEngine');
    const real = orch.localChatAnswerFor;
    const calls: Array<{ hasPlan: boolean; recordId: string }> = [];
    const spy = vi.spyOn(orch, 'localChatAnswerFor').mockImplementation(async (input: any) => {
      calls.push({ hasPlan: !!input.plan, recordId: String(input.record.id) });
      return real(input);
    });
    try {
      vi.mocked(listBaziRecords).mockResolvedValue([await chartWithLocalAnalyses()] as never);
      const reply = await askChat({ question: '今年事业运如何', history: [] });
      expect(calls.length, 'runner 一次都没走本机问答入口 ⇒ 接线被删了').toBeGreaterThan(0);
      expect(calls[0].hasPlan).toBe(true);
      expect(reply.status).toBe('completed');
      expect(reply.answer).toContain('2026年');
      expect(serverFetch).not.toHaveBeenCalled();     // 不触网
      expect(chatDirect).not.toHaveBeenCalled();      // 不调模型
      expect(reply.evidence?.personName).toBe('测试甲');
    } finally { spy.mockRestore(); }
  });

  /* 「补算」这件事分两层，别混成一条用例：
       ① 排盘时段数组（大运/流年/流月）—— 由 `ensureLocalChartComplete` 现算补回；
       ② 各篇批断正文 —— **补算不会生成正文**，正文只有点过「生成本地批断」才有。
     上一版把标题写成「否则时段问题答不出具体年份」，其实测的是①；而删掉补算那行的 H1 变异之所以存活，
     是因为 fixture 里预置了 2026 年正文 ⇒ 问「今年事业运」不补算也答得出。所以这里刻意问一个
     **未补算时压根不存在**的时段（明年三月 = 2027年3月，瘦身的 monthlyFortunes 里没有它），
     并把「退路是老实说缺」一起钉住：既证明①跑了，也证明取不到话时不硬凑。 */
  it('本机这一路会先把瘦身盘的时段事实补算一次（未补算就没有 2027年3月 可答）', async () => {
    expect(unlockLocalSystem('mingli-local-2026')).toBe(true);
    const record = slimRecord();
    resetLocalSystemForTests();                        // 只留解锁标记带来的判据：台账单独清
    unlockLocalSystem('mingli-local-2026');
    markLocalChartHydrated(record.id);                 // 记上「这台设备补算过」⇒ 之后不再需要补算
    expect(JSON.stringify((record.nonAiResult as any).annualFortunes)).toBe('[]');
    const question = '明年三月要注意什么';
    const data = await localChatAnswerFor({ record, plan: analyzeQuestion(question, [record], NOW), question, history: [] });
    /* 判据读的是**函数返回的记录**而不是入参：ensureLocalChartComplete 不改入参（F 变异专门测这点）。 */
    expect(data).toBeTruthy();
    expect(data!.answer).toContain('2027年3月');
    expect(localChartNeedsHydrate(record.id)).toBe(false);
  });

  /** ②那一层：一条从没生成过批断的瘦身盘，问到具体某一年时必须如实说缺，而不是拿别的年份凑。 */
  it('补算只补排盘事实、不造批断正文：没算过的年份如实说缺', async () => {
    expect(unlockLocalSystem('mingli-local-2026')).toBe(true);
    const record = slimRecord();
    const question = '2035年事业运如何';                // 补算后这一年有干支，但本设备上没人算过它的正文
    const data = await localChatAnswerFor({ record, plan: analyzeQuestion(question, [record], NOW), question, history: [] });
    expect(data).toBeTruthy();
    expect(data!.answer).toContain('还没有');
    expect(data!.answer).toContain('2035');
    expect(data!.missing.length).toBeGreaterThan(0);
    expect(data!.sources).toEqual([]);                  // 一条证据都没引用，回执里不许假装有
  });

  it('组不出答案（如纯语气词追问）→ 落回原有通道，不硬凑', async () => {
    expect(unlockLocalSystem('mingli-local-2026')).toBe(true);
    vi.mocked(listBaziRecords).mockResolvedValue([slimRecord()] as never);
    const reply = await askChat({ question: '呢', history: [] });
    expect(reply.status).not.toBe('completed');        // 交回原路径 ⇒ 未配置/失败形态
    expect(chatDirect).toHaveBeenCalled();
  });

  it('多条命盘且本轮没点名字 → 不猜命主，仍由原路径给选择列表', async () => {
    expect(unlockLocalSystem('mingli-local-2026')).toBe(true);
    const a = slimRecord();
    const b = { ...a, id: 'r-other', name: '测试乙' } as BaziRecord;
    vi.mocked(listBaziRecords).mockResolvedValue([a, b] as never);
    const reply = await askChat({ question: '今年事业运如何', history: [] });
    expect(reply.status).toBe('need_record');          // 不是本机答案
    expect(reply.evidence?.options?.map((o) => o.name)).toEqual(['测试甲', '测试乙']);
  });

  it('回答末尾如实标注来源与「不联网、不消耗额度」', async () => {
    expect(unlockLocalSystem('mingli-local-2026')).toBe(true);
    /* ⚠ 这里必须用**有正文**的盘：缺口回执那句写的是「本机只做取用，不替你推测」，压根不含
       「本机规则回答」这几个字 ⇒ 拿空盘测这句承诺会得到一条假绿（实测踩过）。 */
    vi.mocked(listBaziRecords).mockResolvedValue([await chartWithLocalAnalyses()] as never);
    const reply = await askChat({ question: '喜用五行是什么', history: [] });
    expect(reply.answer).toContain('本机规则回答');
    expect(reply.answer).toContain('不联网、不调模型、不消耗额度');
    expect(reply.answer).not.toMatch(/[A-Za-z]/);      // 清洗后仍不得出现拉丁字母
  });
});
