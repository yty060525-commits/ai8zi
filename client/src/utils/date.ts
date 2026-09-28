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
