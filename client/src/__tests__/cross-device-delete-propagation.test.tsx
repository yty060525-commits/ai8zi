import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { RecordsPage } from '../features/records/RecordsPage';
import { __allowUnsyncedIdsForTests, __resetSyncStateForTests, configureBaziRepository, listBaziRecords, memoryBaziRepository, saveBaziRecord } from '../data/clientRepository';
import { setServerSession, setServerUrl } from '../data/serverClient';
import { initializeMockSession, resetMockSession } from '../data/clientRepository';
import type { BaziRecord } from '../types/domain';

/* 判据空白 #146：「另一台设备上删掉的那条盘，本机到底会不会跟着删掉」——全仓没有任何用例读过这条路径。
   mergeRemoteRecords(clientRepository:782) 的注释把「远端列表是**合并**而非替换」写得很清楚，
   applyMerged(:794-809) 也确实只做两件事：本机有、远端也有的就地更新；远端新增的追加进来。
   **没有第三条分支** —— 远端本轮清单里没有的 id 会一路留在本机视图里，还会被 persistView() 重新写进
   localStorage。于是「换设备删除」这件事在网页版上根本传不开：A 手机删了，B 手机的列表照旧显示，
   点进去还能继续批断，而服务器那条已经不存在(下一次推送会撞 404)。

   ⚠ 本文件先只做**取证**，不预设这是缺陷还是有意设计：下面两条读数是当场量出来的产品行为，
   把它们钉住是为了让「以后有人把合并改成替换」这件事必须过一道明说的判断，而不是悄悄改变语义。 */

const rec = (id: string, name: string): BaziRecord => ({
  id, name, gender: 'male', birthYear: 1984, birthMonth: 2,
  createdAt: '2025-01-01T00:00:00.000Z', yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午',
  aiStatus: 'not_started',
} as unknown as BaziRecord);

/** 记录 GET /records 返回什么：只回「服务器上还剩哪条」，本机那条已被另一端删掉的不在里面。 */
function remoteServes(ids: Array<{ id: string; name: string }>) {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    if ((init?.method ?? 'GET') === 'GET') {
      return { ok: true, status: 200, json: async () => ({ records: ids.map((x) => ({ ...rec(x.id, x.name), owner: 'boss' })) }) } as Response;
    }
    return { ok: true, status: 200, json: async () => ({ record: {} }) } as Response;
  });
}

beforeEach(() => {
  localStorage.clear();
  configureBaziRepository(memoryBaziRepository);
  initializeMockSession([], []);
  __allowUnsyncedIdsForTests(true);
  __resetSyncStateForTests();
  setServerUrl('http://127.0.0.1:8787');
  setServerSession({ token: 'tok', username: 'boss', role: 'user' });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  __allowUnsyncedIdsForTests(false);
  __resetSyncStateForTests();
  resetMockSession();
  setServerUrl('');
  setServerSession(null);
  localStorage.clear();
});

describe('换设备删除在本机是否生效(#146 取证)', () => {
  it('前提钉子：本机确实有一条盘，且本轮远端清单里它不见了', async () => {
    vi.stubGlobal('fetch', remoteServes([{ id: 'keep', name: '留下者' }]));
    await saveBaziRecord(rec('vanished', '消失者'));   // 本机建一条，远端清单里没有它
    const before = (await listBaziRecords()).map((r) => r.id).sort();
    expect(before, '夹具没造出「本机有、远端无」⇒ 下面的比对等于没测').toEqual(['keep', 'vanished']);
  });

  it('当前读数：远端已经没有的那条，本机读取一轮之后仍然留在列表里', async () => {
    /* 这一条是**读数登记**，不是期望行为。它同时说明两件好事没发生：
       ① 合并不会把离线建的盘抹掉(:784 注释承诺的那一半，成立)；
       ② 但它也不会把「另一端已删」的盘抹掉 —— 语义上这两者在本机看不出区别，
          都表现为「本轮清单里没有」。要区分只能靠归属表/删除墓碑，代码里没有。 */
    vi.stubGlobal('fetch', remoteServes([{ id: 'keep', name: '留下者' }]));
    await saveBaziRecord(rec('vanished', '消失者'));
    const after = (await listBaziRecords()).map((r) => r.id).sort();
    expect(after).toEqual(['keep', 'vanished']);

    render(<RecordsPage onOpenPerson={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('消失者')).toBeTruthy());
    /* 界面照旧列得出来 ⇒ 用户在这台设备上看不见「这条已经被删了」的任何迹象。
       徽章那句「未同步，仅存本机」也不会挂(它读的是 dirty 名单，与远端是否存在无关)，
       所以这里连一条误导性的提示都没有 —— 是彻底的沉默。 */
    expect(screen.getAllByText('消失者').length).toBeGreaterThanOrEqual(1);
  }, 30000);

  it('反向钉子：远端有条、本机没有的会被追加进来(证明上面那条不是「合并整体失效」)', async () => {
    vi.stubGlobal('fetch', remoteServes([{ id: 'keep', name: '留下者' }, { id: 'other-device', name: '他机建' }]));
    const ids = (await listBaziRecords()).map((r) => r.id).sort();
    expect(ids, '追加都没发生 ⇒ 拉取整条路没跑，前两条读数为零').toEqual(['keep', 'other-device']);
  }, 30000);
});
