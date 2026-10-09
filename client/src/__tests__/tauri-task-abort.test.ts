import { afterEach, describe, expect, it, vi } from 'vitest';

/* 缺陷 #142：桌面端(Tauri)那两条本机通道路径没接住「停止」。
 *
 * Rust 侧的取消凭据早就存在且真被读：lib.rs:712/741/748 三处 session_cancelled()，
 * 置位后 run_ai_task 直接 Err("cancelled")、一个上游字节都不发；聊天那条(834-895)一条都没读。
 * 漏在 JS 这一侧，共两处半：
 *   ① analyzeBazi / analyzeTask 的 inTauri() 分支把 invoke 抛来的 "cancelled" 交给
 *      readableTransportError() —— 那里只认 rate limit / overloaded 这类英文关键词，中文串原样透传，
 *      编排器再把「用户主动停止」当成一条**失败批断**存进 aiTasks。
 *   ② chatEngine.askChatLocal 的 Tauri 分支既不读 signal、也不看会话开关，
 *      清空对话或换问题时在途那一问照样跑完并写本机聊天缓存(#143)。
 *
 * 判据全部走真实导出(cancelAiSession / askChat 的 signal)，不直接改桩里的布尔，免得自证。 */

let sessionCancelled = false;
const upstreamCalls: string[] = [];
/** 挂起用的闸门：置 true 时上游调用 await 到 releaseUpstream() 才返回。 */
let hangUpstream = false;
let releaseUpstream: (() => void) | null = null;
/** 桌面聊天分支的缓存写入计数(Rust 侧 write_cache 的替身)，用来证明中止那一问照样落了缓存。 */
let desktopChatCacheWrites = 0;

async function fakeUpstream(cmd: string): Promise<{ status: string; analysis?: unknown; answer?: string }> {
  upstreamCalls.push(cmd);
  if (cmd === 'run_ai_task' && sessionCancelled) throw new Error('cancelled');
  if (hangUpstream) await new Promise<void>((resolve) => { releaseUpstream = resolve; });
  if (cmd === 'run_ai_chat') desktopChatCacheWrites += 1;   // Rust:932 只在 completed 路径写缓存
  return cmd === 'run_ai_task'
    ? { status: 'completed', analysis: { explanation: '【健康】1. 好。' } }
    : { status: 'completed', answer: '桌面答案' };
}

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === 'begin_ai_session') { sessionCancelled = false; return null; }
    if (cmd === 'cancel_ai_session') { sessionCancelled = true; return null; }
    return fakeUpstream(cmd);
  }),
}));

const { analyzeBazi, analyzeTask, cancelAiSession } = await import('../data/deepseekAdapter');

/* askChat 的取证要读命盘列表、hydrateRecord 是一次 IndexedDB 读，真仓库在 jsdom 下不可靠：
   按 chat-engine.test.ts 那套换成可控桩。serverClient 也一并 mock —— 桌面外壳 + 服务器通道
   这一档(详情页连着服务器)正是要测的路径，用 localStorage 摆登录态比替掉 isServerMode 更贴近真实。 */
vi.mock('../data/clientRepository', () => ({ listBaziRecords: vi.fn(async () => []), hydrateRecord: vi.fn(async (r) => r) }));
vi.mock('../data/serverClient', async (importActual) => {
  const actual = await importActual<typeof import('../data/serverClient')>();
  return { ...actual, serverFetch: vi.fn(async () => ({ status: 200, data: { status: 'completed', answer: '不该被发出去' } })) };
});
const { askChat } = await import('../data/chatEngine');
const { listBaziRecords, hydrateRecord } = await import('../data/clientRepository');
const { serverFetch } = await import('../data/serverClient');

const record = {
  id: 'r142', name: '张三', gender: 'male', birthYear: 1990, birthMonth: 6,
  yearPillar: '庚午', monthPillar: '壬午', dayPillar: '甲子', hourPillar: '甲子',
  createdAt: '2026-01-01T00:00:00.000Z', aiStatus: 'not_started',
  nonAiResult: { dayMaster: '甲', zodiac: '马', solarDate: '1990-06-15', elements: {}, tenGods: [], hiddenStems: [], relationships: {} },
} as never;
const task = { taskId: 'task-01', type: 'baseline' } as never;

afterEach(() => {
  sessionCancelled = false;
  upstreamCalls.length = 0;
  desktopChatCacheWrites = 0;
  hangUpstream = false;
  releaseUpstream = null;
  delete (window as Record<string, unknown>).__TAURI_INTERNALS__;
  localStorage.clear();
});

