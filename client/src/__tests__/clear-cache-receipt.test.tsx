import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

/* 「清除批断结果与缓存」按钮有三句回执(清掉 N 条 / 本无缓存 / 没清掉)，源码注释专门写了
   「谎报已清除会让人以为下次分析必然重算(其实仍会命中旧缓存)」。但真实实现里这三句在测试环境
   永远走不到：storageInfo.clearChartCache 先判 inTauri()，浏览器路没有 recordId 就直接返回 0。
   所以这里把这一个函数换成可控桩，被测对象仍是 PersonDetail 里那段决定文案的代码。

   这个文件自带夹具并整模块桩掉 clientRepository —— 因为要换 storageInfo 就得让 PersonDetail
   重新求值，而 resetModules 会让它拿到一份全新的会话存储；共用别的用例那份内存视图会直接
   「查无此人」(实测踩过)。 */

let clearStub: () => Promise<number>;
vi.mock('../data/storageInfo', () => ({
  clearChartCache: () => clearStub(),
  getStorageStats: vi.fn(async () => ({ records: 0, cacheEntries: null, dbBytes: 0 })),
  compactRecords: vi.fn(async () => 0),
  runAiSelfTest: vi.fn(),
}));
const saved: Record<string, unknown> = {};
vi.mock('../data/clientRepository', () => ({
  getBaziRecord: vi.fn(async (id: string) => (id === 'cache-person' ? clone(fixture) : undefined)),
  saveBaziRecord: vi.fn(async (r: unknown) => { Object.assign(saved, r); return r; }),
  refreshRecord: vi.fn(async (r: unknown) => r),
  listBaziRecords: vi.fn(async () => [clone(fixture)]),
  unsyncedRecordIds: vi.fn(() => []),
}));

type Rec = Record<string, unknown>;
const clone = (v: Rec): Rec => JSON.parse(JSON.stringify(v)) as Rec;

const fixture: Rec = {
  id: 'cache-person', name: '缓存播报', gender: 'male', birthYear: 1990, birthMonth: 1,
  createdAt: '2025-01-01T00:00:00.000Z', yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午',
  aiStatus: 'completed',
  aiTasks: {
    'task-01': { task: { taskId: 'task-01', type: 'baseline' }, status: 'completed', analysis: { pattern: '', strength: '', usefulElements: [], avoidElements: [], explanation: '【健康】注意睡眠。' } },
  },
};

async function openDetail(): Promise<void> {
  const { PersonDetail } = await import('../features/person/PersonDetail');
  render(<PersonDetail personId="cache-person" onBack={vi.fn()} />);
  await screen.findByRole('button', { name: /清除批断结果与缓存/ });
}

beforeEach(() => { clearStub = async () => 0; });
afterEach(() => { cleanup(); vi.resetModules(); });

describe('清除批断结果后的缓存回执必须如实', () => {
  it('服务器删掉了三条 → 播报里带上「三条」', async () => {
    clearStub = async () => 3;
    await openDetail();
    fireEvent.click(screen.getByRole('button', { name: /清除批断结果与缓存/ }));
    await waitFor(() => expect(screen.getByText(/并清掉服务器上三条命中缓存/)).toBeTruthy());
  });

  it('服务器本来一条都没有 → 明说「本无缓存」', async () => {
    clearStub = async () => 0;
    await openDetail();
    fireEvent.click(screen.getByRole('button', { name: /清除批断结果与缓存/ }));
    await waitFor(() => expect(screen.getByText(/该盘在服务器上本无缓存/)).toBeTruthy());
  });

  it('清除请求失败 → 承认「没清掉、下次可能复用旧结果」，不许出现任何成功字样', async () => {
    clearStub = async () => { throw new Error('403'); };
    await openDetail();
    fireEvent.click(screen.getByRole('button', { name: /清除批断结果与缓存/ }));
    await waitFor(() => expect(screen.getByText(/服务器缓存没清掉/)).toBeTruthy());
    expect(document.body.textContent).not.toMatch(/本无缓存|命中缓存/);
  });
});
