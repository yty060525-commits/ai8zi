/* 判据空白：importRecords 里那句「同 id 覆盖优先于去重」从来没有按**勾选的模式**验证过。

   代码形态(sqlImport.ts)是先算 isUpdate = !!record.id && existingIds.has(record.id)，
   命中就直接 saveBaziRecord + updated += 1 并 continue，根本不看 mode；只有非更新那条才走
   `mode === 'dedupe' && fingerprint.has(key)` 的跳过分支。界面把两个单选写成互斥选项
   (SettingsPage：「追加并覆盖，同标识覆盖、新记录追加」/「同盘去重…则跳过」)，
   所以 dedupe 下遇到同 id 时到底覆盖还是跳过，是用户看得见的两种不同结果 —— 而现有四条
   import-dedupe 用例里，同 id 覆盖只在 overwrite 下测过。

   本文件钉的是承诺：勾了「同盘去重」也不能把用户已经存在的这条盘整条盖掉。
   夹具特意让新旧两版带**可区分的正文**(旧版有批断、新版没有)，否则「覆盖了但没看出来」
   和「没覆盖」的读数会一样。 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configureBaziRepository, listBaziRecords, memoryBaziRepository, saveBaziRecord } from '../data/clientRepository';
import { importRecords } from '../data/sqlImport';
import type { BaziAIAnalysis, BaziRecord } from '../types/domain';

/* 正文夹具要满足 BaziAIAnalysis 的完整形状：`npm run build` 会跑 tsc，而 vitest 不做类型检查 ——
   只写 { explanation } 能过测试却把构建弄红(实测 TS2739)。 */
const analysis = (explanation: string): BaziRecord['aiAnalysis'] => ({
  pattern: '身强', strength: '偏旺', usefulElements: ['水'], avoidElements: ['火'], explanation,
});

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

describe('导入模式必须真的分流：dedupe 不做同 id 覆盖', () => {
  /* 先把一条**带批断正文**的盘放进本机库，再拿同 id、无正文的一条去 dedupe 导入。 */
  async function seedAndImport() {
    await saveBaziRecord(rec({ id: 'same', name: '旧名', aiStatus: 'completed', aiAnalysis: analysis('旧批断正文') }));
    const before = (await listBaziRecords()).find((r) => r.id === 'same');
    const summary = await importRecords([rec({ id: 'same', name: '新名' })], 'dedupe');
    const after = (await listBaziRecords()).find((r) => r.id === 'same');
    return { before, after, summary };
  }

  it('夹具前提：库里确实躺着那条带正文的旧盘(否则下面的「没被盖掉」是在空集上永真)', async () => {
    const { before } = await seedAndImport();
    expect(before?.name, '夹具没能预置这条盘').toBe('旧名');
    expect(before?.aiStatus, '夹具的旧盘应标为已完成').toBe('completed');
  });

  it('dedupe 下同 id 不再整条覆盖：名字与批断都保持原样', async () => {
    const { before, after } = await seedAndImport();
    expect(after?.name, 'dedupe 导入把已存在的盘改名了 ⇒ 该模式不该做同 id 覆盖').toBe(before?.name);
    expect(after?.aiStatus, 'dedupe 导入把 aiStatus 打回未开始 ⇒ 整条被替换').toBe(before?.aiStatus);
    expect((after as unknown as { aiAnalysis?: { explanation?: string } }).aiAnalysis?.explanation,
      'dedupe 导入清掉了原有批断正文 ⇒ 用户点「去重」却丢了分析结果').toBe('旧批断正文');
  });

  it('dedupe 下同 id 计入 skipped，不是 updated(回执数字要与实际动作一致)', async () => {
    const { summary } = await seedAndImport();
    expect({ ...summary }, 'dedupe 下同 id 既不该报覆盖、也不该报新增').toEqual({ added: 0, updated: 0, skipped: 1, total: 1 });
  });

  it('正向钉子：同一份数据在 overwrite 下确实覆盖(证明上面三条不是「导入什么都不做」)', async () => {
    await saveBaziRecord(rec({ id: 'same', name: '旧名', aiStatus: 'completed', aiAnalysis: analysis('旧批断正文') }));
    const summary = await importRecords([rec({ id: 'same', name: '新名' })], 'overwrite');
    const after = (await listBaziRecords()).find((r) => r.id === 'same');
    expect(summary.updated, 'overwrite 没走同 id 覆盖这条路').toBe(1);
    expect(after?.name).toBe('新名');
    /* 覆盖是整条替换：旧正文随之消失，这正是 dedupe 要避免的那个动作。 */
    expect((after as unknown as { aiAnalysis?: { explanation?: string } }).aiAnalysis?.explanation,
      'overwrite 应当整条盖掉，旧正文不该还留着').toBeUndefined();
  });

  it('dedupe 下全新的人照样能进来(闸门不能把正路也堵死)', async () => {
    await saveBaziRecord(rec({ id: 'old', name: '旧名' }));
    const summary = await importRecords([
      rec({ id: 'new-a', name: '新人甲', birthMonth: 4 }),
      rec({ id: 'new-b', name: '新人乙', birthMonth: 7 }),
    ], 'dedupe');
    expect({ ...summary }, '同盘去重不该拦下指纹不同的新记录').toEqual({ added: 2, updated: 0, skipped: 0, total: 2 });
    const names = (await listBaziRecords()).map((r) => r.name).sort();
    expect(names).toEqual(['旧名', '新人乙', '新人甲'].sort());
  });
});