describe('桌面端(Tauri)要接住「立即停止」(#142/#143)', () => {
  it('前提钉子：没有桌面标记就不该走桌面分支(否则下面几条空转)', async () => {
    await analyzeBazi(record, task, { tone: 80 });
    expect(upstreamCalls.filter((c) => c === 'run_ai_task').length,
      '网页环境却走了桌面分支').toBe(0);
  });

  it('analyzeBazi：停止后的回执是「已取消」，不是一条失败的批断', async () => {
    (window as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    const first = await analyzeBazi(record, task, { tone: 80 });
    expect(first.status, '桌面分支没走到，读数：' + JSON.stringify(first)).toBe('completed');
    expect(upstreamCalls.filter((c) => c === 'run_ai_task').length).toBe(1);

    // 用户点「立即停止」：走真实导出，会话开关置位后 Rust 那三条闸门就都拦得住。
    cancelAiSession();
    const stopped = await analyzeBazi(record, task, { tone: 80 });
    expect(stopped.status, '停止后的形态变了：' + JSON.stringify(stopped)).toBe('failed');
    expect(String(stopped.error), '停止被写成了一条普通失败批断，会存进 aiTasks').toContain('已取消');
  });

  it('analyzeTask：同一条桌面路径的兄弟入口也要认出取消', async () => {
    (window as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    expect((await analyzeTask(record, task, 80)).status).toBe('completed');
    cancelAiSession();
    const stopped = await analyzeTask(record, task, 80);
    expect(stopped.status, 'analyzeTask 的回执形态变了：' + JSON.stringify(stopped)).toBe('failed');
    expect(String(stopped.error), '这里也没认出取消：' + String(stopped.error)).toContain('已取消');
  });

  it('桌面聊天分支：中止那一问照样跑完、照样落缓存(#143)', async () => {
    /* ChartChat 的「清空对话」与「发起新一问」都只 sharedAbort?.abort() + 置空，不调 cancelAiSession
       (见 ChartChat.tsx:52-56 与 :102-108)；而 askChatLocal 的 Tauri 分支(chatEngine.ts:587)既不读
       signal，Rust 侧 run_ai_chat(lib.rs:834-895)也没有一条 session_cancelled() 闸门 —— 与任务通道
       (lib.rs:712/741/748 三处)正好缺一半。这一条钉的是 JS 这一侧：signal 传到了就必须拦住。 */
    (window as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    vi.mocked(listBaziRecords).mockResolvedValue([record] as never);
    hangUpstream = true;
    const controller = new AbortController();
    const pendingAsk = askChat({ question: '2026年事业如何？', signal: controller.signal });
    while (upstreamCalls.length === 0) await Promise.resolve();   // 等第一次调用真发出去
    controller.abort();
    releaseUpstream?.();
    const reply = await pendingAsk;
    const chats = upstreamCalls.filter((c) => c === 'run_ai_chat').length;
    expect(chats, '中止后又重发了第二次上游调用，共 ' + chats + ' 次').toBe(1);
    expect(reply.status, '中止后的回执形态：' + JSON.stringify(reply)).toBe('failed');
    expect(String(reply.error)).toContain('已取消');
    /* ⚠ 反向钉子，钉的是现状而非理想：Rust 侧 run_ai_chat(lib.rs:834-895)一条 session_cancelled()
       闸门都没有(任务通道有 lib.rs:712/741/748)，JS 这一侧拦不住那一次上游调用与它的缓存写入。
       实测读数 desktopChatCacheWrites=1 —— 客户端只能把这次结果挡在会话之外，钱已经花了。 */
    expect(desktopChatCacheWrites, '桌面聊天分支的缓存写入行为变了(现状=中止那次仍落缓存；若已补 Rust 闸门请一并改这条)：'
      + desktopChatCacheWrites).toBe(1);
  });

  it('桌面聊天分支：会话早已中止时，一问都不许发出去', async () => {
    /* 上面那条走的是「先发后中止」，M4(删掉 invoke 之前那道 signal?.aborted 预检)在那条里压根执行不到，
       所以它当时存活。这一条把顺序反过来：signal 在调用前就已 aborted，前置闸门是唯一拦住上游调用的东西。
       实测：删掉那句预检后本条必红(发出 1 次调用)。 */
    (window as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    vi.mocked(listBaziRecords).mockResolvedValue([record] as never);
    const controller = new AbortController();
    controller.abort();                                        // 「停止」已经按过，这一次是迟到的那一问
    const reply = await askChat({ question: '2026年事业如何？', signal: controller.signal });
    const chats = upstreamCalls.filter((c) => c === 'run_ai_chat').length;
    expect(chats, '会话早已中止却仍发了 ' + chats + ' 次上游调用 ⇒ invoke 之前的 signal 预检被删掉了').toBe(0);
    expect(reply.status, '中止后的回执形态：' + JSON.stringify(reply)).toBe('failed');
    expect(String(reply.error)).toContain('已取消');
  });

  it('服务器模式：取证途中按停止，不得再把这一问发上服务器(#143 同类)', async () => {
    /* 取证那一步是 await hydrateRecord(target)(chatEngine.ts:515)，一次 IndexedDB 读；
       旧写法只在 serverFetch 抛 AbortError 时才认出取消，而这里 fetch 压根没发出去，
       于是「点停止 → 又上一条服务器请求」在网页/桌面连着服务器时都会发生。 */
    (window as Record<string, unknown>).__TAURI_INTERNALS__ = {};   // 桌面外壳 + 服务器通道，正是详情页那一档
    localStorage.setItem('mingli.server.url', 'http://127.0.0.1:9');
    localStorage.setItem('mingli.server.session', JSON.stringify({ token: 't', username: 'u', role: 'user' }));
    vi.mocked(listBaziRecords).mockResolvedValue([record] as never);
    const controller = new AbortController();
    vi.mocked(hydrateRecord).mockImplementation(async () => { controller.abort(); return record; });
    const reply = await askChat({ question: '2026年事业如何？', signal: controller.signal });
    expect(serverFetch, '取证途中已中止，却还是发出了服务器请求').not.toHaveBeenCalled();
    expect(reply.status, '中止后的回执形态：' + JSON.stringify(reply)).toBe('failed');
    expect(String(reply.error)).toContain('已取消');
  });
});
