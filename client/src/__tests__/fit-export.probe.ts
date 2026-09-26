import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { BaziRecord } from '../types/domain';
import { buildLocalAnalysis } from '../data/localAnalysis';

/* 拟合：把真实云端样本(SQL 导出)逐盘喂给**当前产品代码**，读它实际发射的喜用/忌元素，
   与云端 AI 正文里的 usefulElements/avoidElements 对账。判据取自渲染后的句子，不自己重算，
   避免分类器口径错导致的假阳性(上一轮吃过这个亏)。 */
const F = 'C:/Users/yty06/Desktop/mingli-export-2026-09-25.sql.txt';
const DIR = 'C:/Users/yty06/Documents/ai/bbazi/ai 8zi/ai 8zi/ai 8zi/client/.scratch/';
const NOW = new Date('2026-09-26T06:00:00Z');
const EL = ['木', '火', '土', '金', '水'];
const srt = (a: string[]) => a.slice().sort((x, y) => EL.indexOf(x) - EL.indexOf(y)).join(',');

describe('真实样本拟合：引擎喜忌 vs 云端AI喜忌', () => {
  it('逐盘对账并分类分歧', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(readFileSync(F, 'utf8'));
    const rows = db.prepare('SELECT name,gender,birth_year,birth_month,year_pillar,month_pillar,day_pillar,hour_pillar,non_ai_result,ai_analysis FROM bazi_records WHERE ai_analysis IS NOT NULL').all() as any[];
    const out: string[] = [];
    let bandAgree = 0, useAgree = 0, n = 0;
    for (const r of rows) {
      const na = JSON.parse(r.non_ai_result);
      const ai = JSON.parse(r.ai_analysis);
      const rec = { id: r.name, name: r.name, gender: r.gender, createdAt: NOW.toISOString(),
        birthYear: +r.birth_year, birthMonth: +r.birth_month, yearPillar: r.year_pillar, monthPillar: r.month_pillar,
        dayPillar: r.day_pillar, hourPillar: r.hour_pillar, nonAiResult: na, aiStatus: 'completed' } as unknown as BaziRecord;
      const base = buildLocalAnalysis(rec, NOW);
      if (!base) { out.push(`${r.name} NO_LOCAL`); continue; }
      n++;
      // 引擎档位与喜忌：从产品导出的字段读，不从句子抠
      const engLabel = na.strengthScore?.label ?? '';
      const engStrong = engLabel === '身强' || engLabel === '中和偏旺';
      const engUseful = srt(base.usefulElements ?? []);
      const engAvoid = srt(base.avoidElements ?? []);
      const aiUseful = srt(ai.usefulElements ?? []);
      const aiAvoid = srt(ai.avoidElements ?? []);
      const t = String(ai.pattern) + String(ai.strength);
      const aiBand = /身强|偏强|偏旺/.test(t) ? '旺' : /身弱|偏弱/.test(t) ? '弱' : '?';
      const engBand = engStrong ? '旺' : '弱';
      const uOK = engUseful === aiUseful;
      if (engBand === aiBand) bandAgree++;
      if (uOK) useAgree++;
      out.push(`${r.name} ${r.day_pillar[0]}日 index=${na.strengthScore?.index} | eng[${engBand}/${engLabel}] useful=${engUseful} avoid=${engAvoid} || ai[${aiBand}] useful=${aiUseful} avoid=${aiAvoid} | band=${engBand===aiBand?'✓':'✗'} use=${uOK?'✓':'✗'}`);
    }
    out.unshift(`N=${n} BAND_AGREE=${bandAgree}/${n} USEFUL_AGREE=${useAgree}/${n}`);
    writeFileSync(DIR + 'fit-export.txt', out.join('\n') + '\n', 'utf8');
    expect(n).toBeGreaterThan(5);
  }, 60000);
});
