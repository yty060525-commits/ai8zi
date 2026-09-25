import { afterEach, describe, expect, it } from 'vitest';
import { isOfflineMode, resetAiSettingsForTests } from '../data/aiSettings';
import {
  isLocalSystemEnabled, isLocalSystemUnlocked, hideLocalSystem, unlockFromLocation,
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
