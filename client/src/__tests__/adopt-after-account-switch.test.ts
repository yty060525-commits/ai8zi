import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __allowUnsyncedIdsForTests, __resetSyncStateForTests, __setOwnerKeyForTests, configureBaziRepository, flushPendingPushes, listBaziRecords, markKnownRemote, saveBaziRecord, storageBackedBaziRepository } from '../data/clientRepository';
import { getServerSession, setServerSession, setServerUrl } from '../data/serverClient';
import type { BaziRecord } from '../types/domain';

/* #154 「视图空着先采纳本机存储」(ensureViewLoaded) 在拿不到可用账号名时不该当作「本账号」。
   两条认领路此前宽窄不同：
   · adoptUnclaimedLocalRecords(clientRepository.ts:127-150) 要求 pending.has(r.id)，注释写着
     「旧实现全部认领并把它们的名字写进本账号库…换个账号登录一次，别人的盘就成了你的名字」；
   · ensureViewLoaded 用 mineOnDevice(r, me)，而 me 取的是 `getServerSession()?.username ?? ''`，
     mineOnDevice(:474-477) 对**无标签**的盘恒为真 —— 于是 me==='' 时那扇门是整份敞开采纳。
   修法是把口径改成「账号名为空 ⇒ 没有『本账号』这个参照 ⇒ 不采纳」(me 不再兜底成空串)。

   ⚠ 这条门的**可达性要如实登记**：null 会话走不到它 —— isServerMode()(serverClient.ts:25) 为假时
   pullAndMergeLocal(:693) 在调用 ensureViewLoaded 之前就 return 了(实测：夹具用 setServerSession(null)
   时删掉整道门仍 4 passed)。能走到那条门的只有「会话对象存在、username 为空串」这一形态，
   而 server/app.mjs:61 把注册用户名限成 2–24 位、SettingsPage.tsx:177/189 直抄服务器回的 username，
   所以当前两端都造不出空账号名。**这是一处防御性收紧，不是已复现的线上缺陷**；
   它的价值在于把「谁算本账号」这个判断从字符串兜底改成显式拒绝，将来任何一侧放宽校验都不会自动退化成敞开采纳。

   ⚠ 判据缺口的实测读数（改代码之前跑的变异）：**删掉整条 ensureViewLoaded 函数体**，
   全量 827 条用例只有 1 条红(sync-admin-ghost.test.ts:179「视图清空后重新读取」)，其余全绿 ——
   也就是说这条真实设备上决定「重启后列表有没有数据」的路径，此前只有一条用例在读它。 */

const KEY = 'mingli.records.boss';            // storageBackedBaziRepository 的本机存储键(测试夹具)
const SHARED_NS = 'mingli.pwa.records';       // 产品 nsKey() 未登录时指向的共享命名空间
const OWNER_KEY = 'mingli.record.owners.test';
const dirtyOf = (u: string) => 'mingli.records.' + u + '.dirty';

const record = (id: string, name: string): BaziRecord => ({
  id, name, gender: 'male', birthYear: 1984, birthMonth: 2,
  createdAt: '2025-01-01T00:00:00.000Z', yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午',
  aiStatus: 'not_started',
});

/** 服务器一律回空清单：这几条要读的就是「本机存储里有什么」，不是远端。 */
function emptyServer() {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ records: [] }) }) as Response));
}

/** 记录所有 POST/PUT /api/records* 的写请求，用来判定「有没有拿别人的盘去覆盖服务器」。 */
function spyWrites(log: string[]) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? 'GET';
    if ((method === 'POST' || method === 'PUT') && /\/api\/records(\/[^/]+)?$/.test(u)) log.push(method + ' ' + u);
    return { ok: true, status: 200, json: async () => ({ records: [] }) } as Response;
  }));
}

beforeEach(() => {
  __setOwnerKeyForTests(OWNER_KEY);
  __allowUnsyncedIdsForTests(true);
  __resetSyncStateForTests();
  configureBaziRepository(storageBackedBaziRepository(KEY));
  setServerUrl('');
  setServerSession(null);
});
afterEach(() => {
  vi.unstubAllGlobals();
  __setOwnerKeyForTests(null);
  __allowUnsyncedIdsForTests(false);
  __resetSyncStateForTests();
  try { localStorage.clear(); } catch { /* jsdom 可能禁用 storage */ }
});

