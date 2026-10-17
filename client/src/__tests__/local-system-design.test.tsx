import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PersonDetail } from '../features/person/PersonDetail';
import { SettingsPage } from '../features/settings/SettingsPage';
import { flushPendingPruneWrites, getBaziRecord, hydrateRecord, initializeMockSession, listBaziRecords, resetMockSession, saveBaziRecord } from '../data/clientRepository';
import { isOfflineMode, resetAiSettingsForTests } from '../data/aiSettings';
import { isLocalSystemEnabled, isLocalSystemUnlocked, hasPeriodFacts, hideLocalSystem, completeChartForTests, resetLocalSystemForTests, setLocalSystemEnabled, unlockLocalSystem } from '../data/localSystem';
import type { BaziRecord, BaziTaskResult } from '../types/domain';
import { calculateNonAi, computePillarsFromDate } from '../features/chart/nonAiCalculator';
import '../features/chart/nonAiCalculator'; // 预载引擎(缓存)，让页面内的按需加载立即命中
/* 本机那一条必须带当前版本标记：真实产物出自 buildLocalTaskAnalysis，它一定写 engineVersion。
   桩件漏了它就等于伪造一条「上一版引擎批的存量」，读取路径会把它当旧话清洗掉 —— 那是清洗判据
   正常工作，不是这几条用例要测的东西（实测：漏标记时「跑完一轮再读」被判成未开始）。 */
import * as localSystem from '../data/localSystem';
import { LOCAL_ANALYSIS_ENGINE_VERSION } from '../data/localAnalysis';
import { App } from '../App';
import { canBuildLocalAnalysis } from '../data/localSystem';
import { expectedTaskIds } from '../data/baziOrchestrator';

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
const person = { id: 'p1', name: '设计测试', nameInitial: 'S', gender: 'male' as const, birthSummary: '甲子年' };

/** 默认那枚桩：卡在闸门上，等用例自己放它收尾（`passStubRound()`）。
 *  ⚠ 不能像旧版那样「抛错」当默认桩：requestAnalysis 的 catch 分支会把 record **原样**交回视图
 *    （见那里 `onUpdated(errorRecord)`），于是视图里那份时段齐全的那一份被保住、第二轮直接命中缓存早退
 *    （实测：桩件调用停在 1）。按真实语义让这一轮"以这份盘收尾"才测得出跨轮的引擎读数。 */
let releaseStubRound: (() => void) | undefined;
const passStubRound = () => releaseStubRound?.();
const gatedStub = (): OrchStub => {
  let release: (() => void) | undefined;
  releaseStubRound = () => release?.();
  return vi.fn(async (rec: BaziRecord) => {
    await new Promise<void>((r) => { release = r; });
    return rec;
  }) as unknown as OrchStub;
};
/** 取「当前这枚桩」：默认那枚卡在闸门上，用例点完一轮必须自己 `passStubRound()` 放它收尾。 */
const orchestrateSpy = () => (ORCH_STUB.holder.fn ??= gatedStub());

const task = (taskId: string, source: 'cloud' | 'local' | undefined): BaziTaskResult => ({
  task: { taskId, type: 'baseline' },
  status: 'completed',
  analysis: { pattern: '', strength: '', usefulElements: [], avoidElements: [], explanation: `【健康】${source ?? '缺省'}来源正文`, ...(source === 'local' ? { engineVersion: LOCAL_ANALYSIS_ENGINE_VERSION } : {}) },
  ...(source ? { source } : {}),
});

const mk = (over: Partial<BaziRecord> = {}): BaziRecord => ({
  id: 'p1', name: '设计测试', gender: 'male', birthYear: 1990, birthMonth: 1,
  createdAt: '2025-01-01T00:00:00.000Z', yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午',
  aiStatus: 'completed', aiTasks: {}, ...over,
});

/** 夹具里的四柱必须与生日**自洽**：hydrateRecords 会按「公历年月 + 三柱」反查出生日，
   手抄一组对不上的干支 ⇒ 扫不到那天 ⇒ 这份盘压根补不回时段数据（实测：详情页停在
   「暂无基础排盘数据」，横幅永远不出现，判据空转）。所以由真实日期现算。 */
const pillarsOf = (year: number, month: number, day: number, hour: number) => computePillarsFromDate({ year, month, day, hour });

