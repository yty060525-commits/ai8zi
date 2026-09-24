import { invoke } from '@tauri-apps/api/core';

export type AiProvider = 'deepseek' | 'kimi' | 'qwen';
export type ServiceId = 'serviceOne' | 'serviceTwo' | 'serviceThree';
export type CredentialStatus = 'configured' | 'not_configured';
export interface AiProviderStatus {
  selectedProvider: AiProvider;
  deepseek: CredentialStatus;
  kimi: CredentialStatus;
  qwen: CredentialStatus;
}


const inTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
const credKey = (provider: AiProvider) => 'mingli.cred.' + provider;
const isProdBrowser = () => !inTauri() && import.meta.env.MODE !== 'test';
export function getBrowserCredential(provider: AiProvider): string | undefined {
  try { return localStorage.getItem(credKey(provider)) ?? undefined; } catch { return undefined; }
}
export async function saveAiCredential(provider: AiProvider, secret: string): Promise<CredentialStatus> {
  if (isProdBrowser()) { localStorage.setItem(credKey(provider), secret); return 'configured'; }
  return invoke<CredentialStatus>('save_ai_credential', { provider, secret });
}

export async function clearAiCredential(provider: AiProvider): Promise<CredentialStatus> {
  if (isProdBrowser()) { localStorage.removeItem(credKey(provider)); return 'not_configured'; }
  return invoke<CredentialStatus>('clear_ai_credential', { provider });
}

export async function getAiProviderStatus(): Promise<AiProviderStatus> {
  if (isProdBrowser()) {
    return { selectedProvider: (localStorage.getItem('mingli.provider') as AiProvider) ?? 'qwen', deepseek: getBrowserCredential('deepseek') ? 'configured' : 'not_configured', kimi: getBrowserCredential('kimi') ? 'configured' : 'not_configured', qwen: getBrowserCredential('qwen') ? 'configured' : 'not_configured' };
  }
  return invoke<AiProviderStatus>('get_ai_provider_status');
}

export async function setAiProvider(provider: AiProvider): Promise<AiProvider> {
  if (isProdBrowser()) { localStorage.setItem('mingli.provider', provider); return provider; }
  return invoke<AiProvider>('set_ai_provider', { provider });
}

export const serviceProvider = (service: ServiceId): AiProvider => service === 'serviceOne' ? 'deepseek' : service === 'serviceTwo' ? 'kimi' : 'qwen';
export const serviceOf = (provider: AiProvider): ServiceId => provider === 'deepseek' ? 'serviceOne' : provider === 'kimi' ? 'serviceTwo' : 'serviceThree';

export async function getServiceStatus(): Promise<{ selectedService: ServiceId; serviceOne: CredentialStatus; serviceTwo: CredentialStatus; serviceThree: CredentialStatus }> {
  const status = await getAiProviderStatus();
  return { selectedService: serviceOf(status.selectedProvider), serviceOne: status.deepseek, serviceTwo: status.kimi, serviceThree: status.qwen };
}

export async function saveServiceCredential(service: ServiceId, secret: string): Promise<CredentialStatus> {
  return saveAiCredential(serviceProvider(service), secret);
}

export async function clearServiceCredential(service: ServiceId): Promise<CredentialStatus> {
  return clearAiCredential(serviceProvider(service));
}

export async function setSelectedService(service: ServiceId): Promise<ServiceId> {
  await setAiProvider(serviceProvider(service));
  return service;
}

/** 通道显示名（与服务器/桌面端一致）。 */
export const PROVIDER_LABEL: Record<AiProvider, string> = { deepseek: 'DeepSeek', kimi: 'Kimi', qwen: 'Qwen3.8-Flash' };

/* ── 本地离线（第四路）开关 ────────────────────────────────────────────────
   「第四路」= 本地规则引擎，免密、不联网、不消耗额度。刻意不进 AiProvider/ServiceId 枚举、
   也不经 set_ai_provider 上行：它是**本机每台设备各管各的**生成方式开关，不该同步、
   更不该让云端三通道 / 服务器 / Rust 的去重·前缀 parity·回退逻辑认识一个永不出网的 provider。
   浏览器与桌面 WebView 都有 localStorage，够它持久化。开启后主「AI 分析」改由本地 runner
   产出，结果照常写进 record.aiTasks（会同步、聊天能引用），并按 source==='local' 打绿点标注。

   **此功能已下架**，设置页入口与详情页本地批断按钮都收起了，所以这里必须**默认关**：
   入口没了而开关还开着，等于用户永远关不掉一个仍在生效的生成方式 —— 点「AI 分析」
   会被本地引擎静默接管，连"切回云端"的开关都不在界面上。旧值一律按关处理，
   已跑过的本地结果仍留在盘上(存量不动)，切回云端后点「AI 分析」即用云端结果覆盖。
   日后重新上架时，连同设置页那一块入口一起恢复即可。 */
const OFFLINE_KEY = 'mingli.offline';
export function isOfflineMode(): boolean {
  // 功能下架期间恒为 false：不再读 localStorage —— 入口没了却让残留的 '1' 继续生效，
  // 用户会被本地引擎静默接管且在界面上找不到任何开关把它关掉。
  try { localStorage.removeItem(OFFLINE_KEY); } catch { /* 隐私模式忽略 */ }
  return false;
}
export function setOfflineMode(on: boolean): boolean {
  try { localStorage.removeItem(OFFLINE_KEY); } catch { /* 隐私模式忽略 */ }
  return false;
}

/** 测试专用：清空本机(浏览器)凭据与通道选择，避免用例之间互相污染。 */
export function resetAiSettingsForTests(): void {
  try {
    localStorage.removeItem('mingli.provider');
    localStorage.removeItem(OFFLINE_KEY);
    for (const p of ['deepseek', 'kimi', 'qwen'] as AiProvider[]) localStorage.removeItem('mingli.cred.' + p);
  } catch { /* 非浏览器环境忽略 */ }
}

