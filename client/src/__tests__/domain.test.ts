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
    expect(await listBaziRecords()).toEqual([saved]);
    expect(await getBaziRecord(saved.id)).toEqual(saved);
  });
});
