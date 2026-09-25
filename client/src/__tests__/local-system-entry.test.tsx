import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SettingsPage } from '../features/settings/SettingsPage';
import { isOfflineMode, resetAiSettingsForTests } from '../data/aiSettings';
import { isLocalSystemEnabled, isLocalSystemUnlocked, resetLocalSystemForTests, unlockFromLocation, unlockLocalSystem } from '../data/localSystem';
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

// 这一组钉的是**跨版本一直没变的那条底线**：解锁码永远不当云端凭据用。
// （分流版被否掉后改回独立密钥框，如今连密钥框也不摆了 —— 但「不许拿解锁码去存凭据」
//  这条判据一直留着：谁再把两者搅在一起，这里就会红。）
const credInput = () => screen.getByLabelText('Qwen3.8-Flash 访问凭据') as HTMLInputElement;

describe('本地系统入口：与 Qwen 凭据彻底分开', () => {
  it('凭据框只管凭据：占位与另两格一致，页面上没有第二个输入口', () => {
    const { container } = render(<SettingsPage />);
    expect(credInput().placeholder).toBe('粘贴访问凭据');
    // 界面上不留本地系统的任何痕迹（用户：「不要让任何人看得出来有展开方式」）
    expect(container.textContent).not.toContain('本地系统');
    expect(screen.queryByLabelText('本地系统密钥')).toBeNull();
    // 整页不再有「一个框两件事」那套说辞
    expect(document.body.textContent).not.toContain('既不是以 sk- 开头');
    expect(document.body.textContent).not.toContain('识别为本地系统密钥');
  });

  it('在 Qwen 凭据框里填解锁码：既不写凭据、也不开通本地', async () => {
    render(<SettingsPage />);
    fireEvent.change(credInput(), { target: { value: LOCAL_SYSTEM_KEY } });
    fireEvent.click(screen.getAllByRole('button', { name: '保存' })[2]);
    await waitFor(() => expect(screen.getAllByText('未配置').length).toBeGreaterThan(0));
    expect(isLocalSystemUnlocked(), '凭据框不该再认解锁码').toBe(false);
    expect(localStorage.getItem('mingli.cred.qwen')).toBe(null);
    expect(document.body.textContent).not.toContain(LOCAL_SYSTEM_KEY);
  });

  it('解锁码只走地址栏；展开后仍要手动勾选才接管', async () => {
    expect(unlockFromLocation('?local=' + LOCAL_SYSTEM_KEY), '解锁码不对，前提没成立').toBe(true);
    render(<SettingsPage />);
    expect(await screen.findByText('已开通')).toBeTruthy();
    const box = screen.getByRole('checkbox', { name: /使用本地系统/ }) as HTMLInputElement;
    expect(box.checked, '刚开通不该自动启用').toBe(false);
    expect(isLocalSystemEnabled()).toBe(false);
    // 开通只动本机标记，云端凭据状态一个字都不该变
    expect(credInput().placeholder).toBe('粘贴访问凭据');
    fireEvent.click(box);
    await waitFor(() => expect(isLocalSystemEnabled()).toBe(true));
    expect(isOfflineMode()).toBe(true);
  });

  /* 正例钉子：证明上一条的「出现勾选框」真的是地址栏那次解锁带来的，
     而不是这块 UI 恒在。同一段渲染代码，未开通时一个字都不摆。 */
  it('不走地址栏就没有这一节（防止上一条变成恒真）', async () => {
    unlockLocalSystem(' ');
    const { container } = render(<SettingsPage />);
    expect(container.textContent).not.toContain('本地系统');
    expect(screen.queryByRole('checkbox', { name: /使用本地系统/ })).toBeNull();
  });
});
