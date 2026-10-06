import { useEffect, useMemo, useRef, useState } from 'react';
import { exportableRecords, listBaziRecords, syncAdminAll, unsyncedRecordIds } from '../../data/clientRepository';
import { exportRecordsSQLite, exportRecordsSQLText } from '../../data/sqliteExport';
import { getServerSession, isServerMode } from '../../data/serverClient';
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

/* 列表里所有可见文案一律读成中文：阿拉伯数字、间隔号、箭头、半角括号在正式版口径下都算
   算法痕迹，与英文字段名同级。cnCount 只覆盖到二十(人数/序号够用)，年份走逐位读。
   词表在 shared/chineseReadAloud，与详情页/设置页同源，不再各抄一份。 */
import { cnCount, cnSmall, cnYear } from '../../shared/chineseReadAloud';
import { readableName } from '../../data/chatEngine';

/** 「1990-01-01」→「一九九〇年一月一日」；不是这个形态就原样返回。
 *  ⚠ 与 PersonDetail 那份 cnDate 是**同一套读法**的两份实现(缺陷 #96 的教训：月/日要走
 *  cnSmall 规范读法，用 cnCount 会把「二十三日」念成「二三日」)。date-reading-parity.test.tsx
 *  同时渲染两端并比对字符串，任一侧单独改动就会红。 */