/* 自洽夹具（见上面 pillarsOf 那段禁令）：生日 + 由这一天现算的四柱，而不是 mk() 默认那组手抄干支。
   ⚠ 为什么非要有个专用构造器：hydrateRecords 反查出生日靠的是「公历年月 + 三柱」，mk() 里
      birthMonth:1 配一组 5 月才有的干支 ⇒ 扫不到那天 ⇒ canRecompute 通过、补算却返回空 ⇒
      存储里那份既没数组也没槽位 ⇒ buildBaziTasks 只剩 task-01，第四路在发射前就挡下
      （实测提示「本地系统需要先有排盘数据」，编排器桩件零调用）。 */
const selfConsistent = (over: Partial<BaziRecord> = {}): BaziRecord =>
  mk({ ...pillarsOf(1990, 5, 15, 10), birthMonth: 5, ...over });

const seed = async (record: BaziRecord) => {
  initializeMockSession([person], [{ person, record, aiAnalysis: { status: 'completed', result: 'x' } }]);
  return record;
};

/** 页面上摆出来的全部文字。⚠ 别用 `document.body.innerText`：jsdom 没实现它，读回来是
 *  undefined，于是任何字符串判据都变成「undefined 与 string」的无效比较（实测踩过）。 */
const baseText = () => document.body.textContent ?? '';

/* 「这一盘该有完整时段数据」只由产品自己的补算给出（ensureLocalChartComplete，走第四路前调的就是它）。
   夹具不许自己调 calculateNonAi 造一份「看着完整」的盘：实测那样落库的是**带完整数组**的那份，
   于是读取路径 isPruned()=false ⇒ hydrate 整条跳过 ⇒ 大运/流年/流月全空 ⇒ buildBaziTasks 只剩
   task-01 一条必填项；第一轮跑完桩件把正文写回后，第二次点击就命中「结果齐全」早退，编排器零调用，
   后面几条 options.local 判据全部空转（表现是 findByRole('AI 分析') 超时）。
   未开通时 ensureLocalChartComplete 原样返回，所以这里用 completeChartForTests（只在没开通时现开通，
   不搅勾选）。 */
const fullChart = (record: BaziRecord): Promise<BaziRecord> => completeChartForTests(record);

/** 打开「已开通 + 已勾选」的本地系统：走真实写入口，不手搓键名。 */
const turnLocalSystemOn = () => {
  unlockLocalSystem(KEY);
  setLocalSystemEnabled(true);
};

/* 「两套链接」（用户 2026-09-28）之后，**从 App 挂载进来时哪套引擎接管由地址栏锚点决定**：
   裸链＝原本三样（云端），`#local`＝直接本机。所以凡是「render(<App/>) 且要求本路在接管」的用例，
   都必须**从 `#local` 这条链接进来**，不能再靠 turnLocalSystemOn() 的勾选硬撑过挂载 —— 挂载那一刻
   App 会按裸链把接管关掉（见 App.tsx 的 preferLocalFromHash 分支）。这里只改 location.hash，
   jsdom 不触发导航，正好让挂载 effect 读到我们要的那条链接。 */
const setHash = (hash: string) => window.location.replace(window.location.href.split('#')[0] + hash);

/* 「再点一次 AI 分析」到底会不会真的发起一轮，取决于本机语气台账（`ran.<id>`）里上次用的语气：
   与当前语气一致且结果齐全 ⇒ requestAnalysis 走「命中缓存」早退，编排器一次都不被调用（实测踩过：
   桩件零调用，几条判据全部空转）。默认语气是常量、测试里没人拖滑块，所以**清掉台账就等于必然发射**。
   键名口径以产品代码为准（PersonDetail 的 ranKey），这里只删这一条盘的这一把。 */
const clearToneLedger = (recordId = 'p1') => { try { localStorage.removeItem('mingli.analysis.tone.' + recordId + '.ran'); } catch { /* 无存储环境：本轮本来就没落账 */ } };

