import { beforeEach, describe, expect, it } from 'vitest';
import { getPerson, initializeMockSession, listPersons, saveBaziRecord, listBaziRecords, getBaziRecord } from '../data/clientRepository';
import type { BaziRecord } from '../types/domain';
import { mockPeople, mockPersonDetails } from './fixtures/mockData';

describe('simplified client repository', () => {
  beforeEach(() => initializeMockSession());

  it('starts empty and has no transient job or quota state', () => {
    expect(listPersons()).toEqual([]);
  });

  it('sorts people by initial then name', () => {
    initializeMockSession(mockPeople, mockPersonDetails);
    expect(listPersons().map((person) => person.name)).toEqual(['李明', '王芳', '张伟']);
  });

  it('returns isolated detail data', () => {
    initializeMockSession(mockPeople, mockPersonDetails);
    const detail = getPerson('zhang-wei');
    expect(detail).toBeDefined();
    detail!.person.name = '已修改';
    expect(getPerson('zhang-wei')?.person.name).toBe('张伟');
  });

  it('persists a complete bazi record in the browser repository', async () => {
    const record: Omit<BaziRecord, 'id' | 'aiStatus'> = { name: '测试', gender: 'female', birthYear: 1991, birthMonth: 8, createdAt: '2025-01-01T00:00:00.000Z', yearPillar: '辛未', monthPillar: '丙申', dayPillar: '甲子', hourPillar: '甲子' };
    const saved = await saveBaziRecord(record);
    expect(saved.id).toBeTruthy();
    expect(saved.aiStatus).toBe('not_started');
    /* 「保存返回什么」的契约见 storage-slim 那一条(存储那份瘦身盘)。这里没带 nonAiResult，
       所以原样进出、仍是 undefined，列表该与之逐字相同。 */
    expect(await listBaziRecords()).toEqual([saved]);
    /* 详情页比列表多一层 hydrate：把存储里清空的派生数组即时重算回来(界面上的大运/流年分组靠它)，
       所以「详情的数组非空」是有意为之，不是又一份厚度不一致 —— 除这些数组外两边必须逐字相同。
       曾经这里写的是整条等值比较，等于要求详情也不重算，与 storage-slim 那条「详情即时重算完整」
       直接矛盾；两条一起摆出来才说清各自的契约。 */
    const detail = await getBaziRecord(saved.id);
    expect(detail?.nonAiResult).toBeTruthy();
    expect(detail!.nonAiResult!.greatFortunes.length, '详情页没把瘦身数组重算回来').toBeGreaterThan(0);
    expect({ ...detail, nonAiResult: saved.nonAiResult }).toEqual(saved);
  });
});
