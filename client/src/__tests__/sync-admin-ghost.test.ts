import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __allowUnsyncedIdsForTests, __assumeOnServerForTests, __failRemoteForTests, __resetSyncStateForTests, __setOwnerKeyForTests, configureBaziRepository, deleteBaziRecord, flushPendingPushes, listBaziRecords, memoryBaziRepository, saveBaziRecord, storageBackedBaziRepository, syncAdminAll, unsyncedRecordIds } from '../data/clientRepository';
import { setServerSession, setServerUrl } from '../data/serverClient';
import type { BaziRecord } from '../types/domain';

/* 管理员列表页写着「本列表为服务器全部账号记录，含账号名」，syncAdminAll 的注释又承诺
   「这一轮服务器没返回的盘是点不开的幽灵记录，必须剔掉」。这两句此前没有一条用例同时钉住：
   旧实现把剔幽灵交给 mergeRemoteRecords，而它参照的是随后 listBaziRecords 拉回的**普通清单**
   —— 普通 /api/records 只回当前账号名下的盘(server/app.mjs: listRecordsByUser)，别人的盘
   当然不在里面，于是每次同步都把跨账号视图塌回自己那几条。本文件把两句承诺变成判据。

   「上一轮引进、这一轮没了」这类判据必须有真持久层：产品代码在 MODE==='test' 下 CAN_PERSIST 为假，
   persistLocal/loadLocal 全程不落盘，内存视图又被 configureBaziRepository 每次清空，于是「刷新一次」
   这条真实路径在单测里根本不存在(旧版本用例只能退化成「一轮之内」)。这里用测试专用的
   storageBackedBaziRepository 把端口层的读写接到 localStorage，并给归属表开一个测试键，
   多轮同步与待推送名单就能当场判定。界面仍走产品那条(CAN_PERSIST + SQLite 镜像)。 */

const KEY = 'mingli.records.boss';
const OWNER_KEY = 'mingli.record.owners.test';
/** 本账号那份待推送名单的键名(产品代码里由 nsKey() 拼出)：用例要直接读它，就得自己拼一份。 */
const dirtyOf = (username: string) => 'mingli.records.' + username + '.dirty';

const record = (id: string, name: string): BaziRecord => ({
  id, name, gender: 'male', birthYear: 1984, birthMonth: 2,
  createdAt: '2025-01-01T00:00:00.000Z', yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午',
  aiStatus: 'not_started',
});

interface Harness { pushes: string[]; adminGets: number; plainGets: number; logs: string[] }

/** adminRows = /api/admin/records 这一轮回的全量清单；
 *  plainRows = /api/records 回的本账号清单(故意仍带着 ghost —— 若实现拿它当「服务器没有」的参照，
 *  用例就会红，变异跑的就是这个差别)。POST/PUT 记进 pushes，用来证明推送确实发了请求。
 *  同步链路上每一段 try/catch 都会把异常咽成「继续用本地」，测试里那等于静默失败：
 *  列表少了几条盘却看不出为什么。所以这里把每次 fetch 与每个异常都记进 h.logs，
 *  断言失败时能当场读出「根本没发过这个请求」还是「发了但被吞掉」。 */
function mockRows(adminRows: BaziRecord[], plainRows: BaziRecord[]): Harness {
  const h: Harness = { pushes: [], adminGets: 0, plainGets: 0, logs: [] };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? 'GET';
    if (u.includes('/api/admin/records')) { h.adminGets += 1; h.logs.push('GET admin -> ' + adminRows.length); return { ok: true, status: 200, json: async () => ({ records: adminRows }) } as Response; }
    // PUT 的 URL 带盘 id(/api/records/<id>)，POST 建行才是裸 /api/records：两种都要认，
    // 否则「补推走 PUT」这条真实路径会被当成意外请求抛掉(实测：上传永远失败、标记永远清不掉)。
    if (/\/api\/records(\/[^/]+)?$/.test(u) && (method === 'POST' || method === 'PUT')) { h.pushes.push(method + ' ' + u); h.logs.push(method + ' record'); return { ok: true, status: 200, json: async () => ({ record: {} }) } as Response; }
    if (/\/api\/records$/.test(u)) { h.plainGets += 1; h.logs.push('GET records -> ' + plainRows.length); return { ok: true, status: 200, json: async () => ({ records: plainRows.map(({ username: _u, ...rest }) => rest) }) } as Response; }
    h.logs.push('THROW unexpected ' + method + ' ' + u);
    throw new Error('unexpected fetch: ' + u + ' ' + method);
  }));
  return h;
}

