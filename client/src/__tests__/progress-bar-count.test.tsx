import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PersonDetail, findCurrentFortune } from '../features/person/PersonDetail';
import { FIRST_DECADE_TASK_INDEX, OVERVIEW_TASK_ID, analysisHorizon, buildBaziTasks, orchestrateBaziAnalysis } from '../data/baziOrchestrator';
import { initializeMockSession, pruneStaleTasks, resetMockSession } from '../data/clientRepository';
import { cnCount } from '../shared/chineseReadAloud';
import type { BaziRecord, BaziTaskResult, NonAiChart } from '../types/domain';

/* 进度条那格「占位」的账：编排器只在每条任务真正收尾后发 progress，而「后天调整」「全盘总结」要等
   本命跑完 / 时段任务开跑才入列 —— 不补占位就会出现「二四，共二三」那种 done>total；补了占位又要在
   它们真的落地时撤掉，否则分母虚报、用户看着进度条永远差最后一格。

   这套判据此前完全空白：全仓没有一条用例读过 aria-valuenow / aria-valuemax / progress-fill 宽度，
   编排器侧也只钉过「末条 total=24」这一个端点值(orchestration.test.ts L118)，中间每一步的分母没人看。

   取证(读数见本文件末尾注释)决定了两层分工：
   · 「done 随每条任务推进」只能在编排器层钉。jsdom 里桩是即时 resolve，整批任务在第一次宏任务之前
     就跑完了，界面永远只来得及渲染出起点那一帧(实测停在「零，共二五」直到分析结束)。
   · 界面层钉的是形状与口径：分母等于真实队列+占位、读数不许超分母、宽度与读数同源、收尾撤块。 */

vi.mock('../data/deepseekAdapter', () => ({ analyzeBazi: vi.fn(), beginAiSession: vi.fn(), cancelAiSession: () => {} }));
import { analyzeBazi } from '../data/deepseekAdapter';

const ID = 'prog-person';
const thisYear = new Date().getFullYear();

/** 干净盘(无 nonAiResult)：buildBaziTasks 只出 本命1 + 流年10 + 流月12 = 23 槽位。 */
const record: BaziRecord = {
  id: ID, name: '进度盘', gender: 'male', birthYear: 1984, birthMonth: 2,
  createdAt: '2025-03-08T12:34:56.000Z', yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午',
  aiStatus: 'not_started', toneUsed: 80,
} as unknown as BaziRecord;

/** 夹具本身不许从被测实现借数：这里的窗口起点、大运判据、起运锚点全部按产品口径自己写一遍，
 *  和 baziOrchestrator.buildBaziTasks / nonAiCalculator 各算各的对得上才叫契约。 */
const HORIZON = { y: thisYear, m: new Date().getMonth() + 1 };
const EMPTY_REL = { sanHe: [], liuHe: [], xing: [], chong: [], po: [], hai: [], ke: [] };
/** 大运行的整数年区间按「起点+9」连续排布(与引擎一致)；交运日另给一个锚点，见 FIRST_ONSET。 */
const decadeRow = (ganZhi: string, startYear: number, onsetYear: number): NonAiChart['greatFortunes'][number] =>
  ({ ganZhi, startYear, endYear: startYear + 9, onsetDate: `${onsetYear}-03-15`, endDate: `${onsetYear + 9}-03-14`, relationships: EMPTY_REL });
/** 九步大运：整数年区间起点今年-79 起连续排 ⇒ 与十年窗口[今年, 今年+9]相交的**恰好两段**
 *  (辛巳、壬午)，槽位数 23+2=25，杀得住「把分母写死成 25」。
 *  交运日锚在「今年-8 的 3/15」：这样按精确交运日覆盖今天的这一柱(甲戌)与整数年区间读出的那一柱
 *  (辛巳)必然不同 —— 两条路口径分叉，正是「当前运判定」那条用例要钉的东西。
 *  实测全年 12×3 个取样日读数都一致(见 __probe 记录在文末注释)，不依赖今天落在几月。 */
