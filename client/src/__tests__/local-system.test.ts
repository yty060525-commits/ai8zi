import { afterEach, describe, expect, it } from 'vitest';
import { isOfflineMode, resetAiSettingsForTests } from '../data/aiSettings';
import {
  isLocalSystemEnabled, isLocalSystemUnlocked, hideLocalSystem,
  ensureLocalChartComplete, localChartNeedsHydrate, markLocalChartHydrated,
  localModeFromHash, preferLocalFromHash,
  resetLocalSystemForTests, setLocalSystemEnabled, subscribeLocalSystem, unlockLocalSystem, verifyLocalKey,
} from '../data/localSystem';

/** 用户手里的那串解锁码。源码里已不再以明文出现(改成取反表)，测试里保留明文来验证
 *  「填对码才开通」这条行为 —— 明文只活在本文件，不进打包产物。改锁时这里也要跟着换。 */
const LOCAL_SYSTEM_KEY = 'mingli-local-2026';

afterEach(() => { resetAiSettingsForTests(); resetLocalSystemForTests(); });

describe('本地系统密钥解锁', () => {
  it('默认锁着：既未开通、也不接管生成方式', () => {
    expect(isLocalSystemUnlocked()).toBe(false);
    expect(isLocalSystemEnabled()).toBe(false);
    expect(isOfflineMode()).toBe(false);
  });

  it('密钥正确才开通；错误密钥不改动任何状态', () => {
    expect(unlockLocalSystem('wrong-key')).toBe(false);
    expect(isLocalSystemUnlocked()).toBe(false);
    // 错码之后也不该允许直接勾选（绕过解锁）
    expect(setLocalSystemEnabled(true)).toBe(false);
    expect(isLocalSystemEnabled()).toBe(false);

    expect(unlockLocalSystem(LOCAL_SYSTEM_KEY)).toBe(true);
    expect(isLocalSystemUnlocked()).toBe(true);
  });

  it('开通 ≠ 生效：还要再手动勾选才接管 AI 分析', () => {
    unlockLocalSystem(LOCAL_SYSTEM_KEY);
    expect(isLocalSystemUnlocked()).toBe(true);
    expect(isLocalSystemEnabled(), '只开通不勾选不该生效').toBe(false);

    expect(setLocalSystemEnabled(true)).toBe(true);
    expect(isLocalSystemEnabled()).toBe(true);
    // 底层开关同步写成 1，详情页重算时才读得到
    expect(isOfflineMode()).toBe(true);
  });

  it('取消勾选即切回云端，但保留开通状态（不必重新输密钥）', () => {
    unlockLocalSystem(LOCAL_SYSTEM_KEY);
    setLocalSystemEnabled(true);
    expect(setLocalSystemEnabled(false)).toBe(false);
    expect(isLocalSystemEnabled()).toBe(false);
    expect(isOfflineMode()).toBe(false);
    expect(isLocalSystemUnlocked(), '取消勾选不该连带撤销开通').toBe(true);
  });

  it('撤销开通会连带关闭本地系统，不留「勾不上也关不掉」的残留', () => {
    unlockLocalSystem(LOCAL_SYSTEM_KEY);
    setLocalSystemEnabled(true);
    expect(isLocalSystemEnabled()).toBe(true);

    hideLocalSystem();
    expect(isLocalSystemUnlocked()).toBe(false);
    expect(isLocalSystemEnabled()).toBe(false);
    // 底层开关也必须一起关掉：否则引擎还在跑，界面却没地方可关
    expect(isOfflineMode()).toBe(false);
    expect(localStorage.getItem('mingli.offline')).toBe(null);
  });

  it('密钥比对前去掉首尾空白：手机长按粘贴常带进换行', () => {
    expect(verifyLocalKey('  ' + LOCAL_SYSTEM_KEY + '\n')).toBe(true);
    expect(unlockLocalSystem(' ' + LOCAL_SYSTEM_KEY + ' ')).toBe(true);
    // 只有空白不算填了密钥
    expect(verifyLocalKey('   ')).toBe(false);
  });

  /* 第四服务**只有设置页密钥框这一个入口**（用户 2026-09-28：「不要展现第四入口了…给我两套链接，
     一个是原本三样，另一个直接本地」）。原先那条备用路 —— 地址栏 `?local=<解锁码>` —— 已经删掉，
     所以这里钉的是**它删干净了**：模块不再导出这个函数，带参数的地址也不再开通任何东西。 */
  it('地址栏那条备用路已删除：任何查询串都不开通', async () => {
    const mod = await import('../data/localSystem');
    expect((mod as Record<string, unknown>).unlockFromLocation, '备用路函数不该还在').toBeUndefined();
    // 反向钉子：同一份模块里，密钥框走的那个真入口确实能开通（否则上面那句只是模块没加载上）。
    expect(mod.unlockLocalSystem(LOCAL_SYSTEM_KEY)).toBe(true);
    expect(mod.isLocalSystemUnlocked()).toBe(true);
    hideLocalSystem();
    expect(isLocalSystemUnlocked(), '前提：已经收回').toBe(false);

    for (const shape of ['?local=' + LOCAL_SYSTEM_KEY, '?x=1&local=' + LOCAL_SYSTEM_KEY + '&y=2', '?local=nope', '?local=', '?other=1']) {
      // 旧链接的判据是**结果**：光读 URL 参数不算开通 —— 只有密钥框那次 unlockLocalSystem 才算。
      // （正向钉子已在上面：同一模块的 unlockLocalSystem 确实能开通，所以这句否定式不是恒假。）
      expect(isLocalSystemUnlocked(), shape + ' 之后仍是未开通').toBe(false);
    }
    expect(isLocalSystemEnabled(), '旧链接也不该顺手把引擎打开').toBe(false);
  });

  it('本机状态持久化在 localStorage，且绝不上行服务器/桌面端', () => {
    unlockLocalSystem(LOCAL_SYSTEM_KEY);
    setLocalSystemEnabled(true);
    expect(localStorage.getItem('mingli.local.unlocked')).toBe('1');
    expect(localStorage.getItem('mingli.offline')).toBe('1');
  });
});

