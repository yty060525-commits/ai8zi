import { describe, expect, it } from 'vitest';
import { sanitizeAnalysisText } from '../features/chart/elements';
import { sanitizeAnalysis } from '../data/baziOrchestrator';

/* 逐条剥除规则的真实产物(用被测实现本身跑一遍，不凭记忆写期望值)。 */
const SAMPLE = '【身强身弱与喜忌】\n1. 月支非日主禄刃之地，不得令。\n2. 助身方得分 28.8，克泄耗方得分 71。';
const STRIPPED = sanitizeAnalysisText(SAMPLE);

/* 闸门放行的字符集：汉字、空白、中文句读，外加唯一保留的结构标记 【】。 */
const PURE = /^[一-鿿 \n、。，：；？！【】]+$/;

describe('批断正文中文闸门', () => {
  it('截图事故句：括号注音的英文字段名被清掉，中文说法留下', () => {
    const out = sanitizeAnalysisText('月柱非禄刃之地，得令与否(inSeason)为false，助身方得分(support)为 28.8。');
    expect(out).not.toMatch(/[A-Za-z]/);
    expect(out).not.toContain('（');
    expect(out).toContain('月柱非禄刃之地');
    expect(out).toContain('助身方得分');
    expect(PURE.test(out)).toBe(true);
  });

  it('裸标识符与 true/false 残句一并清除', () => {
    const out = sanitizeAnalysisText('1. monthHasSupport 为 false，故无通根之助。');
    expect(out).not.toMatch(/[A-Za-z]/);
    expect(out).toContain('故无通根之助');
  });

  it('存量正文(带【】小节与旺衰读数)读出来是纯中文，且不留引擎读数', () => {
    // 旧数据不会自动变干净：展示/复制路径直读旧文本，这里就是那一道读时兜底。
    expect(STRIPPED).toBe('【身强身弱与喜忌】\n\n一、月支非日主禄刃之地，不得令。\n二、助身方得分，克泄耗方得分。');
    expect(PURE.test(STRIPPED)).toBe(true);
    // 钉子：读数复述整段删除的规则一旦失效，数字会转成「二十八点八」留下 —— 这条会红。
    expect(STRIPPED).not.toContain('二十八');
    expect(STRIPPED).not.toContain('七十一');
  });

  it('结构不丢：小节标记原样保留、编号行翻成中文序号，供检索与维度筛选切段', () => {
    // 闸门只放行汉字与中文句读，因此这对括号是归一化专门翻回来的唯一非汉字字符；
    // 若改成「删掉括号」，标题会与正文粘成一句(健康注意作息)，维度筛选再也命中不到。
    const out = sanitizeAnalysisText('【健康】\n1. 注意作息。\n2. 避免熬夜。');
    expect(out).toBe('【健康】\n\n一、注意作息。\n二、避免熬夜。');
    expect(out).not.toContain('健康注意作息');
    // 除小节括号外，正文里不许有第三种符号
    expect(out.replace(/[【】]/g, '')).toMatch(/^[一-鿿 \n、。，：；？！]+$/);
  });

  it('不误伤中文数字与标点，换行结构保持', () => {
    const out = sanitizeAnalysisText('【财运】\n1. 今年财星得地，宜守不宜攻。\n2. 忌神在年，防破财。');
    expect(out).toBe('【财运】\n\n一、今年财星得地，宜守不宜攻。\n二、忌神在年，防破财。');
  });

  it('sanitizeAnalysis 全字段过一遍：pattern/strength/explanation 都不留英文', () => {
    const out = sanitizeAnalysis({
      pattern: '食神格(basis)',
      strength: '身弱(inSeason为false)',
      usefulElements: ['木'],
      avoidElements: ['金'],
      explanation: '【身强身弱与喜忌】\n1. 净分(index)为 -42，档位(label)身弱。',
    } as never);
    for (const value of [out.pattern, out.strength, out.explanation]) {
      expect(value).not.toMatch(/[A-Za-z0-9]/);
    }
    expect(out.pattern).toContain('食神格');
    expect(out.explanation).toContain('身弱');
  });
});
