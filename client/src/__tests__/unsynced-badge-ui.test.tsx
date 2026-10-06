import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { RecordsPage } from '../features/records/RecordsPage';
import { App } from '../App';
import { __allowUnsyncedIdsForTests, __failRemoteForTests, __resetSyncStateForTests, configureBaziRepository, flushPendingPushes, memoryBaziRepository, saveBaziRecord, unsyncedRecordIds } from '../data/clientRepository';
import { setServerSession, setServerUrl } from '../data/serverClient';
import { initializeMockSession, resetMockSession } from '../data/clientRepository';
import type { BaziRecord } from '../types/domain';

/* 记录列表那句「未同步，仅存本机」此前只有数据层判据(sync-admin-ghost.test.ts:135 钉的是
   unsyncedRecordIds() 的返回值)，没有任何用例渲染过徽章那一行 —— 把 RecordsPage.tsx:197 的
   {unsynced.has(record.id) && ...} 整块删掉、或丢掉 L61 的 setUnsynced 那半句，全量测试照旧全绿。
   聊天那条「等列表里那条的未同步标记消失后再问」(chatEngine.ts:534)依赖的正是这个界面承诺，
   所以必须当场判定：名单里有的那条挂着、没有的那条不许挂、补推成功后徽章跟着消失。 */

const rec = (id: string, name: string): BaziRecord => ({
  id, name, gender: 'male', birthYear: 1984, birthMonth: 2,
  createdAt: '2025-01-01T00:00:00.000Z', yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午',
  aiStatus: 'not_started',
} as unknown as BaziRecord);

/** 直接读 localStorage 里的 dirty 键(产品代码 nsKey() 拼出)：证明 markDirty 真的落了盘。 */
const peekDirty = (): string[] => {
  try { return JSON.parse(localStorage.getItem('mingli.records.boss.dirty') ?? '[]') as string[]; } catch { return []; }
};

/** 两行各含一个姓名，徽章按 DOM 归属到那一行(不靠文案出现顺序猜)。 */
const badgeOf = (name: string): Element | null =>
  screen.getByText(name).closest('button')?.querySelector('.ai-status.unsynced') ?? null;

beforeEach(() => {
  localStorage.clear();
  configureBaziRepository(memoryBaziRepository);
  // 视图与存储都是内存那份：先建一个空会话，saveBaziRecord 走正常路径进视图
  initializeMockSession([], []);
  __allowUnsyncedIdsForTests(true);   // 测试模式下 CAN_PERSIST 为假，这道门专给单测开(见 clientRepository L86)
  __resetSyncStateForTests();
  setServerUrl('http://127.0.0.1:8787');
  setServerSession({ token: 'tok', username: 'boss', role: 'user' });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  __allowUnsyncedIdsForTests(false);
  __failRemoteForTests(false);
  __resetSyncStateForTests();
  resetMockSession();
  setServerUrl('');
  setServerSession(null);
  localStorage.clear();
});

