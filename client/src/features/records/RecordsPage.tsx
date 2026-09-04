import { useEffect, useMemo, useRef, useState } from 'react';
import { listBaziRecords, syncAdminAll } from '../../data/clientRepository';
import { exportRecordsSQLite, exportRecordsSQLText } from '../../data/sqliteExport';
import { getServerSession, isServerMode } from '../../data/serverClient';
import type { BaziRecord } from '../../types/domain';

interface RecordsPageProps {
  onOpenPerson: (personId: string) => void;
  refreshKey?: number;
}

const downloadBlob = (blob: Blob, name: string) => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
};
const stamp = () => new Date().toISOString().slice(0, 10);

export function RecordsPage({ onOpenPerson, refreshKey = 0 }: RecordsPageProps) {
  const [query, setQuery] = useState('');
  const [descending, setDescending] = useState(false);
  const [records, setRecords] = useState<BaziRecord[]>([]);
  const latestRequest = useRef(0);
  const adminScope = isServerMode() && getServerSession()?.role === 'admin';
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [panelOpen, setPanelOpen] = useState(false);
  const [includedIds, setIncludedIds] = useState<Set<string>>(new Set());
  const [exportNote, setExportNote] = useState<string>();
  const [exporting, setExporting] = useState(false);
  const noteTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => { if (noteTimer.current) clearTimeout(noteTimer.current); }, []);

  useEffect(() => {
    const request = ++latestRequest.current;
    let mounted = true;
    const readRecords = async () => {
      try {
        if (adminScope) await syncAdminAll();
        const nextRecords = await listBaziRecords();
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

  const showNote = (text: string) => {
    setExportNote(text);
    if (noteTimer.current) clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => setExportNote(undefined), 4000);
  };
  const toggleSelected = (id: string) => setSelectedIds((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const toggleAll = () => setSelectedIds((current) => current.size === records.length ? new Set() : new Set(records.map((r) => r.id)));
  const selectedRecords = useMemo(() => records.filter((r) => selectedIds.has(r.id)), [records, selectedIds]);
  const chosenRecords = useMemo(() => records.filter((r) => includedIds.has(r.id)), [records, includedIds]);

  const openPanel = () => { setIncludedIds(new Set(selectedIds)); setPanelOpen(true); };
  const doExport = async (kind: 'sqlite' | 'sql' | 'json') => {
    if (chosenRecords.length === 0) { showNote('请先勾选至少一位人物再导出。'); return; }
    setExporting(true);
    try {
      const date = stamp();
      if (kind === 'json') {
        downloadBlob(new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), records: chosenRecords }, null, 2)], { type: 'application/json' }), 'mingli-export-' + date + '.json');
        showNote('已导出所选 ' + chosenRecords.length + ' 人的 JSON 备份。');
      } else if (kind === 'sql') {
        const text = exportRecordsSQLText(chosenRecords);
        downloadBlob(new Blob([text], { type: 'text/plain;charset=utf-8' }), 'mingli-export-' + date + '.sql');
        showNote('已导出所选 ' + chosenRecords.length + ' 人的 SQL 文本(.sql)，可在任何文本工具/数据库软件打开。');
      } else {
        const bytes = await exportRecordsSQLite(chosenRecords);
        const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        downloadBlob(new Blob([ab], { type: 'application/x-sqlite3' }), 'mingli-export-' + date + '.sqlite');
        showNote('已导出所选 ' + chosenRecords.length + ' 人的 SQLite(.sqlite)，每人整条记录完整保存，可在设置页导入还原。');
      }
      setPanelOpen(false);
    } catch (error) {
      showNote('导出失败：' + (error instanceof Error ? error.message : String(error)));
    } finally {
      setExporting(false);
    }
  };

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
        <div className="toolbar-buttons">
          <button className="sort-button" type="button" onClick={() => setDescending((value) => !value)}>
            按姓名排序 {descending ? '↓' : '↑'}
          </button>
          <button className="text-button tiny" type="button" onClick={toggleAll}>{selectedIds.size === records.length && records.length > 0 ? '取消全选' : '全选'}</button>
        </div>
      </div>

      <div className="records-selectbar" aria-label="批量导出">
        <span className="select-summary">{records.length > 0 ? '已选 ' + selectedIds.size + ' / ' + records.length + ' 人' : '暂无记录'}</span>
        <button className="primary-button export-selected" type="button" disabled={selectedIds.size === 0 || exporting} onClick={() => void openPanel()}>
          {'导出勾选（' + selectedIds.size + '）…'}
        </button>
        {selectedIds.size > 0 && <button className="text-button tiny" type="button" onClick={() => setSelectedIds(new Set())}>清空勾选</button>}
        <span className="copy-help">提示：点小方格左上角的小方框勾选人物（可多选），再点“导出勾选”在弹出的面板里确认后导出。</span>
      </div>
      {exportNote && <p role="status">{exportNote}</p>}

      {visibleRecords.length > 0 ? (
        <div className="records-grid" role="list" aria-label="人物记录">
          {visibleRecords.map((record) => {
            const checked = selectedIds.has(record.id);
            return (
              <div className="person-item" key={record.id}>
                <label className="records-check" title={checked ? '取消勾选' : '勾选后可按导出'}>
                  <input type="checkbox" aria-label={'选择' + record.name} checked={checked} onChange={() => toggleSelected(record.id)} />
                </label>
                <button className="person-open" type="button" onClick={() => onOpenPerson(record.id)} aria-label={'查看' + record.name}>
                  <strong>{record.name}</strong>
                  <span className={'gender gender-' + record.gender}>{record.gender === 'male' ? '男' : '女'}</span>
                  <span className="birth-summary">{record.birthYear}年 {record.birthMonth}月 · {record.yearPillar}年 {record.monthPillar}月 {record.dayPillar}日 {record.hourPillar}时</span>
                  {record.nonAiResult && <span className="chart-summary">公历 {record.nonAiResult.solarDate} · 生肖 {record.nonAiResult.zodiac} · 日主 {record.nonAiResult.dayMaster}</span>}
                  <span className="ai-status">AI：{record.aiStatus === 'completed' ? '已完成' : record.aiStatus === 'not_configured' ? '未配置' : record.aiStatus === 'failed' ? '失败' : record.aiStatus === 'pending' ? '分析中' : '未开始'}</span>
                  <span className="row-action">查看 →</span>
                </button>
              </div>
            );
          })}
        </div>
      ) : <><div className="records-grid" role="list" aria-label="人物记录" />
        <p className="empty-records" role="status">{records.length === 0 ? '还没有保存任何记录' : '没有找到匹配的记录'}</p></>}

      {panelOpen && (
        <div className="modal-backdrop" onClick={() => { if (!exporting) setPanelOpen(false); }}>
          <div className="modal" role="dialog" aria-label="导出勾选的人物" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header"><h2>导出勾选的人物</h2><button className="text-button" type="button" onClick={() => setPanelOpen(false)}>关闭</button></div>
            <p className="copy-help">每个人导出为一条完整记录（基础信息＋排盘数据＋全部 AI 结果），可导出 .sqlite / .sql 文本 / .json 三种，导入回来可完整还原。取消某人的勾选则不带入文件。</p>
            {selectedRecords.length === 0 && <p role="status">还没有勾选人物，请回到列表勾选后再来。</p>}
            <ul className="export-person-list">
              {selectedRecords.map((record) => {
                const on = includedIds.has(record.id);
                return (
                  <li key={record.id}>
                    <label className="checkbox-label">
                      <input type="checkbox" aria-label={'包含' + record.name} checked={on} onChange={() => setIncludedIds((current) => { const next = new Set(current); if (next.has(record.id)) next.delete(record.id); else next.add(record.id); return next; })} />
                      <span><strong>{record.name}</strong> · {record.birthYear}年{record.birthMonth}月 · {record.yearPillar} {record.monthPillar} {record.dayPillar} {record.hourPillar} · AI {record.aiStatus === 'completed' ? '已完成' : record.aiStatus}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
            <div className="button-group">
              <button className="primary-button" type="button" disabled={chosenRecords.length === 0 || exporting} onClick={() => void doExport('sqlite')}>{exporting ? '导出中…' : '导出 SQL(.sqlite) ' + chosenRecords.length + ' 人'}</button>
              <button className="text-button" type="button" disabled={chosenRecords.length === 0 || exporting} onClick={() => void doExport('sql')}>导出 SQL 文本(.sql)</button>
              <button className="text-button" type="button" disabled={chosenRecords.length === 0 || exporting} onClick={() => void doExport('json')}>导出 JSON 备份</button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
