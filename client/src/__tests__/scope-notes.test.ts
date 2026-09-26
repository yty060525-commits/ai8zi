import { afterEach, describe, expect, it } from 'vitest';
import {
  deleteScopeNote, deleteScopeNotesForRecord, getScopeNote, getScopeNotes,
  NOTE_MAX_LEN, resetScopeNotesForTests, saveScopeNote,
} from '../data/scopeNotes';

const KEY = 'mingli.notes';
afterEach(() => { resetScopeNotesForTests(); localStorage.clear(); });

describe('逐条点评的存储（本机、按 recordId + taskId）', () => {
  it('没写过就是没有；写入后能读回来，且带时间戳', () => {
    expect(getScopeNote('r1', 'task-05')).toBeUndefined();
    expect(saveScopeNote('r1', 'task-05', '这年我自己觉得准')).toBe(true);
    const note = getScopeNote('r1', 'task-05');
    expect(note?.text).toBe('这年我自己觉得准');
    // 时间戳必须真的写进去了：它是"这条点评有多旧"的唯一依据
    expect(Date.parse(note?.updatedAt ?? '')).not.toBeNaN();
  });

  it('两条盘互不串台；同一条盘的两个格子各存各的', () => {
    saveScopeNote('r1', 'task-05', '甲盘流年');
    saveScopeNote('r2', 'task-05', '乙盘流年');
    saveScopeNote('r1', 'task-13', '甲盘流月');
    expect(getScopeNote('r1', 'task-05')?.text).toBe('甲盘流年');
    expect(getScopeNote('r2', 'task-05')?.text).toBe('乙盘流年');
    expect(Object.keys(getScopeNotes('r1'))).toEqual(['task-05', 'task-13']);
  });

  it('覆盖写只留最新一条；空白文字等于删除', () => {
    saveScopeNote('r1', 'task-01', '第一版');
    saveScopeNote('r1', 'task-01', '第二版');
    expect(getScopeNotes('r1')).toEqual({ 'task-01': { text: '第二版', updatedAt: getScopeNote('r1', 'task-01')!.updatedAt } });
    saveScopeNote('r1', 'task-01', '   ');
    expect(getScopeNote('r1', 'task-01')).toBeUndefined();
    expect(Object.keys(getScopeNotes('r1'))).toHaveLength(0);
  });

  it('超长直接截到上限，不把整篇论文塞进本地存储', () => {
    saveScopeNote('r1', 'task-01', '话'.repeat(NOTE_MAX_LEN + 50));
    expect(getScopeNote('r1', 'task-01')!.text).toHaveLength(NOTE_MAX_LEN);
  });

  /* 读侧也要截：写的时候可能没截（旧版本、或上限以后调小）。这条把「只在写入处截刀」的写法钉住 ——
     直接把存储里的长文本摆好，绕开写入口，看读出来还剩多长。 */
  it('存储里已有的过长文本，读回来同样不超上限', () => {
    localStorage.setItem(KEY, JSON.stringify({ r1: { 'task-01': { text: '话'.repeat(NOTE_MAX_LEN + 80), updatedAt: '2026-01-01T00:00:00.000Z' } } }));
    expect(getScopeNote('r1', 'task-01')!.text).toHaveLength(NOTE_MAX_LEN);
  });

  /* 判据不能只盯"最新那条"：updatedAt 必须跟着每次保存往前走，否则界面没法说这条点评是什么时候写的。 */
  it('每次覆盖都刷新时间戳（不是只在第一次写时盖上）', async () => {
    saveScopeNote('r1', 'task-01', '第一版');
    const first = Date.parse(getScopeNote('r1', 'task-01')!.updatedAt);
    await new Promise((r) => setTimeout(r, 15));
    saveScopeNote('r1', 'task-01', '第二版');
    expect(Date.parse(getScopeNote('r1', 'task-01')!.updatedAt)).toBeGreaterThan(first);
  });

  it('首尾空白存进去前先去掉：界面上不留只有空格的假点评', () => {
    saveScopeNote('r1', 'task-01', '\n  两句之间的空白  \n');
    expect(getScopeNote('r1', 'task-01')!.text).toBe('两句之间的空白');
  });

  /* 「空白 = 删除」的另一半：对**没有**点评的格子写空白，必须一个字都不落。
     漏了这一支的实现（无脑 delete / 无脑建 recordId）在这里红 —— 它会让"我什么都没写"
     的盘在存储里冒出一个空壳键。 */
  it('给没写过的格子保存空白：不建立条目、也不留下这条盘的壳', () => {
    expect(saveScopeNote('r1', 'task-01', '   ')).toBe(true);
    expect(localStorage.getItem(KEY), '空白写入不该在存储里建出任何东西').toBeNull();
    expect(Object.keys(getScopeNotes('r1'))).toHaveLength(0);
    // 已有点评时同样一句话才生效：先写一句，再用空白清掉
    saveScopeNote('r2', 'task-01', '写过一句');
    expect(saveScopeNote('r2', 'task-01', '  ')).toBe(true);
    expect(getScopeNote('r2', 'task-01')).toBeUndefined();
    expect(localStorage.getItem(KEY), '清空最后一条后该把键删掉').toBeNull();
  });

  /* 空白只作废**那一格**：同一条盘上别的点评一个字都不许被牵连。
     （"清空整条盘再返回 true" 这种实现能骗过上面那条 —— 它对没写过的格子确实什么都不建。） */
  it('对某格保存空白不许清掉同一条盘其他格的点评', () => {
    saveScopeNote('r1', 'task-01', '本命的话');
    saveScopeNote('r1', 'task-05', '流年的话');
    expect(saveScopeNote('r1', 'task-13', '   '), '空白写入本身要成功返回').toBe(true);
    expect(getScopeNote('r1', 'task-01')?.text).toBe('本命的话');
    expect(getScopeNote('r1', 'task-05')?.text).toBe('流年的话');
    // 真正清空某一格时，也只动那一格
    expect(saveScopeNote('r1', 'task-05', '')).toBe(true);
    expect(getScopeNote('r1', 'task-05')).toBeUndefined();
    expect(getScopeNote('r1', 'task-01')?.text, '删一格不能顺手清整条盘').toBe('本命的话');
  });

  it('删掉某格只动那一格；删盘把这条盘的点评整体清掉', () => {
    saveScopeNote('r1', 'task-01', '本命');
    saveScopeNote('r1', 'task-05', '流年');
    saveScopeNote('r2', 'task-01', '别人的盘');
    deleteScopeNote('r1', 'task-01');
    expect(getScopeNote('r1', 'task-01')).toBeUndefined();
    expect(getScopeNote('r1', 'task-05')?.text, '删错格子会把别的点评一起带走').toBe('流年');
    expect(getScopeNote('r2', 'task-01')?.text).toBe('别人的盘');
    deleteScopeNotesForRecord('r1');
    expect(Object.keys(getScopeNotes('r1'))).toHaveLength(0);
    expect(getScopeNote('r2', 'task-01')?.text, '删一条盘不该碰别人的点评').toBe('别人的盘');
  });

  it('空记录全清掉时连键都不留（不给设置页/容量统计添一个空壳）', () => {
    saveScopeNote('r1', 'task-01', '一句话');
    deleteScopeNotesForRecord('r1');
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('坏数据不炸：非 JSON / 数组 / 缺 text 一律当没有', () => {
    localStorage.setItem(KEY, '{这不是 JSON');
    expect(getScopeNotes('r1')).toEqual({});
    localStorage.setItem(KEY, '[1,2,3]');
    expect(getScopeNotes('r1')).toEqual({});
    localStorage.setItem(KEY, JSON.stringify({ r1: { 'task-01': { text: '   ' }, 'task-02': null }, '': { 'task-01': { text: 'x' } } }));
    expect(Object.keys(getScopeNotes('r1'))).toEqual([]);
  });

  it('存不下时如实报 false（配额满/隐私模式不能假装保存成功）', () => {
    const real = Storage.prototype.setItem;
    Storage.prototype.setItem = () => { throw new Error('QuotaExceededError'); };
    try {
      expect(saveScopeNote('r1', 'task-01', '写不进去')).toBe(false);
      expect(deleteScopeNote('r1', 'task-01')).toBe(true);   // 本来就没有：删除无需写入，仍算成功
    } finally { Storage.prototype.setItem = real; }
    // 旁路核对：恢复可写后同一句话就能存下，说明上面那条 false 是存储失败而不是逻辑失败
    expect(saveScopeNote('r1', 'task-01', '写不进去')).toBe(true);
    expect(getScopeNote('r1', 'task-01')?.text).toBe('写不进去');
  });

  it('没有主键就不写：避免留下一条谁也匹配不上的脏项', () => {
    expect(saveScopeNote(undefined, 'task-01', 'x')).toBe(false);
    expect(saveScopeNote('r1', undefined, 'x')).toBe(false);
    expect(saveScopeNote('', '', 'x')).toBe(false);
    expect(localStorage.getItem(KEY), '无效主键不该在存储里留下任何东西').toBeNull();
  });
});
