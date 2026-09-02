import { afterEach, describe, expect, it } from 'vitest';
import { clearAiCredential, getAiProviderStatus, resetAiSettingsForTests, saveAiCredential, setAiProvider } from '../data/aiSettings';
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
