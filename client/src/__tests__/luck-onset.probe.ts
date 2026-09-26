import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { Solar } from 'lunar-javascript';
import { calculateNonAi, computePillarsFromDate } from '../features/chart/nonAiCalculator';

const DIR = 'C:/Users/yty06/Documents/ai/bbazi/ai 8zi/ai 8zi/ai 8zi/client/.scratch/';
const NOW = new Date('2026-09-26T06:00:00Z');
const ymd = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;

describe('交运日：我们自算 vs 库 getStartSolar', () => {
  it('枚举 出生日×性别，比对年份差与天数差', () => {
    const out: string[] = [];
    let n = 0, sameYear = 0, diffYear = 0, within7 = 0, worse = 0;
    const bad: string[] = [];
    for (let year = 1955; year <= 2005; year += 3) {
      for (const month of [1, 2, 5, 8, 11]) {
        for (const day of [3, 14, 28]) {
          for (const gender of ['male', 'female'] as const) {
            const p = computePillarsFromDate({ year, month, day, hour: 12 });
            let r;
            try { r = calculateNonAi({ birthYear: year, birthMonth: month, birthDay: day, ...p }, gender, NOW.toISOString()); } catch { continue; }
            if (!r.luckStart || !r.luckOnset) continue;
            // 库的权威值：用引擎定位到的公历生日正午重算
            const [, my, mm, md] = [/^(\d{4})/, /^(\d{4})-(\d{2})/, /^(\d{4})-(\d{2})-(\d{2})/].map((re) => Number(re.exec(r.solarDate)![1]));
            void my;
            const born = Solar.fromYmdHms(Number(/^(\d{4})/.exec(r.solarDate)![1]), Number(/^(\d{4})-(\d{2})/.exec(r.solarDate)![2]), Number(/-(\d{2})$/.exec(r.solarDate)![1]), 12, 30, 0);
            const lib = born.getLunar().getEightChar().getYun(gender === 'male' ? 1 : 0).getStartSolar();
            const libDate = new Date(Date.UTC(lib.getYear(), lib.getMonth() - 1, lib.getDay()));
            const ours = new Date(r.luckOnset + 'T00:00:00Z');
            n++;
            if (libDate.getUTCFullYear() === ours.getUTCFullYear()) sameYear++; else { diffYear++; if (bad.length < 8) bad.push(`生${r.solarDate} ${gender} 跨度=${r.luckStart.years}y${r.luckStart.months}m${r.luckStart.days}d 库=${ymd(libDate)} 我们=${r.luckOnset} 差=${Math.round((ours.getTime() - libDate.getTime()) / 864e5)}天`); }
            const dd = Math.abs(ours.getTime() - libDate.getTime()) / 864e5;
            if (dd <= 7) within7++; else worse++;
          }
        }
      }
    }
    out.push(`样本=${n} 同年=${sameYear} (${((sameYear / n) * 100).toFixed(2)}%) 跨年=${diffYear} 相差<=7天=${within7} >7天=${worse}`);
    for (const b of bad) out.push('  ' + b);
    writeFileSync(DIR + 'luck-onset.txt', out.join('\n') + '\n', 'utf8');
    expect(n).toBeGreaterThan(200);
    expect(diffYear).toBe(0);
  });
});
