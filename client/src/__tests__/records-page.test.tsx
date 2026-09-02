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
