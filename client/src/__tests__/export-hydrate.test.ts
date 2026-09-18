import { describe, expect, it } from 'vitest';
import { exportableRecords, saveBaziRecord, pruneRecord } from '../data/clientRepository';
import { calculateNonAi } from '../features/chart/nonAiCalculator';
import { exportRecordsSQLText } from '../data/sqliteExport';

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
});