beforeEach(() => { setHash(''); resetAiSettingsForTests(); resetLocalSystemForTests(); });
afterEach(() => { setHash(''); cleanup(); resetMockSession(); resetAiSettingsForTests(); resetLocalSystemForTests(); });

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
    const note = await screen.findByText(/上次本地批断/);
    expect(note.textContent).toContain('重新计算');
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
    expect(screen.queryByText(/上次本地批断/), '未开通的人不该看见这句话').toBeNull();
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

  it('未开通时界面上没有接管控件，且库里有本机结果也不代表它在接管', async () => {
    await seed(mk({ aiTasks: { 'task-01': task('task-01', 'local') } }));
    // 未展开 + 没勾选：设置页上只有那个待输入的密钥框，没有勾选框、没有「关起来」。
    // （第四服务的入口形态 2026-09-28 定稿为「看得见一个框」，见 localSystem.ts 的入口史；
    //   这里判的是**接管态控件**不许在没开通时出现 —— 那才是「藏着却关不掉」的来源。）
    expect(unlockLocalSystem(KEY), '解锁码不对，前提没成立').toBe(true);
    hideLocalSystem();
    expect(isLocalSystemUnlocked(), '前提：本机回到未开通').toBe(false);
    const { container } = render(<SettingsPage />);
    expect(screen.getByLabelText('本地系统密钥'), '入口本身要一直在，否则机主找不到输码的地方').toBeTruthy();
    expect(container.textContent).toContain('未开通');
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
    /* 夹具要一次摆对（2026-09-28 这条重写过，之前那版是**假覆盖**，见下面两段说明）：
       · 横幅读的是 AIAnalysis 的 record prop，它只在**组件挂载那一刻**由 getBaziRecord 取一次；
         所以「哪一份盘」必须在 render(<App/>) **之前**就 seed 好 —— 中途再 seed 一次，界面拿到的
         仍是第一份（实测：那样首屏横幅压根不出现，判据空转）。
       · aiTasks 必须为空 ⇒ 必然发射（摆着已完成的 local 正文会命中缓存早退，桩件零调用）。
       · 时段数据走 fullChart()：存储里那份必须是**瘦身态**，读取时 hydrate 才补得回来。 */
    const pillars = pillarsOf(1990, 5, 15, 10);
    await seed(await fullChart(selfConsistent({ ...pillars, birthMonth: 5, aiStatus: 'completed', aiTasks: {} })));
    clearToneLedger();
    turnLocalSystemOn();
    setHash('#local');   // 从「直接本地」那条链接进来：App 挂载才会让本路接管，裸链会把它关掉
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

    /* 脏读数要造得对：详情页横幅读的是**本轮开跑时冻结的快照**（见 PersonDetail 的 localSystemRef，
       busy 期间不跟随界面），不是实时值。所以：
         · 单改 localStorage 不够 —— 重进详情时组件是新挂载的，挂载那一刻读到 live=false，
           横幅压根不会出现（实测那样这条判据恒真，是假覆盖）；
         · 让真引擎跑一整轮也不够 —— 本机的 runner 一帧同步跑完，等回到断言时 busy 已经掉了
           （同样实测过）。
       所以这里用打桩编排器把这一轮卡在「进行中」：闸门不开 ⇒ busy 恒真 ⇒ 快照冻在 true。
       ⚠ 前提钉子必须放在**用例里**而不是桩里：expect 写在异步桩体内会被外层 try/finally 吞掉，
          桩压根没被调用时那两句「前提」就成了空断言（实测踩过：点击被 canBuildLocalAnalysis 挡下，
          桩一次都没跑，测试却一路"通过"）。 */
    // 打桩编排器：把这一轮卡在「进行中」，闸门不开 ⇒ busy 恒真 ⇒ 快照冻在 true。
    let passGate: (() => void) | undefined;
    const gate = new Promise<void>((r) => { passGate = r; });
    const stubCalls: unknown[][] = [];
    ORCH_STUB.holder.fn = vi.fn(async (...args: unknown[]) => {
      stubCalls.push(args);
      await gate;
      return args[0] as BaziRecord;
    }) as unknown as OrchStub;

    openSettings();
    expect(isLocalSystemEnabled(), '前提：进设置页之前本机是接管着的（否则下面那一下点击是勾上而不是取消）').toBe(true);
    fireEvent.click(await screen.findByRole('checkbox', { name: /使用本地系统/ }));
    await waitFor(() => expect(isLocalSystemEnabled()).toBe(false));
    await backToDetail();
    expect(screen.queryByText(/当前为本地系统/), '已经切回云端了，横幅就不许再说本地').toBeNull();

    // 再勾回来：同一条盘、同一个实例，横幅必须重新认领这句话。
    openSettings();
    const recheck = await screen.findByRole('checkbox', { name: /使用本地系统/ });
    fireEvent.click(recheck);
    await waitFor(() => expect(isLocalSystemEnabled()).toBe(true));
    await backToDetail();
    expect(await screen.findByText(/当前为本地系统/), '勾回来就得重新认领这句话').toBeTruthy();

    // 开跑一轮并把它卡在途中：此刻 busy 为真，读数被冻结。
    fireEvent.click(await screen.findByRole('button', { name: '批断分析' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: '立即停止' })).toBeTruthy(), { timeout: 4000 });
    expect(stubCalls.length, '前提：这一轮真的到了编排器（没被缓存或空盘挡下）').toBe(1);
    expect(optionsOf(stubCalls[0]), '前提：这一轮按本机引擎发射').toEqual(expect.objectContaining({ local: true }));
    expect(screen.queryByText(/当前为本地系统/), '前提：跑着的时候横幅就该挂着').toBeTruthy();

    // 跑到一半去取消勾选：这一轮余下的任务仍按本机引擎走完，所以横幅**该**继续挂着（不是 bug）。
    openSettings();
    const checkbox = await screen.findByRole('checkbox', { name: /使用本地系统/ });
    fireEvent.click(checkbox);
    await waitFor(() => expect(isLocalSystemEnabled()).toBe(false));
    expect((checkbox as HTMLInputElement).checked, '设置页上的勾要真的掉').toBe(false);

    // 放这一轮收尾，返回并重新进详情：冻结解除 ⇒ 横幅必须改掉口径；还挂着就是「写着本地、实跑云端」。
    passGate?.();
    await waitFor(() => expect(screen.queryByRole('button', { name: '立即停止' })).toBeNull(), { timeout: 4000 });
    await backToDetail();
    expect(screen.queryByText(/当前为本地系统/), '已经切回云端了，横幅就不许再说本地').toBeNull();
    ORCH_STUB.holder.fn = undefined;
  });
});