describe('#154 「没有可用账号名」时不采纳本机存储(ensureViewLoaded)', () => {
  /* ⚠ 夹具形态是本轮改过一次才有效的。第一版用 `setServerSession(null)`，实测**删掉整道门仍 4 passed**
     —— 因为 null 会话下 isServerMode()(serverClient.ts:25) 为假，pullAndMergeLocal(:693) 在调用
     ensureViewLoaded **之前**就 return 了，那条门压根没被执行。这条红断言救了我：它长得像判据、实为空转。
     现在用「会话存在但 username 是空串」：isServerMode() 为真 ⇒ 真的走到那道门；而旧实现
     `?? ''` 把空串当合法账号名，mineOnDevice 对无标签盘恒真 ⇒ 整份敞开采纳。 */
  const unusableSession = { token: 'tok', username: '', role: 'user' } as const;

  it('前提钉子：会话还在但账号名为空时，这次读取确实不再采纳 —— 若它采纳了，下面几条全是空转', async () => {
    setServerUrl('http://127.0.0.1:8787');
    setServerSession({ token: 'tok', username: 'boss', role: 'user' });
    await saveBaziRecord(record('a1', '甲一'));
    expect(JSON.parse(localStorage.getItem(KEY) || '[]').map((r: BaziRecord) => r.id)).toContain('a1');
    setServerSession(unusableSession);
    expect(getServerSession(), '会话必须仍然存在，否则 isServerMode() 为假、整条同步链在门口就返回，本文件测不到任何东西').not.toBeNull();
    configureBaziRepository(storageBackedBaziRepository(KEY));   // 模拟「视图没了、存储还在」
    emptyServer();
    expect((await listBaziRecords()).map((r) => r.id), '账号名为空仍采纳本机存储 → 闸门没关，本文件其余判据不成立').toEqual([]);
  });

  it('如实登记：账号名为空时新建的盘**不落任何本机键**(CAN_PERSIST 在 MODE=test 为假)', async () => {
    /* ⚠ 这条钉的是当前读数。我原本按产品注释(「未登录时本机数据放这一份共享命名空间」:16-18)
       期望它落 SHARED_NS，跑出来两个键都是空 —— 原因是 persistLocal(:38-43) 整条被 CAN_PERSIST 挡掉，
       单测里 MODE==='test' ⇒ 那条路根本不存在。所以这里能钉住的只有「不会串写进上一账号的本机存储」。
       真正的「登出态建的盘落在共享键、登录后由 adoptUnclaimedLocalRecords 认领」只能在浏览器 E2E 验。 */
    setServerUrl('http://127.0.0.1:8787');
    setServerSession({ token: 'tok', username: 'boss', role: 'user' });
    await saveBaziRecord(record('a1', '甲一'));
    setServerSession(unusableSession);
    configureBaziRepository(storageBackedBaziRepository(KEY));
    emptyServer();
    expect((await listBaziRecords()).map((r) => r.id)).toEqual([]);   // 前提钉子(上一条)已证闸门关闭
    await saveBaziRecord(record('b1', '乙一'));                        // 账号名为空时新建
    const shared = JSON.parse(localStorage.getItem(SHARED_NS) || '[]').map((r: BaziRecord) => r.id);
    expect(shared, '读数变了：说明测试模式下开始落共享键了，请把真设备语义与这条一起重新取证').toEqual([]);
    const boss = JSON.parse(localStorage.getItem(KEY) || '[]').map((r: BaziRecord) => r.id);
    expect(boss, '读数变了：说明视图与存储之间多了一次同步。当前实现是「整体覆盖」(saveView:242 write(records.filter(...))、'
      + '端口层 saveBaziRecord 不回写视图)，闸门关闭后视图为空 ⇒ 这一轮把本机存储覆盖成只剩新建那条，'
      + '上一账号的 a1 就此从这台设备的存储里消失。换回 boss 时 loadLocal(:44) 读的是这份被覆盖过的键。'
    ).toEqual(['b1']);
  });

  it('如实登记：这份测试存储**不按账号分键** —— 换账号后仍会整份采纳进新账号视图', async () => {
    /* ⚠ 这条钉的是**当前读数**，不是期望值。它同时是本文件的反向钉子(证明「不采纳」只发生在无会话时，
       有会话但换了账号那条路仍然通)，也是一处**未修的缺陷面**：
       · storageBackedBaziRepository(KEY) 的注释承诺「属于别人的那些另存到它自己账号的命名空间
         (与产品那条 loadLocal 的『每账号一份』同源)」，可 saveBaziRecord(:208-223) 写入时用的是
         固定 storageKey，只有 saveView(:229-243) 才分流到 namespacePrefix+owner；
       · ensureViewLoaded 拿 mineOnDevice(r, 'carl') 判「本账号」，而上一账号自建的盘**没有标签**，
         ownerOf(:471-472) 回空串 ⇒ 恒判为自己的 ⇒ 整份采纳进新账号视图，persistView 再整体覆盖回来。
     真设备上的网页端口是否同形此前无人测过(sqlMirror 的 DB_KEY='sqlite-bytes' 同样不带账号)。
     真要改语义(按 nsKey 分键或引入归属墓碑)，必须把这条改成新语义，并说明
     「本机自建、从没带过标签的盘为什么不会被抹掉」。 */
    setServerUrl('http://127.0.0.1:8787');
    setServerSession({ token: 'tok', username: 'boss', role: 'user' });
    await saveBaziRecord(record('a1', '甲一'));
    await saveBaziRecord(record('a2', '甲二'));
    localStorage.setItem(dirtyOf('boss'), JSON.stringify(['a1', 'a2']));   // 自建、还没推上去的真积压
    configureBaziRepository(storageBackedBaziRepository(KEY));             // 换账号 = 又一次「视图没了、存储还在」
    const writes: string[] = [];
    spyWrites(writes);
    markKnownRemote(['a1', 'a2']);                                // 让补推走 PUT(单条覆盖)，与真设备同形

    setServerSession({ token: 'tok2', username: 'carl', role: 'user' });
    const seen = (await listBaziRecords()).map((r) => r.id).sort();
    expect(seen, '读数变了：说明存储层已开始按账号分键，请把这条改写成新语义并交代无标签自建盘去哪了').toEqual(['a1', 'a2']);
    /* ⚠ 这一轮**没有**发出任何 PUT。取证：补推循环(:761-772)只遍历 readDirty() —— 也就是
       **当前账号**那份名单(mingli.records.carl.dirty)，而 boss 的积压写在 mingli.records.boss.dirty 上，
       carl 看不见 ⇒ 一条也不推。所以危害不是「覆盖别人的服务器数据」，而是本地这两处：
       · reconcileDirty(:75-83) 把视图非空时「本账号名单里、视图已没有」的 id 直接删掉；
       · persistView→saveView(:229-243) 把这批无标签盘整份写进 storageKey(测试夹具里就是 KEY)。
       真要钉「谁也不该被误清/误写」得先把名单口径与存储口径对齐(#154b)，别在这里顺手改成
       「符合当前实现」的空话，所以这条只登记读数、不假装它是期望。 */
    await flushPendingPushes();
    expect(writes.filter((w) => /\/(a1|a2)$/.test(w)), '补推只认当前账号的 .dirty 名单：换了账号就不该替 boss 推盘').toEqual([]);
    expect(JSON.parse(localStorage.getItem(dirtyOf('boss')) || '[]').sort(), 'boss 的待推送名单不该在 carl 这一轮被动过').toEqual(['a1', 'a2']);
  });

  it('反向钉子：已登录 + 本账号名下(含无标签自建)的盘必须仍被采纳回来', async () => {
    setServerUrl('http://127.0.0.1:8787');
    setServerSession({ token: 'tok', username: 'boss', role: 'user' });
    await saveBaziRecord(record('a1', '甲一'));
    localStorage.setItem(dirtyOf('boss'), JSON.stringify(['a1']));   // 本机自建、还没推上去
    configureBaziRepository(storageBackedBaziRepository(KEY));
    emptyServer();
    const ids = (await listBaziRecords()).map((r) => r.id);
    expect(ids, '已登录且是本账号的盘都不采纳 → 界面显示「暂无记录」，用户以为数据丢了').toEqual(['a1']);
  });
});