const cnDate = (iso: string): string => {
  const m = /^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?/.exec(String(iso ?? '').trim());
  if (!m) return String(iso ?? '');
  return `${cnYear(+m[1])}年${cnSmall(+m[2])}月${m[3] ? cnSmall(+m[3]) + '日' : ''}`;
};

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
  /* 「全选」的范围必须是**当前看得见的那几条**，不是 records(全部)。
     旧实现按 records.length 判满、按 records 增删：搜索框留着关键字时按钮写着「全选当前一条」，
     点下去却把没显示的两个人也一起选进导出名单 —— 文案与实现相反(缺陷 #91，实测读数见
     records-select-all-scope.test.tsx)。可见集是 records 的子集，所以「可见的全在选中里」
     就是这一轮该取消的满态；不可见的勾选原样保留。 */
  const visibleIds = useMemo(() => visibleRecords.map((record) => record.id), [visibleRecords]);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id));
  const toggleAll = () => setSelectedIds((current) => {
    if (allVisibleSelected) { const next = new Set(current); for (const id of visibleIds) next.delete(id); return next; }
    return new Set([...current, ...visibleIds]);
  });
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
        showNote('已导出所选' + cnCount(chosenRecords.length) + '人的备份文件，可在设置页导入还原。');
      } else if (kind === 'sql') {
        const text = exportRecordsSQLText(payloadRecords);
        downloadBlob(new Blob([text], { type: 'text/plain;charset=utf-8' }), 'mingli-export-' + date + '.sql');
        showNote('已导出所选' + cnCount(chosenRecords.length) + '人的结构化文本，可用任何文本工具打开。');
      } else {
        const bytes = await exportRecordsSQLite(payloadRecords);
        const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        downloadBlob(new Blob([ab], { type: 'application/x-sqlite3' }), 'mingli-export-' + date + '.sqlite');
        showNote('已导出所选' + cnCount(chosenRecords.length) + '人的数据库文件，每人整条记录完整保存，可在设置页导入还原。');
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
        <p className="eyebrow">本机档案库</p>
        <h1>记录</h1>
        <p className="page-description">管理已经保存的出生与四柱记录。{adminScope ? '管理员视角：本列表为服务器全部账号记录，含账号名。' : '登录服务器后自动同步。'}</p>
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
            按姓名{descending ? '倒序' : '正序'}
          </button>
          {/* 搜索框里留着关键字时，「全选」只勾得到当前可见的几条，所以把范围写进标签，
              免得用户以为选中了全部记录却只导出了一小撮。满态判断同样按可见集(allVisibleSelected)：
              以前这里比的是 selectedIds.size === records.length，过滤态永远等不到「取消全选」，
              于是按钮一直说「全选当前一条」而点下去是在清空 —— 同一处缺陷的另一半。 */}
          <button className="text-button tiny" type="button" onClick={toggleAll}>{allVisibleSelected && visibleIds.length > 0 ? '取消全选' : query.trim() && visibleRecords.length ? '全选当前' + cnCount(visibleRecords.length) + '条' : '全选'}</button>
        </div>
      </div>

      <div className="records-selectbar" aria-label="批量导出">
        <span className="select-summary">{records.length > 0 ? '已选' + cnCount(selectedIds.size) + '人，共' + cnCount(records.length) + '人' : '暂无记录'}</span>
        {/* 以前没勾选时按钮直接禁用：点下去没有任何反应，也没有一句提示，用户只能猜。
            现在按钮保持可点，点了给一句「先勾人」的话术。 */}
        <button className="primary-button export-selected" type="button" disabled={exporting} onClick={() => void openPanel()}>
          {'导出勾选，已选' + cnCount(selectedIds.size) + '人'}
        </button>
        {selectedIds.size > 0 && <button className="text-button tiny" type="button" onClick={() => setSelectedIds(new Set())}>清空勾选</button>}
        <span className="copy-help">提示：点小方格左侧的小方框勾选人物，可多选，再点导出勾选在弹出的面板里确认后导出。</span>
      </div>
      {exportNote && <p role="status">{exportNote}</p>}

      {visibleRecords.length > 0 ? (
        <div className="records-grid" role="list" aria-label="人物记录">
          {visibleRecords.map((record) => {
            const checked = selectedIds.has(record.id);
            return (
              <div className="person-item" key={record.id}>
                <label className="records-check" title={checked ? '取消勾选' : '勾选后可按导出'}>
                  <input type="checkbox" aria-label={'选择' + readableName(record.name)} checked={checked} onChange={() => toggleSelected(record.id)} />
                </label>
                <button className="person-open" type="button" onClick={() => onOpenPerson(record.id)} aria-label={'查看' + readableName(record.name)} title={record.name}>
                  <strong>{readableName(record.name)}</strong>
                  <span className={'gender gender-' + record.gender}>{record.gender === 'male' ? '男' : '女'}</span>
                  <span className="birth-summary">{cnYear(record.birthYear)}年{cnCount(record.birthMonth)}月；{record.yearPillar}年、{record.monthPillar}月、{record.dayPillar}日、{record.hourPillar}时</span>
                  {/* 管理员看的是全服务器所有账号的盘：不标所属账号，同名记录分不清是谁的。
                      用户名是登录时填的机器串(可含字母数字)，直接印进正文就违反「只能中文」口径，
                      所以界面上只说「他人建的盘」，完整账号放进 title 供核对。 */}
                  {adminScope && record.username && <span className="owner-tag" title={'账号：' + record.username}>账号归属见悬浮说明</span>}
                  {/* 生肖按「年柱地支」(立春口径)现算，不读存量 nonAiResult.zodiac：
                      旧盘里那个字段是库按春节(正月初一)切的，立春后·春节前出生会存成与年柱相矛盾的属相
                      (实测 2024-02-06 甲辰年却显示「生肖 兔」，与同一行左侧「甲辰年」自相矛盾)。
                      年柱缺失时才回退存量值。 */}
                  {record.nonAiResult && <span className="chart-summary">公历{cnDate(record.nonAiResult.solarDate)}，生肖{zodiacOfBranch(record.yearPillar?.[1] ?? '') || record.nonAiResult.zodiac}，日主{record.nonAiResult.dayMaster}</span>}
                  <span className="ai-status">批断：{record.aiStatus === 'completed' ? '已完成' : record.aiStatus === 'not_configured' ? '未配置' : record.aiStatus === 'failed' ? '失败' : record.aiStatus === 'pending' ? '分析中' : '未开始'}</span>
                  {/* 还没推上服务器的盘：不标出来，用户会先在同机「问问批断」上撞到「还没有任何命盘」。 */}
                  {unsynced.has(record.id) && <span className="ai-status unsynced">未同步，仅存本机。提问前先在设置里登录服务器</span>}
                  <span className="row-action">查看</span>
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
            <p className="copy-help">每个人导出为一条完整记录，含基础信息、排盘数据、全部批断结果与当时的语气档。可导出数据库文件、结构化文本、备份文件三种，导入回来可完整还原。取消某人的勾选则不带入文件。</p>
            {selectedRecords.length === 0 && <p role="status">还没有勾选人物，请回到列表勾选后再来。</p>}
            <ul className="export-person-list">
              {selectedRecords.map((record) => {
                const on = includedIds.has(record.id);
                return (
                  <li key={record.id}>
                    <label className="checkbox-label">
                      <input type="checkbox" aria-label={'包含' + readableName(record.name)} checked={on} onChange={() => setIncludedIds((current) => { const next = new Set(current); if (next.has(record.id)) next.delete(record.id); else next.add(record.id); return next; })} />
                      <span><strong>{readableName(record.name)}</strong>，{cnYear(record.birthYear)}年{cnCount(record.birthMonth)}月，{record.yearPillar}、{record.monthPillar}、{record.dayPillar}、{record.hourPillar}，批断{record.aiStatus === 'completed' ? '已完成' : record.aiStatus === 'not_configured' ? '未配置' : record.aiStatus === 'failed' ? '失败' : record.aiStatus === 'pending' ? '分析中' : '未开始'}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
            <div className="button-group">
              <button className="primary-button" type="button" disabled={chosenRecords.length === 0 || exporting} onClick={() => void doExport('sqlite')}>{exporting ? '导出中' : '导出数据库文件，共' + cnCount(chosenRecords.length) + '人'}</button>
              <button className="text-button" type="button" disabled={chosenRecords.length === 0 || exporting} onClick={() => void doExport('sql')}>导出结构化文本</button>
              <button className="text-button" type="button" disabled={chosenRecords.length === 0 || exporting} onClick={() => void doExport('json')}>导出备份文件</button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
