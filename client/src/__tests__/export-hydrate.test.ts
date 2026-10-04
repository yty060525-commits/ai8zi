import { describe, expect, it } from 'vitest';
import { exportableRecords, saveBaziRecord, pruneRecord } from '../data/clientRepository';
import { calculateNonAi } from '../features/chart/nonAiCalculator';
import { exportRecordsSQLText } from '../data/sqliteExport';
import { parseBackupFile } from '../data/sqlImport';

/** 存储是瘦身的(数组留空、由引擎重算)；导出必须是完整盘，否则分享文件不可自解释。 */
describe('导出前还原完整盘', () => {
  const base = {
    id: 'h1', name: '导出完整性', gender: 'male' as const, birthYear: 1984, birthMonth: 2,
    createdAt: '2025-03-08T12:34:56.000Z', yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午',
    aiStatus: 'not_started' as const,
  };

  it('exportableRecords 带非空流年/大运，且 SQL 文本包含这些行', async () => {
    // 生产路径：先由确定性引擎算出完整盘，落库时自动瘦身
    const nonAiResult = calculateNonAi({ birthYear: 1984, birthMonth: 2, yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午' }, 'male', '2025-03-08T12:34:56.000Z');
    await saveBaziRecord({ ...base, nonAiResult });
    const list = await exportableRecords();
    const rec = list.find((r) => r.id === 'h1');
    expect(rec).toBeTruthy();
    expect((rec!.nonAiResult?.annualFortunes ?? []).length).toBeGreaterThan(0);
    expect((rec!.nonAiResult?.greatFortunes ?? []).length).toBeGreaterThan(0);
    const sql = exportRecordsSQLText([rec!]);
    // 干支年数据确实写进了导出内容
    expect(sql).toContain('greatFortunes');
    expect(sql).toMatch(/startYear/);
  });

  it('pruneRecord 仍是瘦身存储(不影响本地体积优化)', () => {
    const p = pruneRecord({ ...base, nonAiResult: { greatFortunes: [{ ganZhi: '丁卯', startYear: 2020, endYear: 2029 }], annualFortunes: [{}], monthlyFortunes: [{}] } } as never);
    expect(p.nonAiResult!.greatFortunes).toHaveLength(0);
  });

  /* .sql 文本备份是三种导出格式里唯一没有往返用例的那一种(.sqlite 与 .json 见 import-roundtrip)。
     它靠「把整段 SQL 喂给一个空库再读表」导入，所以任何一处写侧改动 —— 转义、列序、事务边界 ——
     坏掉的形态都是「文件导得出去、导不回来」或「导回来的字段串了位」。下面这条把导出文本原样
     当备份文件解析回来，逐字段比对。 */
  it('.sql 文本备份能原样解析回来：字段不错位、引号不截断、AI 正文完整', async () => {
    const analysis = { pattern: '七杀格', strength: '身强', usefulElements: ['水'], avoidElements: ['火'], explanation: "这段里带一个单引号 ' 和逗号, 用来验证转义" };
    const full = await exportableRecords();
    const rec = full.find((r) => r.id === 'h1')!;
    const withQuote = { ...rec, aiAnalysis: analysis, name: "名字'带引号", toneUsed: 35 } as typeof rec;
    const text = exportRecordsSQLText([withQuote]);
    const { records } = await parseBackupFile(new TextEncoder().encode(text), 'mingli-export.sql');
    expect(records).toHaveLength(1);
    const back = records[0];
    // 判据取「解析回来的这一条」的每个字段，而不是整条 deep-equal：整条比对里，字段错位只要
    // 两侧同时错到同一处就看不出来，逐字段才拦得住列序被改动。
    expect(back.id).toBe(withQuote.id);
    expect(back.name).toBe("名字'带引号");
    expect(back.gender).toBe('male');
    expect(back.birthYear).toBe(1984);
    expect(back.birthMonth).toBe(2);
    expect(back.createdAt).toBe('2025-03-08T12:34:56.000Z');
    expect([back.yearPillar, back.monthPillar, back.dayPillar, back.hourPillar]).toEqual(['甲子', '丙寅', '庚午', '壬午']);
    expect(back.toneUsed).toBe(35);
    expect((back.aiAnalysis as { explanation?: string })?.explanation).toBe(analysis.explanation);
    // 派生数组随导出一起走：分享出去的第三方拿到文件就能读懂大运流年，不必再排一次盘
    expect((back.nonAiResult?.greatFortunes ?? []).length).toBeGreaterThan(0);
  });
});
