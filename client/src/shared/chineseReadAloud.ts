/* 中文读法词表 —— 界面/导出正文共用的「把数字念成人话」工具。
 *
 * 为什么单独成模块：cnCount 原先在 PersonDetail、RecordsPage、SettingsPage 各抄一份，
 * 三处字面量一模一样却互不相干，改一处忘另一处就会出现「已配置 零 条」这种同一屏里
 * 空格分词与连写混着来的脏文案。读法属于展示层口径，和 chineseGate(判据) 同层不同职责：
 * 闸门负责「删掉不该有的」，这里负责「把数字写成中文」。 */

const CN_NUMERALS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十'];

/** 计数读法：≤二十 用整体读法(十五)，再大就逐位读(一九九零)。人数/序号够用，年份请走 cnYear。 */
export const cnCount = (n: number): string => (Number.isInteger(n) && n >= 0 && n < CN_NUMERALS.length ? CN_NUMERALS[n] : String(n).split('').map((d) => CN_NUMERALS[+d] ?? d).join(''));

/** 年份逐位读：1984 → 一九八四(命理文本里年份从不按「一千九百…」念)。 */
export const cnYear = (n: number): string => String(n).split('').map((d) => CN_NUMERALS[+d] ?? d).join('');

/** 状态码逐位读：503 → 五零三，界面写成「服务返回五零三」。
 *  与 cnYear 同源但语义不同：HTTP 状态码要逐位念成代号，不能读成「五百零三」。 */
export const cnCode = (status: number | string): string => String(status).split('').map((d) => CN_NUMERALS[+d] ?? d).join('');

/** ≤99 的规范读法：个位原样、十几读「十二」、整十读「二十」、其余读「二十三」。 */
export function cnSmall(n: number): string {
  if (!Number.isFinite(n) || n < 0) return String(n);
  if (n < 10) return CN_NUMERALS[n];
  const tens = Math.floor(n / 10), ones = n % 10;
  return (tens === 1 ? '十' : CN_NUMERALS[tens] + '十') + (ones ? CN_NUMERALS[ones] : '');
}
