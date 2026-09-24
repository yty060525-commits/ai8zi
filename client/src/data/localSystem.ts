/* ── 本地系统（原「本地离线·第四路」）的密钥解锁层 ─────────────────────────
   本地规则引擎免密、不联网、不消耗额度，但**默认锁着**：要粘贴一串解锁码才能启用，
   填对了才出现「使用本地系统」的勾选框，再手动勾选才真的接管「AI 分析」。
   这样它就从「默认生成方式」退回成一个需要授权才开的旁路生成方式。

   **解锁码写在前端常量里，只做本地比对。** 这是用户 2026-09-25 明确选的方案
   （另两个候选：前端存哈希、服务器下发校验），所以必须诚实认识它的边界：
   代码是公开的(gh-pages 对所有人可见)，这串码拦的是**误开与随手开**，
   拦不住有意去扒包的人 —— 它不是权限控制，是个开关闸。
   真要变成权限，得换成服务器下发校验，那时代码改动集中在 verifyLocalKey 一处。

   刻意不进 AiProvider/ServiceId 枚举、也不上行服务器或桌面端：它是**本机每台设备
   各管各的**生成方式，不该同步，更不该让三条云端通道与服务器去重·前缀 parity 认识
   一个永不出网的 provider。浏览器与桌面 WebView 都有 localStorage，够它持久化。 */
import { isOfflineMode, setOfflineMode } from './aiSettings';

/** 本地系统的解锁码。不经提示词、不进 AI 缓存。改它等于换锁：老设备下次保存即失效。 */
export const LOCAL_SYSTEM_KEY = 'mingli-local-2026';

const UNLOCKED_KEY = 'mingli.local.unlocked';
const ON_KEY = 'mingli.local.on';

/** 解锁码是否匹配。比较前去掉首尾空白：手机上长按粘贴很容易带进一个换行。 */
export function verifyLocalKey(input: string): boolean {
  return input.trim() === LOCAL_SYSTEM_KEY;
}

/** 本机是否已用解锁码开通过本地系统。 */
export function isLocalSystemUnlocked(): boolean {
  try { return localStorage.getItem(UNLOCKED_KEY) === '1'; } catch { return false; }
}

/** 用解锁码开通：码对则记住本机已开通并返回 true；码错不改动任何状态。 */
export function unlockLocalSystem(key: string): boolean {
  if (!verifyLocalKey(key)) return false;
  try { localStorage.setItem(UNLOCKED_KEY, '1'); } catch { /* 隐私模式忽略：本会话内仍可用 */ }
  return true;
}

/** 撤销开通：连带把本地系统关掉并清掉开关标记，避免留下一个勾不上也关不掉的残留状态。 */
export function lockLocalSystem(): void {
  try { localStorage.removeItem(UNLOCKED_KEY); } catch { /* 忽略 */ }
  setLocalSystemEnabled(false);
}

/** 本地系统当前是否真的在接管「AI 分析」：**既要已开通、又要勾选了**。
 *  两道条件缺一不可 —— 只开通不勾选不生效，勾了但没开通也不生效。 */
export function isLocalSystemEnabled(): boolean {
  return isLocalSystemUnlocked() && isOfflineMode();
}

/** 勾选/取消「使用本地系统」。未开通时一律不生效，防止绕过解锁直接把引擎打开。 */
export function setLocalSystemEnabled(on: boolean): boolean {
  if (on && !isLocalSystemUnlocked()) return false;
  try { if (on) localStorage.setItem(ON_KEY, '1'); else localStorage.removeItem(ON_KEY); } catch { /* 忽略 */ }
  return setOfflineMode(on);
}

/** 「本地系统」相关的本机键（解锁标记，以及底层 mingli.offline）一起清掉，供测试与撤销使用。 */
export function resetLocalSystemForTests(): void {
  try { localStorage.removeItem(UNLOCKED_KEY); localStorage.removeItem(ON_KEY); } catch { /* 忽略 */ }
}
