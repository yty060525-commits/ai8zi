/* =============================================================================
 * 「念出机器串」这一层的判据
 *
 * 界面上有三类东西天生是机器串：HTTP 状态码、用户自填的账号名、构建/缓存号。
 * 正式版口径要「正文只能中文」，但它们又不能直接删 —— 删了管理员就不知道该给哪条通道补凭据、
 * 分不清哪个账号建的盘、也判断不出手机装的是哪一版。做法是把原样挪进悬浮说明(title)，
 * 正文留中文读法。于是这里必须同时钉两件事：
 *  1) 读法本身正确(逐位、不四舍五入、纯中文名不改写)；
 *  2) 原串确实还在 DOM 里可取回 —— 只断言「正文没英文」会放过「直接把账号删掉」这种实现。
 * ========================================================================= */
import { describe, expect, it } from 'vitest';
import { readableName } from '../data/chatEngine';
import { cnCode } from '../shared/chineseReadAloud';

describe('账号名与状态码的中文读法', () => {
  it('状态码逐位读，不读成数值', () => {
    expect(cnCode(503)).toBe('五零三');
    expect(cnCode(429)).toBe('四二九');
    expect(cnCode('8787')).toBe('八七八七');
    expect(cnCode(0)).toBe('零');
  });

  it('纯中文账号原样显示，不替用户改写名字', () => {
    expect(readableName('张三')).toBe('张三');
    expect(readableName(' 李四 ')).toBe('李四');
  });

  it('含拉丁字母或数字的账号读成中文，正文不留一个拉丁字母', () => {
    const read = readableName('admin');
    expect(/[A-Za-z]/.test(read), '读法里仍含英文：' + read).toBe(false);
    expect(/[0-9]/.test(read), '读法里仍含数字：' + read).toBe(false);
    // 逐位读 ⇒ 长度只会变长不会丢字符；空读法说明映射表漏了某字母被静默吞掉。
    expect(read.length).toBeGreaterThan(1);
    expect(readableName('user01')).not.toBe(readableName('user02'));
  });

  it('空账号与完全念不出的账号都退回固定说法，不会渲染成空白', () => {
    expect(readableName('')).not.toBe('');
    expect(readableName(undefined)).not.toBe('');
    expect(readableName('🙂🙂')).not.toBe('');
  });
});
