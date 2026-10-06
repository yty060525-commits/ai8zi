import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { RecordsPage } from '../features/records/RecordsPage';
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
