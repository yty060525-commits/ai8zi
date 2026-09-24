import { describe, expect, it } from 'vitest';
import { applyTrueSolar } from '../features/chart/nonAiCalculator';

/* 真太阳时·算例对撞(渡星河 stariver.me「23点10分为何是亥时」+ 北京时间官网口径)。
   口径为本项目**约定**：以东经120°为基准，每差1°经度差4分钟，西减东加，**只按经度差、不加均时差**
   （用户 2026-09-24 拍板；联网核实：确有排盘工具采此简化式，但也有 AstroBazi/小宝命理站等按天文学
    定义「平太阳时+均时差(±16分)」的另一派——两派仅在时辰边界 ±16 分内有别，非行业统一口径）。
   这里断言的是「时支」——正是「本地计算有误」曾翻车的边界(乌鲁木齐 23:10 采经度差口径应落 亥 非 戌)。
   注意：这是拿外部公开算例校验，不是拿本地公式自证(那种测法只锁自洽、查不出系统性偏差)。 */
const BRANCHES = ['子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥'];
const branchOf = (hour: number) => BRANCHES[Math.floor(((hour + 1) % 24) / 2)];
const at = (hour: number, minute: number, lng: number) =>
  applyTrueSolar({ year: 2025, month: 6, day: 21, hour, minute }, lng);

describe('真太阳时 · 权威算例对撞', () => {
  // 12:00 钟表，纯经度差即得渡星河表格值
  const noon: Array<[string, number, string, string]> = [
    ['杭州', 120.2, '12:00', '午'],   // 近基准线
    ['北京', 116.4, '11:45', '午'],    // −14.4 分
    ['西安', 108.9, '11:15', '午'],    // −44.4 分
    ['成都', 104.1, '10:56', '巳'],    // −63.6 分
    ['乌鲁木齐', 87.6, '09:50', '巳'], // −129.6 分，渡星河明列 09:50
  ];
  for (const [city, lng, wantClock, wantBranch] of noon) {
    it(`${city}(${lng}°E) 12:00 → ${wantClock} ${wantBranch}时`, () => {
      const dt = at(12, 0, lng);
      expect(`${String(dt.hour).padStart(2, '0')}:${String(dt.minute).padStart(2, '0')}`).toBe(wantClock);
      expect(branchOf(dt.hour)).toBe(wantBranch);
    });
  }

  // 23:10 出生：向西回拨退入亥时(21–23)，偏东过 23:00 落子时
  const night: Array<[string, number, string]> = [
    ['北京', 116.4, '亥'],   // ≈22:56
    ['成都', 104.1, '亥'],   // ≈22:06
    ['乌鲁木齐', 87.6, '亥'],// ≈21:00 —— 曾因误加 EoT 掉到 20:58 戌，本用例钉死回归
    ['上海', 121.5, '子'],   // 偏东 23:16
    ['沈阳', 123.4, '子'],   // 偏东更多 23:23
  ];
  for (const [city, lng, wantBranch] of night) {
    it(`${city}(${lng}°E) 23:10 → ${wantBranch}时`, () => {
      expect(branchOf(at(23, 10, lng).hour)).toBe(wantBranch);
    });
  }

  it('23:10 偏东过 23:00 不改公历日、偏西未跨 00:00 亦不改日', () => {
    expect(at(23, 10, 121.5)).toMatchObject({ day: 21, hour: 23 }); // 上海子时仍当日
    expect(at(23, 10, 87.6)).toMatchObject({ day: 21, hour: 21 });  // 乌鲁木齐退到 21:00 亥
  });
});
