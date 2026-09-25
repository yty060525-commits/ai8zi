/* ── 本地系统（原「本地离线·第四路」）的密钥解锁层 ─────────────────────────
   本地规则引擎免密、不联网、不消耗额度，但**默认锁着**：要先在隐藏入口里粘贴解锁码，
   填对了才出现「使用本地系统」的勾选框，再手动勾选才真的接管「AI 分析」。
   这样它就从「默认生成方式」退回成一个需要授权才开的旁路生成方式。

   **源码里不出现解锁码明文。** 用户 2026-09-25 的要求：「不显示本地启动代码，隐藏起来」。
   做法是把解锁码与一个固定掩码异或、以十六进制落盘（`EMBEDDED`），比对时还原后比较。
   必须诚实说明它**不是保密**，只是不摆在明面上：
     · 源码与打包产物(gh-pages 完全公开)里搜不到那串码，常量名也不叫 KEY；
     · 但纯前端逃不过会读 JS 的人 —— 一次异或即可还原，调试一下就能看破。
   它拦的是**搜到就抄、误开、随手开**；真要当权限用，必须换成服务器下发校验，
   那时改动只集中在 verifyLocalKey 一处，其余调用点不动。

   刻意不进 AiProvider/ServiceId 枚举、也不上行服务器或桌面端：它是**本机每台设备
   各管各的**的生成方式，不该同步，更不该让三条云端通道与服务器去重·前缀 parity 认识
   一个永不出网的 provider。浏览器与桌面 WebView 都有 localStorage，够它持久化。 */
import { isOfflineMode, OFFLINE_STORAGE_KEY, setOfflineMode } from './aiSettings';

/** 解锁码的混淆表（十六进制，两位一字符），不是明文。
 *  改锁＝换这一行：明文每个字符 c → (c ^ 0x5d) 的十六进制。
 *  用异或而不是「0xF 减」：保证任意可打印字符都映射到 [0x00,0x7F]，
 *  不会算出负数、也不会因为少了前导 0 而把长度算错。 */
const EMBEDDED = '3034333a31347031323e3c31706f6d6f6b';
const MASK = 0x5d;

/** 还原解锁码。名字刻意平淡：它在打包产物里只是一段普通的十六进制→字符串转换。 */
function decode(): string {
  let text = '';
  for (let i = 0; i < EMBEDDED.length; i += 2) {
    text += String.fromCharCode(parseInt(EMBEDDED.slice(i, i + 2), 16) ^ MASK);
  }
  return text;
}

const KEY_LEN = 17;

const UNLOCKED_KEY = 'mingli.local.unlocked';
const ON_KEY = 'mingli.local.on';

