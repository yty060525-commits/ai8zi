/* ── 本地系统（原「本地离线·第四路」）的密钥解锁层 ─────────────────────────
   本地规则引擎免密、不联网、不消耗额度，但**在界面上完全不存在**：设置页里没有任何提示句、
   没有密钥框、没有按钮。展开方式只有机主本人知道 —— 地址栏里把查询串写成 `?local=<解锁码>`
   并回车，本机才开通这一路；开通后设置页出现「本地系统」那一节，再手动勾选才真的接管「AI 分析」。
   「关起来」把这一节收回、同时把生成方式交还给云端；要再用就得再走一次上面那个地址。
   （用户 2026-09-25 定稿口径：「我要看不出来的隐藏起来。只有我自己知道怎么展开，不要让任何人
   看得出来有展开方式。」此前留过一行明说的入口 + 常驻密钥框，都算"看得出来"，已去掉。）

   **源码与产物里都不出现解锁码明文。** 做法是把解锁码与一个固定掩码异或、以十六进制落盘
   （`EMBEDDED`），比对时还原后比较。必须诚实说明它**不是保密**：
     · 搜不到那串码，常量名也不叫 KEY，界面上更没有任何指向它的线索；
     · 但纯前端逃不过会读 JS 的人 —— 一次异或即可还原。它拦的是**看一眼就发现、误开、随手开**。
   另外这个地址只在**本机的浏览器/桌面 WebView** 里生效：标记写在本机 localStorage，
   不进数据库、不上行服务器、不同步到别的设备，所以别人那边看不到任何痕迹。

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

/** 用解锁码开通：码对则记住本机已开通并返回 true；码错不改动任何状态。
 *  界面上没有调它的地方 —— 唯一调用方是下面的 `unlockFromLocation`（地址栏那条路）。 */
export function unlockLocalSystem(key: string): boolean {
  if (!verifyLocalKey(key)) return false;
  try { localStorage.setItem(UNLOCKED_KEY, '1'); } catch { /* 隐私模式忽略：本会话内仍可用 */ }
  notifyLocalChange();
  return true;
}

/** 「关起来」：把本地系统收回成没展开的样子，**并且一定先让它回到云端**。
 *  用户 2026-09-25 的口径：「我还可以关起来，随时想还可以再输入打开。但我不要其他的隐藏方式。
 *  只要关闭了就默认走 qwen。」—— 所以这里必须先把 `mingli.offline` 关掉，再清掉开通标记；
 *  顺序反了就会留下"界面已经藏起来、引擎还在接管"那种关不掉的状态（§下架那次踩过）。
 *  两个标记都清 = 唯一的再开方式是**重新输一遍密钥**：不再有连点手势，也不再有"藏着但还开着"的
 *  第三种持久状态 —— 那正是上一版被否掉的东西。 */
export function hideLocalSystem(): void {
  setOfflineMode(false);
  try { localStorage.removeItem(ON_KEY); localStorage.removeItem(UNLOCKED_KEY); } catch { /* 隐私模式忽略：本会话内仍按已关处理 */ }
  notifyLocalChange();
}

/** 本地系统当前是否真的在接管「AI 分析」：**既要已开通、又要勾选了**。
 *  两道条件缺一不可 —— 只开通不勾选不生效，勾了但没开通也不生效。 */
export function isLocalSystemEnabled(): boolean {
  return isLocalSystemUnlocked() && isOfflineMode();
}

/* 详情页那句「没密钥」的引导语要在渲染时现读本地系统的状态（见 PersonDetail 的
   keyMissingHintOf），所以这里以取值函数形式转出，别在模块加载时就把它定成常量。 */
export const localSystemUnlocked = isLocalSystemUnlocked;

/* 「这盘能不能出本地批断」：整条第四路在调引擎之前就用它挡空盘，所以判据放在本模块，
   与规则引擎本体（localAnalysis，41 KB）解耦 —— 页面加载阶段只为这句判断去拖整个引擎不值。 */
export const canBuildLocalAnalysis = (record: { nonAiResult?: unknown }): boolean => !!record.nonAiResult;

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
    // 撤销开通时设置页那块整块消失，详情页的读数也得跟着重算。
    if (event.key === null || event.key === UNLOCKED_KEY || event.key === ON_KEY || event.key === OFFLINE_STORAGE_KEY) notifyLocalChange();
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
  try { localStorage.removeItem(UNLOCKED_KEY); localStorage.removeItem(ON_KEY); localStorage.removeItem(CHARTS_KEY); } catch { /* 忽略 */ }
}

/* ── 「这一盘的时段数据补算过了没有」的本机台账 ───────────────────────────────
   背景：存储里的记录是瘦身过的 —— greatFortunes / annualFortunes / monthlyFortunes 三个数组
   落库时清空，读取时才由 hydrate 现算补回（见 clientRepository 的 pruneRecord / hydrateRecords）。
   规则引擎只认传进来的 record.nonAiResult：谁把**未补算**的那份直接交给它，大运流年就是空的，
   于是「全盘总结」里一个年份节点都出不来（用户 2026-09-25 实测报的「没有时间节点」）。
   所以走第四路之前先按这份台账判断要不要补算一次。刻意不往 record.nonAiResult 上加布尔位：
   那个对象会随记录上行服务器、下发别的设备，为本该隐形的功能在同步数据里留痕不值当。
   ⚠ 台账只是**观测点**，不是开关：`ensureLocalChartComplete` 每次都会补算（幂等、确定性），
   用例靠这个数判「真的跑过一次」，别把它读成「没记上就不算」。
   ⚠ 这条路径只在本机已开通时才写；未开通的人这里永远是空的 ⇒ 界面上依旧零痕迹。 */