const DECADE_GZ = ['甲戌', '乙亥', '丙子', '丁丑', '戊寅', '己卯', '庚辰', '辛巳', '壬午'];
const FIRST_ONSET = thisYear - 8;
const DECADES = Array.from({ length: 9 }, (_, k) => decadeRow(DECADE_GZ[k], thisYear - 79 + k * 10, FIRST_ONSET + k * 10));
/** 独立按整数年区间找「今年所在那一柱」：与产品口径的 onsetDate 判据分叉，用来证明两条路确实不同源。 */
const coveredRow = (): NonAiChart['greatFortunes'][number] | undefined =>
  DECADES.find((g) => g.startYear <= thisYear && thisYear <= g.endYear);
/** 独立按精确交运日找今天所在那一柱(不用产品的 findCurrentFortune)。 */
const rowCovering = (todayYmd: string): NonAiChart['greatFortunes'][number] | undefined =>
  DECADES.find((g) => (g.onsetDate ?? '') <= todayYmd && todayYmd <= (g.endDate ?? ''));
const STEMS = '甲乙丙丁戊己庚辛壬癸';
const BRANCHES = '子丑寅卯辰巳午未申酉戌亥';
/** 未来十年的流年干支按六十甲子连续推(甲子=今年)；流月只给窗口首年的十二个(甲子年正月=丙寅)。
 *  两样都只是给第贰栏和大运表当展示数据 —— 进度条读的是任务槽位数，不是这两张表。 */
const ANNUALS = Array.from({ length: 10 }, (_, i) => ({ year: HORIZON.y + i, month: 1, ganZhi: STEMS[(i) % 10] + BRANCHES[(i) % 12], relationships: EMPTY_REL }));
const MONTHLIES = Array.from({ length: 12 }, (_, i) => ({ year: HORIZON.y, month: i + 1, ganZhi: STEMS[(2 + i) % 10] + BRANCHES[(2 + i) % 12], relationships: EMPTY_REL }));

/** 「带完整排盘数据」的盘(nonAiResult 为完整形态)：读取路径只对瘦身盘重算，完整形态原样带过，
 *  所以缺哪一栏第贰栏就崩在哪一栏(实测 TypeError 见末尾注释)。这里把它读得到的键补齐，
 *  并刻意**不经引擎**造数据 —— 引擎的大运锚点是精确交运年(几乎不在 1/1)，跨用例不稳定。 */
const chart = {
  pillars: { year: '甲子', month: '丙寅', day: '庚午', hour: '壬午' },
  lunarDate: '甲子年正月十六', solarDate: `${HORIZON.y - 30}-02-06`, zodiac: '鼠',
  elements: { 木: 1, 火: 2, 土: 0, 金: 2, 水: 1 }, elementRatio: { 木: 20, 火: 40, 土: 0, 金: 20, 水: 20 },
  hiddenStems: [['癸'], ['甲丙戊'], ['丁己'], ['己丁']], tenGods: ['伤官', '偏印', '正官', '正印'], naYin: ['海中金', '炉中火', '路旁土', '杨柳木'],
  dayMaster: '庚', twelveLongevity: ['死', '绝', '沐浴'], currentTime: '午', forecastRange: ANNUALS.map((a) => a.year),
  relationships: EMPTY_REL, relationshipDetails: [], tenGodDetails: { heavenly: [], hidden: [[], [], [], []] },
  luckStart: { years: 3, months: 2, days: 1, date: '1987-04-07' }, luckOnset: `${FIRST_ONSET}-03-15`,
  greatFortunes: DECADES, annualFortunes: ANNUALS, monthlyFortunes: MONTHLIES,
  shenSha: { auspicious: [], inauspicious: [] },
} as unknown as NonAiChart;

const withDecade: BaziRecord = { ...record, nonAiResult: chart } as unknown as BaziRecord;

