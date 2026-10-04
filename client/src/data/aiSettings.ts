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
  try {
    // 读取侧同样要 trim，否则「保存/显示」与「真正发请求」用的不是同一份值：
    // 改动前只有写入侧去空白，而存量脏值(带空格或纯空白)仍会被下面的 truthiness 报成
    // 「已配置」，设置页四格亮着灯，deepseekAdapter 却把那份带空白的串发给上游 ⇒ 必失败。
    // trim 后为空就返回 undefined，等于「这条通道没配」，与桌面端、服务器同口径。
    const raw = localStorage.getItem(credKey(provider));
    const trimmed = raw?.trim();
    return trimmed ? trimmed : undefined;
  } catch { return undefined; }
}
export async function saveAiCredential(provider: AiProvider, secret: string): Promise<CredentialStatus> {
  // 与另两端同口径：桌面端 save_ai_credential 见空密钥直接报「密钥不能为空」，服务器 saveProviderKey
  // 要求 key.trim()。网页版过去照原样落库，粘贴时多带一个空格就显示「已配置」，
  // 而那份串发给上游必失败 —— 所以这里既拒绝空白，也顺手去掉首尾空白再存。
  const trimmed = (secret ?? '').trim();
  if (!trimmed) return 'not_configured';
  if (isProdBrowser()) { localStorage.setItem(credKey(provider), trimmed); return 'configured'; }
  return invoke<CredentialStatus>('save_ai_credential', { provider, secret: trimmed });
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

/** 通道显示名：界面正文只放行中文，所以用中文名；服务商英文名只在协议层(模型标识)出现，不外露。
 *  中间不写「·」：那道「只能中文」闸门的白名单里没有中点，带进去会被静默删成「通道一深思」，
 *  界面上等于凭空少一个字 —— 这里直接写成闸门放行的最终形态。 */
export const PROVIDER_LABEL: Record<AiProvider, string> = { deepseek: '通道一深思', kimi: '通道二克米', qwen: '通道三千问' };

/** 测试专用：清空本机(浏览器)凭据与通道选择，避免用例之间互相污染。 */
export function resetAiSettingsForTests(): void {
  try {
    localStorage.removeItem('mingli.provider');
    for (const p of ['deepseek', 'kimi', 'qwen'] as AiProvider[]) localStorage.removeItem('mingli.cred.' + p);
  } catch { /* 非浏览器环境忽略 */ }
}

