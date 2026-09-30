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
      '',
    ];
    for (const text of cases) {
      const viaElements = reexport.sanitizeChatText(text);
      expect(viaElements, text).toBe(gate.sanitizeChatText(text));
      // 正式版口径：除小节括号外不留任何非汉字字符；被拦下的返回空串而不是残缺正文。
      if (viaElements) expect(viaElements.replace(/[【】]/g, '')).toMatch(/^[一-鿿 \n、。，：；？！]+$/);
    }
  });
});