/* ---- 独立推算「这一盘该排多少格」：故意不调 buildBaziTasks/queuedTotal/expectedTaskIds。 ---- */
/** 本命1 + 十年流年10 + 从今天起的十二个公历月 + 与十年窗口有交集的大运段。 */
function slotsOf(greatFortunes: NonAiChart['greatFortunes']): number {
  const intersecting = greatFortunes.filter((g) => g.startYear <= HORIZON.y + 9 && g.endYear >= HORIZON.y);
  return 1 + 10 + 12 + intersecting.length;
}
/** 占位两条(后天调整、全盘总结)都会真的落地：本命桩给了喜用 ⇒ 调整会发；时段任务有正文 ⇒ 有要点 ⇒ 总结会发。
 *  所以「加得上」和「撤得掉」在这一格里是同一笔账：分母恒等于槽位数+2。 */
const expectedTotalFor = (taskCount: number): number => taskCount + 2;

/** 时段任务正文不带【】小节：missingOf 放行，不触发结构重试(重试多耗一次调用，把「每条一次进度」搅浑)。
 *  本命那条必须给喜用(木)，否则「后天调整」压根不排，占位账就少算一格。 */
const baselineAnalysis = { pattern: '身弱', strength: '弱', usefulElements: ['木'], avoidElements: ['金'], explanation: '顺遂。' };
const plainAnalysis = { pattern: '', strength: '', usefulElements: [], avoidElements: [], explanation: '顺遂。' };
const overviewAnalysis = { pattern: '', strength: '', usefulElements: [], avoidElements: [], explanation: '【核心结论】1. 主线。\n【值得关注的时间节点】1. 二零二七年机会窗口。\n【行动建议】1. 抓上半年。' };

const resultFor = (task: BaziTaskResult['task']): BaziTaskResult => ({
  task, status: 'completed', analysis: task.type === 'baseline' ? baselineAnalysis : task.type === 'overview' ? overviewAnalysis : plainAnalysis,
});

/* `_r` 必须标成 unknown 而不是 never：`vi.mocked(analyzeBazi).mockImplementation(slowStub(30))`
   要求参数**逆变**兼容(record: BaziRecord)，而 never 只能匹配 never ⇒ tsc -b 报 TS2345。
   桩压根不读这个参数，返回值末尾的 `as never` 才是喂给 mock 的那一侧。 */
const stubFor = async (_r: unknown, task?: { type?: string }) => ({
  status: 'completed',
  analysis: task?.type === 'overview' ? overviewAnalysis : task?.type === 'annual' || task?.type === 'monthly' || task?.type === 'decade' ? plainAnalysis : baselineAnalysis,
} as never);

/** 采样点之间插入真实延迟的桩：否则即时 resolve 会让整批任务在第一个宏任务前跑完，
 *  界面只渲染得出起点那一帧(实测)，中间态与「起跑前」那一帧都采不到。 */
const slowStub = (ms: number) => async (_r: unknown, task?: { type?: string }) => {
  await new Promise((r) => setTimeout(r, ms));
  return stubFor(_r, task);
};

beforeEach(() => { vi.mocked(analyzeBazi).mockImplementation(stubFor); });
afterEach(() => { cleanup(); resetMockSession(); vi.restoreAllMocks(); try { localStorage.clear(); } catch { /* jsdom 可能禁用 storage */ } });

async function seed(rec: BaziRecord) {
  const person = [{ id: rec.id, name: rec.name, nameInitial: 'J', gender: 'male' as const, birthSummary: 'x' }];
  initializeMockSession(person, [{ person: person[0], record: structuredClone(rec), aiAnalysis: { status: 'not_started' } }]);
  render(<PersonDetail personId={rec.id} onBack={vi.fn()} />);
  await screen.findByRole('button', { name: '批断分析' });
}

/** 点「批断分析」并在每一个宏任务节拍上采一次进度块读数。
 *  ⚠ 每轮必须排一个真实定时器：纯微任务循环里 React 还没提交，进度块压根不存在(实测采样 0 次)。 */
async function clickAndSample(limit: number, read: (track: HTMLElement) => void) {
  let samples = 0;
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: '批断分析' }));
    for (let i = 0; i < limit; i += 1) {
      await new Promise((r) => setTimeout(r, 0));
      const track = document.querySelector('.progress-track') as HTMLElement | null;
      if (!track) break;
      read(track);
      samples += 1;
    }
  });
  return samples;
}

