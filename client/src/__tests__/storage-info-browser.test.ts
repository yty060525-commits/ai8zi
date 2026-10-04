import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setServerUrl, setServerSession } from '../data/serverClient';

/* storageInfo.ts 的**浏览器那一路**此前从没被执行过：clear-cache-receipt.test.tsx 把整个模块
 * 桩掉了(为了测 PersonDetail 的三句回执)，SettingsPage 的用例也拿不到真实现。于是这一层里
 * 四条「网页版如实说明」的承诺全是空口白话：
 *   - cacheEntries 要报 null(未知)，不许摆个像「缓存已空」的假 0；
 *   - records 数取自本机库，不是写死的 0；
 *   - 清除缓存没有 recordId 时返回 0 —— 而 PersonDetail 会把 0 念成「该盘在服务器上本无缓存」，
 *     这句话在没有 id 的场景下是假的(根本没去问服务器)；
 *   - 连通自检要说清去哪儿测，而不是报一个看起来像故障的失败。
 * 判据走真实 import：不桩 storageInfo，只桩 fetch 和 Tauri 标记。 */

const FIELDS = { gender: 'male', yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午' };

/** 拦组件真正发出去的那条请求，而不是我自己再拼一个 URL(既往教训：自建 URL 的判据变异全绿)。 */
let requests: Array<{ url: string; method: string }> = [];
let removedByServer = 4;
let fetchShouldFail = false;

function stubFetch() {
  requests = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = String(init?.method ?? 'GET');
    requests.push({ url: String(url), method });
    if (fetchShouldFail) return { ok: false, status: 500, json: async () => ({}) } as Response;
    if (method === 'GET' && /\/api\/records$/.test(String(url))) {
      return { ok: true, status: 200, json: async () => ({ records: [] }) } as Response;
    }
    return { ok: true, status: 200, json: async () => ({ removed: removedByServer }) } as Response;
  }));
}

beforeEach(() => {
  localStorage.clear();
  requests = [];
  removedByServer = 4;
  fetchShouldFail = false;
  stubFetch();
  setServerUrl('http://127.0.0.1:8787');
  setServerSession({ token: 't', username: 'judge', role: 'user' });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  localStorage.clear();
});

describe('storageInfo 的浏览器路径(整模块桩掉时永远走不到)', () => {
  it('桌面版标记存在时一律转给 Tauri 命令，且参数按名传过去', async () => {
    const invoke = vi.fn(async (cmd: string) => (cmd === 'get_storage_stats'
      ? { records: 7, cacheEntries: 3, dbBytes: 4096 }
      : cmd === 'compact_records' ? { changedRecords: 2 }
        : cmd === 'clear_chart_cache' ? 9 : { ok: true, provider: 'qwen' }));
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = { invoke };
    try {
      const storageInfo = await import('../data/storageInfo');
      expect(await storageInfo.getStorageStats()).toEqual({ records: 7, cacheEntries: 3, dbBytes: 4096 });
      expect(await storageInfo.compactRecords(), '桌面版要回 changedRecords 而不是固定 0').toBe(2);
      expect(await storageInfo.clearChartCache(FIELDS, 'id-1')).toBe(9);
      expect((await storageInfo.runAiSelfTest()).ok).toBe(true);
      const names = invoke.mock.calls.map((c) => c[0]);
      expect(names).toEqual(['get_storage_stats', 'compact_records', 'clear_chart_cache', 'ai_self_test']);
      // 清除缓存必须把四柱+性别传给 Rust(服务器不需要，桌面端靠它算签名)
      const clearCall = invoke.mock.calls.find((c) => c[0] === 'clear_chart_cache');
      expect(clearCall?.[1]).toEqual({ gender: 'male', yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午' });
      // 反向钉子：桌面路径一次都不该打服务器
      expect(requests).toHaveLength(0);
    } finally {
      delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    }
  });

  it('网页版存储统计：cacheEntries 报「未知(null)」而不是像「已清空」的 0，记录数取自本机库', async () => {
    const { configureBaziRepository, memoryBaziRepository, saveBaziRecord } = await import('../data/clientRepository');
    configureBaziRepository(memoryBaziRepository);
    await saveBaziRecord({ name: '甲', gender: 'male', birthYear: 1990, birthMonth: 3, yearPillar: '庚午', monthPillar: '辛巳', dayPillar: '乙酉', hourPillar: '癸未' } as never);
    await saveBaziRecord({ name: '乙', gender: 'female', birthYear: 1988, birthMonth: 9, yearPillar: '戊辰', monthPillar: '壬戌', dayPillar: '甲子', hourPillar: '丙寅' } as never);

    const storageInfo = await import('../data/storageInfo');
    const stats = await storageInfo.getStorageStats();
    expect(stats.records, '记录数没从本机库读').toBe(2);
    expect(stats.cacheEntries, '「根本没查」被写成 0，界面会显示成缓存已空').toBeNull();
    // 正向钉子：records 那条读数确实来自库(改成硬编码 0 的变异要红)
    expect((await storageInfo.getStorageStats()).records).toBe(stats.records);
  });

  it('网页版清除缓存：有 id 才打服务器，并把服务器删掉的条数原样回报', async () => {
    const storageInfo = await import('../data/storageInfo');
    expect(await storageInfo.clearChartCache(FIELDS, 'rec-9')).toBe(4);
    expect(requests.filter((r) => r.method === 'POST' && /\/records\/rec-9\/ai\/cache-clear$/.test(r.url))).toHaveLength(1);
  });

  it('网页版缺 id 时：不去猜着发请求，也不许让界面念成「服务器上本无缓存」——这条只能由调用方给 id', async () => {
    const storageInfo = await import('../data/storageInfo');
    const before = requests.length;
    const removed = await storageInfo.clearChartCache(FIELDS, undefined);
    expect(removed).toBe(0);
    // 判据要点：0 同时是 PersonDetail 里「该盘在服务器上本无缓存」的条件。
    // 这里钉住「没发请求却返回 0」这个事实，逼后续改动区分「没缓存」与「没去查」。
    expect(requests.length, '没 id 却打了服务器(会清错盘或 404)').toBe(before);
    const detailSource = await import('./helpers/offlineSqlLiterals').then((h) => h.src('../../features/person/PersonDetail.tsx'));
    expect(detailSource, '界面把 removed===0 念成「本无缓存」的地方变了，判据要重新对齐')
      .toContain('该盘在服务器上本无缓存');
  });

  it('网页版连通自检：如实说明去哪儿测，不许伪装成一次真失败的探测', async () => {
    const storageInfo = await import('../data/storageInfo');
    const out = await storageInfo.runAiSelfTest();
    expect(out.ok).toBe(false);
    expect(out.message).toContain('网页版');
    expect(/批断分析|问问批断/.test(out.message ?? ''), '得指出可操作的入口').toBe(true);
    // 自检不该发出任何 AI 请求(它只是文案，不是探测)
    expect(requests.filter((r) => /ai\/(task|chat)/.test(r.url))).toHaveLength(0);
  });

  it('服务器报错时 clearChartCache 抛出而不是吞成 0(吞掉就把失败念成「本无缓存」)', async () => {
    fetchShouldFail = true;
    const storageInfo = await import('../data/storageInfo');
    await expect(storageInfo.clearChartCache(FIELDS, 'rec-9')).rejects.toBeTruthy();
  });
});
