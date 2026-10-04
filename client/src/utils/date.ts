/** 北京时间下取公历年(用于“今年”边界)。独立成小模块，避免把历法引擎带进首屏主包。 */
export function chinaYear(value: string | Date): number {
  const date = typeof value === 'string' ? new Date(value) : value;
  return new Date(date.getTime() + 8 * 60 * 60 * 1000).getUTCFullYear();
}
/** 北京时间下的公历年月(记录创建时的“现在”，滚动十二个月的起点)。 */
export function chinaYearMonth(value: string | Date): { year: number; month: number } {
  const date = typeof value === 'string' ? new Date(value) : value;
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1 };
}
/** 北京时间下的年月日，month/day 为 1 基。界面里凡是要和排盘结果(流年、交运日)比「今天」的，
 *  都必须走这里：设备时区不是东八区时，直接读本地 getFullYear/getMonth/getDate 会在
 *  「UTC 16:00 之后北京已是次日」那一整天里错一天，年末交运的人会被整段报成上一柱。 */
export function chinaDateParts(value: string | Date): { year: number; month: number; day: number } {
  const date = typeof value === 'string' ? new Date(value) : value;
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}
/** 北京时间下的年月日时分，month/day 为 1 基、hour 0–23、minute 0–59。
 *  buildLabel 这类要把时刻读成人话的地方必须走它：本地 getHours()/getDate() 在非 +08
 *  设备上会比北京早若干小时，跨午夜那一刻日期还会差一天。 */
export function chinaDateTimeParts(value: string | Date): { year: number; month: number; day: number; hour: number; minute: number } {
  const date = typeof value === 'string' ? new Date(value) : value;
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return {
    year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(), minute: shifted.getUTCMinutes(),
  };
}
/** 北京时间下的 ISO 日期「YYYY-MM-DD」，月日补零 —— 与存量 onsetDate/endDate 同形态可直接比较。 */
export function chinaYmd(value: string | Date): string {
  const { year, month, day } = chinaDateParts(value);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
