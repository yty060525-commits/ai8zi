import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { configureBaziRepository, memoryBaziRepository, listBaziRecords } from '../data/clientRepository';
import { importRecords, type ImportMode } from '../data/sqlImport';
import type { BaziRecord } from '../types/domain';

/** 只关心去重指纹用到的字段，其余排盘数据留空即可(导入不落派生数组)。 */
const rec = (over: Partial<BaziRecord>): BaziRecord => ({
  id: over.id ?? `id-${Math.random().toString(36).slice(2)}`,
  name: '甲', gender: 'male', birthYear: 1990, birthMonth: 5,
  createdAt: '2026-01-01T00:00:00.000Z',
  yearPillar: '庚午', monthPillar: '辛巳', dayPillar: '乙酉', hourPillar: '癸未',
  aiStatus: 'not_started',
  ...over,
} as unknown as BaziRecord);

beforeEach(() => { configureBaziRepository(memoryBaziRepository); });
afterEach(() => { configureBaziRepository(memoryBaziRepository); });

async function run(records: BaziRecord[], mode: ImportMode) {
  const summary = await importRecords(records, mode);
  return { summary, stored: await listBaziRecords() };
}

describe('导入去重指纹(dedupe)', () => {
  it('同四柱、同年但不同出生月 → 是两个人，不能被当成重复丢掉', async () => {
    const { summary, stored } = await run([
      rec({ id: 'a', name: '春生', birthMonth: 3 }),
      rec({ id: 'b', name: '秋生', birthMonth: 9 }),
    ], 'dedupe');
    expect(summary.skipped).toBe(0);
    expect(stored.map((r) => r.name).sort()).toEqual(['春生', '秋生']);
  });

  it('完全同人(性别+四柱+出生年月一致)才跳过', async () => {
    const { summary, stored } = await run([
      rec({ id: 'a', name: '张三' }),
      rec({ id: 'b', name: '张三副本' }),
    ], 'dedupe');
    expect(summary.skipped).toBe(1);
    expect(stored).toHaveLength(1);
  });

  it('overwrite：同 id 覆盖、新 id 追加', async () => {
    await run([rec({ id: 'a', name: '旧名' })], 'overwrite');
    const { summary, stored } = await run([
      rec({ id: 'a', name: '新名' }),
      rec({ id: 'c', name: '另一个人' }),
    ], 'overwrite');
    expect(summary.updated).toBe(1);
    expect(summary.added).toBe(1);
    expect(stored.find((r) => r.id === 'a')?.name).toBe('新名');
  });

  it('同一批里出现两次的新盘(无 id)：文件内部去重只留一条', async () => {
    const { summary, stored } = await run([
      rec({ id: undefined, name: '甲', birthMonth: 5 }),
      rec({ id: undefined, name: '甲', birthMonth: 5 }),
    ], 'dedupe');
    expect(summary.added).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(stored).toHaveLength(1);
  });
});
