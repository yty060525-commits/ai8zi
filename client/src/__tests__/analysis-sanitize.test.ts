import { describe, expect, it } from 'vitest';
import { sanitizeAnalysisText } from '../features/chart/elements';
import { sanitizeAnalysis } from '../data/baziOrchestrator';

describe('批断正文去英文', () => {
  it('截图事故句：括号注音的英文字段名被清掉，中文说法留下', () => {
    const out = sanitizeAnalysisText('月柱非禄刃之地，得令与否(inSeason)为false，助身方得分(support)为 28.8。');
    expect(out).not.toContain('inSeason');
    expect(out).not.toContain('support');
    expect(out).not.toContain('（');
    expect(out).toContain('月柱非禄刃之地');
    expect(out).toContain('为 28.8');
  });

  it('裸标识符与 true/false 残句一并清除', () => {
    const out = sanitizeAnalysisText('1. monthHasSupport 为 false，故无通根之助。');
    expect(out).not.toMatch(/[A-Za-z]/);
    expect(out).toContain('故无通根之助');
  });

  it('已经是纯中文的段落原样不动', () => {
    const src = '【身强身弱与喜忌】\n1. 月支非日主禄刃之地，不得令。\n2. 助身方得分 28.8，克泄耗方得分 71。';
    expect(sanitizeAnalysisText(src)).toBe(src);
  });

  it('不误伤中文数字与标点，换行结构保持', () => {
    const out = sanitizeAnalysisText('【财运】\n1. 今年财星得地，宜守不宜攻。\n2. 忌神在年，防破财。');
    expect(out).toBe('【财运】\n1. 今年财星得地，宜守不宜攻。\n2. 忌神在年，防破财。');
  });

  it('sanitizeAnalysis 全字段过一遍：pattern/strength/explanation 都不留英文', () => {
    const out = sanitizeAnalysis({
      pattern: '食神格(basis)',
      strength: '身弱(inSeason为false)',
      usefulElements: ['木'],
      avoidElements: ['金'],
      explanation: '【身强身弱与喜忌】\n1. 净分(index)为 -42，档位(label)身弱。',
    } as never);
    expect(out.pattern).not.toMatch(/[A-Za-z]/);
    expect(out.strength).not.toMatch(/[A-Za-z]/);
    expect(out.explanation).not.toMatch(/[A-Za-z]/);
    expect(out.explanation).toContain('为 -42');
  });
});
