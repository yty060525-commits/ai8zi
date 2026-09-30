import { describe, expect, it } from 'vitest';
import { sanitizeChatText, isChineseOnly, nonChineseKinds, FIELD_NAME_ZH } from '../features/chart/elements';

/* 正式版口径：正文限死纯中文。模型实测会把证据 JSON 里的英文字段名原样抄进正文
 * (「身弱（strengthScore 42）」「patternFacts 为准」)，提示词只是软约束，这里做确定性兜底。
 * 与旧版的区别：数字、括号、书名号、英文缩写(AI/JSON)一律不许留下；清洗后仍不合规就返回空，
 * 由上层按失败处理并换通道 —— 宁可没答案，也不给用户看半句非中文。 */
describe('聊天正文中文闸门', () => {
  it('英文字段名翻成中文说法，括号与阿拉伯数字一并清掉', () => {
    const out = sanitizeChatText('本命盘事实为庚金日主、身弱（strengthScore 42），喜土金。');
    expect(out).toBe('本命盘事实为庚金日主、身弱旺衰评分 四十二，喜土金。');
    expect(isChineseOnly(out)).toBe(true);
  });

  it('未收录的变量名直接从中文语境里剔除', () => {
    const out = sanitizeChatText('依据 strengthScore 与 someInternalVar 判断，身弱。');
    expect(out).not.toMatch(/[A-Za-z]/);
    expect(out).toContain('身弱');
    expect(out).toContain('旺衰评分');
  });

  it('多个字段名连续出现也不留英文', () => {
    const out = sanitizeChatText('patternFacts 与 strengthScore 均如此。');
    expect(out).not.toMatch(/patternFacts|strengthScore/);
    expect(out).toContain('格局事实');
    expect(out).toContain('旺衰评分');
  });

  it('编号、年份转中文写法，小节括号作为唯一结构标记保留', () => {
    const out = sanitizeChatText('1. 事业：稳中有进，宜守不宜攻。依据：2027年·流年批断的【事业】小节。');
    expect(out).toBe('一、事业：稳中有进，宜守不宜攻。依据：二零二七年流年批断的【事业】小节。');
    expect(isChineseOnly(out)).toBe(true);
  });

  it('除小节括号外不留任何符号：引号、间隔号、半角标点都被剥掉', () => {
    const out = sanitizeChatText('请点「AI 分析」并查看 JSON 字段(说明)。');
    expect(out).not.toMatch(/[A-Za-z]/);
    expect(out).not.toContain('「');
    expect(out).not.toContain('(');
    expect(isChineseOnly(out)).toBe(true);
  });

  it('整段跑成英文(无中文且英文词多) → 返回空，交上层按失败换通道', () => {
    expect(sanitizeChatText('Sorry, I cannot answer this question based on the provided data.')).toBe('');
  });

  it('清洗后仍混着不可读符号 → 返回空而不是放行', () => {
    // 闸门比清洗器更严：清洗表里没有的字符(如 ㊣)不该被放过，也不该在日志里报成「无违规」。
    expect(nonChineseKinds('甲子㊣乙丑')).toEqual(['其他符号']);
    expect(sanitizeChatText('甲子㊣乙丑')).toBe('');
  });

  it('空白与 null 输入不抛错', () => {
    expect(sanitizeChatText('')).toBe('');
    expect(sanitizeChatText(null as unknown as string)).toBe('');
  });

  it('字段名映射表覆盖关键字段(三端口径一致的基础)', () => {
    for (const key of ['patternFacts', 'strengthScore', 'dayMaster', 'elementRatio', 'periodFacts', 'missing']) {
      expect(FIELD_NAME_ZH[key], key).toBeTruthy();
      expect(FIELD_NAME_ZH[key]).toMatch(/^[一-鿿]+$/);
    }
  });
});
