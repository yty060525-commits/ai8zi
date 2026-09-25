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

   这里只负责**如实存取**这个开关（0/1 与 localStorage 一致），不做任何拦截。
   它是否允许被打开由上层 `localSystem.ts` 的密钥解锁把关：**别在这里加"恒 false"之类的
   暗门** —— 上一版就是这么干的（功能下架时把读写都改成空操作），后果是"入口藏起来了、
   开关却还开着"且界面上再也关不掉。闸门只应有一处，且必须有个看得见的开关与之配对。 */
/** 这个键的**字面量**：给需要监听 localStorage 事件的订阅方用（跨模块只能传字符串，
 *  别处不许再抄一份 'mingli.offline'，改键名时只动这一行）。 */
export const OFFLINE_STORAGE_KEY = 'mingli.offline';
const OFFLINE_KEY = OFFLINE_STORAGE_KEY;
export function isOfflineMode(): boolean {
  try { return localStorage.getItem(OFFLINE_KEY) === '1'; } catch { return false; }
}
export function setOfflineMode(on: boolean): boolean {
  try { if (on) localStorage.setItem(OFFLINE_KEY, '1'); else localStorage.removeItem(OFFLINE_KEY); } catch { /* 隐私模式忽略：本会话内仍可切换 */ }
  return on;
}

/** 测试专用：清空本机(浏览器)凭据与通道选择，避免用例之间互相污染。 */
export function resetAiSettingsForTests(): void {
  try {
    localStorage.removeItem('mingli.provider');
    localStorage.removeItem(OFFLINE_KEY);
    localStorage.removeItem('mingli.local.unlocked');
    localStorage.removeItem('mingli.local.on');
    localStorage.removeItem('mingli.local.hidden');
    for (const p of ['deepseek', 'kimi', 'qwen'] as AiProvider[]) localStorage.removeItem('mingli.cred.' + p);
  } catch { /* 非浏览器环境忽略 */ }
}