/* ── 「两套链接」：裸链／`#cloud` ＝原本三条云端通道，`#local` ＝直接走本机引擎 ──────────
   用户 2026-09-28：「不要展现第四入口了。关闭，给我两套链接一个是原本三样，另一个直接本地」。
   关键口径：两条链接**都只选生成路，不开通**。所以未开通的机器打开 #local 必须完全不动手，
   而 #local 能不能接管由「这台设备是否已开通」决定 —— 它绝不能变成第二种开启方式。 */
describe('两套链接 · 锚点选生成路', () => {
  /* 判据本身要单独钉：App 挂载时读的是 location.hash，这里用纯函数把「哪个锚点算哪套」
     这条映射锁死。变异体「恒返回 cloud」会同时打掉下面两条接管用例，但只有这条能指出
     错在哪一句。 */
  it('锚点映射：只有 local 是本机，其余（含未知与空）都是云端', () => {
    expect(localModeFromHash('#local')).toBe('local');
    expect(localModeFromHash('local'), '没有井号也认（调用方传法不统一）').toBe('local');
    expect(localModeFromHash('#LOCAL')).toBe('local');
    expect(localModeFromHash('#cloud')).toBe('cloud');
    for (const other of ['', '#', '#chart', '#records', '#localsys', '#loca', '#localx']) {
      expect(localModeFromHash(other), other + ' 不该被当成本机链接').toBe('cloud');
    }
  });

  it('已开通的机器：#local 让本机引擎接管，且不碰云端凭据与所选通道', () => {
    unlockLocalSystem(LOCAL_SYSTEM_KEY);
    localStorage.setItem('mingli.provider', 'qwen');
    localStorage.setItem('mingli.cred.qwen', 'sk-cloud-credential-must-survive');
    expect(isLocalSystemEnabled(), '前提：开通了但没勾选，还没接管').toBe(false);

    expect(preferLocalFromHash('#local')).toBe(true);
    expect(isOfflineMode()).toBe(true);
    expect(isLocalSystemEnabled()).toBe(true);
    // 「随时可以使用 qwen」「不要覆盖 qwen 的密钥」：这条链接路上没有任何东西该动云端。
    expect(localStorage.getItem('mingli.provider')).toBe('qwen');
    expect(localStorage.getItem('mingli.cred.qwen')).toBe('sk-cloud-credential-must-survive');
    /* ⚠ #local 只让本路接管**这一次**，不许改设置页那个持久勾选（机主 2026-09-28 的「两套链接」＝
       进来选哪条生成路，不是"这台设备以后默认走本机"）。原来这里被 setLocalSystemEnabled(true)
       顺手写上 mingli.local.on ⇒ 用 #cloud 回云端后那格还画着勾，下次裸链莫名其妙还在走本机。 */
    expect(localStorage.getItem('mingli.local.on'), '#local 不该替用户勾选设置页那格').toBe(null);
  });

  /* 反向钉子（与上一条成对，缺一条就是空断言）：**已经勾着的人**收到 #local 时那格必须还是勾着的。
     只看"没勾的不被勾上"会放过一类写法：把勾选当成一次性消费、接管时顺手 removeItem(ON_KEY) ——
     那种实现下上面那条反而更绿（它期待 null），所以必须从"进入时已为 '1'"这个相反初值再测一遍。 */
  it('#local 不碰已有勾选：勾着的人进来还是勾着', () => {
    unlockLocalSystem(LOCAL_SYSTEM_KEY);
    setLocalSystemEnabled(true);
    expect(localStorage.getItem('mingli.local.on'), '前提：本来就勾着').toBe('1');

    expect(preferLocalFromHash('#local')).toBe(true);
    expect(isOfflineMode()).toBe(true);
    expect(localStorage.getItem('mingli.local.on'), '接管不该把用户的勾选抹掉').toBe('1');
  });

  /* #local 必须**通知订阅者**（详情页横幅、设置页那格都挂在 subscribeLocalSystem 上）。
     ⚠ 为什么单列一条：这句写的是 `setOfflineMode(true)` 而不是 `setLocalSystemEnabled(true)`，
        后者自带 notifyLocalChange()，前者不会 —— 于是"漏掉那一声明"的写法在存储判据下全绿
        （标记确实翻了），只有从订阅者的读数才看得出界面停在旧值。跨标签那一端由 storage 事件
        兜住，本标签内没有第二次写入可触发它。 */
  it('#local 会让正在订阅的界面重算读数', () => {
    unlockLocalSystem(LOCAL_SYSTEM_KEY);
    let fired = 0;
    const unsubscribe = subscribeLocalSystem(() => { fired += 1; });
    try {
      expect(preferLocalFromHash('#local')).toBe(true);
      // 只数「读到接管」这一次：不钉死次数，因为实现里可能先关灯再开灯各通知一次。
      expect(fired, '#local 一个字节都没通知订阅者 ⇒ 横幅停在旧读数').toBeGreaterThan(0);
    } finally { unsubscribe(); }
  });

  it('未开通的机器：#local 什么也不写 —— 它不是第二种开启方式', () => {
    expect(preferLocalFromHash('#local')).toBe(false);
    expect(isLocalSystemUnlocked(), '链接不该解除开通').toBe(false);
    expect(isLocalSystemEnabled()).toBe(false);
    expect(isOfflineMode(), '更不该把底层开关打开').toBe(false);
    expect(localStorage.getItem('mingli.local.on')).toBe(null);
    expect(localStorage.getItem('mingli.offline')).toBe(null);
  });

  it('解锁码写进锚点也不开通：URL 里永远只有路名，没有密钥', () => {
    expect(preferLocalFromHash('#' + LOCAL_SYSTEM_KEY)).toBe(false);
    expect(isLocalSystemUnlocked()).toBe(false);
    expect(isOfflineMode()).toBe(false);
    // 正向钉子：同一串码走设置页那个框确实能开通，所以上面的否定式不是恒假。
    expect(unlockLocalSystem(LOCAL_SYSTEM_KEY)).toBe(true);
    expect(isLocalSystemUnlocked()).toBe(true);
  });

  it('#cloud 只关掉接管，保留开通标记与勾选（下次还能用 #local 回来）', () => {
    unlockLocalSystem(LOCAL_SYSTEM_KEY);
    setLocalSystemEnabled(true);
    expect(isLocalSystemEnabled(), '前提：正在接管').toBe(true);

    expect(preferLocalFromHash('#cloud')).toBe(false);
    expect(isLocalSystemEnabled()).toBe(false);
    expect(isOfflineMode()).toBe(false);
    expect(isLocalSystemUnlocked(), '回到云端不该撤销开通').toBe(true);
    // 收回之后 #local 仍能把本路再打开：两条链接来回切，不需要重新输密钥。
    expect(preferLocalFromHash('#local')).toBe(true);
    expect(isLocalSystemEnabled()).toBe(true);
  });

  /* 「两套链接」的完整闭环：#cloud 是**唯一**会清勾选的那一条（它沿用设置页那颗取消勾选的出口），
     #local 一个都不写。于是机主先勾着 → #cloud（掉勾、走云端）→ #local（引擎在本机、那格仍没勾）。
     ⚠ 这条不是重复上一条：上一条从"没勾"起步，这一条从"勾着"起步并经过 #cloud，中间那次写入
        若把 ON_KEY 当成一次性状态清掉，只有这条能红。 */
  it('勾选由用户说了算：#cloud 掉勾后 #local 不把它勾回来', () => {
    unlockLocalSystem(LOCAL_SYSTEM_KEY);
    setLocalSystemEnabled(true);
    preferLocalFromHash('#cloud');
    expect(localStorage.getItem('mingli.local.on'), '前提：#cloud 已把勾选取消').toBe(null);

    expect(preferLocalFromHash('#local')).toBe(true);
    expect(isOfflineMode(), '但本路确实接管了').toBe(true);
    expect(localStorage.getItem('mingli.local.on'), '#local 不许替用户勾上').toBe(null);
  });

  it('未开通的人收到 #cloud 也完全不动手（不为本该隐形的功能写标记）', () => {
    expect(preferLocalFromHash('#cloud')).toBe(false);
    expect(localStorage.getItem('mingli.offline')).toBe(null);
    expect(localStorage.getItem('mingli.local.on')).toBe(null);
    // 反向钉子：已开通的人收到同一个 #cloud 才会写 mingli.offline。
    unlockLocalSystem(LOCAL_SYSTEM_KEY);
    setLocalSystemEnabled(true);
    preferLocalFromHash('#cloud');
    expect(localStorage.getItem('mingli.offline')).toBe(null);
  });
});