beforeEach(() => {
  // 归属表(盘→账号名)、「服务器已有 id」名单、最近一轮全量清单都是跨用例状态：
  // 用例开头显式清干净，否则上一个用例引进的标签会混进下一个列表。
  // 库用带 localStorage 的那份，**不能**再走 configureBaziRepository —— 它会连内存视图一起清空，
  // 而视图正是「本机这份数据」，清了它 syncAdminAll 写进去的全量清单当场就没了(实测过一次)。
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

describe('管理员全量视图(syncAdminAll)', () => {
  it('别的账号的盘：一次同步之后仍在列表里，且带着账号名标签', async () => {
    setServerUrl('http://127.0.0.1:8787');
    setServerSession({ token: 'tok', username: 'boss', role: 'admin' });
    // boss 名下只有 mine；客户甲那条属于另一个账号，只出现在全量清单里。
    await saveBaziRecord(record('mine', '自留'));
    const other = { ...record('other', '张三'), username: '客户甲' };
    mockRows([other, record('mine', '自留')], [record('mine', '自留')]);
    await syncAdminAll();
    const rows = await listBaziRecords();
    expect(rows.map((r) => r.id), '跨账号视图被普通清单覆盖回去 → 界面那句「全部账号记录」成了空话').toEqual(expect.arrayContaining(['mine', 'other']));
    expect(rows.find((r) => r.id === 'other')?.username).toBe('客户甲');
  });

  it('上一轮引进、这一轮全量清单没有但普通清单还在的盘 → 按全量清单判删除，剔掉幽灵', async () => {
    setServerUrl('http://127.0.0.1:8787');
    setServerSession({ token: 'tok', username: 'boss', role: 'admin' });
    await saveBaziRecord(record('live', '在管'));
    // 第一轮：ghost 属于客户丙，全量清单里有它 → 正常引进视图。
    mockRows([{ ...record('ghost', '幽灵'), username: '客户丙' }, record('live', '在管')], [record('live', '在管')]);
    await syncAdminAll();
    expect((await listBaziRecords()).map((r) => r.id)).toContain('ghost');
    // 第二轮：ghost 被删/改属，全量清单不再返回它；普通清单**故意仍返回**(它不是删除的参照)。
    const h = mockRows([record('live', '在管')], [record('live', '在管'), { ...record('ghost', '幽灵'), username: '客户丙' }]);
    await syncAdminAll();
    const ids = (await listBaziRecords()).map((r) => r.id);
    expect(ids).toContain('live');
    expect(ids, '全量清单已无此盘却留在列表里 → 点进去详情接口就是打不开的幽灵记录').not.toContain('ghost');
    expect(h.adminGets, '本轮确实打过全量接口(否则上面那条等于没测)').toBeGreaterThan(0);
  });

  it('正向钉子：本机新建、还没进过全量清单的盘不得被误剔', async () => {
    setServerUrl('http://127.0.0.1:8787');
    setServerSession({ token: 'tok', username: 'boss', role: 'admin' });
    await saveBaziRecord(record('fresh', '新建'));
    const h = mockRows([], []);
    await flushPendingPushes();          // 等保存时那条不 await 的推送落地
    await syncAdminAll();
    expect((await listBaziRecords()).map((r) => r.id), '全量为空就清空视图 → 刚建的盘当场消失').toContain('fresh');
    expect(h.pushes.length, '保存时那次推送(不 await)在本轮内确实发了请求').toBeGreaterThan(0);
  });

  it('推送不通的新盘：留在列表里并标成待同步，恢复后补推并清掉提示', async () => {
    // 这条钉的是 unsyncedRecordIds 那句「界面据此提示『这条还没同步』」的承诺。
    // 旧实现在这里直接 return []：CAN_PERSIST 在测试模式下为假，于是「待同步提示」整条路径
    // 从来没有被任何单测读过 —— 界面永远显示「全部已同步」，用户等到聊天答不到人才发现。
    setServerUrl('http://127.0.0.1:8787');
    setServerSession({ token: 'tok', username: 'boss', role: 'admin' });
    const broken = mockRows([], []);
    __failRemoteForTests(true);
    await saveBaziRecord(record('offline', '离线建'));
    await flushPendingPushes();           // 推送是 void 出去的：等它落地才能判定「推没推上去」
    // __failRemoteForTests 的闸门在 uploadRecord 里、发请求之前，所以「试过上传」不能看 fetch 计数：
    // 判据是它确实走到了上传这一步(否则 markDirty 无从谈起)，用待同步名单本身来钉下一条。
    expect(broken.pushes.length, '推送失败前不该真的发出请求(闸门在发请求之前)').toBe(0);
    expect((await listBaziRecords()).map((r) => r.id), '推送失败的盘不该从列表里消失').toContain('offline');
    expect(unsyncedRecordIds(), '没推上去却没标待同步 → 界面那句提示是空话').toEqual(['offline']);
    // 恢复网络：下一轮普通读取会把积压的补推上去，并把标记清掉。
    __failRemoteForTests(false);
    const fixed = mockRows([], [record('offline', '离线建')]);
    await listBaziRecords();
    expect(fixed.pushes.some((p) => p.includes('/api/records')), '待推送名单里的盘下一轮要真的补推上去').toBe(true);
    expect(unsyncedRecordIds(), '补推成功后仍挂着「未同步」→ 提示和事实相反').toEqual([]);
  });

  it('合并判据：一次同步里既留得住别的账号的盘，也剔得掉被删的那条', async () => {
    // 两条规则写在同一个函数里，分开测各自都可能是「另一条恰好没生效」换来的绿：
    // 只按全量清单剔 → 本用例的 other 会被误杀；参照普通清单剔 → 本用例的 ghost 会被留下。
    setServerUrl('http://127.0.0.1:8787');
    setServerSession({ token: 'tok', username: 'boss', role: 'admin' });
    await saveBaziRecord(record('mine', '自留'));
    // 第一轮：other 与 gone 都还在全量清单里 → 一起引进视图(此时两条都只是「别的账号的盘」)。
    const h = mockRows(
      [{ ...record('other', '张三'), username: '客户甲' }, { ...record('gone', '旧属'), username: '客户乙' }, record('mine', '自留')],
      [record('mine', '自留')],
    );
    await syncAdminAll();
    expect((await listBaziRecords()).map((r) => r.id), '第一轮视图没落地: ' + h.logs.join(' | ')).toEqual(expect.arrayContaining(['other', 'gone', 'mine']));
    // 第二轮：gone 被删/改属，全量清单不再返回；普通清单故意仍带着它 —— 参照错清单就会留下幽灵。
    mockRows(
      [{ ...record('other', '张三'), username: '客户甲' }, record('mine', '自留')],
      [record('mine', '自留'), { ...record('gone', '旧属'), username: '客户乙' }],
    );
    await syncAdminAll();
    const ids = (await listBaziRecords()).map((r) => r.id);
    expect(ids, '别人的盘被普通清单覆盖回去 → 跨账号视图塌了').toContain('other');
    expect(ids, '全量清单已无此盘却留在列表里 → 幽灵记录').not.toContain('gone');
    expect(ids).toContain('mine');
  });

  it('普通用户调它：不打 /admin/records，本地列表原样不动', async () => {
    setServerUrl('http://127.0.0.1:8787');
    setServerSession({ token: 'tok', username: 'worker', role: 'user' });
    const h = mockRows([{ ...record('other', '张三'), username: '客户甲' }], []);
    await saveBaziRecord(record('own', '自留'));
    h.pushes.length = 0;
    await syncAdminAll();
    expect(h.adminGets, '非管理员也会打 /admin/records → 权限门形同虚设').toBe(0);
    expect(h.pushes.length, 'syncAdminAll 自己不该再推任何盘').toBe(0);
    expect((await listBaziRecords()).map((r) => r.id)).toContain('own');
  });

  /* 界面那句「本列表为服务器全部账号记录」在真设备上还要经得起**换页面/重启**：视图清空、
     只留存储与归属表，下一次读取必须把这台设备该看的那些重新采纳回来。产品代码那条路是
     CAN_PERSIST + loadLocal，单测里 MODE==='test' 让它整段短路(实测删掉 ensureViewLoaded
     全量用例仍全绿)，所以这里用 configureBaziRepository 清视图来模拟「视图没了、存储还在」。 */
  it('视图清空后重新读取：本机自建盘从存储采纳回来，别人的盘不借道复活', async () => {
    setServerUrl('http://127.0.0.1:8787');
    setServerSession({ token: 'tok', username: 'boss', role: 'admin' });
    await saveBaziRecord(record('mine', '自留'));
    mockRows([{ ...record('other', '张三'), username: '客户甲' }, record('mine', '自留')], [record('mine', '自留')]);
    await syncAdminAll();
    expect((await listBaziRecords()).map((r) => r.id)).toEqual(expect.arrayContaining(['other', 'mine']));
    // 「刷新一次」：视图清空(configureBaziRepository 的既有语义)，存储与归属表原封不动。
    // 这一轮服务器**不可达** —— 真设备上重启时列表读的就是本机存储；若这里仍回着清单，
    // mergeRemoteRecords 会把远端那几条直接填进视图，ensureViewLoaded 那条采纳路径根本走不到
    // (实测：删掉它全量用例照旧全绿，就是因为闸门被这条旁路绕过了)。
    configureBaziRepository(storageBackedBaziRepository(KEY));
    __setOwnerKeyForTests(null);            // 证明 loadOwners 会从存储重载标签，而不是靠上一轮的内存残留
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('测试：重启时离线'); }));
    const ids = (await listBaziRecords()).map((r) => r.id);
    expect(ids, '视图空了就不采纳存储 → 界面显示「暂无记录」，用户以为数据丢了').toContain('mine');
    expect(ids, '离线重启把不属于本账号的盘也采纳进列表 → 它既点不开又会被当成积压推上去').not.toContain('other');
    // 恢复联网后：本机那条照常补推，别人的盘要等管理员重新拉全量清单才回到跨账号视图。
    const h2 = mockRows([{ ...record('other', '张三'), username: '客户甲' }, record('mine', '自留')], [record('mine', '自留')]);
    await flushPendingPushes();
    await syncAdminAll();
    const back = (await listBaziRecords()).map((r) => r.id);
    expect(back, '重启后本账号的盘该留在列表里(推送由保存/同步链路负责)').toContain('mine');
    expect(back).toEqual(expect.arrayContaining(['other']));
    expect(h2.adminGets, '跨账号视图只能由 /admin/records 重建').toBe(1);
  });

  /* 幽灵的账要三处一起清：视图、待推送名单、以及「最近一轮全量清单」这份参照。
     参照留着旧 id，下一轮普通读取就仍把它判成「服务器上还有」，而全量清单里其实已经没有它 ——
     这条盘既点不开(GET /records/<id> 回 403/404)又赖在列表里。上面那条多轮用例剔的是同一盘，
     但它的参照来自**新一轮**的 adminFullView.set，看不出旧参照有没有跟着瘦身，所以单独钉这一条。 */
  it('剔掉幽灵时把「最近一轮全量清单」里的它也忘掉：旧参照不会把它请回来', async () => {
    setServerUrl('http://127.0.0.1:8787');
    setServerSession({ token: 'tok', username: 'boss', role: 'admin' });
    await saveBaziRecord(record('live', '在管'));
    mockRows([{ ...record('ghost', '幽灵'), username: '客户丙' }, record('live', '在管')], [record('live', '在管')]);
    await syncAdminAll();
    expect((await listBaziRecords()).map((r) => r.id)).toContain('ghost');
    // 第二轮：ghost 不在全量清单里 → dropAbsentFromAdminView 当场剔它并同步瘦身参照。
    mockRows([record('live', '在管')], [{ ...record('ghost', '幽灵'), username: '客户丙' }, record('live', '在管')]);
    await syncAdminAll();
    expect((await listBaziRecords()).map((r) => r.id)).not.toContain('ghost');
    // 第三轮：故意让管理员同步失败(清单请求抛错)。此时唯一能剔 ghost 的就是上一轮那份参照 ——
    // 参照没跟着瘦身的话，普通读取会照着它判定「服务器上还有」，ghost 原地复活。
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('测试：本轮不可达'); }));
    const ids = (await listBaziRecords()).map((r) => r.id);
    expect(ids, '旧全量清单还留着已删盘的 id → 幽灵在下一轮复活: ' + JSON.stringify(ids)).not.toContain('ghost');
    expect(ids).toContain('live');
  });

  /* 补推循环只推「记在本账号名下」的盘。这条判据此前被一次行级清理误删过(注释留着、代码没了)，
     全量 460 条用例依然全绿 —— 说明其余用例没有一个真的走到「视图里躺着别人的盘 + 它在待推送名单上」。
     下面这条就是那枚缺失的钉子：server/app.mjs 对 PUT /api/records/<id> 放行 owner **或** admin，
     所以管理员设备一旦补推别人名下的盘，就是用本机这份视图覆盖对方的数据(无声、不可回滚)。 */
  it('待推送名单里的「别人的盘」不会被补推到服务器', async () => {
    setServerUrl('http://127.0.0.1:8787');
    setServerSession({ token: 'tok', username: 'boss', role: 'admin' });
    // 第一轮：other 由管理员全量同步引进，带着「客户甲」的标签。
    mockRows([{ ...record('other', '张三'), username: '客户甲' }], []);
    await syncAdminAll();
    expect((await listBaziRecords()).map((r) => r.id)).toContain('other');
    // 这台设备上把它改了一次(例如清结果/改语气)：推送先失败 ⇒ 落进待推送名单。
    __failRemoteForTests(true);
    const h = mockRows([{ ...record('other', '张三'), username: '客户甲' }], []);
    await saveBaziRecord({ ...record('other', '张三'), username: '客户甲', toneUsed: 30 });
    await flushPendingPushes();
    expect(unsyncedRecordIds(), '改完别人的盘应当先进待推送名单').toContain('other');
    // 网络恢复后读列表：补推循环会遍历这份名单。
    __failRemoteForTests(false);
    h.pushes.length = 0;
    await listBaziRecords();
    await flushPendingPushes();
    expect(h.pushes, '管理员设备把客户甲的盘 PUT 上去了 → 覆盖别人数据: ' + JSON.stringify(h.pushes)).toEqual([]);
    expect(unsyncedRecordIds(), '不属于本账号的积压要留着标记，等它真归到本账号名下再推').toContain('other');
    expect((await listBaziRecords()).map((r) => r.id), '拦推送不能把这条盘从视图里抹掉').toContain('other');
  });

  /* 归属表(盘→账号名)是跨账号视图的第二份依据，它必须跟**本轮全量清单**一样大。
     留着上一轮那些：loadOwners 会把「服务器已经没有、标签却还在」的盘重新认成管理员引进的盘，
     dropAbsentFromAdminView 与普通读取那道幽灵闸门都照它判 —— 实测：删掉瘦身那一行，
     下面这条在恢复联网后仍把 gone 留在列表里(而 GET /records/gone 回 403/404，点不开)。 */
  it('归属表跟着本轮全量清单瘦身：上一轮被删的盘不会靠旧标签复活', async () => {
    setServerUrl('http://127.0.0.1:8787');
    setServerSession({ token: 'tok', username: 'boss', role: 'admin' });
    await saveBaziRecord(record('mine', '自留'));
    mockRows([{ ...record('gone', '旧属'), username: '客户乙' }, record('mine', '自留')], [record('mine', '自留')]);
    await syncAdminAll();
    expect(JSON.parse(localStorage.getItem(OWNER_KEY) || '{}'), '第一轮该把客户乙记进归属表').toEqual([['gone', '客户乙']]);
    // 第二轮：gone 在服务器上没了(删除或改属)，全量清单不再返回它。
    mockRows([record('mine', '自留')], [record('mine', '自留')]);
    await syncAdminAll();
    expect(JSON.parse(localStorage.getItem(OWNER_KEY) || '[]'), '全量清单已无此盘，归属表却还给它挂着账号名').toEqual([]);
    // 恢复联网再读一次：此时唯一能把 gone 请回来的就是那份旧标签(loadOwners + withOwner)。
    const h = mockRows([record('mine', '自留')], [{ ...record('gone', '旧属'), username: '客户乙' }, record('mine', '自留')]);
    const ids = (await listBaziRecords()).map((r) => r.id);
    expect(ids, '旧标签让点不开的幽灵重新出现在列表里: ' + JSON.stringify(h.logs)).not.toContain('gone');
    expect(ids).toContain('mine');
  });

  /* 待推送名单有本账号那份和共享(登录前)那份两本账；清标记只清一本，另一本就永远留着这个 id。
     下一任在这台设备登录的账号会照着共享名单把别人的盘「认领」成自己的(adoptUnclaimedLocalRecords)，
     于是那条盘既进了它的列表又会被 PUT 到别人名下。实测：删掉那段共享键清理，全量用例仍全绿。 */
  it('补推成功后两本待推送账一起清：下一个登录的账号不会重复认领', async () => {
    setServerUrl('http://127.0.0.1:8787');
    setServerSession({ token: 'tok', username: 'boss', role: 'admin' });
    await saveBaziRecord(record('mine', '自留'));
    await flushPendingPushes();
    // 登录前离线建的盘：记录与标记都落在共享命名空间上。
    localStorage.setItem('mingli.pwa.records', JSON.stringify([record('legacy', '登录前建')]));
    localStorage.setItem('mingli.pwa.records.dirty', JSON.stringify(['legacy']));
    localStorage.setItem(dirtyOf('boss'), JSON.stringify(['mine']));
    __assumeOnServerForTests(['mine']);
    const h = mockRows([record('mine', '自留'), record('legacy', '登录前建')], [record('mine', '自留')]);
    await listBaziRecords();               // 这一轮把 boss 名下积压的那条补推上去
    await flushPendingPushes();
    expect(h.pushes.length, '待推送名单里的盘这轮该真的推上去').toBeGreaterThan(0);
    expect(JSON.parse(localStorage.getItem(dirtyOf('boss')) || '[]')).not.toContain('mine');
    expect(JSON.parse(localStorage.getItem('mingli.pwa.records.dirty') || '[]'),
      '本账号名单清了、共享名单还留着同一个 id → 下个账号会把它当成自己的积压再认领一遍').not.toContain('mine');
  });

  /* persistView 里那道「端口镜像视图就不整体落盘」的判断是死代码：当场取证(在函数里打印端口形状)
     显示整组用例跑下来每次调用都是 sv=function、mv=undefined —— 产品路径从不会把镜像端口(内存库那条
     根本没有 saveView)送到这里，所以删掉那道判断全量照旧全绿。与其留一条测不到的判据，不如把这条
     用例改成**可达性钉子**：真要把带账号标签的跨账号视图交给这种端口整体落盘，别人的盘就会写进
     本账号那份存储，重启后以「自留盘」身份回列表、还会被当成积压 PUT 回别人名下(server/app.mjs
     对 PUT 放行 admin)。正向对照证明这份桩确实接得住落盘 —— 少了它，下面的反向断言恒真。 */
  it('镜像视图的端口不该被整体落盘：跨账号视图不会写进本账号存储', async () => {
    setServerUrl('http://127.0.0.1:8787');
    setServerSession({ token: 'tok', username: 'boss', role: 'admin' });
    mockRows([{ ...record('other', '张三'), username: '客户甲' }, record('mine', '自留')], [record('mine', '自留')]);
    const liveKey = KEY + '.live';
    configureBaziRepository(storageBackedBaziRepository(liveKey));
    await syncAdminAll();
    const mine = (JSON.parse(localStorage.getItem(liveKey) || '[]') as BaziRecord[]).map((r) => r.id);
    expect(mine, '这一趟同步本身得能落盘(否则下面那条反向断言恒真)').toContain('mine');
    const otherNs = (JSON.parse(localStorage.getItem(liveKey + '.客户甲') || '[]') as BaziRecord[]).map((r) => r.id);
    expect(otherNs, '别人的盘该落在它自己账号的命名空间里').toContain('other');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('测试：本轮不可达'); }));
    // 反向：换成「声明镜像但仍带 saveView」的端口(独立键，免得上一段合法写入冒充这次的结果)，
    // 视图里仍带着客户甲那条标签。产品代码若对它整体落盘，别人的盘就进了这个键。
    const mirrorKey = KEY + '.mirror';
    configureBaziRepository({
      ...storageBackedBaziRepository(mirrorKey),
      mirrorsView: () => true,
      listBaziRecords: async () => [],       // 存储读成空：里面只要出现东西，就只能是这次被整体落盘写进去的
    });
    await syncAdminAll();
    const mirrored = (JSON.parse(localStorage.getItem(mirrorKey) || '[]') as BaziRecord[]).map((r) => r.id);
    expect(mirrored,
      '端口镜像视图时又整体落盘一遍 → 跨账号视图被写进本账号那份存储，重启后别人的盘成了自留盘').toEqual([]);
    // 这条桩只测了 persistView；saveLocalRecord 那道「镜像就不往视图里塞第二份」由它自己那条判据兜着
    // (实测：删掉那行，全量有 3 条用例当场红)，这里补一句把两份能力的分工写明：带 saveView 的端口
    // **不声明** mirrorsView，视图才归产品代码维护。
    expect(storageBackedBaziRepository(KEY).mirrorsView,
      'storageBackedBaziRepository 不该声明 mirrorsView(它只管存储，视图由产品代码维护)').toBeUndefined();
  });

  /* syncAdminAll 那道剔幽灵是**唯一**会顺手把 adminFullView / knownRemoteIds / 归属表一起瘦身的地方。
     合并结果里那条 `!remoteNow.has(id)` 只保证这一轮的视图与存储干净，参照留着旧 id 就等于
     下一轮仍照着它判定「服务器上还有」；而普通清单(server/app.mjs 按 username 查，改属的盘已经
     不在本账号名下)也不会再返回它 —— 于是这条点不开的幽灵永远赖在列表里(实测：删掉那一行调用，
     下面这条第三轮照样看得见 gone)。 */
  it('管理员同步剔幽灵时三处账目一起清：后续每一轮都不会把它请回来', async () => {
    setServerUrl('http://127.0.0.1:8787');
    setServerSession({ token: 'tok', username: 'boss', role: 'admin' });
    await saveBaziRecord(record('mine', '自留'));
    mockRows([{ ...record('gone', '旧属'), username: '客户乙' }, record('mine', '自留')], [record('mine', '自留')]);
    await syncAdminAll();
    expect((await listBaziRecords()).map((r) => r.id)).toContain('gone');
    // 第二轮：gone 改了归属，全量清单不再返回它 → dropAbsentFromAdminView 当场剔它并瘦身三处账目。
    mockRows([record('mine', '自留')], [record('mine', '自留')]);
    await syncAdminAll();
    expect((await listBaziRecords()).map((r) => r.id)).not.toContain('gone');
    // 第三轮：本轮清单同样没有它，任何一处旧账(adminFullView / knownRemoteIds / 归属表)都能把它复活。
    const h = mockRows([record('mine', '自留')], [{ ...record('gone', '旧属'), username: '客户乙' }, record('mine', '自留')]);
    await syncAdminAll();
    const ids = (await listBaziRecords()).map((r) => r.id);
    expect(ids, '旧账没跟着瘦身 → 幽灵在后续每一轮都回来: ' + JSON.stringify(h.logs)).not.toContain('gone');
    expect(ids).toContain('mine');
  });

  /* 删除一条盘要把归属表里那条标签一起忘掉：留着它，这条 id 在归属表里仍是「管理员引进的盘」，
     而磁盘上/存储里可能还躺着它的副本 —— 采纳与合并都会照旧标签把它请回来。
     实测：只删 forgetOwner 那一处(内存库那条)，全量用例仍全绿。 */
  it('删除一条盘后，归属表里不会再挂着它的账号标签', async () => {
    setServerUrl('http://127.0.0.1:8787');
    setServerSession({ token: 'tok', username: 'boss', role: 'admin' });
    mockRows([{ ...record('other', '张三'), username: '客户甲' }], []);
    await syncAdminAll();
    expect((await listBaziRecords()).map((r) => r.id)).toContain('other');
    await deleteBaziRecord('other');
    expect(JSON.parse(localStorage.getItem(OWNER_KEY) || '[]'), '盘都删了，归属表还给它的 id 挂着账号名').toEqual([]);
    expect((await listBaziRecords()).map((r) => r.id)).not.toContain('other');
  });

  /* 「内存库那条」(memoryBaziRepository，桌面/无服务器路径用的就是它)是视图即存储：别人的盘一旦
     带着账号标签落进它，下一次整体覆盖就把它写进本账号那份存储，重启后它以「自留盘」身份回列表、
     还会被当成积压 PUT 回别人名下。网页那条端口按账号分键、别人的盘有去处；这份没有，所以不落地。 */
  it('内存库端口不收下带别人账号名的条目', async () => {
    __resetSyncStateForTests();
    configureBaziRepository(memoryBaziRepository);
    await memoryBaziRepository.saveBaziRecord({ ...record('other', '张三'), username: '客户甲' });
    expect((await memoryBaziRepository.listBaziRecords()).map((r) => r.id),
      '带别人账号名的条目落进了本账号那份库').toEqual([]);
    // 正向钉子：同一条去掉标签就该正常落地，否则上面那句等于「什么都存不下」也照样绿。
    await memoryBaziRepository.saveBaziRecord(record('own', '自留'));
    expect((await memoryBaziRepository.listBaziRecords()).map((r) => r.id)).toEqual(['own']);
    // 这条端口**没有** saveView —— persistView 那道「没有 saveView 就直接返回」就是为它准备的，
    // 但内存库不收别人的盘，所以那条判断在这里永远碰不到(实测：删掉那道判断，全量 472 条照旧全绿)。
    expect(memoryBaziRepository.saveView,
      '内存库带 saveView 的话 persistView 会把跨账号视图整体落进本账号那份存储').toBeUndefined();
  });

  /* 五行计数回写(listBaziRecords 里那条 saveToStorage)只动存储、不动视图。
     它一旦带上视图副作用(某些端口会把记录追加到视图末尾)，下一次整体覆盖就把这条盘排到
     别人账号的盘后面 —— 列表顺序当场变；而修好的值又被视图里那份旧行盖回去。 */
  it('存储回写不改视图：列表顺序与内容都不受影响', async () => {
    setServerUrl('http://127.0.0.1:8787');
    setServerSession({ token: 'tok', username: 'boss', role: 'admin' });
    await saveBaziRecord(record('mine', '自留'));
    mockRows([{ ...record('other', '张三'), username: '客户甲' }, record('mine', '自留')], [record('mine', '自留')]);
    await syncAdminAll();
    const before = (await listBaziRecords()).map((r) => r.id);
    expect(before).toEqual(['mine', 'other']);
    // 五行计数回写的触发条件：存储里那条的口径版本号是旧的(存量盘)，读列表时确定性校正会算回来并落库。
    const stale = JSON.parse(localStorage.getItem(KEY) || '[]');
    localStorage.setItem(KEY, JSON.stringify(stale.map((r: BaziRecord) => ({ ...r, nonAiResult: { ...(r.nonAiResult ?? {}), elementRuleVersion: 'old-rule' } }))));
    const after = (await listBaziRecords()).map((r) => r.id);
    expect(after, '回写存储顺带动了视图 → 列表顺序/内容被这次读数改掉').toEqual(before);
    // 正向钉子：上面那句「没动视图」也可能只是因为压根没发生回写 —— 这里确认存储真的被改过。
    const written = JSON.parse(localStorage.getItem(KEY) || '[]') as BaziRecord[];
    expect(written.find((r) => r.id === 'mine')?.nonAiResult?.elementRuleVersion,
      '存储里仍是旧口径 → 校正没落库，导出/同步出去的仍是错的计数').not.toBe('old-rule');
  });

  /* persistView 里「端口没有 saveView 就直接返回」这一半单独钉(另一半「镜像视图不整体落盘」见上面那条，
     那条的桩同时带 saveView，走不到这里)。旧用例装的是「镜像视图 + 没有 saveView」，两道一起成立，
     删掉任一道全量 472 条都照旧全绿 —— 等于没钉(实测)。所以这里装的桩**整条不声明** mirrorsView：
     注意不能写 mirrorsView: () => false —— 那道判断按真值短路，false 与「没有这个方法」等价，
     那么装了就等于两道一起关掉，探针永远不会响(实测：calls 恒空)。
     桩还必须是**独立实例 + 独立键**：configureBaziRepository 只清视图不清存储，复用 KEY 的话
     上一段 syncAdminAll 合法写进存储的那两条会冒充这次的落盘结果(实测)。 */
  it('端口不管整体落盘时直接返回：不会在没有 saveView 的端口上继续往下走', async () => {
    setServerUrl('http://127.0.0.1:8787');
    setServerSession({ token: 'tok', username: 'boss', role: 'admin' });
    configureBaziRepository(storageBackedBaziRepository(KEY));
    await saveBaziRecord(record('mine', '自留'));
    mockRows([{ ...record('other', '张三'), username: '客户甲' }, record('mine', '自留')], [record('mine', '自留')]);
    await syncAdminAll();
    expect((await listBaziRecords()).map((r) => r.id), '视图本身该带着两条').toEqual(expect.arrayContaining(['mine', 'other']));
    const nosvKey = KEY + '.nosv';
    const calls: number[] = [];
    let armed = false;   // 只在换库之后计数，免得前面那段合法同步的落盘混进来
    configureBaziRepository({
      ...storageBackedBaziRepository(nosvKey),
      async saveView(records) { if (armed) calls.push(records.length); },
    });
    // 本轮仍要发得出 /api/admin/records：persistView 在清单回来之后才走到，
    // 若在这里让 fetch 直接抛错，请求根本没发出、落盘也永远到不了(实测：探针恒空)。
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ records: [{ ...record('other', '张三'), username: '客户甲' }, record('mine', '自留')] }),
    })));
    armed = true;
    await syncAdminAll();
    expect(calls, '端口有 saveView 且未声明镜像时这一轮该落一次盘(否则下面那段等于没测)').toEqual([2]);
    calls.length = 0;
    configureBaziRepository({ ...storageBackedBaziRepository(nosvKey + '2'), saveView: undefined });
    await syncAdminAll();
    expect(calls.length, '端口没有 saveView 仍往下走 → 跨账号视图无处可落，这一轮存储副本静默丢失').toBe(0);
  });

  /* 普通读取那道幽灵闸门的注释承诺「这里不动归属表」，而代码逐条 forgetOwner —— 两句对不上。
     真实语义是：**只忘本轮判成幽灵的那几条**，绝不跟本轮普通清单对齐整表(那是 /admin/records
     的全量清单才配得上的参照)。变异跑的就是这个差别：把它换成按本轮清单瘦身，
     「别的账号的盘：一次同步之后仍在列表里」当场红 —— 客户甲那条的标签被抹掉，下一次读取
     它以「无主本机盘」身份回来并进待推送名单，管理员设备会把它 PUT 回别人名下。 */
  it('普通读取剔幽灵只忘那几条的标签：别的账号盘的归属不受牵连', async () => {
    setServerUrl('http://127.0.0.1:8787');
    setServerSession({ token: 'tok', username: 'boss', role: 'admin' });
    await saveBaziRecord(record('mine', '自留'));
    mockRows([{ ...record('other', '张三'), username: '客户甲' }, { ...record('gone', '旧属'), username: '客户乙' }, record('mine', '自留')], [record('mine', '自留')]);
    await syncAdminAll();
    expect((await listBaziRecords()).map((r) => r.id)).toEqual(expect.arrayContaining(['other', 'gone']));
    // 第二轮：服务器端 gone 被删/改属，全量与普通清单都不再返回它；other 仍在服务器上，
    // 但普通清单(server/app.mjs 按 username 查)压根不带别的账号的盘。
    mockRows([{ ...record('other', '张三'), username: '客户甲' }, record('mine', '自留')], [record('mine', '自留')]);
    await syncAdminAll();
    const ids = (await listBaziRecords()).map((r) => r.id);
    expect(ids, '本轮清单里没有的别人的盘该被剔掉').not.toContain('gone');
    expect(ids).toContain('other');
    // 归属表此刻只剩 other：gone 的标签忘了，other 的标签必须还在。
    expect(JSON.parse(localStorage.getItem(OWNER_KEY) || '[]'), '归属表被本轮普通清单当参照整表瘦身').toEqual([['other', '客户甲']]);
    // 正向钉子：离线重启一次(视图清空)，other 仍按标签被挡在本账号采纳之外，不会变成自留盘。
    configureBaziRepository(storageBackedBaziRepository(KEY));
    __setOwnerKeyForTests(null);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('测试：重启时离线'); }));
    const after = (await listBaziRecords()).map((r) => r.id);
    expect(after, '标签被误抹 → 别人的盘以无主盘身份回到本账号列表').not.toContain('other');
    expect(after).toContain('mine');
  });
});
