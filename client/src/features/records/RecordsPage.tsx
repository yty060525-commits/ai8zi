import { useEffect, useMemo, useRef, useState } from 'react';
import { listBaziRecords, syncAdminAll } from '../../data/clientRepository';
import { getServerSession, isServerMode } from '../../data/serverClient';
import type { BaziRecord } from '../../types/domain';

interface RecordsPageProps {
  onOpenPerson: (personId: string) => void;
  refreshKey?: number;
}

export function RecordsPage({ onOpenPerson, refreshKey = 0 }: RecordsPageProps) {
  const [query, setQuery] = useState('');
  const [descending, setDescending] = useState(false);
  const [records, setRecords] = useState<BaziRecord[]>([]);
  const latestRequest = useRef(0);
  const adminScope = isServerMode() && getServerSession()?.role === 'admin';
  useEffect(() => {
    const request = ++latestRequest.current;
    let mounted = true;
    const readRecords = async () => {
      try {
        if (adminScope) await syncAdminAll();
        const nextRecords = await listBaziRecords();
        // A refresh can start before the previous adapter read resolves. Only
        // the most recent read is allowed to publish its snapshot.
        if (mounted && request === latestRequest.current) setRecords(nextRecords);
      } catch {
        // Keep the last usable snapshot when an adapter read fails.
      }
    };
    void readRecords();
    return () => { mounted = false; };
  }, [refreshKey]);
  const visibleRecords = useMemo(() => records
    .filter((record) => record.name.includes(query.trim()))
    .sort((left, right) => {
      const result = left.name.localeCompare(right.name);
      return descending ? -result : result;
    }), [records, query, descending]);

  return (
    <main className="records-page">
      <header className="page-heading">
        <p className="eyebrow">LOCAL DIRECTORY</p>
        <h1>记录</h1>
        <p className="page-description">管理已经保存的出生与四柱记录。{adminScope ? '（管理员：本列表为服务器全部账号记录，含账号名）' : '（登录服务器后自动同步）'}</p>
      </header>

      <div className="records-toolbar">
        <label className="search-field">
          搜索姓名
          <input
            type="search"
            aria-label="搜索姓名"
            placeholder="输入姓名"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <button className="sort-button" type="button" onClick={() => setDescending((value) => !value)}>
          按姓名排序 {descending ? '↓' : '↑'}
        </button>
      </div>

      {visibleRecords.length > 0 ? (
        <div className="records-grid" role="list" aria-label="人物记录">
          {visibleRecords.map((record) => (
            <button className="person-item" type="button" key={record.id} onClick={() => onOpenPerson(record.id)} aria-label={`查看${record.name}`}>
              <strong>{record.name}</strong>
              <span className={`gender gender-${record.gender}`}>{record.gender === 'male' ? '男' : '女'}</span>
              <span className="birth-summary">{record.birthYear}年 {record.birthMonth}月 · {record.yearPillar}年 {record.monthPillar}月 {record.dayPillar}日 {record.hourPillar}时</span>
              {record.nonAiResult && <span className="chart-summary">公历 {record.nonAiResult.solarDate} · 生肖 {record.nonAiResult.zodiac} · 日主 {record.nonAiResult.dayMaster}</span>}
              <span className="ai-status">AI：{record.aiStatus === 'completed' ? '已完成' : record.aiStatus === 'not_configured' ? '未配置' : record.aiStatus === 'failed' ? '失败' : record.aiStatus === 'pending' ? '分析中' : '未开始'}</span>
              <span className="row-action">查看 →</span>
            </button>
          ))}
        </div>
      ) : <><div className="records-grid" role="list" aria-label="人物记录" />
        <p className="empty-records" role="status">{records.length === 0 ? '还没有保存任何记录' : '没有找到匹配的记录'}</p></>}
    </main>
  );
}