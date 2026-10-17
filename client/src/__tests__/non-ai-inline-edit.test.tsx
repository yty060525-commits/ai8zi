import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PersonDetail } from '../features/person/PersonDetail';
import { initializeMockSession, resetMockSession } from '../data/clientRepository';
import { mockPersonDetails } from './fixtures/mockData';

beforeEach(() => {
  const detail = mockPersonDetails[0];
  const person = { ...detail.person, id: detail.record.id };
  initializeMockSession([person], [{ ...detail, person }]);
});
afterEach(() => { cleanup(); resetMockSession(); });

describe('详情非 AI 数据原位编辑', () => {
  it('提供统一编辑入口并移除独立修正四柱入口', async () => {
    render(<PersonDetail personId="zhang-wei-record" onBack={() => {}} />);
    await screen.findByRole('region', { name: '基础信息' });
    expect(screen.queryByRole('button', { name: '修正四柱' })).toBeNull();
    expect(screen.getByRole('button', { name: '编辑数据' })).toBeTruthy();
  });

  it('编辑态在原位置暴露基本信息、派生字段、关系及大运各列', async () => {
    render(<PersonDetail personId="zhang-wei-record" onBack={() => {}} />);
    await screen.findByRole('region', { name: '基础信息' });
    fireEvent.click(screen.getByRole('button', { name: '编辑数据' }));

    for (const name of [
      '姓名', '性别', '出生年', '出生月', '年柱', '公历日期',
      '五行木', '五行比例木', '十二长生年柱', '起运年数', '交运日期', '称骨总重', '称骨年重',
      '藏干年柱', '藏干十神年柱', '十神年柱', '纳音年柱', '大运方向',
      '本命生肖', '人际适配三合', '关系三合', '关系克',
      '大运第一步干支', '大运第九步交运日',
    ]) expect(screen.getByLabelText(name), `缺少原位控件：${name}`).toBeTruthy();
    expect(screen.getAllByLabelText(/矩阵四柱/)).toHaveLength(4);
    expect(screen.queryByLabelText(/神煞/)).toBeNull();
    expect(screen.queryByLabelText(/流年/)).toBeNull();
    expect(screen.queryByLabelText(/流月/)).toBeNull();
  });
});
