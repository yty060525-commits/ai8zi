import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_TONE } from '../data/baziOrchestrator';
import { readTone, saveTone, toneLabel } from '../features/person/PersonDetail';
afterEach(() => { try { localStorage.removeItem('mingli.analysis.tone'); } catch {} });

describe('语气滑杆', () => {
  it('默认 80：八成好话两成委婉', () => {
    expect(DEFAULT_TONE).toBe(80);
    expect(readTone()).toBe(80);
    expect(toneLabel(80)).toContain('温和');
    expect(toneLabel(80)).toContain('八成好话');
  });
  it('两端与中立文案正确', () => {
    expect(toneLabel(0)).toContain('犀利直白');
    expect(toneLabel(50)).toContain('中立');
    expect(toneLabel(100)).toContain('温柔夸夸');
  });
  it('保存后下次启动记住', () => {
    saveTone(35);
    expect(readTone()).toBe(35);
  });
});
