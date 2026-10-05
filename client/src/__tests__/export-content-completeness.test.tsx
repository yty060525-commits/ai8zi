/* 判据空白：导出面板那句承诺「每个人导出为一条完整记录，含基础信息、排盘数据、全部批断结果」
   此前只钉到「哪几个人进了文件」(export-panel-inclusion.test.tsx)，以及单测层面的
   exportableRecords() 本身(export-hydrate.test.ts)。**界面这条路径**上有一步静默降级从来没被照过：

     RecordsPage.doExport:
       const full = await exportableRecords();                       // 全部记录 hydrate
       const byId = new Map(full.map((r) => [r.id, r]));
       const payloadRecords = chosenRecords.map((r) => byId.get(r.id) ?? r);   // ← 查不到就用视图那条

   视图里的行是瘦身存储原样(列表读取刻意不 hydrate，见 clientRepository.listBaziRecords 的注释)，
   所以 `?? r` 一旦命中，写进备份的就是「大运/流年/流月全空」的那一行 —— 文件照样导得出去、
   回执照样说「已导出所选一人」，只有换设备导入之后点开才发现时段全没了。

   本文件把两件事分开钉：正常路径确实完整(承诺的正例)，以及**任何一条盘都不许以瘦身形态进文件**
   (闸门判据；它同时是变异判据 —— 把 `?? r` 改成唯一来源时两条一起红)。 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RecordsPage } from '../features/records/RecordsPage';
import { configureBaziRepository, initializeMockSession, listBaziRecords, memoryBaziRepository, resetMockSession } from '../data/clientRepository';
import type { BaziRecord, Person } from '../types/domain';

const person: Person[] = [{ id: 'full-export', name: '完整导出', nameInitial: 'J', gender: 'male', birthSummary: '庚午年' }];

/** 一条「跑完分析、时段数组已被瘦身」的盘：这正是存储/视图里的形态(hydrate 之前)。 */
const prunedRecord = (): BaziRecord => ({
  id: 'full-export', name: '完整导出', gender: 'male', birthYear: 1990, birthMonth: 5,
  createdAt: '2025-06-01T00:00:00.000Z', yearPillar: '庚午', monthPillar: '辛巳', dayPillar: '乙酉', hourPillar: '癸未',
  aiStatus: 'completed',
  nonAiResult: { greatFortunes: [], annualFortunes: [], monthlyFortunes: [] } as never,
  aiTasks: {
    'task-01': { task: { taskId: 'task-01', type: 'baseline' }, status: 'completed', analysis: { pattern: '', strength: '', usefulElements: [], avoidElements: [], explanation: '【健康】注意睡眠。' } },
  } as never,
} as unknown as BaziRecord);

/** 下载取证：⚠ 不能用 blob.text()(异步微任务，waitFor 抢在它前面恒空，实测超时过一次)，
 *  走 export-panel-inclusion 里那套 FileReader.onload。 */
let parsed: { records: BaziRecord[] } | undefined;
const realCreate = URL.createObjectURL;
const realRevoke = URL.revokeObjectURL;
beforeEach(() => {
  parsed = undefined;
  initializeMockSession(person, [{ person: person[0], record: structuredClone(prunedRecord()), aiAnalysis: { status: 'completed', result: 'x' } }]);
  (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = ((blob: Blob) => {
    const reader = new FileReader();
    reader.onload = () => { parsed = JSON.parse(String(reader.result)) as { records: BaziRecord[] }; };
    reader.readAsText(blob);
    return 'blob:stub';
  }) as typeof URL.createObjectURL;
  (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = (() => undefined) as typeof URL.revokeObjectURL;
});
afterEach(() => {
  cleanup();
  configureBaziRepository(memoryBaziRepository);
  resetMockSession();
  (URL as unknown as { createObjectURL: unknown }).createObjectURL = realCreate;
  (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = realRevoke;
});

/** 勾上唯一那条 → 打开面板 → 点「导出备份文件」，等正文到手。 */
async function exportJson(): Promise<BaziRecord[]> {
  render(<RecordsPage onOpenPerson={vi.fn()} />);
  await screen.findByRole('checkbox', { name: '选择完整导出' });
  fireEvent.click(screen.getByRole('checkbox', { name: '选择完整导出' }));
  fireEvent.click(screen.getByRole('button', { name: /导出勾选/ }));
  await screen.findByRole('dialog', { name: '导出勾选的人物' });
  fireEvent.click(screen.getByRole('button', { name: /导出备份文件/ }));
  await waitFor(() => expect(parsed, '没解析到下载内容').toBeTruthy(), { timeout: 8000 });
  return parsed!.records;
}

describe('导出文件的正文必须是还原后的完整盘', () => {
  it('夹具前提：视图里那条确实是瘦身的(时段数组皆空)', async () => {
    const view = (await listBaziRecords()).find((r) => r.id === 'full-export');
    expect(view?.nonAiResult?.greatFortunes, '夹具应预置瘦身形态').toEqual([]);
    expect(view?.nonAiResult?.annualFortunes).toEqual([]);
  });

  it('正常路径：导出的 json 里大运/流年被还原出来，批断正文也在', async () => {
    const records = await exportJson();
    expect(records).toHaveLength(1);
    const rec = records[0];
    expect((rec.nonAiResult?.greatFortunes ?? []).length, '备份里没有大运段 ⇒ 导入回来等于丢光时段').toBeGreaterThan(0);
    expect((rec.nonAiResult?.annualFortunes ?? []).length, '备份里没有流年').toBeGreaterThan(0);
    expect(rec.aiTasks?.['task-01']?.analysis?.explanation).toContain('注意睡眠');
  });

  /* 闸门判据：不猜产品会不会走到 `?? r`，而是直接问一句承诺 ——
     导出正文里每条盘的时段数组都必须非空；谁落到瘦身行，这条就红在哪一个 id 上。 */
  it('闸门判据：导出正文中任何一条盘都不许带着空时段数组(静默降级的形状)', async () => {
    const records = await exportJson();
    const thin = records.filter((r) => (r.nonAiResult?.greatFortunes ?? []).length === 0 && (r.nonAiResult?.annualFortunes ?? []).length === 0);
    expect(thin.map((r) => r.id), '这些盘是以瘦身形态写进备份的').toEqual([]);
  });
});
