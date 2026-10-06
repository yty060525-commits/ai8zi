/** 当前构建版本：与 sw.js 的缓存号同源(同一次构建生成的同一个时间戳)。
 *  构建时由 vite.config.ts 的 define 注入；测试/开发环境无注入时回退为 unknown，
 *  不至于让 UI 崩掉。 */
import { chinaDateTimeParts } from './date';
import { cnSmall } from '../shared/chineseReadAloud';

export const BUILD_ID: string = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'unknown';

const CN_DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

/* 这里曾有一份私有的 cnSmall(与 shared/chineseReadAloud 那份逐字重复)。缺陷 #96 的教训就是
   同一个读法抄两份、改一处漏一处；穷举比对实测 0-99 两版读数恒等(shared 版对 NaN/负数多一层
   防护，而这里的入参全是 chinaDateTimeParts 拆出的 0-59)，合并掉。CN_DIGITS 留着：年份逐位
   读与十六进制校验码还要用。 */

/** 构建时间戳 → 中文读法。界面正文在正式版口径下不许出现阿拉伯数字与半角符号，
 *  所以版本号也翻成汉字：「二零二六年九月二十二日九时五分」。年逐位读、月日时按中文数读。
 *  同一次构建里 UI 显示与 SW 缓存号是同一个 id，所以看到哪个时间就是哪一版。
 *  ⚠ 年月日时分一律按北京口径取(chinaDateTimeParts)：这里原先直接读本地字段，
 *  非 +08 设备会把同一版构建读成「前一天/前几小时」——而底部版本戳正是用来判断
 *  「手机是不是旧版」的依据，读数差一天就会把人引向错误的结论。 */
export function buildLabel(id: string = BUILD_ID): string {
  if (!/^\d{10,}$/.test(id)) return id;
  const at = new Date(Number(id));
  if (Number.isNaN(at.getTime())) return id;
  const p = chinaDateTimeParts(at);
  // 年份逐位读，补到四位(闰年/极早年份不会短一位)。
  const y = [...String(p.year).padStart(4, '0')].map((d) => CN_DIGITS[+d]).join('');
  return `${y}年${cnSmall(p.month)}月${cnSmall(p.day)}日${cnSmall(p.hour)}时${cnSmall(p.minute)}分`;
}

/** SW 缓存号(mingli-<id>)：这是给运维核对用的机器标识，不参与展示 ——
 *  展示一律走 cacheReadout/cacheLabel 的中文读法，界面上不留拉丁字母与数字。 */
export function cacheLabel(id: string = BUILD_ID): string {
  return 'mingli-' + id;
}

/** git 版本号「提交序号-短哈希」，与 scripts/version.sh 的快照名同源。非 git 构建时为空。
 *  这一串本身是机器标识(要照着它敲 `version.sh restore <同名>`)，所以留在 title 里，
 *  正文用 cnVersion 读成人话。 */
export const GIT_VERSION: string = typeof __GIT_VERSION__ === 'string' ? __GIT_VERSION__ : '';

/** 「6-caa86bd」→「第六版，校验码西阿阿八六比地」：提交序号按中文数读，
 *  哈希逐位念(哈希没有读音，逐位是唯一不丢信息的读法)。字母表里 b/d/p/t/v/z 这类
 *  形状相近的，配一个常用字方便听写；纯展示，核对仍以 title 里的原串为准。 */
const HEX_READ = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九',
  '阿', '比', '西', '地', '衣', '弗'];
export function cnVersion(raw: string): string {
  const m = /^(\d+)-([0-9a-fA-F]+)$/.exec(String(raw ?? '').trim());
  if (!m) return raw;
  const seq = Number(m[1]);
  const head = Number.isFinite(seq) && seq > 0 ? '第' + (seq <= 99 ? cnSmall(seq) : [...String(seq)].map((d) => CN_DIGITS[+d]).join('')) + '版' : '版本' + raw;
  return head + '，校验码' + [...m[2].toLowerCase()].map((c) => /[0-9]/.test(c) ? CN_DIGITS[+c] : HEX_READ[parseInt(c, 16)] ?? c).join('');
}

/** 「已缓存版本」那一行的读法：把 mingli-<构建号> 读成「与本页面同一版缓存 / 第…次构建」，
 *  状态类文本(检测中、无、此环境不支持、读取失败)原样留着——它们本来就是中文。 */
export function cacheReadout(swCache: string, currentId: string = cacheLabel()): string {
  const value = String(swCache ?? '');
  if (!value || value === '检测中' || value === '无' || value === '此环境不支持' || value === '读取失败') return value || '暂无';
  if (value === currentId) return '与本页面同一版缓存';
  const stamp = /^mingli-(\d{10,})$/.exec(value);
  if (stamp) return '第' + buildLabel(stamp[1]) + '那次构建的缓存';
  return '另一版缓存';
}

/** 完整版本标签：有 git 号时优先显示它(可回退)，否则退回构建时间。
 *  两条都是中文读法 —— 底部常驻的版本戳同样属于界面正文。 */
export function versionLabel(): string {
  return GIT_VERSION ? cnVersion(GIT_VERSION) : buildLabel();
}