describe('详情页 · 同一轮只用一个生成方式读数（打桩编排器）', () => {
  /* 打桩编排器看发射点。`vi.mock` 会被提升到文件顶部，所以桩工厂只能引用**惰性求值**的
   holder：真身由这一条用例现造，其余用例根本不调用它。 */
  it('每一轮开跑时重新取一次生成方式读数：横幅与实跑引擎不许各自为政', async () => {
    /* 三条 options.local 判据要的是「连着三轮，每轮各按当时的勾选发射」。这里走**真实导航**
       （App：记录页 → 详情 → 设置 → 返回），不是直挂 PersonDetail，理由有两条，都是实测踩过的：
       ① 视图里那份盘必须时段齐全 —— requestAnalysis 拿 record.nonAiResult **原样**去数任务
          （buildBaziTasks 读那三个数组），自己一口都不补；补算是编排器里本机 runner 的事
          （localChartForTask），而这里被换掉的正是编排器本身。一轮跑完 onUpdated 交回来的是瘦身那份，
          此后只有「重新挂载」才会再 hydrate 一遍；不离开详情页就连点三轮，第三轮只剩一条必填任务、
          跑完即「结果齐全」⇒ 根本不发射（实测桩件调用停在 2）。
       ② 夹具在页面外替组件"补一次算"会惊动订阅者：解锁/关起来各通知一次，正好落在
          「刚读到盘、还没发射」那个窗口里，把视图换回没数组的那一份，第四路随即挡下这一轮
          （界面提示「本地系统需要先有排盘数据」）。真实用户不会在这个窗口里改本机标记。
       ⚠ 别把这条误读成「一轮之内读数会跟着界面翻」—— 恰恰相反：进行中那一轮必须冻结在开跑时的值，
          那条由下面「一轮跑到一半时取消勾选」专门盯着。本条只钉"新一轮取新值"。
       ⚠ 必须先 seed 再干别的：没 seed 时这条 p1 在会话里根本不存在，详情页永远停在「正在读取命盘…」。 */
    const spy = orchestrateSpy();
    expect(spy).toBeDefined();
    try {
      await seed(await fullChart(selfConsistent({ aiStatus: 'completed', aiTasks: {} })));
      turnLocalSystemOn();
      clearToneLedger();
      setHash('#local');   // 从「直接本地」那条链接进来，挂载才会让本路接管（裸链会关掉它）
      render(<App />);
      const openDetail = async () => {
        fireEvent.click(screen.getByRole('button', { name: '记录' }));
        fireEvent.click(await screen.findByRole('button', { name: '查看设计测试' }, { timeout: 4000 }));
        await screen.findByRole('heading', { name: '人物详情' });
      };
      /* 每一轮：进详情（挂载时自己 hydrate 出完整视图）→ 点「AI 分析」→ 等它真的发射 → **回记录页**。
         "发射钉子"必须在点完之后等：本轮没到编排器的话（被缓存或被瘦身盘挡下）当场就红，
         绝不让后面那条 options.local 变成空断言。
         ⚠ 回记录页走的是标题旁那颗「返回记录」（PersonDetail 的 onBack），**不是底部导航那颗「记录」**：
            App 只在 handleSectionChange('chart') 里清 openedPersonId（见 App.tsx），点「记录」并不会退出
            详情 —— 于是第二轮 openDetail 点的其实是详情页正文里那条同名 aria-label 的行，界面压根不换，
            桩件那一轮的 promise 也没人放，第三轮永远发不出去（实测停在 backToRecords 找不到行）。 */
      const runRound = async () => {
        clearToneLedger();   // 早退分支与缓存无关，只与「本机上次用的语气」有关
        await openDetail();
        const before = spy.mock.calls.length;
        fireEvent.click(await screen.findByRole('button', { name: '批断分析' }) as HTMLButtonElement);
        await waitFor(() => expect(spy.mock.calls.length).toBe(before + 1), { timeout: 4000 });
        return before;
      };
      const backToRecords = async () => {
        passStubRound();
        await waitFor(() => expect(screen.queryByRole('button', { name: '立即停止' })).toBeNull(), { timeout: 4000 });
        fireEvent.click(screen.getByRole('button', { name: '返回记录' }));
        await screen.findByRole('button', { name: '查看设计测试' }, { timeout: 4000 });
      };

      let i = await runRound();
      expect(optionsOf(spy.mock.calls[i])).toEqual(expect.objectContaining({ local: true }));
      await backToRecords();

      // 第二轮之前取消勾选 ⇒ 这一轮该按新读数走（local:false）
      setLocalSystemEnabled(false);
      i = await runRound();
      expect(optionsOf(spy.mock.calls[i])).toEqual(expect.objectContaining({ local: false }));
      await backToRecords();

      // 反向钉子：第三轮之前又勾上 ⇒ 又回到 local:true（不是只朝一个方向漂）
      setLocalSystemEnabled(true);
      i = await runRound();
      expect(optionsOf(spy.mock.calls[i])).toEqual(expect.objectContaining({ local: true }));
      await backToRecords();
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
      const button = await screen.findByRole('button', { name: '批断分析' }) as HTMLButtonElement;
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
      expect(screen.getByRole('button', { name: '分析中，请稍候' }), '闸门没卡住：这一轮已经跑完了').toBeTruthy();

      /* 用户视角的下一步往往是「再点一次」。真实界面里按钮此刻是禁用的（disabled 不拦 fireEvent），
         所以这一击必须被 requestAnalysis 开头的 busy 闸门挡下：不许发起第二轮、更不许用翻转后的
         false 去起一轮 —— 那正是丢掉冻结后会出现的混排（变异体 H/I）。 */
      fireEvent.click(screen.getByRole('button', { name: '分析中，请稍候' }));
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
  const sectionShown = () => !!screen.queryByText('本地系统，本机规则引擎');

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
    expect(screen.getByText('未来十年全盘总结')).toBeTruthy();
    expect(screen.getByText('后天调整与职业适配')).toBeTruthy();
    const local = document.querySelector('section[aria-label="本地系统"]')!;
    expect(local.textContent).not.toMatch(/[A-Za-z0-9·（）「」…—]/);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    fireEvent.click(screen.getByRole('button', { name: '复制本地批断' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const copied = writeText.mock.calls[0][0] as string;
    expect(copied).not.toMatch(/[A-Za-z0-9·（）「」…—]/);
    expect(copied).toContain('本命命局');
    for (const block of local.querySelectorAll('.local-block')) {
      expect(copied.replace(/[\s【】]/g, '')).toContain((block.textContent ?? '').replace(/[\s【】]/g, ''));
    }

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
    const n = (await import('../data/clientRepository')).pruneRecord(saved).nonAiResult;
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
    await waitFor(() => expect(screen.queryByText('未来十年全盘总结')).toBeTruthy(), { timeout: 4000 });
    const text = baseText();
    // 判据取正向：只有真的算出大运段/年份节点才算通过（负向断言读不出「到底有没有」）。
    expect(text, '大运段没算出来 ⇒ 引擎拿到的是瘦身数据').toContain('未来十年先走');
    expect(text, '一个四位年份节点都没有 ⇒ 就是用户说的「没有时间节点」').toMatch(/二[〇零一二三四五六七八九]{3}年/g);
    expect(text.match(/二[〇零一二三四五六七八九]{3}年/g)!.length, '关键节点不该只有一个').toBeGreaterThan(1);
  });

  it('补算标记落本机后不再重复重算；换一条盘仍会补算（标记不跨记录）', async () => {
    const { localChartNeedsHydrate, markLocalChartHydrated } = await import('../data/localSystem');
    await seed(mk({ nonAiResult: await storedChart() }));
    unlockLocalSystem(KEY);
    render(<PersonDetail personId="p1" onBack={vi.fn()} />);
    const button = await screen.findByRole('button', { name: '生成本地批断' }, { timeout: 4000 });
    fireEvent.click(button);
    await waitFor(() => expect(screen.queryByText('未来十年全盘总结')).toBeTruthy(), { timeout: 4000 });
    expect(localChartNeedsHydrate('p1'), '跑过一次就该记下：这盘的时段数据已备齐').toBe(false);
    expect(baseText()).toMatch(/二[〇零一二三四五六七八九]{3}年/g);    // 反向钉子：同一条判据对没跑过的 p2 必须仍是 true，否则上面那句 false 可能只是恒假
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



describe('本地版本按需加载期间的停止', () => {
  it.each([false, true])('停止旧请求后加载完成不得发起或干扰新轮，新轮启动为 %s', async (startNew) => {
    await seed(await fullChart(selfConsistent({ aiStatus: 'not_started', aiTasks: {} })));
    turnLocalSystemOn();
    let releaseVersion!: (version: string) => void;
    let releaseRound!: () => void;
    const versionWait = new Promise<string>((resolve) => { releaseVersion = resolve; });
    const roundWait = new Promise<void>((resolve) => { releaseRound = resolve; });
    const version = vi.spyOn(localSystem, 'localEngineVersion').mockReturnValueOnce(versionWait);
    const run = vi.fn(async (record: BaziRecord) => { await roundWait; return { ...record, aiStatus: 'completed' }; }) as unknown as OrchStub;
    ORCH_STUB.holder.fn = run;
    try {
      render(<PersonDetail personId="p1" onBack={vi.fn()} />);
      fireEvent.click(await screen.findByRole('button', { name: '批断分析' }));
      await waitFor(() => expect(version).toHaveBeenCalledTimes(1));
      fireEvent.click(screen.getByRole('button', { name: '立即停止' }));
      expect(run.mock.calls).toHaveLength(0);
      if (startNew) {
        setLocalSystemEnabled(false);
        fireEvent.click(await screen.findByRole('button', { name: '批断分析' }));
        await waitFor(() => expect(run.mock.calls).toHaveLength(1));
        expect(optionsOf(run.mock.calls[0]).local).toBe(false);
      }
      await act(async () => { releaseVersion(LOCAL_ANALYSIS_ENGINE_VERSION); });
      expect(run.mock.calls).toHaveLength(startNew ? 1 : 0);
      if (startNew) {
        expect((screen.getByRole('button', { name: '分析中，请稍候' }) as HTMLButtonElement).disabled).toBe(true);
        expect(screen.getByRole('button', { name: '立即停止' })).toBeTruthy();
        await act(async () => { releaseRound(); });
      }
      await waitFor(() => expect(screen.queryByRole('button', { name: '立即停止' })).toBeNull());
      expect((screen.getByRole('button', { name: '批断分析' }) as HTMLButtonElement).disabled).toBe(false);
    } finally {
      releaseVersion(LOCAL_ANALYSIS_ENGINE_VERSION); releaseRound();
      version.mockRestore(); ORCH_STUB.holder.fn = undefined;
    }
  });
});
