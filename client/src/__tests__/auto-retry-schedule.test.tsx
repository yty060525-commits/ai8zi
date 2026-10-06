import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PersonDetail } from '../features/person/PersonDetail';
import { initializeMockSession, listBaziRecords, resetMockSession } from '../data/clientRepository';
import type { BaziRecord } from '../types/domain';

/* 「分析失败后的全自动重试」这条钱袋子路径此前无任何界面判据。
   全仓只在编排器层测过「任务级自动重试」(orchestration.test.ts)，而详情页这套
   「整盘失败 → 十二秒后再跑、最多两次、密钥类不盲试、可取消」的调度器(scheduleAutoRetry)没人钉过。
   它的代价是真金白银 —— 少一次上限判断就可能对着余额不足连烧请求，所以单独成文件。

   ⚠ 取证(jsdom，桩即时 resolve，2026-10-06)：一轮完整批断在测试里要 ~14–16s(23 槽位 × 首试+补跑 ≈ 92 次调用)，
      且**只有真跑完一轮、saved.aiStatus==='failed' 时才会排自动重试**(读的是 saved.aiError)。
      「首轮失败、之后成功」的桩在这里不可用：编排器的补跑(REPAIR_RETRIES)会把失败任务重跑成成功，
      整轮照样落 completed ⇒ scheduleAutoRetry 根本不触发。所以下面一律用**恒失败桩**，
      判据改为数 analyzeBazi 的调用总数(每多一批请求＝多发起一轮)，而不是看最终状态。 */

vi.mock('../data/deepseekAdapter', () => ({ analyzeBazi: vi.fn(), beginAiSession: vi.fn(), cancelAiSession: () => {} }));
import { analyzeBazi } from '../data/deepseekAdapter';

const ID = 'retry-person';
const RETRY_MSG = '网络超时，请求未完成';        // 命中 isRetryableFailure 的 TRANSIENT_RE ⇒ 值得再试
const KEY_MSG = '未配置访问凭据(not_configured)'; // 命中 not_configured 分支 ⇒ 不该盲试
const HINT_RE = /将在十二秒后自动重新分析/;

const record = (aiStatus: BaziRecord['aiStatus']): BaziRecord => ({
  id: ID, name: '重试盘', gender: 'male', birthYear: 1984, birthMonth: 2,
  createdAt: '2025-03-08T12:34:56.000Z', yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午',
  aiStatus, toneUsed: 80,
} as unknown as BaziRecord);

const okAnalysis = { pattern: '正格', strength: '', usefulElements: ['木'], avoidElements: [], explanation: '【身强身弱与喜忌】旺\n【健康】可\n【事业】顺\n【财运】平\n【爱情】稳' };
const doneResult = { status: 'completed', analysis: okAnalysis };

beforeEach(() => { localStorage.removeItem('pref.' + ID); localStorage.removeItem('ran.' + ID); });
afterEach(() => { cleanup(); resetMockSession(); vi.restoreAllMocks(); try { localStorage.clear(); } catch { /* jsdom 可能禁用 storage */ } });

async function seed() {
  const person = [{ id: ID, name: '重试盘', nameInitial: 'J', gender: 'male' as const, birthSummary: 'x' }];
  initializeMockSession(person, [{ person: person[0], record: structuredClone(record('not_started')), aiAnalysis: { status: 'not_started' } }]);
  render(<PersonDetail personId={ID} onBack={vi.fn()} />);
  await screen.findByRole('button', { name: '批断分析' });
}

/** 步进式等待：每步推进真实宏任务并回报当前界面是否已出现某状态，避免固定 sleep 猜时间。
 *  ⚠ 一轮完整批断在测试里要 ~16–18s(见文末取证)，maxMs 必须留出这之后的余量，否则等不到排期就超时。 */
async function waitUntil(pred: () => boolean, stepMs = 500, maxMs = 30000): Promise<boolean> {
  for (let t = 0; t <= maxMs; t += stepMs) {
    if (pred()) return true;
    await act(async () => { await new Promise((r) => setTimeout(r, stepMs)); });
  }
  return pred();
}