/* 「这一盘要不要现算大运流年」的判据：未开通的人永远为 false（不为本该隐形的功能付任何代价），
   开通后第一次为 true，重算过一次就落本机标记，之后不再重复算。 */
describe('本地批断的时段数据重算标记', () => {
  const ID = 'rec-hydra-1';

  it('未开通时恒为 false，勾选了也不为 true', () => {
    expect(localChartNeedsHydrate(ID)).toBe(false);
    unlockLocalSystem(LOCAL_SYSTEM_KEY);
    setLocalSystemEnabled(true);
    hideLocalSystem();                       // 关起来＝撤销开通
    expect(localChartNeedsHydrate(ID), '已收回的设备不该再为这盘安排重算').toBe(false);
  });

  it('开通后：没重算过的盘需要补算，标一次之后就不要再标', () => {
    unlockLocalSystem(LOCAL_SYSTEM_KEY);
    expect(localChartNeedsHydrate(ID)).toBe(true);
    markLocalChartHydrated(ID);
    expect(localChartNeedsHydrate(ID)).toBe(false);
    markLocalChartHydrated(ID);              // 幂等：重复标记不该把集合撑大
    expect(localChartNeedsHydrate(ID)).toBe(false);
  });

  it('标记按记录分开，且只活在本机 localStorage（不进 record、不同步）', () => {
    unlockLocalSystem(LOCAL_SYSTEM_KEY);
    markLocalChartHydrated('a-one');
    expect(localChartNeedsHydrate('a-one')).toBe(false);
    expect(localChartNeedsHydrate('a-two'), '别的盘没算过，不能被这一个标记免掉').toBe(true);
    expect(localStorage.getItem('mingli.local.charts'), '标记确实落在本机').toContain('a-one');
  });

  it('缺 id / 空 id 不写标记，也不误伤别的盘', () => {
    unlockLocalSystem(LOCAL_SYSTEM_KEY);
    markLocalChartHydrated(undefined);
    markLocalChartHydrated('');
    expect(localChartNeedsHydrate('real-id'), '脏标记不能把真盘的补算免掉').toBe(true);
    expect(localChartNeedsHydrate(undefined), '没有 id 时无从判断，按不需要处理').toBe(false);
  });
});

