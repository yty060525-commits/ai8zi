/* ── 本地系统（第四服务：本机规则引擎）的密钥解锁层 ────────────────────────
   本地规则引擎不联网、不消耗额度，是**第四条生成方式**：与 DeepSeek / Kimi / Qwen 三条云端通道
   并列显示在设置页上，但**不是** AiProvider/ServiceId 里的一条通道。入口就是一个独立的密钥框
   （用户 2026-09-28 定稿口径：「输入密钥就是第四服务，qwen 就不要亮绿色了，不要覆盖 qwen 的密钥，
   随时可以使用 qwen」）。此前 2026-09-25 那版要求界面上完全隐形、只走地址栏 `?local=<解锁码>`，
   已被这次改口取代 —— 隐形的代价实测是**误用**：机主把解锁码粘进 Qwen 凭据框，结果既没开通第四
   服务、又差点把云端凭据覆盖掉。现在两者各有自己的框，一眼分得清。
     · 这个框**只调 unlockLocalSystem**：绝不写 mingli.cred.*，绝不改 mingli.provider；
     · 三条云通道的绿点／「使用中」只由各自的云端凭据决定，本路开没开通都不参与；
     · **开通入口只有设置页那一个密钥框**：地址栏 `?local=<解锁码>` 那条备用路已按用户要求删掉。
       同一批话里的「给我两套链接一个是原本三样，另一个直接本地」不是第三种开通方式，而是
       **进来之后走哪套引擎**：`#cloud`（含裸链）＝云端三通道，`#local`＝本机引擎，且只在
       **该设备已开通**时才接管（见 preferLocalFromHash）。解锁码永远不进 URL，URL 也不解除开通。
   输对密钥只代表**已开通**这一节；还要再手动勾选「使用本地系统」才真的接管「AI 分析」。
   「关起来」把这一节收回、同时把生成方式交还给云端；要再用就在这个框里再输一次。

   **源码与产物里都不出现解锁码明文。** 做法是把解锁码与一个固定掩码异或、以十六进制落盘
   （`EMBEDDED`），比对时还原后比较。必须诚实说明它**不是保密**：
     · 搜不到那串码，常量名也不叫 KEY；界面上只说「密钥」，不提示它的形状；
     · 但纯前端逃不过会读 JS 的人 —— 一次异或即可还原。它拦的是**看一眼就发现、误开、随手开**。
   另外这个标记只写在**本机的浏览器/桌面 WebView** 的 localStorage 里：不进数据库、不上行服务器、
   不同步到别的设备，所以别人那边不会有这一节。

   刻意不进 AiProvider/ServiceId 枚举、也不上行服务器或桌面端：它是**本机每台设备
   各管各的**的生成方式，不该同步，更不该让三条云端通道与服务器去重·前缀 parity 认识
   一个永不出网的 provider。浏览器与桌面 WebView 都有 localStorage，够它持久化。 */
import { isOfflineMode, OFFLINE_STORAGE_KEY, setOfflineMode } from './aiSettings';
import { chinaYear } from '../utils/date';

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
 *  **唯一调用方是设置页「本地系统」那一节的密钥框**（地址栏那条备用路已删）。
 *  它只动本机的开通标记 —— 不碰云端凭据、不碰所选通道。 */
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
   与规则引擎本体（localAnalysis，41 KB）解耦 —— 页面加载阶段只为这句判断去拖整个引擎不值。
   ⚠ 只问「有没有排盘对象」，**不问时段数组有没有内容**：存储里那份是瘦身盘（pruneRecord 把三个
      派生数组清成空数组），拿数组当闸门会把每一条正常存量盘都挡死；而调用方手里若是没补算的那一份，
      引擎自己会按「缺该时段数据」如实报失败，绝不硬凑批断正文（见编排器的 makeLocalRunner）。 */
export const canBuildLocalAnalysis = (record: { nonAiResult?: unknown }): boolean => !!record.nonAiResult;

