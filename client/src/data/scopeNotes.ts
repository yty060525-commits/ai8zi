/* =============================================================================
 * 逐条「点评」留言 —— 给已经算出来的每一条批断旁边留一句自己的话
 *
 * 为什么单独一个模块、而且**不往 record 上加字段**：
 *   record 会随同步上行服务器、再下发到别的设备。点评是"我看这条盘时随手写的私房话"，
 *   一旦进 record，这边给人甲写的批注会在别人（或另一台设备）那边冒出来，还会被
 *   「复制全部 / 复制勾选内容」当成正文一起带走 —— 那等于把私人笔记混进了命盘正文。
 *   所以存本机 localStorage，键里带 recordId + taskId，跟语气滑杆(pref.<id>)同一套做法。
 *
 * 定位用 taskId 而不是标题文本：taskId 由 buildBaziTasks 按**槽位顺序**生成（本命 task-01、
 *  往后流年/流月/大运依次编号），重跑同一张盘稳定不变；拿 describeScope 那种拼出来的中文标题
 *  当键，改文案就会把老点评全变孤儿。
 *  ⚠ 但槽位会跟着「分析窗口」走：跨年重排时同一个年份可能从 task-05 挪到 task-06。所以这里
 *  的取舍是「点评跟着这一格批断」——格子换了内容，老点评就该留在原处由人自己看着删，
 *  绝不去猜"应该挪到哪一格"（猜错等于把话安到别人头上）。
 *
 * ⚠ 这是**公开功能**，不受本地系统解锁码约束：任何人都能给自己的盘写点评。
 *  （与 data/localSystem.ts 那套「未开通零痕迹」的判据无关，别把它接进那个闸门。）
 * ========================================================================== */

const NOTES_KEY = 'mingli.notes';

export interface ScopeNote { text: string; updatedAt: string }
/** 一条盘的全部点评：taskId → 点评。缺省表示这条盘还没写过。 */
type NotesByRecord = Record<string, Record<string, ScopeNote>>;

/** 单条点评的字数上限：留言不是写论文，超了直接截，免得一个人把整条记录撑爆。 */
export const NOTE_MAX_LEN = 500;

function readAll(): NotesByRecord {
  try {
    const raw = localStorage.getItem(NOTES_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: NotesByRecord = {};
    for (const [recordId, entry] of Object.entries(parsed as Record<string, unknown>)) {
      if (!recordId || !entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const tasks: Record<string, ScopeNote> = {};
      for (const [taskId, note] of Object.entries(entry as Record<string, unknown>)) {
        if (!taskId || !note || typeof note !== 'object') continue;
        const t = (note as Partial<ScopeNote>).text;
        if (typeof t !== 'string' || !t.trim()) continue;      // 空文本人人可读但没人想看，直接丢
        /* ⚠ 读、写两侧各自截一刀，缺任何一侧都算没截：只去写侧是等价变异（读侧替它兜住、用例全绿），
           只去读侧则由「存储里已有的过长文本」那条直接打死 —— 两侧都去才红。留双刀的理由是这条路径
           要挡住的是**别的版本/上限调小后**留在存储里的旧数据，那部分压根不经过写入口。 */
        tasks[taskId] = { text: t.trim().slice(0, NOTE_MAX_LEN), updatedAt: String((note as Partial<ScopeNote>).updatedAt ?? '') };
      }
      if (Object.keys(tasks).length) out[recordId] = tasks;
    }
    return out;
  } catch { return {}; }                                        // 坏 JSON 就当没有，绝不让详情页白屏
}

function writeAll(all: NotesByRecord): boolean {
  try {
    if (Object.keys(all).length === 0) localStorage.removeItem(NOTES_KEY);
    else localStorage.setItem(NOTES_KEY, JSON.stringify(all));
    return true;
  } catch { return false; }                                     // 配额满/隐私模式：调用方要如实报错，别假装存上了
}

/** 取这条盘的全部点评（副本；改返回对象不会碰到存储）。 */
export function getScopeNotes(recordId: string | undefined): Record<string, ScopeNote> {
  if (!recordId) return {};
  return { ...readAll()[recordId] };
}

/** 某一条批断的点评；没写过返回 undefined。 */
export function getScopeNote(recordId: string | undefined, taskId: string | undefined): ScopeNote | undefined {
  if (!recordId || !taskId) return undefined;
  return readAll()[recordId]?.[taskId];
}

/** 写入/覆盖一条点评。空白视为删除。存不下（配额）时返回 false，让界面如实提示而不是静默丢失。 */
export function saveScopeNote(recordId: string | undefined, taskId: string | undefined, text: string): boolean {
  if (!recordId || !taskId) return false;
  const trimmed = String(text ?? '').trim().slice(0, NOTE_MAX_LEN);
  const all = readAll();
  const tasks = { ...(all[recordId] ?? {}) };
  /* 空白 = 「这一格没有点评」，而不是「把这条盘的点评全删掉」。所以它只在**那一格本来有内容**时
     才落删除；否则一律不动存储。少了这个前提，"清空后重写"这类实现会把别的格子一起带走 ——
     实测过一版 `if (!trimmed) { deleteScopeNotesForRecord(recordId); return true; }`：
     对没写过的格子什么都不建（旧判据全绿），却会顺手清光同一条盘其他格子的点评。 */
  if (!trimmed) { if (!tasks[taskId]) return true; delete tasks[taskId]; }
  else tasks[taskId] = { text: trimmed, updatedAt: new Date().toISOString() };
  if (Object.keys(tasks).length) all[recordId] = tasks;
  else delete all[recordId];
  return writeAll(all);
}

export function deleteScopeNote(recordId: string | undefined, taskId: string | undefined): boolean {
  if (!recordId || !taskId) return false;
  const all = readAll();
  if (!all[recordId]?.[taskId]) return true;                    // 本来就没有：幂等成功，不必改写存储
  const tasks = { ...all[recordId] };
  delete tasks[taskId];
  if (Object.keys(tasks).length) all[recordId] = tasks;
  else delete all[recordId];
  return writeAll(all);
}

/** 删盘时连带清掉它的点评（否则每删一条盘就留下一堆谁也匹配不上的孤儿数据）。 */
export function deleteScopeNotesForRecord(recordId: string | undefined): void {
  if (!recordId) return;
  const all = readAll();
  if (!all[recordId]) return;
  delete all[recordId];
  writeAll(all);
}

/** 测试用：清空全部点评。 */
export function resetScopeNotesForTests(): void {
  try { localStorage.removeItem(NOTES_KEY); } catch { /* 忽略 */ }
}
