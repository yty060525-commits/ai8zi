import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SettingsPage } from '../features/settings/SettingsPage';
import { isOfflineMode, resetAiSettingsForTests } from '../data/aiSettings';
import { isLocalSystemEnabled, isLocalSystemUnlocked, resetLocalSystemForTests, unlockLocalSystem } from '../data/localSystem';
import { invoke } from '@tauri-apps/api/core';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

/** 用户手里的解锁码明文，源码里已改成异或表（见 localSystem.ts）。 */
const LOCAL_SYSTEM_KEY = 'mingli-local-2026';

const notConfigured = { selectedProvider: 'deepseek', deepseek: 'not_configured', kimi: 'not_configured', qwen: 'not_configured' };
const happyPath = async (command: string) => command === 'get_ai_provider_status' ? notConfigured
  : command === 'save_ai_credential' ? 'configured'
  : command === 'set_ai_provider' ? 'deepseek'
  : 'not_configured';
vi.mocked(invoke).mockImplementation(happyPath);

afterEach(() => { cleanup(); resetAiSettingsForTests(); resetLocalSystemForTests(); vi.mocked(invoke).mockImplementation(happyPath); vi.clearAllTimers?.(); });

// 这一组钉的是**用户最初那句要求**：「我要的是输入之后打开本地的 ui，自己选择开不开，
// 而不是直接替换掉原本 qwen 的密钥。」分流逻辑后来被撤掉了(改回独立密钥框)，
// 但下面这几条不许删 —— 谁再把解锁码塞回凭据框，这里就会红。
const credInput = () => screen.getByLabelText('Qwen3.8-Flash 访问凭据') as HTMLInputElement;
const localInput = () => screen.getByLabelText('本地系统密钥') as HTMLInputElement;
/** 走一遍暗门：在标题上连点 5 下，让本地系统那块现身。 */
const openSecret = () => {
  const heading = screen.getByRole('heading', { name: '设置' });
  for (let i = 0; i < 5; i += 1) fireEvent.click(heading);
};

describe('本地系统入口：与 Qwen 凭据彻底分开', () => {
  it('解锁块自带独立密钥框，凭据框不再参与分流', () => {
    render(<SettingsPage />);
    openSecret();
    expect(localInput()).toBeTruthy();
    // 凭据框的占位与另两格一致，不写「sk- 开头」之类的分流提示
    expect(credInput().placeholder).toBe('粘贴访问凭据');
    // 整页不再有「一个框两件事」那套说辞
    expect(document.body.textContent).not.toContain('既不是以 sk- 开头');
    expect(document.body.textContent).not.toContain('识别为本地系统密钥');
  });

  it('在 Qwen 凭据框里填解锁码：既不写凭据、也不开通本地（撤回旧的合并分流）', async () => {
    render(<SettingsPage />);
    fireEvent.change(credInput(), { target: { value: LOCAL_SYSTEM_KEY } });
    fireEvent.click(screen.getAllByRole('button', { name: '保存' })[2]);
    await waitFor(() => expect(screen.getAllByText('未配置').length).toBeGreaterThan(0));
    expect(isLocalSystemUnlocked(), '凭据框不该再认解锁码').toBe(false);
    expect(localStorage.getItem('mingli.cred.qwen')).toBe(null);
    expect(document.body.textContent).not.toContain(LOCAL_SYSTEM_KEY);
  });

  it('解锁码只进自己的框；开通后仍要手动勾选才接管', async () => {
    render(<SettingsPage />);
    const heading = screen.getByRole('heading', { name: '设置' });
    for (let i = 0; i < 5; i += 1) fireEvent.click(heading);
    fireEvent.change(localInput(), { target: { value: LOCAL_SYSTEM_KEY } });
    fireEvent.click(screen.getByRole('button', { name: '开通' }));
    await waitFor(() => expect(screen.getByText('已开通')).toBeTruthy());
    const box = screen.getByRole('checkbox', { name: /使用本地系统/ }) as HTMLInputElement;
    expect(box.checked, '刚开通不该自动启用').toBe(false);
    expect(isLocalSystemEnabled()).toBe(false);
    // 开通只动本机标记，云端凭据状态一个字都不该变
    expect(credInput().placeholder).toBe('粘贴访问凭据');
    fireEvent.click(box);
    await waitFor(() => expect(isLocalSystemEnabled()).toBe(true));
    expect(isOfflineMode()).toBe(true);
  });
});
