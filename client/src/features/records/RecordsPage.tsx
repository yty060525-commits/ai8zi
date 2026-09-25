import { useEffect, useMemo, useRef, useState } from 'react';
import { exportableRecords, listBaziRecords, syncAdminAll, unsyncedRecordIds } from '../../data/clientRepository';
import { exportRecordsSQLite, exportRecordsSQLText } from '../../data/sqliteExport';
import { getServerSession, isServerMode } from '../../data/serverClient';
import { aiStatusText } from '../../data/baziOrchestrator';
import { zodiacOfBranch } from '../../utils/interpersonal';
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
  const [unsynced, setUnsynced] = useState<Set<string>>(new Set());
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
        if (mounted && request === latestRequest.current) { setRecords(nextRecords); setUnsynced(new Set(unsyncedRecordIds())); }
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

  const openPanel = () => {
    if (selectedIds.size === 0) { showNote('还没有勾选人物：先在下面列表里点小方框勾上要导出的人，再点这个按钮。'); return; }
    setIncludedIds(new Set(selectedIds)); setPanelOpen(true);
  };
  const doExport = async (kind: 'sqlite' | 'sql' | 'json') => {
    if (chosenRecords.length === 0) { showNote('请先勾选至少一位人物再导出。'); return; }
      // 存储是瘦身的：导出前还原成完整盘，分享出去的文件才可自解释
      const full = await exportableRecords();
      const byId = new Map(full.map((r) => [r.id, r]));
      const payloadRecords = chosenRecords.map((r) => byId.get(r.id) ?? r);
    setExporting(true);
    try {
      const date = stamp();
      if (kind === 'json') {
        downloadBlob(new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), records: payloadRecords }, null, 2)], { type: 'application/json' }), 'mingli-export-' + date + '.json');
        showNote('已导出所选 ' + chosenRecords.length + ' 人的 JSON 备份。');
      } else if (kind === 'sql') {
        const text = exportRecordsSQLText(payloadRecords);
        downloadBlob(new Blob([text], { type: 'text/plain;charset=utf-8' }), 'mingli-export-' + date + '.sql');
        showNote('已导出所选 ' + chosenRecords.length + ' 人的 SQL 文本(.sql)，可在任何文本工具/数据库软件打开。');
      } else {
        const bytes = await exportRecordsSQLite(payloadRecords);
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
          {/* 搜索框里留着关键字时，「全选」只勾得到当前可见的几条，但按钮说的是「全选」。
              这里把范围写进标签，免得用户以为选中了全部记录却只导出了一小撮。 */}
          <button className="text-button tiny" type="button" onClick={toggleAll}>{selectedIds.size === records.length && records.length > 0 ? '取消全选' : query.trim() && visibleRecords.length ? '全选当前 ' + visibleRecords.length + ' 条' : '全选'}</button>
        </div>
      </div>

      <div className="records-selectbar" aria-label="批量导出">
        <span className="select-summary">{records.length > 0 ? '已选 ' + selectedIds.size + ' / ' + records.length + ' 人' : '暂无记录'}</span>
        {/* 以前没勾选时按钮直接禁用：点下去没有任何反应，也没有一句提示，用户只能猜。
            现在按钮保持可点，点了给一句「先勾人」的话术。 */}
        <button className="primary-button export-selected" type="button" disabled={exporting} onClick={() => void openPanel()}>
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
                  {/* 管理员看的是全服务器所有账号的盘：不标所属账号，同名记录分不清是谁的。 */}
                  {adminScope && record.username && <span className="owner-tag">账号：{record.username}</span>}
                  {/* 生肖按「年柱地支」(立春口径)现算，不读存量 nonAiResult.zodiac：
                      旧盘里那个字段是库按春节(正月初一)切的，立春后·春节前出生会存成与年柱相矛盾的属相
                      (实测 2024-02-06 甲辰年却显示「生肖 兔」，与同一行左侧「甲辰年」自相矛盾)。
                      年柱缺失时才回退存量值。 */}
                  {record.nonAiResult && <span className="chart-summary">公历 {record.nonAiResult.solarDate} · 生肖 {zodiacOfBranch(record.yearPillar?.[1] ?? '') || record.nonAiResult.zodiac} · 日主 {record.nonAiResult.dayMaster}</span>}
                  <span className="ai-status">AI：{record.aiStatus === 'pending' ? aiStatusText(record) : record.aiStatus === 'completed' ? '已完成' : record.aiStatus === 'not_configured' ? '未配置' : record.aiStatus === 'failed' ? '失败' : '未开始'}</span>
                  {/* 还没推上服务器的盘：不标出来，用户会先在同机「问问 AI」上撞到「还没有任何命盘」。 */}
                  {unsynced.has(record.id) && <span className="ai-status unsynced">未同步：仅存本机，问 AI 前先在设置里登录服务器</span>}
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
            <p className="copy-help">每个人导出为一条完整记录（基础信息＋排盘数据＋全部 AI 结果＋当时的语气档），可导出 .sqlite / .sql 文本 / .json 三种，导入回来可完整还原。取消某人的勾选则不带入文件。</p>
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
