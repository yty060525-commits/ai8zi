import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SettingsPage } from '../features/settings/SettingsPage';
import { isOfflineMode, resetAiSettingsForTests } from '../data/aiSettings';
import { isLocalSystemEnabled, isLocalSystemHidden, isLocalSystemUnlocked, resetLocalSystemForTests, setLocalSystemHidden, unlockLocalSystem } from '../data/localSystem';
import { invoke } from '@tauri-apps/api/core';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const KEY = 'mingli-local-2026';
const notConfigured = { selectedProvider: 'deepseek', deepseek: 'not_configured', kimi: 'not_configured', qwen: 'not_configured' };
const happyPath = async (command: string) => command === 'get_ai_provider_status' ? notConfigured
  : command === 'save_ai_credential' ? 'configured'
  : command === 'set_ai_provider' ? 'deepseek' : 'not_configured';

/* 每个用例都从**干净的本机存储**开始。上一版把整张矩阵在模块顶层跑完再断言，两个坑：
   · 副作用发生在 vitest 收集阶段 —— 一抛错就只剩空输出，一条断言都看不到；
   · 行间互相污染 —— `unlockLocalSystem` 写的标记不逐行清，下一行开局就是已开通，
     于是测出一堆假红（「暗门本身不开通任何东西」那条就是这么来的）。 */
afterEach(() => { cleanup(); resetAiSettingsForTests(); resetLocalSystemForTests(); vi.mocked(invoke).mockImplementation(happyPath); vi.clearAllTimers?.(); });
vi.mocked(invoke).mockImplementation(happyPath);

const blockShown = () => !!screen.queryByLabelText('本地系统');
const checkbox = () => screen.queryByRole('checkbox', { name: /使用本地系统/ }) as HTMLInputElement | null;
/** 连点 n 下（同步派发，模拟手速极快 / 同一批事件里点完）。 */
const tap = (n: number) => { for (let i = 0; i < n; i += 1) fireEvent.click(screen.getByRole('heading', { name: '设置' })); };

interface Read { shown: boolean; enabled: boolean; unlocked: boolean; hidden: boolean }
/** 可见性问 DOM，其余问 localStorage —— 本机标记才是实现的真相来源，不让组件自报。 */
const observe = (): Read => ({ shown: blockShown(), enabled: isLocalSystemEnabled(), unlocked: isLocalSystemUnlocked(), hidden: isLocalSystemHidden() });

/** 摆好开局本机状态 → 挂载 → 逐段「连点 n 下后重进设置页」，返回每次重进后的读数。
 *  重进是刻意的：`revealed` 只活在内存里，不卸载重挂就分不清「持久行为」和「这一屏的临时态」。
 *  `liveShown` 是**重进之前**(同一屏内)的可见性 —— 未开通设备只有这一层能看见它。 */
function drive(row: { unlocked?: boolean; hidden?: boolean; taps: number[] }): Array<{ shown: boolean; liveShown: boolean; enabled: boolean; unlocked: boolean; hidden: boolean }> {
  if (row.unlocked) unlockLocalSystem(KEY);
  if (row.hidden) setLocalSystemHidden(true);
  const reads: Array<ReturnType<typeof observe> & { liveShown: boolean }> = [];
  let view = render(<SettingsPage />);
  for (const n of row.taps) {
    tap(n);
    const liveShown = blockShown();
    view.unmount();
    view = render(<SettingsPage />);
    reads.push({ ...observe(), liveShown });
  }
  view.unmount();
  return reads;
}

/** 一次「触发」＝连点满 5 下；手势计数器每触发一次归零。
 *  同步连点里相邻两段之间不会超过 2 秒窗口，所以点数是**跨段累计**的：
 *  [2,8] 等价于连着点 10 下＝触发两次后剩 0 下。第一版按「数组元素个数」算触发次数，
 *  于是 [2,8]/[10]/[4,5]/[9]/[11] 这类行全被判错。 */
const TRIGGER = 5;

/** 第 k 次触发的效果，取自 `SettingsPage` 的点击处理（那里就这三个分支）：
 *    · 当屏看得见 → 收起并置 hidden；
 *    · 藏着 → 清掉 hidden；
 *    · 其余（看不见也没藏着）→ 只把这一屏放出来（revealed，不持久）。
 *  判据必须与实现同构 —— 之前两处各写一套算法，才会一边假红一边漏测。 */
function fire(state: { unlocked: boolean; hidden: boolean; revealed: boolean }) {
  const shown = !state.hidden && (state.revealed || state.unlocked);
  if (shown) return { ...state, revealed: false, hidden: true };
  return { ...state, revealed: true, hidden: false };
}

