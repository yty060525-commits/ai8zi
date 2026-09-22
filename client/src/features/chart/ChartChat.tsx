import { useEffect, useRef, useState } from 'react';
import { askChat, type ChatMessage, type ChatReply } from '../../data/chatEngine';
import { listBaziRecords } from '../../data/clientRepository';
import { cancelAiSession } from '../../data/deepseekAdapter';

/** 读取与「AI 分析」同一把语气滑杆(0 犀利 .. 100 温柔)，默认 80。 */
function readTone(): number {
  try {
    const raw = localStorage.getItem('mingli.analysis.tone');
    if (raw === null || raw.trim() === '') return 80;
    const v = Number(raw);
    return Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : 80;
  } catch { return 80; }
}

interface PendingPick { question: string; options: Array<{ id: string; name: string }> }

/** 会话消息：assistant 可带「答谁 / 答哪年」的来源标注。 */
type StoredMessage = ChatMessage & { about?: string };

type ChatState = {
  thread: StoredMessage[];
  busy: boolean;
  error: string;
  needKey: boolean;
  pending: PendingPick | null;
  selected: { id: string; name: string } | null;
};

const EMPTY: ChatState = { thread: [], busy: false, error: '', needKey: false, pending: null, selected: null };
/* 会话常驻进程内：切分页、进「设置」都会卸载组件，但问出的内容、待选的命主、以及「为什么没答上」
   的提示不该跟着消失。仅存内存(不落库)，重启应用即清空；条数封顶，长会话不会无限涨。 */
const CHAT_LIMIT = 40;
let shared: ChatState = { ...EMPTY };
const listeners = new Set<(state: ChatState) => void>();
function publish(patch: Partial<ChatState>) {
  const thread = (patch.thread ?? shared.thread).slice(-CHAT_LIMIT);
  shared = { ...shared, ...patch, thread };
  for (const notify of listeners) notify(shared);
}
/* 中止句柄同样常驻：请求发出后切页回来，「停止」也该还能按。 */
let sharedAbort: AbortController | null = null;

/** 标注这条回答查的是谁、命中的是哪段时间(多命主时尤其需要)。 */
function aboutOf(reply: ChatReply): string {
  const evidence = reply.evidence;
  if (!evidence?.personName) return '';
  const year = evidence.plan?.year;
  const month = evidence.plan?.month;
  return '依据：' + evidence.personName + (year ? ' · ' + year + '年' + (month ? month + '月' : '') : ' · 本命');
}

/** 清空对话：中断在途请求并回到空会话。 */
export function clearChatThread() {
  sharedAbort?.abort();
  sharedAbort = null;
  publish({ ...EMPTY });
}

