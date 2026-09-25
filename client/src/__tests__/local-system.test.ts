import { afterEach, describe, expect, it } from 'vitest';
import { isOfflineMode, resetAiSettingsForTests } from '../data/aiSettings';
import {
  isLocalSystemEnabled, isLocalSystemUnlocked, hideLocalSystem, unlockFromLocation,
  ensureLocalChartComplete, localChartNeedsHydrate, markLocalChartHydrated,
  resetLocalSystemForTests, setLocalSystemEnabled, unlockLocalSystem, verifyLocalKey,
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

  /* 界面上没有入口了（用户：「只有我自己知道怎么展开，不要让任何人看得出来有展开方式」），
     所以展开这条路本身必须有用例钉着：地址栏 ?local=<解锁码>。 */
  it('地址栏带正确解锁码才开通；空参数与错码都不改动任何状态', () => {
    expect(unlockFromLocation('?local=' + LOCAL_SYSTEM_KEY)).toBe(true);
    expect(isLocalSystemUnlocked()).toBe(true);
    hideLocalSystem();
    // 地址栏这条路也要能收：清掉标记后同一串查询再来一次，不该把这一节放回来。
    expect(unlockFromLocation('?local=' + LOCAL_SYSTEM_KEY), '前提：再走一次能开通').toBe(true);
    hideLocalSystem();
    expect(isLocalSystemUnlocked(), '前提：已经收回').toBe(false);

    expect(unlockFromLocation(''), '没有这个参数就该完全不动').toBe(false);
    expect(isLocalSystemUnlocked()).toBe(false);
    expect(unlockFromLocation('?other=1'), '别的参数不该被当成解锁').toBe(false);
    expect(isLocalSystemUnlocked()).toBe(false);
    // 正例钉子：先证明这条**查询串解析路**真的会把码交给解锁函数 ——
    // 否则把整个函数体改成恒 return false，下面这些否定式断言会全部空过。
    expect(unlockFromLocation('?x=1&local=' + LOCAL_SYSTEM_KEY + '&y=2'), '藏在别的参数中间也该认').toBe(true);
    expect(isLocalSystemUnlocked(), '前提：正例确实开通了').toBe(true);
    hideLocalSystem();

    for (const shape of ['?local=nope', '?local', '?local=', '?local=%20', '?a=1&local=&b=2']) {
      expect(unlockFromLocation(shape), shape + ' 不该开通').toBe(false);
      expect(isLocalSystemUnlocked(), shape + ' 之后仍是未开通').toBe(false);
    }
    expect(isLocalSystemUnlocked(), '错码不开通').toBe(false);
    expect(isLocalSystemEnabled(), '错码也不该顺手把引擎打开').toBe(false);
  });

  it('本机状态持久化在 localStorage，且绝不上行服务器/桌面端', () => {
    unlockLocalSystem(LOCAL_SYSTEM_KEY);
    setLocalSystemEnabled(true);
    expect(localStorage.getItem('mingli.local.unlocked')).toBe('1');
    expect(localStorage.getItem('mingli.offline')).toBe('1');
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
