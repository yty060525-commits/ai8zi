import { describe, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { Solar } from 'lunar-javascript';
import { calculateNonAi } from '../features/chart/nonAiCalculator';

const DIR = 'C:/Users/yty06/Documents/ai/bbazi/ai 8zi/ai 8zi/ai 8zi/client/.scratch/';

describe('大运起点 vs 库 getDaYun 逐例比对', () => {
  it('枚举 1950-2010 每天 × 男女，列出与库不一致的样本', () => {
    const rows: string[] = [];
    let total = 0, mismatch = 0;
    for (let y = 1950; y <= 2010; y += 7) {
      for (let m = 1; m <= 12; m++) {
        for (const d of [1, 15, 28, 31]) {
          const born = Solar.fromYmdHms(y, m, d, 12, 30, 0);
          const lunar = born.getLunar();
          const ec = lunar.getEightChar();
          const pillars = [ec.getYear(), ec.getMonth(), ec.getDay(), ec.getTime()];
          for (const gender of ['male', 'female'] as const) {
            let r;
            try {
              r = calculateNonAi({ birthYear: y, birthMonth: m, yearPillar: pillars[0], monthPillar: pillars[1], dayPillar: pillars[2], hourPillar: pillars[3] }, gender, '2026-06-01T04:00:00.000Z');
            } catch { continue; }
            if (!r?.greatFortunes?.length) continue;
            total++;
            const yun = Solar.fromYmdHms(Number(r.solarDate.slice(0, 4)), Number(r.solarDate.slice(5, 7)), Number(r.solarDate.slice(8, 10)), 12, 30, 0)
              .getLunar().getEightChar().getYun(gender === 'male' ? 1 : 0);
            const da = yun.getDaYun(2)[1];
            const ours = r.greatFortunes[0];
            if (ours.startYear !== da.getStartYear()) {
              mismatch++;
              if (rows.length < 40) rows.push(`生${r.solarDate} ${gender} 跨度=${r.luckStart?.years}年${r.luckStart?.months}月${r.luckStart?.days}日 库交运=${r.luckStart?.date} onset=${r.luckOnset} | 库首柱=${da.getGanZhi()}起${da.getStartYear()} 我=${ours.ganZhi}起${ours.startYear}`);
            }
          }
        }
      }
    }
    writeFileSync(DIR + 'gf-vs-lib.txt', `total=${total} mismatch=${mismatch}\n` + rows.join('\n') + '\n');
    console.log(`total=${total} mismatch=${mismatch}`);
  });
});
