import { describe, expect, it, afterEach } from 'vitest';
import { configureBaziRepository, memoryBaziRepository, saveBaziRecord, getBaziRecord, listBaziRecords, pruneRecord, hydrateRecord } from '../data/clientRepository';
import { calculateNonAi } from '../features/chart/nonAiCalculator';
import type { BaziRecord } from '../types/domain';

const fullRecord = (): BaziRecord => {
  const nonAiResult = calculateNonAi({ birthYear: 1984, birthMonth: 2, yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午' }, 'male', '2025-03-08T12:34:56.000Z');
  return { id: 'r1', name: '测试', gender: 'male', birthYear: 1984, birthMonth: 2, createdAt: '2025-03-08T12:34:56.000Z', yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午', nonAiResult, aiStatus: 'not_started' };
};

afterEach(() => { configureBaziRepository(memoryBaziRepository); });

describe('storage slimming (prune/hydrate)', () => {
  it('prunes the 200KB forecast arrays to a ~3KB natal summary', () => {
    const record = fullRecord();
    const original = JSON.stringify(record.nonAiResult).length;
    const pruned = pruneRecord(record);
    const compact = JSON.stringify(pruned.nonAiResult).length;
    expect(original).toBeGreaterThan(100000);
    expect(compact).toBeLessThan(4000);
    expect(pruned.nonAiResult!.greatFortunes).toHaveLength(0);
    expect(pruned.nonAiResult!.annualFortunes).toHaveLength(0);
    expect(pruned.nonAiResult!.monthlyFortunes).toHaveLength(0);
    // 列表/详情需要的本命要点仍完整保留
    expect(pruned.nonAiResult!.pillars.day).toBe('庚午');
    expect(pruned.nonAiResult!.solarDate).toBe('1984-02-06');
    expect(pruned.nonAiResult!.zodiac).toBe('鼠');
    expect(pruned.nonAiResult!.shenSha.items!.length).toBeGreaterThan(0);
  });

  it('hydrates a pruned record back to the identical full chart', async () => {
    const original = fullRecord();
    const restored = await hydrateRecord(pruneRecord(original));
    expect(restored.nonAiResult!.greatFortunes).toHaveLength(9);
    expect(restored.nonAiResult!.annualFortunes).toHaveLength(10);
    expect(restored.nonAiResult!.monthlyFortunes).toHaveLength(120);
    expect(restored.nonAiResult!.annualFortunes[0].ganZhi).toBe(original.nonAiResult!.annualFortunes[0].ganZhi);
    expect(restored.nonAiResult!.greatFortunes[0].ganZhi).toBe('丁卯');
    expect(restored.nonAiResult!.forecastRange).toEqual(original.nonAiResult!.forecastRange);
    expect(restored.nonAiResult!.elements).toEqual(original.nonAiResult!.elements);
  });

  it('round-trips through the repository: list stays slim, detail is full', async () => {
    configureBaziRepository(memoryBaziRepository);
    const saved = await saveBaziRecord(fullRecord());
    expect(saved.id).toBeTruthy();
    expect(saved.nonAiResult!.monthlyFortunes).toHaveLength(120); // 保存返回完整盘
    const listed = await listBaziRecords();
    expect(listed[0].nonAiResult!.monthlyFortunes).toHaveLength(0); // 列表读瘦身数据
    expect(listed[0].nonAiResult!.zodiac).toBe('鼠');
    const detail = await getBaziRecord(saved.id!);
    expect(detail?.nonAiResult!.annualFortunes).toHaveLength(10); // 详情即时重算完整
  });

  it('hydrate is a no-op on malformed/legacy records (never crashes)', async () => {
    const malformed = { ...fullRecord(), yearPillar: '', monthPillar: '', dayPillar: '', hourPillar: '', nonAiResult: { ...pruneRecord(fullRecord()).nonAiResult! } };
    const out = await hydrateRecord(malformed);
    expect(out.nonAiResult!.annualFortunes).toHaveLength(0); // 不重算也不崩
  });
});