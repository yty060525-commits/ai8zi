import { describe, expect, it } from 'vitest';
import { readableName } from '../data/chatEngine';

/** 命主姓名只要夹一个非汉字(数字、空格、间隔号、括号、生僻字)，旧读法就把全部汉字丢掉：
 *  「张三2」上屏成「二」，「张 三」「阿卜杜·热合曼」整名变成「该名称无法用中文念出」。 */
describe('姓名读法保留汉字', () => {
  it.each([
    ['张三', '张三'],
    ['张三2', '张三二'],
    ['张 三', '张三'],
    ['阿卜杜·热合曼', '阿卜杜热合曼'],
    ['小明（同事）', '小明同事'],
    ['𠮷田', '𠮷田'],
    ['王〇', '王〇'],
    ['李a', '李阿'],
  ])('%s → %s', (raw, shown) => {
    expect(readableName(raw)).toBe(shown);
  });

  it('纯机器串仍逐位读成中文，空名回落未命名', () => {
    expect(readableName('T_SOL_01')).not.toMatch(/[A-Za-z0-9_]/);
    expect(readableName('  ')).toBe('未命名');
  });
});
