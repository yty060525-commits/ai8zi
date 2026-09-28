import { describe, expect, it } from 'vitest';
import { sanitizeChatText, FIELD_NAME_ZH } from '../features/chart/elements';

/* 实测回归(deepseek-chat + reasoning_effort=high)：模型会把证据 JSON 里的英文字段名
 * 原样抄进正文，例如「身弱（strengthScore 42）」「patternFacts 为准」。
 * 提示词已明令禁止，这里是确定性兜底，必须做到：中文与标点不动，英文标识符不许出现。 */
describe('聊天正文去英文', () => {
  it('把证据 JSON 的英文字段名翻成中文，而不是删掉', () => {
    const out = sanitizeChatText('本命盘事实为庚金日主、身弱（strengthScore 42），喜土金。');
    expect(out).not.toMatch(/strengthScore/);
    expect(out).toContain('旺衰评分 42');
    expect(out).toContain('庚金日主');
  });

  it('未收录的变量名直接从中文语境里剔除', () => {
    const out = sanitizeChatText('依据 strengthScore 与 someInternalVar 判断，身弱。');
    expect(out).not.toMatch(/[A-Za-z]{2,}/);
    expect(out).toContain('身弱');
    expect(out).toContain('旺衰评分');
  });

  it('多个字段名连续出现也不留英文', () => {
    const out = sanitizeChatText('patternFacts 与 strengthScore 均如此。');
    expect(out).not.toMatch(/patternFacts|strengthScore/);
    expect(out).toContain('格局事实');
    expect(out).toContain('旺衰评分');
  });

  it('纯正文不受影响：中文与标点原样保留', () => {
    const src = '1. 事业：稳中有进，宜守不宜攻。依据：2027年·流年批断的【事业】小节。';
    expect(sanitizeChatText(src)).toBe(src);
  });

  it('保留 AI 这个公认缩写，其余英文缩写剔除', () => {
    const out = sanitizeChatText('请点「AI 分析」并查看 JSON 字段。');
    expect(out).toContain('AI');
    expect(out).not.toContain('JSON');
  });

  it('整段跑成英文(无中文且英文词多) → 返回空，交上层按失败换通道', () => {
    expect(sanitizeChatText('Sorry, I cannot answer this question based on the provided data.')).toBe('');
  });

  it('空白与 null 输入不抛错', () => {
    expect(sanitizeChatText('')).toBe('');
    expect(sanitizeChatText(null as unknown as string)).toBe('');
  });

  it('字段名映射表覆盖关键字段(两端口径一致的基础)', () => {
    for (const key of ['patternFacts', 'strengthScore', 'dayMaster', 'elementRatio', 'periodFacts', 'missing']) {
      expect(FIELD_NAME_ZH[key], key).toBeTruthy();
      expect(FIELD_NAME_ZH[key]).toMatch(/^[\u4e00-\u9fff]+$/);
    }
  });
});