describe('「未同步」徽章与待推送名单一致(判据空白 #98)', () => {
  /** 夹具前提：__failRemoteForTests 的闸门在 uploadRecord 里、发请求之前 —— 全程不需要 fetch，
   *  但也不许有任何真实网络：fetch 桩一律抛错，走到即红。 */
  const noNetwork = () => vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('测试不得联网'); }));

  it('前提钉子：关门时 unsyncedRecordIds() 恒空 ⇒ 本文件的判据确实经过那道门', async () => {
    noNetwork();
    await saveBaziRecord(rec('gated', '闸门'));
    __failRemoteForTests(true);
    await flushPendingPushes();
    expect(peekDirty()).toContain('gated');                 // dirty 确实落了 localStorage
    __allowUnsyncedIdsForTests(false);
    try {
      expect(unsyncedRecordIds(), '关门还读得到 → 开门分支没被真正依赖').toEqual([]);
    } finally {
      __allowUnsyncedIdsForTests(true);
    }
    expect(unsyncedRecordIds()).toContain('gated');         // 再开门又读到 ⇒ 红/绿的差别就是那道门
  });

  it('离线建的盘徽章挂在它那一行；恢复后补推、徽章与名单一起消失', async () => {
    noNetwork();
    __failRemoteForTests(true);
    await saveBaziRecord(rec('u-off', '离线者'));
    await flushPendingPushes();
    expect(peekDirty(), 'dirty 名单为空 ⇒ 后面的界面比对等于没测').toEqual(['u-off']);

    render(<RecordsPage onOpenPerson={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('离线者')).toBeTruthy());
    expect(badgeOf('离线者'), '名单里有这条，界面却不吭声 → 用户等到聊天答不到人才发现没同步').toBeTruthy();
    expect(badgeOf('离线者')!.textContent).toContain('未同步，仅存本机');

    // 恢复网络：下一轮普通读取补推并清标记。fetch 桩只放行 POST/PUT(返回 200)，GET 一律抛错 ——
    // 于是这一轮的语义是「取清单失败但本机有积压 ⇒ remote=[]，积压照推」(L704-710 那条真实路径)。
    // uploadRecord 只看请求成不成(clientRepository L498)，POST 200 即 unmarkDirty。
    __failRemoteForTests(false);
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') !== 'GET') return { ok: true, status: 200, json: async () => ({ record: {} }) } as Response;
      throw new Error('测试：本轮服务器清单不可达');
    }));
    cleanup();
    render(<RecordsPage onOpenPerson={vi.fn()} />);
    await waitFor(() => expect(badgeOf('离线者'), '补推成功后仍挂着「未同步」→ 提示和事实相反').toBeNull());
    expect(peekDirty(), '徽章消失了但名单没清 → 聊天那句「等标记消失」永远等不到').toEqual([]);
  });

  /* 方位词类缺陷(#90 同族)：徽章让用户「去设置里登录服务器」，而全站唯一的常驻入口是
     App 顶部那个 .settings-entry(CSS margin-left:auto ⇒ 右上角)。unconfigured-guidance 已经
     给详情页/聊天那两处提示钉过「不许写左上角、要写右上角」，这句此前漏网 —— jsdom 不排版，
     判据取样式声明本身 + 真实 DOM 顺序(按钮在内容容器第一个)，与那条用例同一口径。 */
  it('徽章那句指向的「设置」确实在页面右上角，文案不许把用户领向别处', async () => {
    noNetwork();
    __failRemoteForTests(true);
    await saveBaziRecord(rec('u-pos', '方位者'));
    await flushPendingPushes();
    render(<RecordsPage onOpenPerson={vi.fn()} />);
    await waitFor(() => expect(badgeOf('方位者')).toBeTruthy());
    const hint = badgeOf('方位者')!.textContent ?? '';
    expect(hint, '把用户领向屏幕左边一个不存在的入口').not.toMatch(/左上|左下|右下/);
    expect(hint).toContain('设置');
    // 与既有两处提示同一方位口径(unconfigured-guidance L53-56 立的规矩)
    expect(hint, '同类提示统一写「右上角」，这句却只说「在设置里」——位置承诺分叉').toContain('右上角');
    // 入口本身的位置：App 外壳常驻渲染 .settings-entry(测试环境无 hash ⇒ App 强制云端分支、
    // 落在排盘页)，所以从真实渲染树里取那一个按钮，而不是 RecordsPage 的子树。
    render(<App />);
    const entries = screen.getAllByRole('button', { name: '设置' });
    expect(entries, '全站应只有一个常驻设置入口(App.tsx)').toHaveLength(1);
    expect(entries[0].className).toContain('settings-entry');
    expect(entries[0].parentElement!.querySelector(':scope > *') === entries[0], '设置按钮不再是内容区第一个元素 ⇒ 布局改了，文案方位要跟着核').toBe(true);
  });

  it('反向钉子：服务器正常的盘一行都不许挂徽章(否则上面两条是永真判据)', async () => {
    // 推送全程成功(uploadRecord 真发请求且 ok)⇒ 从不 markDirty，徽章永不该出现。
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if ((init?.method ?? 'GET') !== 'GET') return { ok: true, status: 200, json: async () => ({ record: {} }) } as Response;
      if (/\/api\/admin\/records/.test(u)) return { ok: true, status: 200, json: async () => ({ records: [] }) } as Response;
      return { ok: true, status: 200, json: async () => ({ records: [] }) } as Response;
    }));
    await saveBaziRecord(rec('ok-1', '在线者'));
    await flushPendingPushes();
    expect(peekDirty()).toEqual([]);
    render(<RecordsPage onOpenPerson={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('在线者')).toBeTruthy());
    expect(badgeOf('在线者')).toBeNull();
    expect(document.querySelectorAll('.ai-status.unsynced')).toHaveLength(0);
  });
});