/* 存储层（clientRepository）在读取路径上要用它剔除陈旧的本机批断，而那里不该为一句判断把整个
   规则引擎静态拖进仓库模块 —— 所以版本号以惰性取值函数转出：`import type` 擦成零字节，函数里的
   `await import` 保持 localAnalysis 独立成块，与原本地 runner 的按需加载同构。
   ⚠ 早于这个字段的存量正文压根没有版本标记（undefined），靠「本机结果 + 版本对不上」这一条
      照样会被剔掉（见 clientRepository 的 stripStaleLocalAnalysis）。 */
export const localEngineVersion = async (): Promise<string> => (await import('./localAnalysis')).LOCAL_ANALYSIS_ENGINE_VERSION;

/* 台账记的是「这台设备已经用当前版本引擎处理过这条盘」，按 recordId 存，不随记录同步。
   为什么需要它：清洗判据（见 clientRepository 的 stripStaleLocalAnalysis）拿
   「正文版本 ≠ 当前版本」剔旧话，剔完必须就地落账 —— 否则每次读取都重新判成陈旧，
   整轮清洗/回写白跑。落账点只有一处：清洗真的改了这条盘。
   ⚠ 早于这个字段的存量正文压根没写版本标记（undefined），按「source==='local' + 版本对不上」
      判照样会被剔掉 —— 所以台账绝不能当成正文有没有标记的证据，它只是防重复清洗的节流阀。
   ⚠ 键在本机 localStorage，不进数据库、不上行，与第四路的解锁标记同一口径。 */
const LOCAL_ENGINE_STAMP = 'mingli.local.engineStamp';
/** 台账是一串 `{ [recordId]: 版本号 }`；解析失败当作空台账(下次读取再刷一遍)。 */
const stampsOf = (): Record<string, string> => {
  try { return JSON.parse(String(globalThis.localStorage?.getItem(LOCAL_ENGINE_STAMP) ?? '{}')) as Record<string, string>; } catch { return {}; }
};
export const localEngineStamped = (id: string, version: string): boolean => stampsOf()[id] === version;
export function markLocalEngineStamped(id: string, version: string): void {
  try {
    const map = stampsOf();
    if (map[id] === version) return;
    map[id] = version;
    globalThis.localStorage?.setItem(LOCAL_ENGINE_STAMP, JSON.stringify(map));
  } catch { /* 无持久化环境：本轮仍会清洗，只是不落账，下次读取再刷一次 */ }
}

/* 上面这个读数是 localStorage 直读的，React 并不知道它什么时候变。详情页要用它当**一轮分析的
   快照**（见 PersonDetail 的 AIAnalysis）：只在挂载时读一次会留下一个跨页缺口 ——
   用户去设置页取消勾选再返回，那边横幅仍写着「当前为本地系统」、这边却已经切回云端。
   所以这里补一个最小订阅：写路径都经过本文件，写入后逐个通知即可；同时兜住别的标签页。 */
type LocalListener = () => void;
const localListeners = new Set<LocalListener>();
/* 通知订阅方。⚠ React 的 useSyncExternalStore 要求「快照变了必须来一次通知」，所以这里**不能**
   按值去重（实测踩过：解锁层加过去重后，跨页那条用例里详情页横幅不再跟随设置页的勾选）。
   ⚠ quietLocalNotifications 只由本文件末尾那个测试钩子加/减，生产路径上恒为 0；它压的是夹具那一对
      「进去时没开通、出来时也没开通」的净零通知，别把它当成"防抖"用在真实写入口上 —— 那等于冻住界面读数。 */