const CHARTS_KEY = 'mingli.local.charts';
const MAX_HYDRATED_CHARTS = 200;

function readHydratedCharts(): string[] {
  try {
    const raw = localStorage.getItem(CHARTS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string' && id.length > 0) : [];
  } catch { return []; }
}

/** 记下「这条记录的时段数据已经在这台设备上备齐过」。空 id 直接忽略：没有主键就写出一条谁也匹配不上的脏项。 */
export function markLocalChartHydrated(id: string | undefined): void {
  if (!id) return;
  const ids = readHydratedCharts();
  if (ids.includes(id)) return;
  ids.push(id);
  // 有界：换机/长期使用时不至于无限撑大，超出后丢最早的（丢了最多多算一次，无害）。
  const kept = ids.slice(-MAX_HYDRATED_CHARTS);
  try { localStorage.setItem(CHARTS_KEY, JSON.stringify(kept)); } catch { /* 存不下就下次多补算一次 */ }
}

/** 这台设备是否还需要为这条记录现算一次大运/流年。
 *  **未开通的人恒为 false** —— 不为一个在他界面上根本不存在的功能付任何计算代价。 */
export function localChartNeedsHydrate(id: string | undefined): boolean {
  if (!isLocalSystemUnlocked() || !id) return false;
  return !readHydratedCharts().includes(id);
}

/** 走第四路前把这份记录补成时段事实齐全的盘（大运/流年/流月）。存储里那份是瘦身的，直接喂给
 *  规则引擎会一个年份节点都出不来 —— 就是用户报的「没有时间节点」。
 *  · **未开通的人原样返回**：不为一个在他界面上根本不存在的功能多算一个字。
 *  · 每次现算，不查台账、也不看数组是否已非空：时段窗口按**当前时刻**排（见 hydrateRecords 同款
 *    口径），今天已经补算过的盘到了下个月仍该重算；而台账只是观测点，不是开关。
 *  · 补算失败就原样返回 —— 引擎会按「缺该时段数据」如实报，绝不拿空数组硬凑批断。
 *  ⚠ 这里用**动态 import** 取历法引擎：nonAiCalculator 静态依赖 baziOrchestrator，而编排器又要
 *  调本函数；静态引会在打包期形成循环（实测让 `REQUIRED_SECTIONS` 在初始化时为 undefined，
 *  一整批用例连带崩掉）。异步边界能把这个环解开。 */
export async function ensureLocalChartComplete<T extends { id?: string; nonAiResult?: unknown }>(record: T): Promise<T> {
  if (!isLocalSystemUnlocked()) return record;      // 没开通的人：一个字都不多算
  markLocalChartHydrated(record.id);                 // 幂等；没有 id/存不下时只是少记一笔，不影响这次补算
  let calculateNonAi: typeof import('../features/chart/nonAiCalculator').calculateNonAi;
  try {
    ({ calculateNonAi } = await import('../features/chart/nonAiCalculator'));
    const r = record as unknown as { birthYear?: number | string; birthMonth?: number | string; nonAiResult?: { birthDay?: number }; yearPillar?: string; monthPillar?: string; dayPillar?: string; hourPillar?: string; gender?: string; createdAt?: string };
    const nonAiResult = calculateNonAi({
      birthYear: Number(r.birthYear), birthMonth: Number(r.birthMonth), birthDay: r.nonAiResult?.birthDay,
      yearPillar: r.yearPillar ?? '', monthPillar: r.monthPillar ?? '', dayPillar: r.dayPillar ?? '', hourPillar: r.hourPillar ?? '',
    }, r.gender === 'female' ? 'female' : 'male', new Date().toISOString());
    markLocalChartHydrated(record.id);
    return { ...record, nonAiResult } as T;
  } catch {
    return record;
  }
}


/** 界面上唯一的展开方式：地址栏里的 `?local=<解锁码>`。
 *  它**不是**页面上的一个控件 —— 别人盯着设置页看也看不出这里能输什么，所以符合
 *  「只有我自己知道怎么展开」的口径；代价是机主得记住这串地址写法。
 *  在应用挂载前调用（main.tsx）：校验通过就写本机开通标记，随后把查询串抹掉，
 *  于是解锁码不会留在地址栏、历史记录或分享链接里。码不对则什么都不动。
 *  返回 true 只用于让调用方决定要不要把 URL 收拾干净。 */
export function unlockFromLocation(search: string = (typeof location === 'undefined' ? '' : location.search)): boolean {
  const params = new URLSearchParams(search);
  // 判据问的是「有没有带这一项」而不是「参数串里能不能搜到这个词」：
  // ?local(无等号)与 ?local=(空值)都必须原样拒掉，否则不解锁码的人也能把这一节放出来。
  if (!params.has('local') || (params.get('local') ?? '').trim() === '') return false;
  const granted = unlockLocalSystem(params.get('local') ?? '');
  notifyLocalChange();
  return granted;
}

/* 这一节的可见性**只有 `isLocalSystemUnlocked()` 一个来源**：设置页与详情页共用同一个判据。
   展开方式前后换过四回，都记在这儿免得再翻烧饼：①「标题连点 5 下」的暗门 + `mingli.local.hidden`
   （用户嫌手势多余，且入口被藏后找不到输密钥的地方）；②Qwen 凭据框按内容分流（用户否掉：
   「不要直接替换掉原本 qwen 的密钥」）；③独立密钥框常驻、④密钥框配一行明说的提示
   （用户最终否掉：「我要看不出来的隐藏起来，只有我自己知道怎么展开」）。
   现在定稿为 **地址栏 `?local=<解锁码>`**：界面上零线索，见上面的 `unlockFromLocation`。
   旧设备残留的 `mingli.local.hidden` 不再被读，无害。 */