const seqs: number[][] = [[5], [5, 5], [5, 5, 5], [10], [2, 8], [5, 4], [4, 5], [3], [9], [11]];
const starts: Array<{ unlocked?: boolean; hidden?: boolean }> = [
  { unlocked: false, hidden: false },
  { unlocked: true, hidden: false },
  { unlocked: false, hidden: true },
  { unlocked: true, hidden: true },
];

describe('暗门连点 × 重进设置页：整条链只该有「翻转隐藏标记」一个效果', () => {
  for (const start of starts) {
    for (const taps of seqs) {
      const label = `开局 u=${start.unlocked ? 1 : 0} h=${start.hidden ? 1 : 0}，连点 [${taps}]`;
      /* 影子模型逐下推进（含 2 秒窗口外的重新计数、残点跨段累计），再拿实测对账：
         · **重进之后**只剩本机标记 ⇒ revealed 归零，未开通设备必然不可见
           （第一版把只在内存里的 `revealed` 当成持久量写进公式，u=0 那 10 行全是假红）；
         · **同一屏内**才看得到临时放出。 */
      it(label, () => {
        const reads = drive({ ...start, taps });
        expect(reads.length, `${label} 读数条数应与连点段数一致`).toBe(taps.length);
        let model = { unlocked: !!start.unlocked, hidden: !!start.hidden, revealed: false };
        let pending = 0;
        for (let t = 0; t < taps.length; t += 1) {
          /* 重进设置页会换掉 `<h1>` 这个 DOM 节点，React 按节点复用 state，于是钩子里的
             `taps/last` 计数器跟着归零 —— 所以**每段独立计数**，上一段的残点不带过来。
             （影子模型第一版按「跨段累计」算，[2,8] 这类行因此被判成触发两次而假红。） */
          pending = 0;
          for (let i = 0; i < taps[t]; i += 1) {
            pending += 1;
            if (pending === TRIGGER) { pending = 0; model = fire(model); }
          }
          const r = reads[t];
          expect(r.hidden, `${label} 前 ${t + 1} 段后的隐藏标记`).toBe(model.hidden);
          expect(r.liveShown, `${label} 前 ${t + 1} 段后的当屏可见性`).toBe(!model.hidden && (model.revealed || model.unlocked));
          expect(r.shown, `${label} 前 ${t + 1} 段后重进设置的可见性`).toBe(model.unlocked && !model.hidden);
          expect(r.unlocked, `${label} 前 ${t + 1} 段后开通态被改动`).toBe(!!start.unlocked);
          expect(r.enabled, `${label} 前 ${t + 1} 段后接管状态被改动`).toBe(false);
          // drive() 在这条读数之后卸载并重新挂载了设置页 ⇒ revealed 是纯内存态，必须归零。
          model = { ...model, revealed: false };
        }
      });
    }
  }
});

describe('曾经那条死路：已开通+已藏，必须还能出得来', () => {
  it('u=1,h=1 → 连点 5 下 → 块回来且清掉隐藏标记', () => {
    const [r] = drive({ unlocked: true, hidden: true, taps: [5] });
    expect(r.shown, '已开通+已藏，连点 5 下该放回来').toBe(true);
    expect(r.hidden, '放回来就该清掉隐藏标记').toBe(false);
    expect(r.unlocked, '放回来不该顺手撤销开通').toBe(true);
  });

  it('u=1,h=0 → 连点 5 下 → 收起并置隐藏标记（第一下手势就生效）', () => {
    const [r] = drive({ unlocked: true, hidden: false, taps: [5] });
    expect(r.shown).toBe(false);
    expect(r.hidden).toBe(true);
  });

  it('收回去再放回来，反复三轮都不留卡死态', () => {
    unlockLocalSystem(KEY);
    let view = render(<SettingsPage />);
    for (let round = 0; round < 3; round += 1) {
      expect(blockShown(), `第${round + 1}轮开局应显示`).toBe(true);
      tap(5); view.unmount(); view = render(<SettingsPage />);
      expect(blockShown(), `第${round + 1}轮收起后不该显示`).toBe(false);
      expect(isLocalSystemHidden()).toBe(true);
      tap(5); view.unmount(); view = render(<SettingsPage />);
      expect(blockShown(), `第${round + 1}轮再点该回来`).toBe(true);
      expect(isLocalSystemHidden(), '回来后隐藏标记必须清掉，否则下一轮又成死路').toBe(false);
    }
    view.unmount();
  });

  it('藏着的时候去点「AI 分析」不受影响：暗门不改生成方式（仍按已开通+未勾选=云端）', () => {
    unlockLocalSystem(KEY);
    setLocalSystemHidden(true);
    render(<SettingsPage />);
    expect(blockShown()).toBe(false);
    expect(isLocalSystemEnabled(), '藏着也不等于开着本地引擎').toBe(false);
    expect(isOfflineMode()).toBe(false);
  });
});

