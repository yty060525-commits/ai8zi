import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RecordsPage } from '../features/records/RecordsPage';
import { configureBaziRepository, initializeMockSession, memoryBaziRepository, resetMockSession } from '../data/clientRepository';
import { mockPeople, mockPersonDetails } from './fixtures/mockData';
import type { BaziRecord } from '../types/domain';

describe('RecordsPage', () => {
  beforeEach(() => initializeMockSession(mockPeople, mockPersonDetails));
  afterEach(() => { cleanup(); configureBaziRepository(memoryBaziRepository); resetMockSession(); });

  it('renders an explicit empty state without placeholder people', () => {
    resetMockSession();
    render(<RecordsPage onOpenPerson={vi.fn()} />);

    expect(screen.getByRole('status').textContent).toContain('还没有保存任何记录');
    expect(screen.queryByText(/张伟|李明|王芳/)).toBeNull();
    expect(screen.getByRole('list', { name: '人物记录' })).toBeTruthy();
  });

  it('searches by name without category filters', async () => {
    render(<RecordsPage onOpenPerson={vi.fn()} />);

    await waitFor(() => expect(screen.getByText('张伟')).toBeTruthy());
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索姓名' }), { target: { value: '芳' } });
    expect(screen.getByText('王芳')).toBeTruthy();
    expect(screen.queryByText('张伟')).toBeNull();
  });

  it('sorts by initial and name, and opens a person', async () => {
    const onOpenPerson = vi.fn();
    render(<RecordsPage onOpenPerson={onOpenPerson} />);

    await waitFor(() => expect(screen.getAllByRole('button', { name: /查看/ })).toHaveLength(3));
    fireEvent.click(screen.getByRole('button', { name: /按姓名排序/ }));
    const items = screen.getAllByRole('button', { name: /查看/ });
    expect(items[0].textContent).toContain('张伟');

    fireEvent.click(screen.getByRole('button', { name: /按姓名排序/ }));
    expect(screen.getAllByRole('button', { name: /查看/ })[0].textContent).toContain('李明');

    fireEvent.click(screen.getByRole('button', { name: /查看李明/ }));
    expect(onOpenPerson).toHaveBeenCalledWith('li-ming');
  });

  it('renders people in a semantic grid of person items', async () => {
    render(<RecordsPage onOpenPerson={vi.fn()} />);

    await waitFor(() => expect(screen.getAllByRole('button', { name: /查看/ })).toHaveLength(3));
    const grid = screen.getByRole('list', { name: '人物记录' });
    expect(grid.classList.contains('records-grid')).toBe(true);
    expect(grid.querySelectorAll('.person-item')).toHaveLength(3);
    const firstItem = Array.from(grid.querySelectorAll('.person-item'))
      .find((item) => item.textContent?.includes('张伟'));
    expect(firstItem?.textContent).toContain('张伟');
    expect(firstItem?.textContent).toContain('男');
    expect(firstItem?.textContent).toContain('甲子年');
    expect(firstItem?.textContent).toContain('壬午时');
    expect(firstItem?.textContent).toContain('AI：已完成');
    expect(firstItem?.textContent).not.toMatch(/DeepSeek|模型|厂商|额度|费用/);
  });

  it('shows pending AI analysis as 分析中', async () => {
    render(<RecordsPage onOpenPerson={vi.fn()} />);

    await waitFor(() => expect(screen.getByText('王芳')).toBeTruthy());
    const pendingItem = screen.getByRole('button', { name: '查看王芳' });
    expect(pendingItem.textContent).toContain('AI：分析中');
    expect(pendingItem.textContent).not.toContain('AI：未开始');
  });

  it('shows the 立春 zodiac (derived from year pillar), not a stale stored zodiac, for legacy records', async () => {
    // 旧引擎把生肖按春节(正月初一)存成「兔」，但年柱甲辰(辰=龙)属立春口径——两者本就该一致。
    // 列表一行同时显示「甲辰年」和「生肖 X」，若直接读存量 nonAiResult.zodiac 就会自相矛盾。
    const legacy = {
      id: 'legacy-chen', name: '甲辰', gender: 'male', birthYear: 2024, birthMonth: 2,
      createdAt: '2025-01-01T00:00:00.000Z', yearPillar: '甲辰', monthPillar: '丙寅', dayPillar: '庚子', hourPillar: '壬午',
      aiStatus: 'not_started',
      // greatFortunes 非空 → isPruned=false → 不触发按当前引擎重算，存量的假「兔」才会原样进渲染，正是我要证明被纠正的场景。
      nonAiResult: { pillars: { year: '甲辰', month: '丙寅', day: '庚子', hour: '壬午' }, solarDate: '2024-02-06', lunarDate: '甲辰年正月初六', zodiac: '兔', dayMaster: '庚', relationships: { sanHe: [], liuHe: [], chong: [], xing: [], hai: [], po: [], ke: [] }, greatFortunes: [{ ganZhi: '丁卯', startYear: 2033, endYear: 2042, relationships: { sanHe: [], liuHe: [], chong: [], xing: [], hai: [], po: [], ke: [] } }], annualFortunes: [], monthlyFortunes: [] },
    } as unknown as BaziRecord;
    configureBaziRepository({ ...memoryBaziRepository, listBaziRecords: async () => [legacy] });
    render(<RecordsPage onOpenPerson={vi.fn()} />);

    await waitFor(() => expect(screen.getByText('甲辰')).toBeTruthy());
    const row = screen.getByRole('button', { name: '查看甲辰' });
    expect(row.textContent).toContain('甲辰年');   // 年柱(立春)
    expect(row.textContent).toContain('生肖 龙');  // 与年支辰一致
    expect(row.textContent).not.toContain('生肖 兔'); // 存量假值不得再显示
  });

  it('publishes only the newest asynchronous refresh result', async () => {
    const reads: Array<(records: BaziRecord[]) => void> = [];
    configureBaziRepository({
      ...memoryBaziRepository,
      listBaziRecords: () => new Promise((resolve) => reads.push(resolve)),
    });
    const { rerender } = render(<RecordsPage onOpenPerson={vi.fn()} refreshKey={0} />);
    const fresh = await memoryBaziRepository.saveBaziRecord({
      id: 'fresh', name: '刚保存', gender: 'male', birthYear: 2001, birthMonth: 2, createdAt: '2025-01-01T00:00:00.000Z',
      yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午', aiStatus: 'pending',
    });
    rerender(<RecordsPage onOpenPerson={vi.fn()} refreshKey={1} />);

    reads[0]?.([]);
    await waitFor(() => expect(screen.queryByText('刚保存')).toBeNull());
    reads[1]?.([fresh]);
    expect(await screen.findByText('刚保存')).toBeTruthy();
  });
});