describe('进度条分母与已完成格数(占位加得上也撤得掉)', () => {
  it('夹具钉子：两盘分别排 23 / 25 槽位，大运段的 taskId 与独立推算逐字一致', () => {
    expect(buildBaziTasks(record)).toHaveLength(23);
    expect(buildBaziTasks(record).some((t) => t.type === 'decade'), '干净盘冒出大运，23+2 的账就不对了').toBe(false);
    const decades = buildBaziTasks(withDecade).filter((t) => t.type === 'decade');
    expect(decades.map((t) => t.taskId), '大运槽位编号不连续 → 后面几条的前提不成立')
      .toEqual([FIRST_DECADE_TASK_INDEX, FIRST_DECADE_TASK_INDEX + 1].map((i) => `task-${String(i).padStart(2, '0')}`));
    expect(buildBaziTasks(withDecade)).toHaveLength(slotsOf(DECADES));
    expect(slotsOf(DECADES), '夹具没排出「恰好两段相交」，25+2 的账证不了分母会变').toBe(25);
  });

  /** 前提钉子：占位那两条在本命落地**之前**并不存在，所以分母不是全程一个常数。
   *  不先量清这条，「total 中途漂移」的断言就会去指控正确代码(我自己第一版就踩了)。 */
  it('分母的已知形态：本命那一条仍是队列长度，往后每条都是队列+2', async () => {
    const steps: Array<{ done: number; total: number }> = [];
    await orchestrateBaziAnalysis(record, async (task) => resultFor(task), (p) => { steps.push({ done: p.done, total: p.total }); }, { retries: 0, retryDelayMs: 0 });
    expect(steps[0]!.total, '本命收尾那一刻就该把两条占位摆进分母(它排在所有时段任务之前)').toBe(23);
    for (let i = 1; i < steps.length; i += 1) expect(steps[i]!.total, `第${i + 1}步分母漂移`).toBe(expectedTotalFor(23));
  });

  it('逐条收敛：done 从一到总数单增、全程不出现 done>total、末条恰好满格', async () => {
    const steps: Array<{ done: number; total: number }> = [];
    await orchestrateBaziAnalysis(record, async (task) => resultFor(task), (p) => { steps.push({ done: p.done, total: p.total }); }, { retries: 0, retryDelayMs: 0 });
    const expected = expectedTotalFor(23);
    // 23 槽位 + 后天调整 + 全盘总结 = 25 条任务，每条发一次进度。
    expect(steps.length, '进度回调条数与真实任务数不同源').toBe(expected);
    for (let i = 0; i < steps.length; i += 1) {
      expect(steps[i]!.done, `第${i + 1}步的 done 应等于已跑条数`).toBe(i + 1);
      expect(steps[i]!.total, '出现「二四，共二三」那种 done>total').toBeGreaterThanOrEqual(steps[i]!.done);
    }
    expect(steps[steps.length - 1]!.done, '末条没收敛到满格').toBe(expected);
    expect(steps[steps.length - 1]!.total).toBe(expected);
  });

  it('有大运的盘：进度条数与分母跟着真实队列走(27)，不是写死的 25', async () => {
    const steps: Array<{ done: number; total: number }> = [];
    await orchestrateBaziAnalysis(withDecade, async (task) => resultFor(task), (p) => { steps.push({ done: p.done, total: p.total }); }, { retries: 0, retryDelayMs: 0 });
    const expected = expectedTotalFor(slotsOf(DECADES));
    expect(steps.length, '大运那两格没被排进队列').toBe(expected);
    expect(Math.max(...steps.map((s) => s.total)), '分母没跟着任务队列变(疑似写死)').toBe(expected);
    expect(steps[steps.length - 1]!.done).toBe(expected);
  });

  /* 大运窗口上界的**两侧同源**：buildBaziTasks 的 `.filter(startYear<=year+9 && endYear>=year)`(排槽位)
     与 pruneStaleTasks.inWindow 的 `start <= horizon+9 && end >= horizon`(判已跑结果是否留用)，
     两处各自写死、注释明令「改这里必须同步改那边」。一旦分叉 —— 界面摆了某运却没把它算进必填槽位，
     「本机结果是否完整」恒为假 ⇒ 每次点 AI 分析把已跑完的盘整轮重算(真金白银)。
     ⚠ 本用例是 M10(把 buildBaziTasks 上界改成 year+8)在全仓唯一的杀手：其余用例只钉总数/进度，
        不比对两侧集合；变异体在编排器层与界面层的读数里都看不出来。 */
  it('大运窗口两侧同源：排进来的运 == 判据留用的运(含 startYear==year+9 边界)', () => {
    const y = analysisHorizon(record).year;
    // 覆盖两端：跨界当前运、恰好触及上界(year+9)的运、整段越界的运、整段走完的旧运。
    const rows = [
      decadeRow('甲申', y - 3, y - 3),   // 当前运，end=y+6 落在窗口内
      decadeRow('乙酉', y + 7, y + 7),   // start=y+7 ≤ y+9、end=y+16 ≥ y → 相交
      decadeRow('丙戌', y + 9, y + 9),   // start 恰为上界 y+9 → 相交(边界必须纳入)
      decadeRow('丁亥', y + 10, y + 10), // start=y+10 > y+9 → 越界，两侧都不该取
      decadeRow('戊子', y - 20, y - 20), // end=y-11 < y → 整段走完，两侧都不该取
    ];
    const withRows = { ...record, nonAiResult: { ...chart, greatFortunes: rows } } as unknown as BaziRecord;
    const scheduled = buildBaziTasks(withRows).filter((t) => t.type === 'decade').map((t) => t.decade?.ganZhi);
    // 先钉夹具本身读成期望集(否则空对空恒真)：恰好的三段。
    expect(scheduled, '夹具没排出「相交三段 / 越界两段」的对照').toEqual(['甲申', '乙酉', '丙戌']);
    // 造一份「所有大运槽位都已跑完」的 aiTasks，让 pruneStaleTasks 用同一判据决定留哪些。
    const done: Record<string, BaziTaskResult> = {};
    for (const t of buildBaziTasks(withRows)) if (t.type === 'decade') done[t.taskId] = { task: t, status: 'completed', analysis: plainAnalysis } as unknown as BaziTaskResult;
    const keptIds = Object.keys(pruneStaleTasks({ ...withRows, aiTasks: done }).aiTasks ?? {});
    const keptGz = keptIds.map((id) => done[id]!.task.decade?.ganZhi);
    expect(keptGz.sort(), 'pruneStaleTasks 留用的运 ≠ buildBaziTasks 排出的运(两侧上界分叉)').toEqual(scheduled.slice().sort());
  });

  it('界面读数：aria-valuemax 就是真实队列+占位，读数不超分母、宽度与读数同源、收尾撤块', async () => {
    await seed(record);
    let maxSeen = 0;
    const samples = await clickAndSample(400, (track) => {
      const now = Number(track.getAttribute('aria-valuenow'));
      const m = Number(track.getAttribute('aria-valuemax'));
      expect(m, '分母读不出来(不是数字)').toBeGreaterThan(0);
      expect(now, '进度读数超过分母 → 「第24项/共23项」那类虚报回来了').toBeLessThanOrEqual(m);
      const w = (track.querySelector('.progress-fill') as HTMLElement).style.width;
      expect(w, '填充宽度与 done/max 不同源').toBe(`${Math.round((now / m) * 100)}%`);
      if (m > maxSeen) maxSeen = m;
    });
    expect(maxSeen, '全程没读到过分母(用例压根没跑到进度阶段)等于没测').toBe(expectedTotalFor(23));
    expect(samples, '一次进度块都没采到 → 界面比对形同虚设').toBeGreaterThan(0);
    expect(document.querySelector('.progress-track'), '跑完后进度块未撤').toBeNull();
  }, 30000);

  it('界面读数：有大运的盘分母同样跟着队列走(杀「写死 25」)', async () => {
    await seed(withDecade);
    let maxSeen = 0;
    const samples = await clickAndSample(400, (track) => {
      const m = Number(track.getAttribute('aria-valuemax'));
      expect(m, '分母读不出来').toBeGreaterThan(0);
      if (m > maxSeen) maxSeen = m;
    });
    expect(samples, '一次进度块都没采到 → 这条压根没跑到进度阶段').toBeGreaterThan(0);
    const expected = expectedTotalFor(slotsOf(DECADES));
    expect(expected, '夹具退化成 25 就等于什么都没杀').not.toBe(expectedTotalFor(23));
    expect(maxSeen, '分母没跟着任务队列变(疑似写死)').toBe(expected);
    const calledIds = vi.mocked(analyzeBazi).mock.calls.map((c) => (c[1] as { taskId?: string } | undefined)?.taskId);
    expect(calledIds, '大运那一格压根没被调用 → 27 只是嘴上说说').toContain(`task-${String(FIRST_DECADE_TASK_INDEX).padStart(2, '0')}`);
    expect(calledIds, '全盘总结没被调用 → 这一格占位撤不掉就是虚报').toContain(OVERVIEW_TASK_ID);
  }, 30000);

  /* 「任务 三，共二五」这句话此前没有任何判据。钉的是它的**形状与同源**：整句由同一次 progress
     读数拼出(done 在前、total 紧随其后)，冒号后面是当前任务名，且这两个数就是 aria 上那两个。
     ⚠ 读法本身不是 cnSmall：进度条走 cnCount(超过二十逐位读 ⇒ 二十五写成「二五」)。这条口径在
     date-reading-parity.test.tsx 里已单独钉过，这里不重复裁决它，只钉「文字与读数不许分叉」。 */
  it('界面文案：进度整句逐字等于「任务 X，共Y：<当前任务名>」，且与 aria 读数同源', async () => {
    await seed(record);
    let checked = 0;
    const frames: string[] = [];
    const samples = await clickAndSample(400, (track) => {
      const block = track.closest('.progress-block') as HTMLElement;
      const text = (block.querySelector('.progress-text') as HTMLElement).textContent ?? '';
      const now = Number(track.getAttribute('aria-valuenow'));
      const m = Number(track.getAttribute('aria-valuemax'));
      const label = text.slice(0, text.indexOf('：'));
      expect(label, '进度整句不是「任务 X，共Y」这种写法(或 done/total 不同源)').toBe(`任务 ${cnCount(now)}，共${cnCount(m)}`);
      expect(text.slice(text.indexOf('：') + 1), '冒号后面没有当前任务名').toBeTruthy();
      if (!frames.includes(label)) frames.push(label);
      checked += 1;
    });
    expect(checked, '一次都没比对上 → 这条判据空转').toBe(samples);
    expect(samples).toBeGreaterThan(0);
    // 起点那一帧必须是「零 / 全量」：done 与 total 都从同一次状态来，缺一格就说明占位账没对上。
    expect(frames[0], '首帧文字与 aria 分母不同源').toBe(`任务 ${cnCount(0)}，共${cnCount(expectedTotalFor(23))}`);
  }, 30000);

  /* 界面把「今年在哪步运」标到哪一柱(大运表的 X行、起运那句文案)，必须由**精确交运日**
     (onsetDate~endDate)裁决，整数年区间只给存量记录兜底。把这条优先级写反、或删掉 onsetDate 分支，
     表里就会把「X行」标到交运日之前那一步运上，而任务槽位照排不误 —— 全仓此前没有任何用例读过
     findCurrentFortune(实测 grep 只有产品定义与两处调用命中)。
     夹具读数(全年 12×3 个取样日实测一致)：按交运日覆盖今天的是「甲戌」(今年-8 的 3/15 起运)，
     按整数年区间读出的却是「辛巳」(今年-9~今年+1)。两柱不同 ⇒ 判据真能分叉，不是同义反复。 */
  it('当前运判定：整条段按精确交运日裁决，而不是落在整数年区间的上一运', () => {
    const today = new Date();
    const todayYmd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    expect(rowCovering(todayYmd)?.ganZhi, '夹具的交运日区间没盖住今天 → 换 FIRST_ONSET 才能复现').toBe('甲戌');
    expect(coveredRow()?.ganZhi, '夹具退化：整数年口径也落到同一柱 → 两条路没有分叉，比较失效').toBe('辛巳');
    const current = findCurrentFortune(chart, thisYear, todayYmd);
    expect(current?.ganZhi, '产品读的不是精确交运日那一柱(疑似退回整数年口径)').toBe('甲戌');
    expect(current?.startYear).toBe(thisYear - 79);
    // 反向钉子：把 onsetDate/endDate 抹掉(模拟存量记录)，产品必须退回整数年口径读出「辛巳」。
    const legacy = { ...chart, greatFortunes: DECADES.map((g) => ({ ...g, onsetDate: '', endDate: '' })) } as NonAiChart;
    expect(findCurrentFortune(legacy, thisYear, todayYmd)?.ganZhi, '存量盘(无交运日)没走整数年兜底').toBe('辛巳');
  });

  /* 「起跑后第一帧」：点下按钮后界面先显示「任务 零，共二五」再逐条推进。
     ⚠ 实测(见文末取证)：fireEvent.click 会同步冲刷 React 的工作队列，onClick 里那句
        setProgress({done:0,total:expectedIds.length+2}) 在 click 返回前就已提交 —— 于是此刻
        progress.total 已有值，aria-valuemax 走的是 `progress?.total` 这一支，**不是** queuedTotal() 兜底。
        所以这条钉的是「点击处理器给的分母 = 队列+占位、且已完成数从 0 起」；至于 progress 仍为 null
        时靠 queuedTotal() 撑住分母那条兜底路(变异 M5/M6)，只能由下面那条 pending 直渲染用例来钉。 */
  it('起跑后第一帧：aria-valuemax 已是队列+占位，进度文字仍写「任务 零」', async () => {
    vi.mocked(analyzeBazi).mockImplementation(slowStub(30));
    await seed(record);
    fireEvent.click(screen.getByRole('button', { name: '批断分析' }));
    const track = screen.getByRole('progressbar');
    expect(track.getAttribute('aria-valuenow'), '起跑前不该报已完成数').toBe('0');
    expect(Number(track.getAttribute('aria-valuemax')), '起跑前分母退回 1 或漏掉占位 → 进度条形状不对').toBe(expectedTotalFor(23));
    const block = track.closest('.progress-block') as HTMLElement;
    expect((block.querySelector('.progress-text') as HTMLElement).textContent, '起跑前文字不该报已完成数').toContain('任务 零');
    // 文字与 aria 必须同源：整句走 cnCount(>20 逐位读 ⇒ 二十五写成「二五」)，aria 走阿拉伯数字。
    expect(block.textContent ?? '', '进度块里的汉字分母与 aria 分母不同源').toContain(`共${cnCount(expectedTotalFor(23))}`);
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  }, 30000);

  /* pending 态直渲染：record.aiStatus==='pending' 且尚未开始分析时，组件在没有 progress 的情况下
     也要给出进度块，此时 aria-valuemax = `progress?.total || queuedTotal() || 1` 走的是中间那一项。
     这是全仓唯一能命中该兜底分支的入口 —— 变异 M5(删掉整个兜底、退回 `|| 1`→得 1)与
     M6(queuedTotal 漏 +2→得 23)都只有在这里才会红。故意不点按钮：一点就触发同步 setProgress，
     progress.total 就位后兜底分支被盖掉(上面「起跑后第一帧」那条实测的就是这一支)。 */
  it('pending 直渲染(未点按钮)：progress 为空时 aria 分母仍等于队列+占位、宽度归零', async () => {
    const pending = { ...record, aiStatus: 'pending' } as unknown as BaziRecord;
    const person = [{ id: pending.id, name: pending.name, nameInitial: 'J', gender: 'male' as const, birthSummary: 'x' }];
    initializeMockSession(person, [{ person: person[0], record: structuredClone(pending), aiAnalysis: { status: 'not_started' } }]);
    render(<PersonDetail personId={pending.id} onBack={vi.fn()} />);
    // 先让异步装载完成(首帧是加载占位)，停在「记录已就绪、尚未点按钮」这一刻：progress 仍为 null。
    await screen.findByRole('button', { name: '批断分析' });
    const track = screen.getByRole('progressbar');
    expect(track.getAttribute('aria-valuenow'), '未起跑不该报已完成数').toBe('0');
    expect(Number(track.getAttribute('aria-valuemax')), 'progress 为空时分母必须由 queuedTotal() 兜底(队列+2)').toBe(expectedTotalFor(23));
    // 宽度与 aria 同源：此刻一格未跑，填充必须为 0%(不是开局拉满)。
    const fill = track.querySelector('.progress-fill') as HTMLElement;
    expect(fill.style.width, '未完成时进度条不该有填充').toBe('0%');
  });

  /* 【缺陷 #119 · 判据空白补位 2026-10-07】补跑那一句状态用的分母若写回 `tasks.length`，会把收尾
     刚撤回的「全盘总结」占位又摆回来。编排器层杀不掉它(实测 A/B：正确码与变异体在 retries:0 恒失败盘上
     逐条读数完全相同 —— 那一格里 totalShown() 恰好等于 tasks.length)，界面层的采样用例也杀不掉
     (桩即时 resolve，采不到中间帧)。所以这里钉**发射点的那行源码**：它是全仓唯一一处带
     「自动重试失败任务」文案的 onProgress 调用，分母必须走 totalShown()。 */
  it('补跑状态句的分母走 totalShown()，不许退回 tasks.length(#119)', () => {
    const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'baziOrchestrator.ts'), 'utf8');
    const lines = src.split(/\r?\n/).filter((l) => l.includes('自动重试失败任务'));
    expect(lines.length, '补跑状态句应当只有一处发射点').toBe(1);
    expect(lines[0], '补跑那一句的分母不是 totalShown() ⇒ 已撤回的总结占位会被重新摆进分母').toMatch(/total:\s*totalShown\(\)/);
    expect(lines[0], '分母退回本轮队列长度 ⇒ 实测 #119 的「共二五」虚报回来了').not.toMatch(/total:\s*tasks\.length/);
  });
});

