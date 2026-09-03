import { describe, expect, it } from 'vitest';
import { formatCopyBody, pickDimensionSections, splitSections, toPointBlocks } from '../features/person/PersonDetail';
import type { BaziAIAnalysis } from '../types/domain';

describe('copy 排版/筛选(范围 x 维度)', () => {
  it('splits explanation into 【】sections and rebuilds the original text', () => {
    const text = '开场引言。\n【健康】注意作息。\n【爱情】三观相合。\n结尾一句。';
    const sections = splitSections(text);
    expect(sections.map((s) => s.head)).toEqual(['', '健康', '爱情']);
    expect(sections[1]?.body).toContain('注意作息');
    expect(sections[2]?.body).toContain('三观相合');
    expect(sections[2]?.body).toContain('结尾一句');
    // 还原正文(段落标记不变，整体等价)
    const rebuilt = sections.map((s) => (s.head ? '【' + s.head + '】' : '') + s.body).join('\n');
    expect(rebuilt.replace(/\s+/g, '')).toBe(text.replace(/\s+/g, ''));
  });

  it('keeps only the checked dimensions when filtering', () => {
    const text = '【健康】早睡。\n【爱情】长久。\n【事业】深耕。\n【财运】稳健。\n【刑冲克害批注】1. 六冲：…';
    const picked = pickDimensionSections(text, ['love', 'wealth']);
    expect(picked.map((s) => s.head)).toEqual(['爱情', '财运']);
    expect(picked.map((s) => s.body).join('')).toContain('长久');
  });

  it('copies 刑冲破害 markers via the chong dimension', () => {
    const text = '【刑冲克害批注】1. 六合：…';
    const picked = pickDimensionSections(text, ['chong']);
    expect(picked.map((s) => s.head)).toEqual(['刑冲克害批注']);
  });

  it('formats a full copy with title and every section; filtered copy drops others', () => {
    const analysis: BaziAIAnalysis = { pattern: 'x', strength: '强', usefulElements: [], avoidElements: [], explanation: '【健康】早睡。\n【爱情】长久。', title: '鸾凤和鸣' };
    const full = formatCopyBody(analysis, null);
    expect(full).toContain('标题：鸾凤和鸣');
    expect(full).toContain('【健康】');
    expect(full).toContain('【爱情】');
    const onlyLove = formatCopyBody(analysis, ['love']);
    expect(onlyLove).toContain('【爱情】');
    expect(onlyLove).not.toContain('【健康】');
    expect(onlyLove).not.toContain('标题');
  });

  it('treats legacy text without any markers as whole content only in full copy', () => {
    const analysis: BaziAIAnalysis = { pattern: 'p', strength: '弱', usefulElements: [], avoidElements: [], explanation: '旧版长文正文…' };
    expect(formatCopyBody(analysis, null)).toContain('旧版长文正文');
    expect(formatCopyBody(analysis, ['love'])).toBe('');
  });
});

describe('正文分点化(toPointBlocks / 复制)', () => {
  const sample = '【身强身弱与喜忌】甲木日主生于巳月，火旺泄身，综合判断为身弱。身弱喜印比，以水木为用。\n【健康】注意肝胆。避免熬夜。\n【刑冲克害批注】1. 三合（巳酉丑半合）：遇合多助；\n2. 六冲（壬午）：易有变动。';

  it('turns every splittable sentence into its own bullet', () => {
    const blocks = toPointBlocks(sample);
    expect(blocks.map((b) => b.head)).toEqual(['【身强身弱与喜忌】', '【健康】', '【刑冲克害批注】']);
    expect(blocks[0]?.points.length).toBe(2);
    expect(blocks[1]?.points).toEqual(['注意肝胆。', '避免熬夜。']);
  });

  it('keeps already-numbered 批注 lines intact as single points', () => {
    const blocks = toPointBlocks(sample);
    expect(blocks[2]?.points).toEqual(['1. 三合（巳酉丑半合）：遇合多助；', '2. 六冲（壬午）：易有变动。']);
  });

  it('bullets the copied body too', () => {
    const analysis: BaziAIAnalysis = { pattern: '', strength: '', usefulElements: [], avoidElements: [], explanation: '【爱情】长久相合。多沟通。' };
    const full = formatCopyBody(analysis, null);
    expect(full).toContain('【爱情】');
    expect(full).toContain('• 长久相合。');
    expect(full).toContain('• 多沟通。');
  });
});
