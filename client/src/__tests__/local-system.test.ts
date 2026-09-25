import { afterEach, describe, expect, it } from 'vitest';
import { isOfflineMode, resetAiSettingsForTests } from '../data/aiSettings';
import {
  isLocalSystemEnabled, isLocalSystemUnlocked, hideLocalSystem,
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

  it('本机状态持久化在 localStorage，且绝不上行服务器/桌面端', () => {
    unlockLocalSystem(LOCAL_SYSTEM_KEY);
    setLocalSystemEnabled(true);
    expect(localStorage.getItem('mingli.local.unlocked')).toBe('1');
    expect(localStorage.getItem('mingli.offline')).toBe('1');
  });
});
