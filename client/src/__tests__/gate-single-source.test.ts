import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as gate from '../shared/chineseGate';
import * as reexport from '../features/chart/elements';

/* 闸门只有一份实现：client/src/shared/chineseGate.ts。服务器 chat.mjs 用 Node 的原生 TS 加载
 * 直接 import 同一个文件，浏览器端经 features/chart/elements.ts 再导出。以前两端各抄一份清洗器，
 * 一端改了另一端不知道，就会出现「网页干净、桌面漏英文」。这里把「同一份」钉成断言。 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../') + '/';
const read = (p: string) => readFileSync(root + p, 'utf8').replace(/\r\n/g, '\n');

describe('正文中文闸门单一来源(服务器与浏览器同口径)', () => {
  it('服务器 chat.mjs 导入的就是这份 chineseGate.ts，没有第二份实现', () => {
    const server = read('server/chat.mjs');
    expect(server).toContain("from '../client/src/shared/chineseGate.ts'");
    // 反向钉子：服务器里不许再自己写清洗函数(否则这份测试就该红在「它测不到分叉」上)。
    expect(server).not.toMatch(/function\s+(stripToChinese|enforceChinese|sanitizeChatText)\s*\(/);
    expect(server.match(/isChineseOnly\s*=\s*\(/g)?.length ?? 0).toBe(0);
  });
  it('浏览器端经 elements.ts 再导出，拿到的是同一个函数对象', () => {
    for (const key of ['sanitizeChatText', 'sanitizeAnalysisText', 'enforceChinese', 'isChineseOnly', 'nonChineseKinds', 'FIELD_NAME_ZH'] as const) {
      expect(reexport[key], key).toBe(gate[key]);
    }
  });
  it('两端同源 ⇒ 同一串脏文本必然得到同一结果(抽查若干形态)', () => {
    const cases = [
      '身弱（strengthScore 42），助身方得分(support)为 28.8。',
      '【健康】1. 注意作息。\n2. 避免熬夜。',
      '依据：2027年·流年批断的【事业】小节。',
      'Sorry, I cannot answer this in English.',
      '甲子㊣乙丑',
      // @ 这类「不在任何清洗表里」的符号：既不许留在正文，也不许把整篇判空。
      '联系师傅@微信：xxx_888，见【总评/行为建议】小节。',
      '命局#吉%宜忌&参考*备注+说明=结论',
      '',
    ];
    for (const text of cases) {
      const viaElements = reexport.sanitizeChatText(text);
      expect(viaElements, text).toBe(gate.sanitizeChatText(text));
      // 正式版口径：除小节括号外不留任何非汉字字符；被拦下的返回空串而不是残缺正文。
      if (viaElements) expect(viaElements.replace(/[【】]/g, '')).toMatch(/^[一-鿿 \n、。，：；？！]+$/);
    }
  });

  /* 删表与判据必须同源：以前 stripToChinese 末尾手写一份符号表，白名单之外漏了 @ ㊣ # % 等形，
     漏掉的字符既不删也过不了 isChineseOnly ⇒ enforceChinese 判空(宁缺毋滥变成全缺)，
     上层按「该通道没给出可用中文」换通道重答，脏符号还会从调用方兜底拼回正文。 */
  it('特殊符号一律清除，且不会因残留把整篇判空', () => {
    const nasty = '甲@乙#丙%丁&戊*己+庚=辛<壬>癸【】《》「」〔〕㊣█■□◆●◎＄￥＿｜~^`\'"“”‘’';
    const out = gate.sanitizeAnalysisText(nasty);
    expect(out, '含生僻符号的正文不该整篇作废').not.toBe('');
    expect(out).toBe('甲乙丙丁戊己庚辛壬癸【】');
    expect(nonChineseSymbols(out)).toEqual([]);
    // 逐类抽查：每类符号单独出现时都被清掉，且句子骨架还在
    for (const sym of ['@', '#', '%', '&', '*', '+', '=', '~', '^', '`', '㊣', '█', '￥', '＿', '｜']) {
      const one = gate.sanitizeAnalysisText(`日主庚金${sym}身弱`);
      expect(one, sym).toBe('日主庚金身弱');
    }
  });
});

/** 白名单之外的字符(【】单独放行)：用于终态断言，不再手写第二份符号清单。 */
function nonChineseSymbols(text: string): string[] {
  return [...text.replace(/[【】]/g, '')].filter((c) => !/^[一-鿿 \n、。，：；？！]$/.test(c));
}
