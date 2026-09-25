import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PersonDetail } from '../features/person/PersonDetail';
import { SettingsPage } from '../features/settings/SettingsPage';
import { getBaziRecord, initializeMockSession, listBaziRecords, resetMockSession, saveBaziRecord } from '../data/clientRepository';
import { isOfflineMode, resetAiSettingsForTests } from '../data/aiSettings';
import { isLocalSystemEnabled, isLocalSystemUnlocked, hideLocalSystem, resetLocalSystemForTests, setLocalSystemEnabled, unlockLocalSystem } from '../data/localSystem';
import type { BaziRecord, BaziTaskResult } from '../types/domain';
import { calculateNonAi } from '../features/chart/nonAiCalculator';
import '../features/chart/nonAiCalculator'; // 预载引擎(缓存)，让页面内的按需加载立即命中
import { App } from '../App';
import { canBuildLocalAnalysis } from '../data/localSystem';

import { invoke } from '@tauri-apps/api/core';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
const notConfigured = { selectedProvider: 'deepseek', deepseek: 'not_configured', kimi: 'not_configured', qwen: 'not_configured' };
vi.mocked(invoke).mockImplementation(async (command) => command === 'get_ai_provider_status' ? notConfigured : 'not_configured');

/* 这一组盯的是**设计层**的不变量，不是某个按钮：本地系统的三个标记都是本机各管各的、
   绝不上行；而 `record.aiTasks[].source` 是唯一会同步的那一个。两者一旦混用就会出现
   「这台设备关了本地系统，那台设备的批断却跟着变了」这类跨设备串味的问题。 */

const KEY = 'mingli-local-2026';

/** 编排器的可替换桩：`vi.mock` 工厂只转发到这里，用例随时换上新函数。 */
type OrchStub = ((...args: unknown[]) => Promise<BaziRecord>) & { mock: { calls: unknown[][] } };
/** 取本轮**发射点**的 options：按「最后一个带 local 键的对象」找，而不是写死下标 ——
 *  参数个数一变(如多传一个回调)下标就指错，测试会退化成恒真的空断言。 */
const optionsOf = (call: unknown[]) => call.find((a) => a && typeof a === 'object' && 'local' in (a as object)) as { local?: boolean };
const ORCH_STUB: { holder: { fn?: OrchStub } } = { holder: {} };
/** 中途冻结用例收集**发射点**的 options.local：每调一次编排 push 一条。 */
const seen: boolean[] = [];
const orchestrateSpy = () => (ORCH_STUB.holder.fn ??= vi.fn(async () => { throw new Error('stop-here'); }) as unknown as OrchStub);
const person = { id: 'p1', name: '设计测试', nameInitial: 'S', gender: 'male' as const, birthSummary: '甲子年' };

const task = (taskId: string, source: 'cloud' | 'local' | undefined): BaziTaskResult => ({
  task: { taskId, type: 'baseline' },
  status: 'completed',
  analysis: { pattern: '', strength: '', usefulElements: [], avoidElements: [], explanation: `【健康】${source ?? '缺省'}来源正文` },
  ...(source ? { source } : {}),
});

const mk = (over: Partial<BaziRecord> = {}): BaziRecord => ({
  id: 'p1', name: '设计测试', gender: 'male', birthYear: 1990, birthMonth: 1,
  createdAt: '2025-01-01T00:00:00.000Z', yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午',
  aiStatus: 'completed', aiTasks: {}, ...over,
});

const seed = async (record: BaziRecord) => {
  initializeMockSession([person], [{ person, record, aiAnalysis: { status: 'completed', result: 'x' } }]);
  return record;
};

/** 页面上摆出来的全部文字。⚠ 别用 `document.body.innerText`：jsdom 没实现它，读回来是
 *  undefined，于是任何字符串判据都变成「undefined 与 string」的无效比较（实测踩过）。 */
const baseText = () => document.body.textContent ?? '';

/** 打开「已开通 + 已勾选」的本地系统：走真实写入口，不手搓键名。 */
const turnLocalSystemOn = () => {
  unlockLocalSystem(KEY);
  setLocalSystemEnabled(true);
};

beforeEach(() => { resetAiSettingsForTests(); resetLocalSystemForTests(); });
afterEach(() => { cleanup(); resetMockSession(); resetAiSettingsForTests(); resetLocalSystemForTests(); });

