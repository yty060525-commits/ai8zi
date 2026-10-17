import { afterEach, describe, expect, it } from 'vitest';
import { configureBaziRepository, memoryBaziRepository, saveBaziRecord, getBaziRecord, saveNonAiEdits, recalculateBaziRecord, saveAiProgress, hydrateRecord, pruneRecord, repairElementCounts } from '../data/clientRepository';
import { calculateNonAi } from '../features/chart/nonAiCalculator';
import { applyManualNonAi, effectiveNonAiFacts, mergeManualNonAiEdits, validateManualNonAiFields } from '../shared/manualNonAi';
import type { BaziRecord, ManualNonAiEdits, NonAiChart } from '../types/domain';

function chart(): NonAiChart {
  return calculateNonAi({ birthYear: 1984, birthMonth: 2, yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午' }, 'male', '2025-03-08T12:34:56.000Z');
}

describe('typed manual non-AI facts', () => {
  it('applies only touched leaves and preserves zero, empty strings, and empty groups', () => {
    const base = chart();
    const edits: ManualNonAiEdits = { version: 1, fields: {
      elements: { 木: 0 }, elementRatio: { 火: 0 }, zodiac: '', fortuneDirection: 'backward',
      hiddenStems: { day: [] }, relationships: { sanHe: [] }, zodiacCompatibility: { liuHe: [] },
    } };
    const result = applyManualNonAi(base, edits);

    expect(result.elements).toEqual({ ...base.elements, 木: 0 });
    expect(result.elementRatio).toEqual({ ...base.elementRatio, 火: 0 });
    expect(result.zodiac).toBe('');
    expect(result.fortuneDirection).toBe('backward');
    expect(result.hiddenStems[2]).toEqual([]);
    expect(result.hiddenStems[0]).toEqual(base.hiddenStems[0]);
    expect(result.relationships.sanHe).toEqual([]);
    expect(result.relationships.liuHe).toEqual(base.relationships.liuHe);
    expect(result.zodiacCompatibility?.liuHe).toEqual([]);
    expect(result.manualEdits).toEqual(edits);
  });

  it('updates a selected pillar and one indexed fortune cell without freezing neighboring fields', () => {
    const base = chart();
    const first = base.greatFortunes[0];
    const edits: ManualNonAiEdits = { version: 1, fields: {
      tenGods: { month: '偏财' },
      tenGodDetails: { hidden: { hour: [{ stem: '癸', tenGod: '伤官', position: 'root' }] } },
      greatFortunes: { 0: { startYear: 1988 } },
    } };
    const result = applyManualNonAi(base, edits);

    expect(result.tenGods).toEqual([base.tenGods[0], '偏财', base.tenGods[2], base.tenGods[3]]);
    expect(result.tenGodDetails.heavenly).toEqual(result.tenGods);
    expect(result.tenGodDetails.hidden[3]).toEqual([{ stem: '癸', tenGod: '伤官', position: 'root' }]);
    expect(result.tenGodDetails.hidden[0]).toEqual(base.tenGodDetails.hidden[0]);
    expect(result.greatFortunes[0]).toEqual({ ...first, startYear: 1988 });
    expect(result.greatFortunes[1]).toEqual(base.greatFortunes[1]);
  });

  it('merges patches leaf-wise and treats an explicit empty array as an update', () => {
    const existing: ManualNonAiEdits = { version: 1, fields: { elements: { 木: 9 }, hiddenStems: { day: ['甲'] }, relationships: { sanHe: ['寅午戌'] } } };
    const merged = mergeManualNonAiEdits(existing, { elements: { 火: 0 }, hiddenStems: { hour: [] }, relationships: { sanHe: [] } });

    expect(merged).toEqual({ version: 1, fields: {
      elements: { 木: 9, 火: 0 }, hiddenStems: { day: ['甲'], hour: [] }, relationships: { sanHe: [] },
    } });
    expect(existing.fields.elements).toEqual({ 木: 9 });
  });

  it('uses the stored patch as the effective object and is idempotent', () => {
    const base = chart();
    const saved = { ...base, manualEdits: { version: 1 as const, fields: { zodiac: '兔', luckStart: { months: 0 } } } };
    const result = effectiveNonAiFacts(saved);
    expect(result.zodiac).toBe('兔');
    expect(result.luckStart?.months).toBe(0);
    expect(effectiveNonAiFacts(result)).toEqual(result);
  });

  it('keeps displayed aliases synchronized when either side is edited', () => {
    const base = chart();
    const luckByStart = applyManualNonAi(base, { version: 1, fields: { luckStart: { date: '2027-02-03' } } });
    expect(luckByStart.luckOnset).toBe('2027-02-03');
    const luckByOnset = applyManualNonAi(base, { version: 1, fields: { luckOnset: '2028-04-05' } });
    expect(luckByOnset.luckStart?.date).toBe('2028-04-05');

    const total = applyManualNonAi(base, { version: 1, fields: { chenggu: { totalLiang: 3.5 } } });
    expect(total.chenggu?.totalText).toBe('三两五钱');
    const parsed = applyManualNonAi(base, { version: 1, fields: { chenggu: { totalText: '三两五钱' } } });
    expect(parsed.chenggu?.totalLiang).toBe(3.5);
  });

  it('validates bounded field shapes while accepting an empty edited group', () => {
    expect(validateManualNonAiFields({ relationships: { sanHe: [] }, elements: { 木: 0 }, hiddenStems: { day: [] } }).valid).toBe(true);
    expect(validateManualNonAiFields({ elements: { 木: -1 } }).valid).toBe(false);
    expect(validateManualNonAiFields({ elementRatio: { 火: 1.2 } }).valid).toBe(false);
    expect(validateManualNonAiFields({ hiddenStems: { fifth: [] } }).valid).toBe(false);
    expect(validateManualNonAiFields({ unexpected: true }).valid).toBe(false);
    expect(validateManualNonAiFields({ elements: { 木: -1 } }).errors[0]).not.toContain('elements.木');
  });

  it('formats and parses multi-digit weights without undefined, and rejects fractions below one qian', () => {
    const base = chart();
    for (const [weight, text] of [[0, '零'], [9.9, '九两九钱'], [10, '十两'], [12.3, '十二两三钱'], [99.9, '九十九两九钱']] as const) {
      expect(validateManualNonAiFields({ chenggu: { totalLiang: weight } }).valid).toBe(true);
      expect(applyManualNonAi(base, { version: 1, fields: { chenggu: { totalLiang: weight } } }).chenggu?.totalText).toBe(text);
      expect(applyManualNonAi(base, { version: 1, fields: { chenggu: { totalText: text } } }).chenggu?.totalLiang).toBeCloseTo(weight);
    }
    for (const weight of [-1, 0.01, 100, NaN, Infinity]) expect(validateManualNonAiFields({ chenggu: { totalLiang: weight } }).valid).toBe(false);
  });
});

describe('manual facts through the real repository', () => {
  afterEach(() => configureBaziRepository(memoryBaziRepository));
  const seed = async (id: string): Promise<BaziRecord> => saveBaziRecord({ id, name: '人工事实', gender: 'male', birthYear: 1984, birthMonth: 2,
    yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午', createdAt: '2025-03-08T12:34:56.000Z',
    nonAiResult: chart(), aiStatus: 'completed', aiAnalysis: { pattern: '格局', strength: '身强', usefulElements: [], avoidElements: [], explanation: '旧本命' }, aiTasks: {} });

  it('persists touched leaves across prune, old-rule repair and refresh while source changes recompute neighbors', async () => {
    const base = await seed('manual-source');
    const changed = await saveNonAiEdits(base.id, { fields: { elements: { 木: 9 }, hiddenStems: { day: ['甲'] }, greatFortunes: { 0: { ganZhi: '甲子' } } } });
    expect(changed.nonAiResult?.factsRevision).toBe(1);
    expect(changed.aiAnalysis).toBeUndefined(); expect(changed.aiStatus).toBe('not_started');
    const gender = await saveNonAiEdits(base.id, { source: { gender: 'female' } });
    expect(gender.nonAiResult?.elements.木).toBe(9);
    expect(gender.nonAiResult?.hiddenStems[2]).toEqual(['甲']);
    expect(gender.nonAiResult?.hiddenStems[0]).toEqual(base.nonAiResult?.hiddenStems[0]);
    expect(gender.nonAiResult?.greatFortunes[0].ganZhi).toBe('甲子');
    expect(gender.nonAiResult?.greatFortunes[1].ganZhi).not.toBe(base.nonAiResult?.greatFortunes[1].ganZhi);
    const pruned = pruneRecord(gender);
    pruned.nonAiResult!.elementRuleVersion = 'old';
    const restored = await hydrateRecord(repairElementCounts(pruned));
    expect(restored.nonAiResult?.elements.木).toBe(9);
    expect(restored.nonAiResult?.greatFortunes[0].ganZhi).toBe('甲子');
    expect(restored.nonAiResult?.manualEdits?.fields.greatFortunes).toEqual({ 0: { ganZhi: '甲子' } });
  });

  it('does not mark unchanged controls, clear AI for name-only edits, or increase revision on no-op', async () => {
    const base = await seed('manual-noop');
    const same = await saveNonAiEdits(base.id, { source: { gender: base.gender }, fields: { elements: { 木: base.nonAiResult!.elements.木 } } });
    expect(same.nonAiResult?.manualEdits).toBeUndefined();
    expect(same.nonAiResult?.factsRevision ?? 0).toBe(0);
    expect(same.aiAnalysis?.explanation).toBe('旧本命');
    const renamed = await saveNonAiEdits(base.id, { source: { name: '新名字' } });
    expect(renamed.name).toBe('新名字'); expect(renamed.aiAnalysis?.explanation).toBe('旧本命');
    expect(renamed.nonAiResult?.factsRevision ?? 0).toBe(0);
  });

  it('rejects invalid source/derived values atomically and restores algorithm values only on explicit recalculate', async () => {
    const base = await seed('manual-invalid');
    for (const request of [{ source: { birthYear: 1984, birthMonth: 2, birthDay: 30 } }, { source: { hourPillar: '甲午' } }, { fields: { elementRatio: { 木: .9 } } }, { fields: { greatFortunes: { 0: { startYear: 2100 } } } }]) {
      await expect(saveNonAiEdits(base.id, request)).rejects.toThrow();
      expect((await getBaziRecord(base.id))?.aiAnalysis?.explanation).toBe('旧本命');
    }
    await saveNonAiEdits(base.id, { fields: { elements: { 木: 0 }, relationships: { sanHe: [] } } });
    const reset = await recalculateBaziRecord(base.id);
    expect(reset.nonAiResult?.manualEdits).toBeUndefined();
    expect(reset.nonAiResult?.elements).toEqual(base.nonAiResult?.elements);
    expect(reset.nonAiResult?.factsRevision).toBe(2);
  });

  it('keeps birthDay on no-op, synchronizes source aliases and drops obsolete precise time on date/pillar change', async () => {
    const base = await seed('manual-date');
    const dated = await saveBaziRecord({ ...base, nonAiResult: { ...base.nonAiResult!, birthDay: 6, birthTime: { year: 1984, month: 2, day: 6, hour: 12, minute: 30 } } });
    expect((await saveNonAiEdits(base.id, {})).nonAiResult?.birthTime).toEqual(dated.nonAiResult?.birthTime);
    const changed = await saveNonAiEdits(base.id, { source: { birthDay: 7 } });
    expect(changed.nonAiResult?.solarDate).toBe('1984-02-07');
    expect(changed.nonAiResult?.birthDay).toBe(7); expect(changed.nonAiResult?.birthTime).toBeUndefined();
    expect(changed.nonAiResult?.pillars.day).toBe(changed.dayPillar);
    expect(changed).not.toHaveProperty('birthDay');
  });

  it('guards every late AI snapshot and merges only AI fields for the matching revision', async () => {
    const old = await seed('manual-late');
    const edited = await saveNonAiEdits(old.id, { fields: { zodiac: '兔' } });
    const late = await saveAiProgress({ ...old, aiStatus: 'completed' }, 0);
    expect(late.nonAiResult?.zodiac).toBe('兔'); expect(late.aiAnalysis).toBeUndefined();
    const completed = await saveAiProgress({ ...old, name: '旧名字', aiStatus: 'completed', aiAnalysis: { ...old.aiAnalysis!, explanation: '新事实批断' } }, edited.nonAiResult!.factsRevision!);
    expect(completed.name).toBe('人工事实'); expect(completed.nonAiResult?.zodiac).toBe('兔');
    expect(completed.aiAnalysis?.explanation).toBe('新事实批断');
  });

  it('surfaces storage rejection without falsely persisting the draft', async () => {
    const base = await seed('manual-failure');
    configureBaziRepository({ ...memoryBaziRepository, getBaziRecord: async () => base, saveBaziRecord: async () => { throw new Error('磁盘写入失败'); } });
    await expect(saveNonAiEdits(base.id, { fields: { zodiac: '兔' } })).rejects.toThrow('磁盘写入失败');
  });

  it('serializes a deferred AI write with a simultaneous edit so the final persisted facts and AI stay current', async () => {
    const base = await seed('manual-race');
    let stored = pruneRecord(base);
    let entered!: () => void; let release!: () => void;
    const writing = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let first = true;
    configureBaziRepository({ ...memoryBaziRepository, getBaziRecord: async () => structuredClone(stored),
      saveBaziRecord: async (next) => {
        if (first) { first = false; entered(); await blocked; }
        stored = structuredClone(next as BaziRecord); return stored;
      } });
    const progress = saveAiProgress({ ...base, aiStatus: 'completed' }, 0);
    await writing;
    const editing = saveNonAiEdits(base.id, { fields: { zodiac: '兔' } });
    release(); await progress; const saved = await editing;
    expect(stored.nonAiResult?.zodiac).toBe('兔'); expect(stored.aiAnalysis).toBeUndefined();
    expect(saved.nonAiResult?.factsRevision).toBe(1);
    const late = await saveAiProgress(base, 0);
    expect(late.nonAiResult?.zodiac).toBe('兔'); expect(late.aiAnalysis).toBeUndefined();
  });

  it('checks preserved manual proportions against new automatic neighbors before saving a changed source', async () => {
    const base = await seed('manual-source-conflict');
    // Only 木 is manually changed; changing pillars recalculates the remaining four fractions.
    const original = base.nonAiResult!.elementRatio;
    const changed = await saveNonAiEdits(base.id, { fields: { elementRatio: { 木: original.木 + .125, 火: original.火 - .125 } } });
    const before = structuredClone(changed);
    await expect(saveNonAiEdits(base.id, { source: { hourPillar: '癸未' } })).rejects.toThrow('五行比例');
    expect((await getBaziRecord(base.id))?.nonAiResult?.factsRevision).toBe(before.nonAiResult?.factsRevision);
    expect((await getBaziRecord(base.id))?.hourPillar).toBe(base.hourPillar);
  });
});