/** 解锁码是否匹配。比较前去掉首尾空白：手机上长按粘贴很容易带进一个换行。 */
export function verifyLocalKey(input: string): boolean {
  const typed = input.trim();
  if (typed.length !== KEY_LEN) return false;
  const expected = decode();
  // 定长逐字符比较，任一位不同即失败（不早退，避免长度/前缀差异被计时区分）。
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= typed.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

/** 本机是否已用解锁码开通过本地系统。 */
export function isLocalSystemUnlocked(): boolean {
  try { return localStorage.getItem(UNLOCKED_KEY) === '1'; } catch { return false; }
}

/** 用解锁码开通：码对则记住本机已开通并返回 true；码错不改动任何状态。 */
export function unlockLocalSystem(key: string): boolean {
  if (!verifyLocalKey(key)) return false;
  try { localStorage.setItem(UNLOCKED_KEY, '1'); } catch { /* 隐私模式忽略：本会话内仍可用 */ }
  notifyLocalChange();
  return true;
}

/** 撤销开通：连带把本地系统关掉并清掉开关标记，避免留下一个勾不上也关不掉的残留状态。 */
export function lockLocalSystem(): void {
  try { localStorage.removeItem(UNLOCKED_KEY); } catch { /* 忽略 */ }
  setLocalSystemEnabled(false);
  notifyLocalChange();
}

/** 本地系统当前是否真的在接管「AI 分析」：**既要已开通、又要勾选了**。
 *  两道条件缺一不可 —— 只开通不勾选不生效，勾了但没开通也不生效。 */
export function isLocalSystemEnabled(): boolean {
  return isLocalSystemUnlocked() && isOfflineMode();
}

/* 上面这个读数是 localStorage 直读的，React 并不知道它什么时候变。详情页要用它当**一轮分析的
   快照**（见 PersonDetail 的 AIAnalysis）：只在挂载时读一次会留下一个跨页缺口 ——
   用户去设置页取消勾选再返回，那边横幅仍写着「当前为本地系统」、这边却已经切回云端。
   所以这里补一个最小订阅：写路径都经过本文件，写入后逐个通知即可；同时兜住别的标签页。 */
type LocalListener = () => void;
const localListeners = new Set<LocalListener>();
function notifyLocalChange() {
  for (const listener of [...localListeners]) listener();
}
try {
  window.addEventListener('storage', (event) => {
    // 连 HIDDEN_KEY 一起听：撤销开通时那块整块消失，详情页的读数也得跟着重算。
    if (event.key === null || event.key === UNLOCKED_KEY || event.key === ON_KEY || event.key === OFFLINE_STORAGE_KEY || event.key === HIDDEN_KEY) notifyLocalChange();
  });
} catch { /* 非浏览器环境（构建期/Node）没有 window：单进程内不需要跨标签通知 */ }

/** 订阅「本地系统」本机标记的变化，返回退订函数。配合 React 的 useSyncExternalStore 用。 */
export function subscribeLocalSystem(listener: LocalListener): () => void {
  localListeners.add(listener);
  return () => { localListeners.delete(listener); };
}

/** 勾选/取消「使用本地系统」。未开通时一律不生效，防止绕过解锁直接把引擎打开。 */
export function setLocalSystemEnabled(on: boolean): boolean {
  if (on && !isLocalSystemUnlocked()) return false;
  try { if (on) localStorage.setItem(ON_KEY, '1'); else localStorage.removeItem(ON_KEY); } catch { /* 忽略 */ }
  const applied = setOfflineMode(on);
  notifyLocalChange();
  return applied;
}

/** 「本地系统」相关的本机键（解锁标记，以及底层 mingli.offline）一起清掉，供测试与撤销使用。 */
export function resetLocalSystemForTests(): void {
  try { localStorage.removeItem(UNLOCKED_KEY); localStorage.removeItem(ON_KEY); } catch { /* 忽略 */ }
}

/* ── 暗门本身的开关 ────────────────────────────────────────────────────────
   用户 2026-09-25：「要加一个隐藏按钮恢复成原貌」。做法是**再叠一层暗门**而不是摆一个
   看得见的按钮：在标题上连点 5 下已经放出解锁块之后，**再连点 5 下**就把它整块收回、
   页面回到从没被开过的样子。这样外人扫一眼设置页看不到任何「关掉隐藏」的线索，
   而知道节奏的人两下就能收回去。

   `mingli.local.hidden` 一旦置起来就压过一切，包括「已开通就直接显示」那条例外 ——
   这正是它的用途：开着本地引擎的人也要能彻底藏干净。代价要说清楚：**这台设备界面上
   就没有能关本地系统的控件了**，`isLocalSystemEnabled()` 仍会返回 true、批断仍走本机。
   要恢复只需在同一处再连点 5 下（状态不持久化到别处，重进设置页也仍然认这个标记）。 */
const HIDDEN_KEY = 'mingli.local.hidden';

export function isLocalSystemHidden(): boolean {
  try { return localStorage.getItem(HIDDEN_KEY) === '1'; } catch { return false; }
}

/** 切换隐藏态，返回切换后的结果。 */
export function setLocalSystemHidden(hidden: boolean): boolean {
  try { if (hidden) localStorage.setItem(HIDDEN_KEY, '1'); else localStorage.removeItem(HIDDEN_KEY); } catch { /* 隐私模式忽略：本会话内仍可切换 */ }
  return hidden;
}
