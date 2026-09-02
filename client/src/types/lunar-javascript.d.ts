declare module 'lunar-javascript' {
  interface Solar {
    getYear(): number;
    getMonth(): number;
    getDay(): number;
    toYmd(): string;
    getLunar(): Lunar;
  }
  interface Lunar {
    toString(): string;
    getEightChar(): EightChar;
    getYearShengXiao(): string;
    getNextJieQi(wholeDay?: boolean): JieQi;
    getPrevJieQi(wholeDay?: boolean): JieQi;
    getYearInGanZhiExact(): string;
    getMonth(): number;
    getDay(): number;
    getMonthInGanZhiExact(): string;
    getDayJiShen(): string[]; getDayXiongSha(): string[];
    getDaySha(): string; getDayTianShen(): string; getTimeTianShen(): string;
  }
  interface JieQi { getSolar(): Solar; }
  interface EightChar {
    getYear(): string; getMonth(): string; getDay(): string; getTime(): string;
    getYearWuXing(): string; getMonthWuXing(): string; getDayWuXing(): string; getTimeWuXing(): string;
    getYearHideGan(): unknown; getMonthHideGan(): unknown; getDayHideGan(): unknown; getTimeHideGan(): unknown;
    getYearShiShenGan(): string; getMonthShiShenGan(): string; getDayShiShenGan(): string; getTimeShiShenGan(): string;
    getYearShiShenZhi(): unknown; getMonthShiShenZhi(): unknown; getDayShiShenZhi(): unknown; getTimeShiShenZhi(): unknown;
    getYearNaYin(): string; getMonthNaYin(): string; getDayNaYin(): string; getTimeNaYin(): string;
    getDayGan(): string; getYearDiShi(): string; getMonthDiShi(): string; getDayDiShi(): string; getTimeDiShi(): string;
    getYun(gender: number, sect: number): Yun;
  }
  interface Yun { getStartSolar(): Solar; getDaYun(count: number): DaYun[]; }
  interface DaYun { getGanZhi(): string; getStartYear(): number; getEndYear(): number; }
  export const Solar: {
    fromYmdHms(year: number, month: number, day: number, hour: number, minute: number, second: number): Solar;
    fromBaZi(year: string, month: string, day: string, hour: string, sect: number, baseYear: number): Solar[];
  };
}