describe('连点节奏：2 秒窗口与「差一下不算」的边界', () => {
  /* 矩阵用的是同步连点（同一批事件里点完），那只是最快的一种。真人会点慢，
     也可能中途停下来 —— 这一组用假时钟把节奏钉住。 */
  const slowTap = (n: number, gapMs: number) => {
    for (let i = 0; i < n; i += 1) {
      fireEvent.click(screen.getByRole('heading', { name: '设置' }));
      vi.advanceTimersByTime(gapMs);
    }
  };

  it('每下间隔 300ms、共 5 下：窗口内该照常触发', () => {
    vi.useFakeTimers();
    try {
      unlockLocalSystem(KEY);
      render(<SettingsPage />);
      expect(blockShown()).toBe(true);
      slowTap(5, 300);
      expect(blockShown(), '正常手速的连点该收起来').toBe(false);
      expect(isLocalSystemHidden()).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it('第 4、5 下之间隔了 2.5 秒：重新数，不该触发', () => {
    vi.useFakeTimers();
    try {
      unlockLocalSystem(KEY);
      render(<SettingsPage />);
      slowTap(4, 100);
      vi.advanceTimersByTime(2500);        // 超过 2 秒窗口
      slowTap(1, 0);                       // 补第 5 下 → 实际只算第 1 下
      expect(blockShown(), '零散地点满 5 下不该放出/收起').toBe(true);
      expect(isLocalSystemHidden(), '更不该因此置上隐藏标记').toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it('恰好 2 秒整仍算一次连点（窗口是「超过」才重置，不是「达到」）', () => {
    vi.useFakeTimers();
    try {
      unlockLocalSystem(KEY);
      render(<SettingsPage />);
      slowTap(5, 2000);
      expect(isLocalSystemHidden(), '间隔恰为 2000ms 时 5 下应成立').toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it('点 4 下后离开页面再回来：计数归零，从头数起', () => {
    unlockLocalSystem(KEY);
    let view = render(<SettingsPage />);
    tap(4);
    view.unmount();
    view = render(<SettingsPage />);       // 重进换掉 h1 节点 → 计数器随 state 一起没了
    tap(1);
    expect(isLocalSystemHidden(), '跨页面的 4+1 下不该拼成一次手势').toBe(false);
    tap(4);
    expect(isLocalSystemHidden(), '重进后重新点满 5 下才生效').toBe(true);
    view.unmount();
  });
});

describe('「自己选择开不开」：勾选才是唯一能改变接管状态的动作', () => {
  it('已开通的设备：勾上才接管，取消就切回云端，底层开关一起归零', () => {
    unlockLocalSystem(KEY);
    render(<SettingsPage />);
    const box = checkbox();
    expect(box, '已开通设备默认就该看得见勾选框').toBeTruthy();
    expect(isLocalSystemEnabled(), '刚进页面不该自动接管').toBe(false);
    fireEvent.click(box!);
    expect(isLocalSystemEnabled()).toBe(true);
    expect(isOfflineMode()).toBe(true);
    fireEvent.click(checkbox()!);
    expect(isLocalSystemEnabled()).toBe(false);
    expect(isOfflineMode(), '取消勾选要真的把底层开关关掉，不留残留').toBe(false);
  });

  it('未开通的设备：连点 5 下只放出密钥框，绝不凭空开通', () => {
    render(<SettingsPage />);
    expect(blockShown(), '没走暗门前不该有这块').toBe(false);
    tap(5);
    expect(blockShown(), '连点 5 下该放出解锁块').toBe(true);
    expect(screen.queryByLabelText('本地系统密钥'), '里面应是密钥框').toBeTruthy();
    expect(checkbox(), '没输对密钥前不该有勾选框').toBeNull();
    expect(isLocalSystemUnlocked(), '暗门本身不开通任何东西').toBe(false);
    expect(isLocalSystemEnabled()).toBe(false);
  });

  it('临时放出态不持久：重进设置页又藏回去（除非本机已开通）', () => {
    let view = render(<SettingsPage />);
    tap(5);
    expect(blockShown(), '这一屏该看得见').toBe(true);
    view.unmount();
    view = render(<SettingsPage />);
    expect(blockShown(), '未开通设备的放出态不该活过一次重进').toBe(false);
    view.unmount();
  });
});