describe('详情页 · 生成方式标注与本机开关的一致性', () => {
  it('开着本地系统进详情页：顶部说明指向「设置页取消勾选」，而不是让人猜', async () => {
    await seed(mk({ nonAiResult: undefined, aiTasks: { 'task-01': task('task-01', 'local') } }));
    turnLocalSystemOn();
    expect(isLocalSystemEnabled()).toBe(true);
    render(<PersonDetail personId="p1" onBack={vi.fn()} />);
    await screen.findByRole('heading', { name: '人物详情' });
    const note = await screen.findByText(/当前为本地系统/);
    // 这句话必须真的能兑现：设置页上确实有那个勾选框(除非用户自己把它藏了)。
    expect(note.textContent).toContain('设置页');
  });

  it('本机开关是纯本机的：写进 record 的只有 source，三个 mingli.local/offline 标记都不上行', async () => {
    await seed(mk({ aiTasks: { 'task-01': task('task-01', 'local') } }));
    turnLocalSystemOn();
    render(<PersonDetail personId="p1" onBack={vi.fn()} />);
    await screen.findByRole('heading', { name: '人物详情' });
    const saved = await listBaziRecords();
    const text = JSON.stringify(saved.find((r) => r.id === 'p1'));
    expect(text, 'record 里不该出现本机开关的键名').not.toContain('mingli.');
    expect(text).not.toContain('"offline"');
    // 反向钉子：source 确实是要同步的那一个，否则上面两条否定式是空断言。
    expect(text).toContain('"source":"local"');
  });

  it('云端模式下存着 local 结果：说明句要提示「点 AI 分析会用云端重算覆盖」（可兑现的动作）', async () => {
    await seed(mk({ aiTasks: { 'task-01': task('task-01', 'local') } }));
    // 已开通但没勾选 ⇒ 走云端；这是最容易让人以为"还在本地跑"的组合。
    unlockLocalSystem(KEY);
    expect(isLocalSystemEnabled()).toBe(false);
    render(<PersonDetail personId="p1" onBack={vi.fn()} />);
    await screen.findByRole('heading', { name: '人物详情' });
    const note = await screen.findByText(/上次本地系统批断的结果/);
    expect(note.textContent).toContain('重算');
    expect(screen.queryByText(/当前为本地系统/), '没勾选就不该说现在是本地系统').toBeNull();
  });

  it('关起来后不留「关不掉」的状态：本机标记归零，且不会再声称正在用本地系统', async () => {
    await seed(mk({ aiTasks: { 'task-01': task('task-01', 'local') } }));
    turnLocalSystemOn();
    render(<PersonDetail personId="p1" onBack={vi.fn()} />);
    await screen.findByRole('heading', { name: '人物详情' });
    expect(isLocalSystemEnabled()).toBe(true);
    // 「关起来」走 localSystem 的写入口（设置页那颗按钮就是它），不在测试里手搓键名。
    hideLocalSystem();
    expect(isLocalSystemEnabled()).toBe(false);
    expect(isOfflineMode()).toBe(false);
    // 重新进入详情页：它每次现算一次，所以不会拿着旧的「本地系统」横幅不放。
    cleanup();
    render(<PersonDetail personId='p1' onBack={vi.fn()} />);
    await screen.findByRole('heading', { name: '人物详情' });
    expect(screen.queryByText(/当前为本地系统/)).toBeNull();
  });

  /* 残留数据也不许说话。上一版「上次本地系统批断的结果」那句只看 aiTasks 里有没有 local 结果，
     于是出现这种泄漏：机主在这台设备上跑过一次本地批断、又关起来，此后**任何**打开这条记录的人
     （换设备、别人看同一条）都会在详情页看见一句提到第四路的话 —— 界面上藏得再干净也白藏。
     现在它和横幅一样受「已开通」约束；而「已开通但没勾选」仍要说（见上面那条用例），不是恒关。 */
  it('关起来后残留的 local 结果也不再对陌生人提第四路', async () => {
    await seed(mk({ aiTasks: { 'task-01': task('task-01', 'local') } }));
    turnLocalSystemOn();
    hideLocalSystem();
    // 正向钉子：数据确实还在 record 里（同步上去的 source:'local' 没被清掉），
    // 否则下面这句「不显示」会因为前提没了而恒真。
    const saved = await listBaziRecords();
    expect(JSON.stringify(saved.find((r) => r.id === 'p1'))).toContain('"source":"local"');
    cleanup();
    render(<PersonDetail personId='p1' onBack={vi.fn()} />);
    await screen.findByRole('heading', { name: '人物详情' });
    expect(screen.queryByText(/上次本地系统批断的结果/), '未开通的人不该看见这句话').toBeNull();
    // 绿点本身可以留（它只是个记号），但 hover / 无障碍名不许再报出「第四路」这种来历。
    const dot = document.querySelector('.local-dot');
    expect(dot, '正向钉子：本机结果确实带着绿点，否则下面两条否定式是空断言').toBeTruthy();
    expect(dot?.getAttribute('title')).not.toMatch(/本地|第四路/);
    expect(dot?.getAttribute('aria-label')).not.toMatch(/本地|第四路/);
    expect(screen.getByRole('heading', { name: '人物详情' })).toBeTruthy();
  });

  it('关起来走真实入口（设置页那颗按钮），而不是手删 localStorage', async () => {
    // 上一版这条用例是**假覆盖**：它自己把三个键 removeItem 掉，等于替被测代码做完了工作，
    // 于是「hideLocalSystem 只清标记不关开关」这个变异照样全绿。判据必须驱动真实路径。
    await seed(mk({ aiTasks: { 'task-01': task('task-01', 'local') } }));
    unlockLocalSystem(KEY);
    setLocalSystemEnabled(true);
    expect(isLocalSystemEnabled()).toBe(true);
    render(<SettingsPage />);
    fireEvent.click(screen.getByRole('button', { name: /关起来/ }));
    // 撤销后勾选框与撤销按钮一起收回，只剩常驻的密钥框（判据问的是**控件**，不是整节标题）。
    await waitFor(() => expect(screen.queryByRole('checkbox', { name: /使用本地系统/ })).toBeNull());
    expect(screen.queryByRole('button', { name: /关起来/ })).toBeNull();
    expect(isLocalSystemUnlocked(), '开通标记该清掉').toBe(false);
    expect(isOfflineMode(), '底层开关必须被一起关掉 —— 否则本地引擎还在接管却没地方关').toBe(false);
    expect(isLocalSystemEnabled()).toBe(false);
    // 详情页重进后不再声称正在用本地系统
    cleanup();
    render(<PersonDetail personId="p1" onBack={vi.fn()} />);
    await screen.findByRole('heading', { name: '人物详情' });
    expect(screen.queryByText(/当前为本地系统/)).toBeNull();
  });

  it('未开通时界面上零痕迹，且库里有本机结果也不代表它在接管', async () => {
    await seed(mk({ aiTasks: { 'task-01': task('task-01', 'local') } }));
    // 未展开 + 没勾选：设置页上连「本地系统」四个字都不该出现（展开走地址栏）。
    expect(unlockLocalSystem(KEY), '解锁码不对，前提没成立').toBe(true);
    hideLocalSystem();
    expect(isLocalSystemUnlocked(), '前提：本机回到未开通').toBe(false);
    const { container } = render(<SettingsPage />);
    expect(container.textContent).not.toContain('本地系统');
    expect(screen.queryByLabelText('本地系统密钥'), '密钥框也已经撤掉').toBeNull();
    expect(screen.queryByRole('checkbox', { name: /使用本地系统/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /关起来/ })).toBeNull();
    cleanup();
    // 正例钉子：本机没勾着的时候，详情页不许声称正在用本地系统 —— 即使库里存着上一轮的本机结果。
    render(<PersonDetail personId="p1" onBack={vi.fn()} />);
    await screen.findByRole('heading', { name: '人物详情' });
    expect(screen.queryByText(/当前为本地系统/), '存着本机结果 ≠ 引擎接管').toBeNull();
    // 走真实入口开通并勾选（不手搓键名），同一条路径上横幅就该出现。
    turnLocalSystemOn();
    cleanup();
    resetMockSession();
    await seed(mk({ aiTasks: { 'task-01': task('task-01', 'local') } }));
    render(<PersonDetail personId="p1" onBack={vi.fn()} />);
    await screen.findByRole('heading', { name: '人物详情' });
    expect((await screen.findByText(/当前为本地系统/)).textContent, '既然真的在接管，详情页就必须说出来').toBeTruthy();
  });

  /* 这一条盯的是**跨页**的缺口。App 里三个区块是**互斥三元表达式**渲染的（不是路由），
     「设置 → 详情」来回切时 PersonDetail/AIAnalysis 那个实例**根本不卸载**，record 也没变
     ⇒ 它连一次重渲染都拿不到。若详情页把生成方式读数冻在挂载那一刻，就会出现「横幅写着当前为
     本地系统、点 AI 分析却已走回云端」。所以这里必须用**真的 App**：自己搭一棵树、切换时换组件
     类型，React 会重挂载并把 ref 清零 —— 实测那样即使把订阅整条删掉也照样全绿（假覆盖）。 */
  it('去设置页取消勾选再返回：详情页不许还挂着「当前为本地系统」（实例被复用，不靠重挂载）', async () => {
    await seed(mk({ aiTasks: { 'task-01': task('task-01', 'local') } }));
    turnLocalSystemOn();
    render(<App />);
    // 记录列表是异步读的：点进「记录」后要等这一盘的行出现，否则点到的是空态。
    const openDetail = async () => {
      fireEvent.click(screen.getByRole('button', { name: '记录' }));
      const row = await screen.findByRole('button', { name: '查看设计测试' }, { timeout: 4000 });
      fireEvent.click(row);
      await screen.findByRole('heading', { name: '人物详情' });
    };
    const openSettings = () => { fireEvent.click(screen.getByRole('button', { name: '设置' })); };
    const backToDetail = async () => {
      // 设置页没有自己的关闭按钮：真实路径就是点底栏任一 tab（App 的 onChange 会把 settingsOpen 压回 false）
      fireEvent.click(screen.getByRole('button', { name: '排盘' }));
      await openDetail();
    };

    await openDetail();
    expect(await screen.findByText(/当前为本地系统/, {}, { timeout: 5000 }), '开着时该说在说').toBeTruthy();

    // 去设置页取消勾选 —— 这一步就是那条变异体翻车的地方：详情页留在原地不重渲染
    openSettings();
    const checkbox = await screen.findByRole('checkbox', { name: /使用本地系统/ });
    fireEvent.click(checkbox);
    await waitFor(() => expect(isLocalSystemEnabled()).toBe(false));
    expect((checkbox as HTMLInputElement).checked, '设置页上的勾要真的掉').toBe(false);

    // 返回并重新进详情：AIAnalysis 仍是同一个实例，横幅不许再声称本地
    await backToDetail();
    expect(screen.queryByText(/当前为本地系统/), '已经切回云端了，横幅就不许再说本地').toBeNull();

    // 反向钉子：勾回来时它要能再说回来，否则上面那条否定式只是「永远不显示」蒙过去的
    openSettings();
    fireEvent.click(await screen.findByRole('checkbox', { name: /使用本地系统/ }));
    await waitFor(() => expect(isLocalSystemEnabled()).toBe(true));
    await backToDetail();
    expect(await screen.findByText(/当前为本地系统/), '勾回来就得重新认领这句话').toBeTruthy();
  });
});

