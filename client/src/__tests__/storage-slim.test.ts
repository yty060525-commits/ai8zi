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
  it('prunes the 200KB forecast arrays to a compact natal summary', () => {
    const record = fullRecord();
    const original = JSON.stringify(record.nonAiResult).length;
    const pruned = pruneRecord(record);
    const compact = JSON.stringify(pruned.nonAiResult).length;
    expect(original).toBeGreaterThan(100000);
    // 本命章节改版后这里多了 strengthScore / relationshipDetails / shenSha / tenGodDetails
    // 四段「列表和详情都要用」的摘要(共约 2.9KB)，瘦身目标从 3KB 提到 6KB；
    // 断言的是「比整盘小两个数量级」，不是某个精确字节数，避免每次加摘要都要改阈值。
    expect(compact).toBeLessThan(6000);
    expect(compact).toBeLessThan(original / 20);
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

  it('老库里的错误五行计数在读列表时被校正并回写(子属水不作木)', async () => {
    configureBaziRepository(memoryBaziRepository);
    // 模拟老版本落库的记录：地支「子」被手抄表记成木 → 木3/水1，且没有 elementRuleVersion
    const legacy = fullRecord();
    legacy.nonAiResult = {
      ...pruneRecord(legacy).nonAiResult!,
      elements: { 木: 3, 火: 3, 土: 0, 金: 1, 水: 1 },
      elementRatio: { 木: 3 / 8, 火: 3 / 8, 土: 0, 金: 1 / 8, 水: 1 / 8 },
      elementRuleVersion: undefined,
    };
    await memoryBaziRepository.saveBaziRecord(pruneRecord(legacy));

    const listed = await listBaziRecords();
    expect(listed[0].nonAiResult!.elements).toEqual({ 木: 2, 火: 3, 土: 0, 金: 1, 水: 2 });
    expect(listed[0].nonAiResult!.elementRuleVersion).toBe('branch-main-v2');

    // 回写生效：再读一次，库里存的就已经是校正后的值(不是每次读都重算)
    const reread = await memoryBaziRepository.getBaziRecord(legacy.id);
    expect(reread?.nonAiResult?.elements).toEqual({ 木: 2, 火: 3, 土: 0, 金: 1, 水: 2 });
    expect(reread?.nonAiResult?.elementRuleVersion).toBe('branch-main-v2');
  });

  it('口径已是最新的记录不会被重复改写', async () => {
    configureBaziRepository(memoryBaziRepository);
    const current = fullRecord(); // calculateNonAi 产出的记录自带当前 elementRuleVersion
    await memoryBaziRepository.saveBaziRecord(pruneRecord(current));
    const before = await memoryBaziRepository.getBaziRecord(current.id);
    await listBaziRecords();
    const after = await memoryBaziRepository.getBaziRecord(current.id);
    expect(JSON.stringify(after?.nonAiResult?.elements)).toBe(JSON.stringify(before?.nonAiResult?.elements));
  });
});