/** 排盘页「问问 AI」：根据提问查库(命盘事实+已算批断)后思考回答；三通道自适应。 */
export function ChartChat() {
  const [state, setState] = useState<ChatState>(shared);
  const [input, setInput] = useState('');
  const [people, setPeople] = useState<Array<{ id: string; name: string }>>([]);
  /* 命主列表默认收起：选中后若一直摊开，会长期占着输入区上方；点「当前命主」的名字才展开改选。 */
  const [pickOpen, setPickOpen] = useState(false);
  const logRef = useRef<HTMLDivElement | null>(null);
  const { thread: messages, busy, error, needKey, pending, selected } = state;

  // 重新挂载时接回常驻会话；卸载时退订，避免向已销毁组件 setState。
  useEffect(() => {
    const notify = (next: ChatState) => setState(next);
    listeners.add(notify);
    setState(shared);
    return () => { listeners.delete(notify); };
  }, []);

  // 新消息总是出现在底部：日志区是定高滚动容器，不自动滚就等于「回答没出来」。
  useEffect(() => {
    const node = logRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages.length, busy]);

  useEffect(() => {
    let alive = true;
    void listBaziRecords().then((records) => {
      if (!alive) return;
      setPeople(records.map((r) => ({ id: r.id, name: r.name })));
    }).catch(() => { /* 本地库暂不可读不影响聊天 */ });
    return () => { alive = false; };
  }, [messages.length]);

  async function ask(question: string, recordId?: string | null) {
    const trimmed = question.trim();
    if (shared.busy || !trimmed) return;
    publish({ busy: true, error: '', needKey: false, pending: null });
    const history = shared.thread;
    const controller = new AbortController();
    sharedAbort = controller;
    publish({ thread: [...shared.thread, { role: 'user', content: trimmed }] });
    setInput('');
    const reply = await askChat({ question: trimmed, history, tone: readTone(), recordId: recordId ?? shared.selected?.id ?? null, signal: controller.signal });
    sharedAbort = null;
    if (reply.status === 'completed' && reply.answer) {
      publish({ busy: false, thread: [...shared.thread, { role: 'assistant', content: reply.answer as string, about: aboutOf(reply) }] });
      return;
    }
    if (reply.status === 'need_record') {
      const options = reply.evidence?.options?.length ? reply.evidence.options : people;
      if (options.length) publish({ busy: false, error: reply.reason || '请选择要提问的命主', pending: { question: trimmed, options } });
      else publish({ busy: false, error: '', thread: [...shared.thread, { role: 'assistant', content: '还没有可查询的命盘：请先在上方录入四柱八字保存一条记录，再来问我。' }] });
      return;
    }
    const keyMissing = reply.status === 'not_configured';
    publish({
      busy: false,
      needKey: keyMissing,
      error: keyMissing ? '尚未配置 AI 密钥：配置后即可向我提问(服务器通道或本机通道均可)。' : (reply.error || '回答失败，请稍后重试'),
    });
  }

  function stop() {
    sharedAbort?.abort();
    sharedAbort = null;
    cancelAiSession(); // 桌面端本机通道同步中断
    publish({ busy: false });
  }

  /** 直达「设置」：由 App 层监听(设置入口是 App 状态，跨组件用事件而非 prop 钻穿)。 */
  function openSettings() { window.dispatchEvent(new Event('mingli:open-settings')); }

  /** 空会话时的示例提问：按已存命主给出可一键发送的检索示范。 */
  const suggestions = people.length && messages.length === 0
    ? [`${people[0].name}的喜用五行是什么？`, ...(people.length > 1 ? [`${people[1].name}今年事业运如何？`] : ['明年运势整体如何？'])]
    : [];

  return <section className="chat-panel" aria-label="问问 AI">
    <h2>问问 AI</h2>
    <p className="chat-hint">基于已入库的命盘与已算批断作答，例如：「张三的喜用五行是什么？」「2027年事业运如何？」。{selected ? <span>当前命主：<button type="button" className="link-button chat-current-person" aria-expanded={pickOpen} aria-label="切换当前命主" onClick={() => setPickOpen((open) => !open)}>{selected.name}</button>（点姓名可切换）</span> : null}</p>
    {messages.length === 0 ? <p className="chat-empty">支持追问：先问本命，再问某年某月，AI 会引用数据库里已算好的流年/流月批断。</p> : null}
    {suggestions.length ? <div className="chat-people" aria-label="示例提问">{suggestions.map((suggestion) => <button type="button" key={suggestion} className="choice-button" disabled={busy} onClick={() => void ask(suggestion)}>{suggestion}</button>)}</div> : null}
    {messages.length > 0 ? <div className="chat-log" role="log" ref={logRef}>
      {messages.map((item, index) => <div key={index} className={item.role === 'user' ? 'chat-msg chat-user' : 'chat-msg chat-assistant'}>
        <span className="chat-role">{item.role === 'user' ? '我' : 'AI'}</span>
        <div className="chat-body">{item.content}{item.about ? <span className="chat-about">{item.about}</span> : null}</div>
      </div>)}
      {busy ? <div className="chat-msg chat-assistant"><span className="chat-role">AI</span><div className="chat-body chat-thinking">正在查库思考…</div></div> : null}
    </div> : null}
    {messages.length > 0 ? <p className="chat-tools"><button type="button" className="text-button chat-clear" onClick={clearChatThread}>清空对话</button></p> : null}
    {pending ? <div className="chat-people" aria-label="选择命主">{pending.options.map((option) => <button type="button" key={option.id} className="choice-button" onClick={() => { publish({ selected: option }); void ask(pending.question, option.id); }}>{option.name}</button>)}</div> : null}
    {!pending && people.length > 1 && (!selected || pickOpen) ? <div className="chat-people" aria-label="已存命主">
      {people.map((person) => <button type="button" key={person.id} className={'choice-button' + (person.id === selected?.id ? ' selected' : '')} title="指定该命主后提问" onClick={() => { publish({ selected: person }); setPickOpen(false); }}>{person.name}</button>)}
      {selected ? <button type="button" className="text-button chat-clear-person" onClick={() => { publish({ selected: null }); setPickOpen(false); }}>取消指定</button> : null}
    </div> : null}
    {error ? <p className="form-error" role="alert">{error}{needKey ? <button type="button" className="text-button chat-settings-link" onClick={openSettings}>去设置 ›</button> : null}</p> : null}
    <div className="chat-input-row">
      <input value={input} maxLength={500} disabled={busy} placeholder="输入命理问题(500 字以内)" aria-label="命理问题"
        onChange={(event) => { if (shared.error) publish({ error: '', needKey: false }); setInput(event.target.value); }}
        onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void ask(input); } }} />
      {busy ? <button className="danger-button" type="button" onClick={stop}>停止</button> : <button className="primary-button" type="button" onClick={() => void ask(input)}>发送</button>}
    </div>
  </section>;
}