describe('详情页 · 同一轮只用一个生成方式读数（打桩编排器）', () => {
  /* 打桩编排器看发射点。`vi.mock` 会被提升到文件顶部，所以桩工厂只能引用**惰性求值**的
   holder：真身由这一条用例现造，其余用例根本不调用它。 */
  it('同一轮分析里生成方式只读一次：横幅与实跑引擎不许各自为政', async () => {
    /* 长跑期间用户去设置页改了勾选 —— 这一轮必须按**开始时**那个读数走完，否则会出现
       「横幅说云端、正文却是本地产的」这类混排。判据取发射点的值(`orchestrateBaziAnalysis`
       收到的 `options.local`)，不是同式重算一遍。 */
    // 用 vi.mock（提升到位）而不是 vi.doMock：doMock 之后的**静态** import 仍是真模块，
    // PersonDetail 顶部那句 `import { orchestrateBaziAnalysis }` 就抓不到桩（实测 spy 零调用）。
    const spy = orchestrateSpy();
    expect(spy).toBeDefined();
    try {
      const { saveBaziRecord: persist } = await import('../data/clientRepository');
      unlockLocalSystem(KEY);
      setLocalSystemEnabled(true);
      // 本地引擎要有排盘数据才放行（`canBuildLocalAnalysis`），空盘会在调编排器之前就被挡下；
      // 用真引擎造一份完整排盘，别手搓缺字段的假 chart（NonAiAnalysis 会读 pillars/twelveLongevity）。
      const chart = calculateNonAi({ birthYear: 1990, birthMonth: 5, birthDay: 15, yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午' }, 'male', '2025-01-01T00:00:00.000Z');
      /* 必须先 seed 再覆盖保存：没 seed 时这条 p1 在会话里根本不存在，`saveBaziRecord` 存进去的是
         一个没有归属人的孤儿记录 ⇒ getBaziRecord 读不到，详情页永远停在「正在读取命盘…」，
         点按钮自然一次都不会生效（实测在此卡住，一度误判成打桩没装上）。 */
      await seed(mk({ nonAiResult: chart }));
      // 再覆盖成「没跑过分析」的干净盘：aiTasks 为空 ⇒ 不命中缓存早退，点击必然走到编排器。
      const fresh = await getBaziRecord('p1');
      await persist({ ...fresh!, aiStatus: 'not_started', aiTasks: {} });
      render(<PersonDetail personId="p1" onBack={vi.fn()} />);
      /* 精确名 `AI 分析`：正则 /AI 分析/ 还会命中「清除AI结果与缓存（只清除，不重算）」，
         于是点到了清除按钮。等按钮出现＝记录真的读到了（首帧只有加载占位）。 */
      const trigger = async () => {
        const b = await screen.findByRole('button', { name: 'AI 分析' }) as HTMLButtonElement;
        fireEvent.click(b);
      };
      await trigger();
      await waitFor(() => expect(spy).toHaveBeenCalledTimes(1), { timeout: 3000 });
      expect(optionsOf(spy.mock.calls[0])).toEqual(expect.objectContaining({ local: true }));

      /* 第二轮**之前**取消勾选 ⇒ 这一轮该按新读数走（local:false）。
         注意这条断言证明不了「冻住进行中那一轮」——那要等真的在跑时改才测得到，见下面两条。 */
      setLocalSystemEnabled(false);
      await trigger();
      await waitFor(() => expect(spy.mock.calls.length).toBe(2), { timeout: 3000 });
      expect(optionsOf(spy.mock.calls[1])).toEqual(expect.objectContaining({ local: false }));

      // 反向钉子：第三轮之前又勾上 ⇒ 又回到 local:true（不是只朝一个方向漂）
      setLocalSystemEnabled(true);
      await trigger();
      await waitFor(() => expect(spy.mock.calls.length).toBe(3), { timeout: 3000 });
      expect(optionsOf(spy.mock.calls[2])).toEqual(expect.objectContaining({ local: true }));
    } finally {
      ORCH_STUB.holder.fn = undefined;
    }
  });

  /* 上面那条只证明「新一轮取新读数」。这一条才钉住真正的机制：**一轮正在跑**时改勾选，
     不许把这一轮劈成半本机半云端。做法是让真本地引擎产出第一篇正文（同步、不联网），
     在第一与第二个 await 之间取消勾选 —— 此刻组件已经重渲染、横幅已翻成云端，
     而这一轮剩下的任务必须仍按开跑时的读数走。 */
  it('一轮跑到一半时取消勾选：这一轮余下的任务仍按开跑时的引擎走完（不混排）', async () => {
    /* 判据取**发射点**：本轮 orchestrate 收到的 options.local。桩按 onProgress 让出控制权后
       卡在闸门上 —— 真本地 runner 是一帧同步跑完的，测不到「进行中」这个窗口。 */
    let passGate1: (() => void) | undefined;
    let passGate2: (() => void) | undefined;
    const gate1 = new Promise<void>((r) => { passGate1 = r; });
    const gate2 = new Promise<void>((r) => { passGate2 = r; });
    ORCH_STUB.holder.fn = vi.fn(async (rec: BaziRecord, _runner?: unknown, onProgress?: (step: { done: number; total: number; label: string; record: BaziRecord }) => Promise<void>, options?: { local?: boolean }) => {
      seen.push(Boolean(options?.local));
      const first: BaziRecord = { ...rec, aiTasks: { 'task-01': task('task-01', 'local') }, aiStatus: 'pending' };
      // 闸门一：本轮已经开跑（busy 为真），但**还没**把任何进度交回组件 —— 用来测「新一轮不许趁虚而入」。
      await gate1;
      await onProgress?.({ done: 1, total: 2, label: '批断中…', record: first });
      // 闸门二：进度已落库、组件已因它重渲染过，这一轮仍未结束 —— 冻结判据的真正战场。
      await gate2;
      return { ...first, aiTasks: { 'task-01': task('task-01', 'local'), 'task-02': task('task-02', 'local') }, aiStatus: 'completed' };
    }) as unknown as OrchStub;
    try {
      turnLocalSystemOn();
      const chart = calculateNonAi({ birthYear: 1990, birthMonth: 5, birthDay: 15, yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午' }, 'male', '2025-01-01T00:00:00.000Z');
      await seed(mk({ nonAiResult: chart }));
      const fresh = await getBaziRecord('p1');
      // 覆盖成「没跑过分析」的干净盘：aiTasks 为空 ⇒ 不命中缓存早退，点击必然走到编排器。
      await saveBaziRecord({ ...fresh!, aiStatus: 'not_started', aiTasks: {} });
      render(<PersonDetail personId="p1" onBack={vi.fn()} />);
      const button = await screen.findByRole('button', { name: 'AI 分析' }) as HTMLButtonElement;
      fireEvent.click(button);
      await waitFor(() => expect(seen.length).toBe(1), { timeout: 3000 });
      expect(seen[0], '本轮开跑时读数是本地系统').toBe(true);
      passGate1?.();

      /* 跑到一半取消勾选。此刻横幅**必须仍然**写着「当前为本地系统」——引擎还在按本机规则批断，
         一掉勾就改口等于谎称已停。同时钉住「这一轮仍在跑」（按钮还写着「分析中…」），
         否则闸门没卡住、busyRef 已归位，下面所有判据都成了空断言。 */
      setLocalSystemEnabled(false);
      await waitFor(() => expect(isOfflineMode()).toBe(false));
      expect(screen.getByText(/当前为本地系统/), '本轮仍按开跑时的引擎在跑，横幅就不许先改口').toBeTruthy();
      expect(screen.getByRole('button', { name: '分析中…' }), '闸门没卡住：这一轮已经跑完了').toBeTruthy();

      /* 用户视角的下一步往往是「再点一次」。真实界面里按钮此刻是禁用的（disabled 不拦 fireEvent），
         所以这一击必须被 requestAnalysis 开头的 busy 闸门挡下：不许发起第二轮、更不许用翻转后的
         false 去起一轮 —— 那正是丢掉冻结后会出现的混排（变异体 H/I）。 */
      fireEvent.click(screen.getByRole('button', { name: '分析中…' }));
      expect(seen, '跑着的时候再点一次，不许另起一轮').toEqual([true]);
      passGate2?.();
      await waitFor(async () => expect((await getBaziRecord('p1'))?.aiStatus).toBe('completed'), { timeout: 3000 });

      // 关键判据：这一轮**只发起过一次**编排，且那一次用的仍是开跑时的读数 ——
      // 中途改勾选既没劈出第二轮，也没把进行中的这一轮换掉引擎。
      expect(seen, '一轮之内不许因界面翻转而换引擎，也不许在跑着时另起一轮').toEqual([true]);
      const finished = await getBaziRecord('p1');
      const produced = Object.values(finished?.aiTasks ?? {});
      expect(produced.length, '一个任务都没产出 ⇒ 这条判据是空的').toBeGreaterThan(0);
      expect(produced.filter((r) => r.source === 'local').length, '本轮结果全部应带 source:local').toBe(produced.length);
    } finally {
      ORCH_STUB.holder.fn = undefined;
    }
  });
});

// 底栏在 jsdom 里整体测会**静默不挂载**(实测：mock 成渲染按钮的桩件后 getByRole 仍找不到)，
// 而它只是导航条、不是本条不变量的被测对象。这里 stub 成能点的东西，让 App 的状态机照原样跑。
vi.mock('../components/BottomNav', () => ({
  BottomNav: ({ onChange }: { onChange: (s: string) => void }) => (
    <div>
      <button type="button" onClick={() => onChange('chart')}>排盘</button>
      <button type="button" onClick={() => onChange('records')}>记录</button>
    </div>
  ),
}));

vi.mock('../data/baziOrchestrator', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../data/baziOrchestrator')>();
  return {
    ...actual,
    orchestrateBaziAnalysis: ((...args: unknown[]) => {
      const stub = ORCH_STUB.holder.fn;
      return stub ? stub(...args) : actual.orchestrateBaziAnalysis(...(args as Parameters<typeof actual.orchestrateBaziAnalysis>));
    }) as typeof actual.orchestrateBaziAnalysis,
  };
});

describe('详情页「本地系统」整块的可见性跟着本机是否开通走', () => {
  /* 走真实导航：记录页是异步加载的，行按钮要等；打开后停在详情页。
     不直接 render(<PersonDetail/>) —— 那会绕过 App 的实例复用，测不出跨页读数。 */
  const openDetail = async () => {
    fireEvent.click(screen.getByRole('button', { name: '记录' }));
    fireEvent.click(await screen.findByRole('button', { name: '查看设计测试' }, { timeout: 4000 }));
    await screen.findByRole('heading', { name: '人物详情' });
  };

  /* 设置页那侧按 unlocked 收放，详情页这块必须跟着同一个判据：漏判的后果是
     从没开过第四路的设备，在命盘里看见一整块用不上的入口。
     判据只问 DOM（那块的唯一标题），不自报状态。 */
  const sectionShown = () => !!screen.queryByText('本地系统（本机规则引擎）');

  it('未开通：详情页不摆出这一块；开通后重进即出现', async () => {
    await seed(mk());
    render(<App />);
    await openDetail();
    expect(sectionShown(), '本机根本没开通，详情页不该摆出第四路入口').toBe(false);
    // 正例钉子：同一份记录、同一条路径，只是本机开通了 —— 这块就该在。
    expect(unlockLocalSystem(KEY), '解锁码不对，前提没成立').toBe(true);
    cleanup();
    resetMockSession();
    await seed(mk());
    render(<App />);
    await openDetail();
    expect(sectionShown()).toBe(true);
  });

  it('撤销开通后详情页也不再露头：两块共用同一个判据', async () => {
    await seed(mk());
    expect(unlockLocalSystem(KEY), '解锁码不对，前提没成立').toBe(true);
    hideLocalSystem();
    expect(isLocalSystemUnlocked(), '前提：撤销之后本机就是未开通').toBe(false);
    render(<App />);
    await openDetail();
    expect(sectionShown(), '本机已撤销开通，详情页却还摆着同一功能').toBe(false);
    // 反向钉子：重新开通后走同一条路径，它必须回来（证明上面那句不是恒假）。
    unlockLocalSystem(KEY);
    cleanup();
    resetMockSession();
    await seed(mk());
    render(<App />);
    await openDetail();
    expect(sectionShown()).toBe(true);
  });
});


/* 拆包后的功能不变量：规则引擎不再静态进首屏包（见「本地规则引擎按需加载」那组），
   改成点「生成本地批断」时才 await import。这条走真实交互路径钉**没被拆坏** —— 按需取到的
   仍是同一个真引擎，能出本命/十年/调整三块。变异对照：动态 import 的路径写错 ⇒ 红；把按钮的
   disabled 判据写成常真 ⇒ 点不动、等不到正文 ⇒ 红。 */
describe('详情页本地批断由按需加载的引擎产出', () => {
  it('点击后渲染出三块正文', async () => {
    const chart = calculateNonAi({ birthYear: 1990, birthMonth: 5, birthDay: 15, yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午' }, 'male', '2025-01-01T00:00:00.000Z');
    await seed(mk({ nonAiResult: chart }));
    expect(unlockLocalSystem(KEY), '解锁码不对，前提没成立').toBe(true);
    render(<PersonDetail personId="p1" onBack={vi.fn()} />);
    const button = await screen.findByRole('button', { name: '生成本地批断' }, { timeout: 4000 });
    fireEvent.click(button);
    await waitFor(() => expect(screen.queryByText('本命命局')).toBeTruthy(), { timeout: 4000 });
    expect(screen.getByText('未来十年 · 全盘总结')).toBeTruthy();
    expect(screen.getByText('后天调整与职业适配')).toBeTruthy();
  });
});

/* 用户实测报的「没有时间节点」：存储里的派生数组是瘦身过的（greatFortunes/annualFortunes 为空，
   读取时才由 hydrate 现算补回），而本地引擎只认 record.nonAiResult。走**真实 UI 路径**点一次
   「生成本地批断」，看它拿到的到底是哪一份数据 —— 修复前这里必红：正文只剩一句
   「未来十年各年均无显著犯忌或进气之年」，一个年份节点都没有。 */
describe('详情页本地批断要有时段事实（大运算得出、节点列得全）', () => {
  /* 未 hydrate 的存储形态 = pruneRecord 的输出。这里**先走真实落库路径**再把它抠出来，而不是
     手搓形状：上一版手搓时带上了 strengthScore/patternFacts，读取路径(isPruned)顺手替它补算了
     ⇒ 用例恒绿，把「本地批断拿瘦身盘算不出时间节点」这条真缺陷整个漏掉。 */
  const storedChart = async () => {
    const full = calculateNonAi({ birthYear: 1990, birthMonth: 5, birthDay: 15, yearPillar: '庚午', monthPillar: '壬午', dayPillar: '丙寅', hourPillar: '癸巳' }, 'male', '2026-09-25T02:00:00.000Z');
    const saved = await saveBaziRecord(mk({ nonAiResult: full }) as BaziRecord);
    const n = saved.nonAiResult;
    expect(n, '前提：记录存下来了').toBeTruthy();
    // 前提钉子：这份才是「没 hydrate 过的存储形态」，时段数组必须真的是空的
    expect(n!.greatFortunes, '存储里大运没被瘦身分 ⇒ 这条判据是空转').toHaveLength(0);
    expect(n!.annualFortunes, '存储里流年没被瘦身分 ⇒ 这条判据是空转').toHaveLength(0);
    return n;
  };

  it('瘦身记录上点「生成本地批断」：全盘总结仍列出具体年份节点与大运段', async () => {
    await seed(mk({ nonAiResult: await storedChart() }));
    unlockLocalSystem(KEY);
    render(<PersonDetail personId="p1" onBack={vi.fn()} />);
    const button = await screen.findByRole('button', { name: '生成本地批断' }, { timeout: 4000 });
    fireEvent.click(button);
    await waitFor(() => expect(screen.queryByText('未来十年 · 全盘总结')).toBeTruthy(), { timeout: 4000 });
    const text = baseText();
    // 判据取正向：只有真的算出大运段/年份节点才算通过（负向断言读不出「到底有没有」）。
    expect(text, '大运段没算出来 ⇒ 引擎拿到的是瘦身数据').toContain('未来十年先走');
    expect(text, '一个四位年份节点都没有 ⇒ 就是用户说的「没有时间节点」').toMatch(/20\d{2}年（/);
    expect(text.match(/20\d{2}年（/g)!.length, '关键节点不该只有一个').toBeGreaterThan(1);
  });

  it('补算标记落本机后不再重复重算；换一条盘仍会补算（标记不跨记录）', async () => {
    const { localChartNeedsHydrate, markLocalChartHydrated } = await import('../data/localSystem');
    await seed(mk({ nonAiResult: await storedChart() }));
    unlockLocalSystem(KEY);
    render(<PersonDetail personId="p1" onBack={vi.fn()} />);
    const button = await screen.findByRole('button', { name: '生成本地批断' }, { timeout: 4000 });
    fireEvent.click(button);
    await waitFor(() => expect(screen.queryByText('未来十年 · 全盘总结')).toBeTruthy(), { timeout: 4000 });
    expect(localChartNeedsHydrate('p1'), '跑过一次就该记下：这盘的时段数据已备齐').toBe(false);
    expect(baseText()).toMatch(/20\d{2}年（/);    // 反向钉子：同一条判据对没跑过的 p2 必须仍是 true，否则上面那句 false 可能只是恒假
    markLocalChartHydrated('other-id');
    expect(localChartNeedsHydrate('p2'), '标记串到别的盘上了').toBe(true);
  });
});

/* 拆包后的设计不变量：规则引擎不进首屏包，只在真的走第四路时才 await import。
   判据读**真实模块源码**(?raw)，不碰组件、不发请求。变异对照见各条注释。 */
const read = async (p: string) => String((await import(p)).default);

describe('本地规则引擎按需加载', () => {
  const cases = [
    ['编排器', '../../src/data/baziOrchestrator.ts?raw'],
    ['详情页', '../../src/features/person/PersonDetail.tsx?raw'],
  ] as const;

  for (const [label, path] of cases) {
    it(`${label} 只用动态 import 取引擎`, async () => {
      const src = await read(path);
      expect(src.length, `${label} 源码没读到，这条判据就是空转`).toBeGreaterThan(1000);
      expect(/import\s[^;]*?from\s*['"][^'"]*localAnalysis['"]/.test(src),
        `${label} 又用静态 import 拉引擎：vite 会把它合回首屏 chunk`).toBe(false);
      expect(/import\(\s*['"][^'"]*localAnalysis['"]\s*\)/.test(src),
        `${label} 里没有动态 import，说明调用点被删了`).toBe(true);
    });
  }

  it('判据住在 localSystem，不在引擎里', async () => {
    const engine = await read('../../src/data/localAnalysis.ts?raw');
    expect(engine).not.toMatch(/export\s+const\s+canBuildLocalAnalysis/);
    expect(canBuildLocalAnalysis({ nonAiResult: {} }), '正例：有排盘数据应放行').toBe(true);
    expect(canBuildLocalAnalysis({}), '反例：没排盘数据必须挡住').toBe(false);
  });
});