/* 取证读数(2026-10-06，jsdom)：
   · 即时 resolve 的桩：tick0 track=none calls=0 → tick1 track=0/25 text=「任务 零，共二五：正在准备任务」calls=25
     → tick2..12 全部仍是 0/25、calls=25，直到分析结束才落定。整批任务在第一个宏任务之前就发完，
     界面采不到中间态计数；所以中间态归编排器层，界面层只钉形状。
   · 纯微任务循环(act 内 await Promise.resolve())：maxSeen=0、samples=0 —— 一次都采不到。
   · 【订正】点按钮后同步读 aria：calls=0、aria-valuemax=25、now=0，看着像走到了 queuedTotal() 兜底；
     但把 M5(删兜底→`|| 1`)落进产品码再跑同一条用例仍全绿 —— 因为 fireEvent.click 同步冲刷了 onClick 里的
     setProgress({done:0,total:队列+2})，断言时 progress.total 已就位，兜底分支根本没执行。
     ⇒ 「起跑后第一帧」这条钉的是点击处理器给的分母；queuedTotal() 兜底(M5/M6)改由「pending 直渲染」那条钉：
       它不经点击、progress 恒为 null，是唯一能命中 `progress?.total || queuedTotal() || 1` 中间支的入口，
       实测 M5→valuemax 塌成 1、M6→塌成 23，两条都变红。(先前误判 M5 为死代码存活，已用电池复证推翻。)
   · 编排器层首次 emit 的 total=23(占位尚未知)，此后 25；单轮全量 UI 跑约 18 秒 ⇒ 三条界面用例都要显式 30s 预算。
   · 手写「半形态」nonAiResult(只填三个时段数组)会被读取路径原样带过(hydrate 只对瘦身盘重算)，
     第贰栏在第 230 行 result.pillars.year 抛 TypeError：Cannot read properties of undefined (reading 'year')。
     这就是本文件把整张图表字段补齐、而不塞一个局部对象的原因。 */