describe('分析失败后的全自动重试(最多两次 / 密钥类不盲试 / 可取消)', () => {
  /* 桩「恒失败」：每一轮(含补跑)都落 failed，saved.aiStatus==='failed'、saved.aiError=RETRY_MSG ⇒ 排自动重试。
     上限判据靠**数 analyzeBazi 调用总数**：手动轮发一批，第一次自动轮再发一批，第二次自动轮再发一批；
     用完两次额度后第三轮不许发起 ⇒ 调用总数封顶在三轮。把 scheduleAutoRetry 的上限从 2 改大就会多出第四批。 */
  it('失败后自动排期重试：提示给出次数与「共两次」，并有取消入口', async () => {
    vi.mocked(analyzeBazi).mockResolvedValue({ status: 'failed', error: RETRY_MSG } as never);
    await seed();
    fireEvent.click(screen.getByRole('button', { name: '批断分析' }));
    const shown = await waitUntil(() => !!screen.queryByRole('button', { name: '取消自动重试' }), 500, 30000);
    expect(shown, '手动那一轮失败后应排自动重试并显示取消入口').toBe(true);
    const hint = screen.getByText(HINT_RE);
    expect(hint.textContent, '自动重试提示该写明是第几次、共几次').toContain('这是第一');
    expect(hint.textContent).toContain('共两次');
  }, 45000);

  it('密钥类失败不盲试：不落排期、无取消入口(saved.aiError 非可重试即早退)', async () => {
    vi.mocked(analyzeBazi).mockResolvedValue({ status: 'failed', error: KEY_MSG } as never);
    await seed();
    fireEvent.click(screen.getByRole('button', { name: '批断分析' }));
    // 等这一轮真跑完(saved=failed)，确认它没有把密钥类失败当成可重试去排下一次。
    let settled = false;
    for (let t = 0; t <= 20000 && !settled; t += 500) {
      const s = (await listBaziRecords()).find((x) => x.id === ID);
      if (s?.aiStatus === 'failed') settled = true;
      else await act(async () => { await new Promise((r) => setTimeout(r, 500)); });
    }
    expect(settled, '这一轮应以 failed 收尾').toBe(true);
    expect(screen.queryByText(HINT_RE), '密钥类失败不该排自动重试').toBeNull();
    expect(screen.queryByRole('button', { name: '取消自动重试' })).toBeNull();
  }, 30000);

  it('点「取消自动重试」后到点不再自动再跑(clearTimeout 真生效)', async () => {
    vi.mocked(analyzeBazi).mockResolvedValue({ status: 'failed', error: RETRY_MSG } as never);
    await seed();
    fireEvent.click(screen.getByRole('button', { name: '批断分析' }));
    const ready = await waitUntil(() => !!screen.queryByRole('button', { name: '取消自动重试' }), 500, 30000);
    expect(ready, '先让重试排起来才有东西可取消').toBe(true);
    const callsAtCancel = vi.mocked(analyzeBazi).mock.calls.length;
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '取消自动重试' })); });
    await act(async () => { await new Promise((r) => setTimeout(r, 14000)); });
    expect(vi.mocked(analyzeBazi).mock.calls.length, '取消后仍到点重跑 → clearTimeout 没生效').toBe(callsAtCancel);
  }, 45000);

  /* 核心钱袋子判据：自动重试上限=2。桩「恒失败」时每一轮都以 failed 收尾，所以只要还在排期，
     就会一轮接一轮地烧请求 —— 正常应当是「手动轮 + 自动一 + 自动二」共三批发完后彻底停手。
     判据取**每批的调用总数快照**：两次放行(+14s)后必须仍在增长(证明确实在重试)，再多等一个完整周期
     (超过十二秒排期点)后必须一口都不再增加。把 scheduleAutoRetry 的上限从 2 抬到 ≥3，就会多出第四批 ⇒ 红。 */
  it('自动重试最多两次：不会发起第三轮(把上限改大就会多烧一轮)', async () => {
    vi.mocked(analyzeBazi).mockResolvedValue({ status: 'failed', error: RETRY_MSG } as never);
    const calls = () => vi.mocked(analyzeBazi).mock.calls.length;
    /** 本轮任务数(含占位)：进度条 aria-valuemax —— 一轮批断「该发多少请求」的地面真值。 */
    const roundTotal = () => Number(screen.getByRole('progressbar').getAttribute('aria-valuemax'));
    await seed();
    fireEvent.click(screen.getByRole('button', { name: '批断分析' }));
    // 起跑第一帧就把分母读出来存住：它等于 expectedIds.length + 2，是这一轮队列的确定值。
    const total = roundTotal();
    expect(total, '进度条分母应是本轮队列+占位').toBeGreaterThan(1);
    // 手动那一轮失败 → 排第一次自动重试。
    expect(await waitUntil(() => !!screen.queryByRole('button', { name: '取消自动重试' }), 500, 30000), '应先排第一次自动重试').toBe(true);
    const manualRound = calls();
    expect(manualRound, '手动那一轮应把整条队列发完(≥分母)').toBeGreaterThanOrEqual(total);
    // 放行第一次自动重试(+12s 起跑、整轮 ~16s)。
    await act(async () => { await new Promise((r) => setTimeout(r, 17000)); });
    await waitUntil(() => !!screen.queryByRole('button', { name: '取消自动重试' }), 500, 30000);
    const afterAuto1 = calls();
    expect(afterAuto1 - manualRound, '第一次自动重试没发起(前置条件不成立，后面无从判上限)').toBeGreaterThanOrEqual(total);
    // 放行第二次自动重试。
    await act(async () => { await new Promise((r) => setTimeout(r, 17000)); });
    await waitUntil(() => !!screen.queryByRole('button', { name: '取消自动重试' }), 500, 30000);
    const afterAuto2 = calls();
    expect(afterAuto2 - afterAuto1, '第二次自动重试没发起(前置条件不成立，后面无从判上限)').toBeGreaterThanOrEqual(total);
    // 额度用尽：再多等一整个周期(远超十二秒排期点)，也不许再发起第三轮。
    await act(async () => { await new Promise((r) => setTimeout(r, 26000)); });
    expect(calls(), '自动重试超过两次 → 上限失效，正在无脑烧请求').toBe(afterAuto2);
    // 额度用尽后 scheduleAutoRetry 早退 ⇒ 排期状态(autoWaiting)也必须一并清掉。
    // 只 return 不 setAutoWaiting(false) 的话，按钮会挂着「取消」的空壳直到下一次失败才被覆盖。
    expect(screen.queryByRole('button', { name: '取消自动重试' }),
      '额度耗尽后仍留着「取消自动重试」→ autoWaiting 没随早退清除').toBeNull();
    // 反向钉子（同类缺陷的另一半）：自动重跑必须**保留**已用额度。若定时器回调把自动轮当手动轮去调
    // requestAnalysis(rec)，`if (!_auto)` 会把计数清零 ⇒ 十二秒后无限重试，而且界面上永远显示「这是第一次」。
    // 此刻调用总数已经封顶，所以任何再现的按钮都只能来自那次错误的重置。
    await act(async () => { await new Promise((r) => setTimeout(r, 30000)); });
    expect(calls(), '封顶后又开始发请求 → 自动轮把额度当成手动轮重置了(无限重试)').toBe(afterAuto2);
    expect(screen.queryByRole('button', { name: '取消自动重试' }),
      '自动轮被当成手动轮 → 每次自动重跑都把额度清零，永远不会用完(无脑烧请求)').toBeNull();
  }, 300000);

  /* 「两次」是**每一回手动批断**的额度，不是这条盘一生的额度：requestAnalysis 里 `if (!_auto) autoRetryCountRef.current = 0;`
     就是那句重置。删掉它之后，第二次手动批断失败排的是「第二/共两次」而不是「第一/共两次」，第三次干脆不排 —— 
     文案型判据杀不掉它吗？杀得掉，但前提是这一轮**必须落 failed**，所以下面用「每轮前四分之三失败、收尾成功」的桩：
     整轮 aiStatus==='failed' ⇒ 一定排期；最后几条成功 ⇒ 下一轮复用缓存，只发前半截请求(调用数是确定值)。
     实测取证(jsdom，2026-10-06)：首轮 49 次调用(队列 23 + 逐任务再试 23 + 补跑 3)，第二轮复用后仅 3 次。
     于是「按钮再现」＝「新一轮真的发起了」，而提示里的次数读数只能由 scheduleAutoRetry 的重置决定。 */
  it('手动再点一次批断：重试额度重新计（两次是每次的额度，不是一生的）', async () => {
    /** 桩：本轮内第 n 次调用，前 ⌈n*0.75⌉ 次失败、其余成功 ⇒ 本轮落 failed 并排期，尾部任务留作下轮缓存。 */
    let n = 0;
    vi.mocked(analyzeBazi).mockImplementation(() => {
      n += 1;
      const fail = (n % 49) !== 0 && ((n - 1) % 49) < 37;
      return Promise.resolve((fail ? { status: 'failed', error: RETRY_MSG } : doneResult) as never);
    });
    const calls = () => vi.mocked(analyzeBazi).mock.calls.length;
    const waitScheduled = () => waitUntil(() => !!screen.queryByRole('button', { name: '取消自动重试' }), 500, 30000);
    const hintNow = () => screen.getByText(HINT_RE).textContent ?? '';

    await seed();
    // 第一次手动批断 → 失败排期：额度刚起算，该写「这是第一次，共两次」。
    fireEvent.click(screen.getByRole('button', { name: '批断分析' }));
    expect(await waitScheduled(), '第一次手动批断失败后应排自动重试').toBe(true);
    expect(hintNow(), '首轮排期提示应写明这是第一次').toContain('这是第一');
    expect(calls(), '第一轮应把整条队列连补跑都发出去').toBeGreaterThanOrEqual(40);
    const afterManual1 = calls();
    // 不放行自动轮，直接手动重开 —— requestAnalysis 会先 cancelAutoRetry() 再按 _auto=false 重置额度。
    fireEvent.click(screen.getByRole('button', { name: '批断分析' }));
    expect(await waitScheduled(), '第二次手动批断失败后应再次排期(额度没被上一轮吃掉)').toBe(true);
    expect(calls(), '第二次手动批断确实又发了请求(否则下面的次数读数只是上轮残留)').toBeGreaterThan(afterManual1);
    // 核心钉子：手动重开是一次**新的**批断，次数必须回到「第一」；没重置就报成「第二」。
    expect(hintNow(), '手动重开没重置重试额度 → 第二次就报成最后一次，第三次干脆不试了').toContain('这是第一');
    expect(hintNow()).not.toContain('这是第二');
  }, 120000);
});