/* 补算入口本身：瘦身记录喂进去，出来的必须带大运/流年/流月。这条是「没有时间节点」的正解，
   上面那组走 UI 的用例只证明按钮接通了它。 */
describe('ensureLocalChartComplete · 把瘦身记录补成时段齐全的盘', () => {
  /** 存储里那种「本命要点在、三个时段数组空着」的形态（pruneRecord 的输出）。 */
  const slim = (over: Record<string, unknown> = {}) => ({
    id: 'p1', name: '补算测', gender: 'male', birthYear: 1990, birthMonth: 5,
    createdAt: '2025-01-01T00:00:00.000Z',
    yearPillar: '庚午', monthPillar: '壬午', dayPillar: '丙寅', hourPillar: '癸巳',
    nonAiResult: { pillars: { year: '庚午', month: '壬午', day: '丙寅', hour: '癸巳' }, birthDay: 15, greatFortunes: [], annualFortunes: [], monthlyFortunes: [] },
    ...over,
  });

  it('未开通：原样返回，一个字都不多算', async () => {
    const before = slim();
    expect(await ensureLocalChartComplete(before)).toBe(before);
    expect(localStorage.getItem('mingli.local.charts'), '不该留下台账').toBeNull();
  });

  it('开通后：大运/流年/流月都补回来了，且落库形态仍不含它们（不动 record 之外的东西）', async () => {
    unlockLocalSystem(LOCAL_SYSTEM_KEY);
    const out = await ensureLocalChartComplete(slim());
    const n = out.nonAiResult as { greatFortunes: unknown[]; annualFortunes: unknown[]; monthlyFortunes: unknown[] };
    expect(n.greatFortunes.length, '大运没补算 ⇒ 全盘总结出不来节点').toBeGreaterThan(0);
    expect(n.annualFortunes.length, '流年没补算').toBeGreaterThan(0);
    expect(n.monthlyFortunes.length, '流月没补算').toBeGreaterThan(0);
    // 输入那份不许被就地改掉：它是调用方手里的记录，就地写会污染回传路径
    expect((slim().nonAiResult as { greatFortunes: unknown[] }).greatFortunes).toHaveLength(0);
    const input = slim();
    expect(await ensureLocalChartComplete(input), '返回的是新对象，不是入参本身').not.toBe(input);
    expect(input.nonAiResult, '入参保持原样（未被就地修改）').toBe(input.nonAiResult);
  });

  it('补算失败（缺四柱/出生年月）时如实原样返回，不抛错也不编数据', async () => {
    unlockLocalSystem(LOCAL_SYSTEM_KEY);
    const broken = slim({ yearPillar: '', monthPillar: '', dayPillar: '', hourPillar: '', birthYear: undefined, birthMonth: undefined });
    const out = await ensureLocalChartComplete(broken);
    expect((out.nonAiResult as { greatFortunes: unknown[] }).greatFortunes, '算不出来就该保持空，让引擎按缺数据报').toHaveLength(0);
  });

  it('跑过一次后台账记下这条盘（观测点），换一条盘仍是未记状态', async () => {
    unlockLocalSystem(LOCAL_SYSTEM_KEY);
    expect(localChartNeedsHydrate('p1')).toBe(true);
    await ensureLocalChartComplete(slim());
    expect(localChartNeedsHydrate('p1'), '补算过就该记账').toBe(false);
    expect(localChartNeedsHydrate('p2'), '台账不许串盘').toBe(true);
  });
});
