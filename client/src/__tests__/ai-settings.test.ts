import { afterEach, describe, expect, it } from 'vitest';
import { clearAiCredential, getAiProviderStatus, isOfflineMode, resetAiSettingsForTests, saveAiCredential, setAiProvider, setOfflineMode } from '../data/aiSettings';
import { invoke } from '@tauri-apps/api/core';
import { vi } from 'vitest';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

afterEach(() => resetAiSettingsForTests());

describe('AI settings adapter', () => {
  it('stores credentials behind a status-only interface', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ selectedProvider: 'deepseek', deepseek: 'not_configured', kimi: 'not_configured' }).mockResolvedValueOnce('configured');
    expect(await getAiProviderStatus()).toEqual({ selectedProvider: 'deepseek', deepseek: 'not_configured', kimi: 'not_configured' });
    const result = await saveAiCredential('deepseek', 'test-secret');
    expect(result).toBe('configured');
    expect(result).not.toContain('secret');
    expect(invoke).toHaveBeenCalledWith('save_ai_credential', { provider: 'deepseek', secret: 'test-secret' });
  });

  it('supports selecting either provider and clearing without exposing plaintext', async () => {
    vi.mocked(invoke).mockImplementation(async (command) => command === 'set_ai_provider' ? 'kimi' : command === 'get_ai_provider_status' ? { selectedProvider: 'kimi', deepseek: 'not_configured', kimi: 'configured' } : 'not_configured');
    await saveAiCredential('kimi', 'another-secret');
    expect(await setAiProvider('kimi')).toBe('kimi');
    expect(await getAiProviderStatus()).toEqual({ selectedProvider: 'kimi', deepseek: 'not_configured', kimi: 'configured' });
    expect(await clearAiCredential('kimi')).toBe('not_configured');
    expect(invoke).toHaveBeenCalledWith('clear_ai_credential', { provider: 'kimi' });
  });
});

describe('本地离线（第四路）开关：只如实存取，闸门交给密钥解锁层', () => {
  it('默认关闭：云端通道仍是默认生成方式', () => {
    expect(isOfflineMode()).toBe(false);
  });
  it('开启后持久化在 localStorage，且绝不上行服务器/桌面端（不调用 invoke）', () => {
    vi.mocked(invoke).mockClear();
    expect(setOfflineMode(true)).toBe(true);
    expect(isOfflineMode()).toBe(true);
    expect(localStorage.getItem('mingli.offline')).toBe('1');
    expect(invoke).not.toHaveBeenCalled();
  });
  it('关闭后清掉标记', () => {
    setOfflineMode(true);
    expect(setOfflineMode(false)).toBe(false);
    expect(isOfflineMode()).toBe(false);
    expect(localStorage.getItem('mingli.offline')).toBe(null);
  });
  it('与云端通道选择彼此独立：切离线不改 mingli.provider，切回也不残留', () => {
    setOfflineMode(true);
    localStorage.setItem('mingli.provider', 'deepseek');
    setOfflineMode(false);
    expect(isOfflineMode()).toBe(false);
    // 关闭离线不应顺带清掉云端通道选择
    expect(localStorage.getItem('mingli.provider')).toBe('deepseek');
  });
});