function notifyLocalChange() {
  if (quietLocalNotifications > 0) return;
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

/** 「两套链接」里「直接本地」那一条的锚点：`…/#local`。见 `preferLocalFromHash`。 */
const LOCAL_HASH = 'local';

/** 地址栏锚点 → 这一盘该由哪套引擎批断（纯函数，不碰任何存储，方便把判据本身钉住）。
 *  用户 2026-09-28：「不要展现第四入口了。关闭，给我两套链接一个是原本三样，另一个直接本地」——
 *  所以两条链接**不是两种开通方式**，而是同一个已开通的本路在进来时选哪条生成路：
 *    · `#local`      → 'local'（本机规则引擎）
 *    · `#cloud` / 其它 / 空 → 'cloud'（原本三条云端通道；未知锚点绝不落到本路）
 *  ⚠ 这里没有第三种取值：解锁码永远进不了 URL，本函数也绝不解除开通标记。 */
export function localModeFromHash(hash: string): 'local' | 'cloud' {
  return String(hash).replace(/^#/, '').toLowerCase() === LOCAL_HASH ? 'local' : 'cloud';
}

/** 「两套链接」里「直接本地」那一条：只把接管开关（`mingli.offline`）打开，**不碰勾选标记**。
 *  · 'local' 且已开通 → 本函数返回 true；'local' 但未开通 → 调用方那道闸拦下，一个字节都不写
 *    （这条链接不是开通方式，要开通只能在设置页那个密钥框里粘一次码，见 SettingsPage）。
 *  ⚠ 为什么不能复用 setLocalSystemEnabled(true)（实测踩过，2026-09-28）：那句会把 ON_KEY 一起写上。
 *     勾选框是"这台设备默认走哪条路"的**持久偏好**，由用户在设置页自己改；两条链接只是**这一次进来
 *     选哪条生成路**，不该替用户改偏好 —— 否则机主用 `#cloud` 回到云端后，那格会被之前的 `#local`
 *     悄悄勾上，下次裸链进来莫名其妙还在走本机。
 *  ⚠ 这里走 aiSettings 那颗「离线模式」的同一条出口（setOfflineMode），并**必须补一次
 *     notifyLocalChange()**：跨标签的 storage 事件只对真写入 localStorage 的那一端触发，本标签内
 *     订阅着详情页横幅的组件全靠这一声通知；漏了它就会出现"引擎已经在本机、横幅还写着云端"。
 *  接管态与横幅同源：两边都读 isLocalSystemEnabled() = 已开通 && mingli.offline。 */
function takeOverLocalEngine(): boolean {
  const applied = setOfflineMode(true);
  if (applied) notifyLocalChange();
  return applied;
}

/** 按地址栏锚点选生成路：**只在已经开通的前提下**才允许 `#local` 接管。
 *  · 'cloud' → 只关掉接管开关，**开通标记与勾选都保留**（下次还能用这条链接回来）；未开通的人
 *    收到 #cloud 完全不动手 —— 不该为本该隐形的功能写一个标记。
 *  两条链接都绝不调用任何凭据接口、绝不改 mingli.provider：云端三格的绿点与本路无关。
 *  返回值 = 这次是否让本路接管，调用方据此决定要不要抹掉锚点。 */
export function preferLocalFromHash(hash: string): boolean {
  if (localModeFromHash(hash) === 'cloud') {
    // 未开通的人收到 #cloud 就该完全不动手：不该为本该隐形的功能写一个标记。
    if (!isLocalSystemUnlocked()) return false;
    setLocalSystemEnabled(false);
    return false;
  }
  return isLocalSystemUnlocked() && takeOverLocalEngine();
}

/** 「本地系统」相关的本机键（解锁标记，以及底层 mingli.offline）一起清掉，供测试与撤销使用。 */
export function resetLocalSystemForTests(): void {
  // CHARTS_KEY/LOCAL_ENGINE_STAMP 是文件后面才声明的 const：本函数若在它们初始化前被调用会踩 TDZ，
  // 所以键名用与声明处逐字相同的字面量（三份测试各自的复位里都有这几句，改键名必须同步改这里）。
  try {
    localStorage.removeItem(UNLOCKED_KEY); localStorage.removeItem(ON_KEY);
    localStorage.removeItem('mingli.local.charts'); localStorage.removeItem('mingli.local.engineStamp');
  } catch { /* 忽略 */ }
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

/* 「这盘有没有时段事实可批」的判据。**必须逐数组看**，不能只看 `nonAiResult` 在不在：
   存储里那份是瘦身盘（pruneRecord 把三个派生数组清成空数组，读取时才由 hydrate 补回），
   它 nonAiResult 齐备、数组却全是空的 —— 规则引擎拿它批，大运流年整段是零节点（就是用户报的
   「没有时间节点」）。所以凡是要**真的产出时段正文**的路径，先问这一句，别问那句宽判据。
   ⚠ 视图里那份由 PersonDetail 挂载时的 getBaziRecord→hydrate 负责补全；本判据只负责**如实回答**，
      补算本身走 ensureLocalChartComplete。它不参与 canBuildLocalAnalysis 那道闸门（那句必须宽，
      否则瘦身存量盘一条都进不去），用例拿它核对的是「这一轮发出去的那份盘到底有没有时段事实」。 */
export const hasPeriodFacts = (chart: unknown): boolean => {
  const n = chart as { greatFortunes?: unknown[]; annualFortunes?: unknown[] } | undefined;
  return !!n && Array.isArray(n.annualFortunes) && n.annualFortunes.length > 0
    && Array.isArray(n.greatFortunes) && n.greatFortunes.length > 0;
};

/** 走第四路前把这份记录补成时段事实齐全的盘（大运/流年/流月）。存储里那份是瘦身的，直接喂给
 *  规则引擎会一个年份节点都出不来 —— 就是用户报的「没有时间节点」。
 *  · **未开通的人原样返回**：不为一个在他界面上根本不存在的功能多算一个字。
 *  · 每次现算，不查台账、也不看数组是否已非空：时段窗口按**当前时刻**排（见 hydrateRecords 同款
 *    口径），今天已经补算过的盘到了下个月仍该重算；而台账只是观测点，不是开关。
 *  · 补算失败就原样返回 —— 引擎会按「缺该时段数据」如实报，绝不拿空数组硬凑批断。
 *  ⚠ 这里用**动态 import** 取历法引擎：nonAiCalculator 静态依赖 baziOrchestrator，而编排器又要
 *  调本函数；静态引会在打包期形成循环（实测让 `REQUIRED_SECTIONS` 在初始化时为 undefined，
 *  一整批用例连带崩掉）。异步边界能把这个环解开。 */
export async function ensureLocalChartComplete<T extends { id?: string; nonAiResult?: unknown }>(record: T, now: Date = new Date()): Promise<T> {
  if (!isLocalSystemUnlocked()) return record;      // 没开通的人：一个字都不多算
  let calculateNonAi: typeof import('../features/chart/nonAiCalculator').calculateNonAi;
  try {
    ({ calculateNonAi } = await import('../features/chart/nonAiCalculator'));
    const r = record as unknown as { birthYear?: number | string; birthMonth?: number | string; nonAiResult?: { birthDay?: number }; yearPillar?: string; monthPillar?: string; dayPillar?: string; hourPillar?: string; gender?: string; createdAt?: string };
    const createdYear = r.createdAt ? chinaYear(r.createdAt) : Number.NaN;
    const anchor = Number.isFinite(createdYear) && createdYear > chinaYear(now) ? r.createdAt! : now.toISOString();
    const nonAiResult = calculateNonAi({
      birthYear: Number(r.birthYear), birthMonth: Number(r.birthMonth), birthDay: r.nonAiResult?.birthDay,
      yearPillar: r.yearPillar ?? '', monthPillar: r.monthPillar ?? '', dayPillar: r.dayPillar ?? '', hourPillar: r.hourPillar ?? '',
    }, r.gender === 'female' ? 'female' : 'male', anchor);
    if (hasPeriodFacts(nonAiResult)) markLocalChartHydrated(record.id);
    return { ...record, nonAiResult } as T;
  } catch {
    return record;
  }
}

/* ⚠ 测试专用：把一份盘补成时段齐全，**并且让本机的开通标记一个字都不变**。
   为什么不能直接用 ensureLocalChartComplete + unlockLocalSystem(KEY) 造夹具：那句会顺手把
   `mingli.local.unlocked` 记上，于是「这一台设备到底开没开通第四路」被夹具改掉了 —— 而第四路的
   可见性判据读的就是它（设置页那一整块、详情页横幅、「未配置」引导语全跟着它走），实测有两条用例
   会因此对着一个被夹具搅过的状态空转。解锁码以明文出现在源码里也违反本文件顶部那条禁令。
   所以这里只借模块内私有的 decode() **临时**解锁，算完立刻收回（走 hideLocalSystem，与界面那颗
   「关起来」按钮同一条出口：先关灯、再清标记，顺序反了才会留下"已经藏起来却还在接管"的脏状态）。
   ⚠ 进入时若已开通，说明是**用例自己**按真实入口打开的，钩子绝不允许把它关掉（把标记 restore 成
      进入时的值是一种看着更"安全"的写法，实测它等于每次造夹具都把勾选作废 ⇒ 下一轮压根不发）。
   ⚠ 台账那笔记账留着不回滚，是有意的：它按 recordId 记，归的是这条盘；且只是观测点，不参与判据。
   ⚠ 本函数只做纯计算 + 临时开关，一个字节都不落库（不写记录、不动 aiTasks）：产品自己的读取路径每次
      hydrate 都会重算同样的数组，夹具多补一次不该留下任何只算过一次才有的痕迹。
   ⚠ **不许在组件挂载之后、点「AI 分析」之前调用它**：进出各有一次 notifyLocalChange()，会把详情页在
      「刚读到盘、还没发射」这个窗口里重渲一遍，实测那一渲就把视图里的时段数组换没了，第四路随即挡下
      这一轮（界面提示「本地系统需要先有排盘数据」）。要在页面外补齐，请用下面的 quiet —— 它压的就是这一对
      净零通知，公开的三个写入口（解锁/勾选/关起来）照旧会通知订阅方。 */
export const completeChartForTests = async <T extends { id?: string; nonAiResult?: unknown }>(record: T): Promise<T> =>
  quiet(() => ensureLocalChartComplete(record), !isLocalSystemUnlocked());

/** quiet 的开关：只在"进去时没开通"时才临时解锁，见上面那段禁令。 */
async function quiet<T>(run: () => Promise<T>, needTempUnlock: boolean): Promise<T> {
  quietLocalNotifications += 1;
  try {
    if (needTempUnlock) unlockLocalSystem(decode());
    return await run();
  } finally {
    try { if (needTempUnlock) hideLocalSystem(); } finally { quietLocalNotifications -= 1; }
  }
}
let quietLocalNotifications = 0;


/* 这一节的可见性**只有 `isLocalSystemUnlocked()` 一个来源**：设置页与详情页共用同一个判据。
   展开方式前后换过五回，都记在这儿免得再翻烧饼：①「标题连点 5 下」的暗门 + `mingli.local.hidden`
   （用户嫌手势多余，且入口被藏后找不到输密钥的地方）；②Qwen 凭据框按内容分流（用户否掉：
   「不要直接替换掉原本 qwen 的密钥」—— 这条禁令至今有效，见 local-system-entry.test.tsx）；
   ③独立密钥框常驻、④密钥框配一行明说的提示（当时否掉：「我要看不出来的隐藏起来」）；
   ⑤界面上零线索、只走地址栏 `?local=<解锁码>`（2026-09-25 定稿，2026-09-28 又被否掉：
   机主把解锁码粘进了 Qwen 凭据框 —— 藏得太彻底反而导致误用）。
   **现在定稿为设置页上唯一的密钥框**（第四服务，与三条云通道并列）。
   ⚠ 不要再加第二种入口/第二条 URL 写法：用户 2026-09-28 同一批话里明确说了「不要展现第四入口了」，
      他要的是**两套链接 = 进来之后走云端三通道 / 走本机引擎**，而不是两个开启方式。
   旧设备残留的 `mingli.local.hidden` 与旧链接上的 `?local=` 参数都不再被读，无害。 */
