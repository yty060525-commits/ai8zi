import { useEffect, useState } from 'react';
import { getServiceStatus, clearServiceCredential, saveServiceCredential, setSelectedService, type ServiceId } from '../../data/aiSettings';
import { compactRecords, getStorageStats, runAiSelfTest, type AiSelfTest } from '../../data/storageInfo';
import { listBaziRecords } from '../../data/clientRepository';
import { exportRecordsSQLite } from '../../data/sqliteExport';

type DisplayStatus = '已配置' | '未配置' | '保存中' | '保存失败';

const services: Array<{ id: ServiceId; label: string }> = [
  { id: 'serviceOne', label: '服务一' },
  { id: 'serviceTwo', label: '服务二' },
];

export function SettingsPage() {
  const [selected, setSelected] = useState<ServiceId>('serviceOne');
  const [statuses, setStatuses] = useState<Record<ServiceId, DisplayStatus>>({ serviceOne: '未配置', serviceTwo: '未配置' });
  const [secret, setSecret] = useState('');
  const [status, setStatus] = useState<DisplayStatus>('未配置');
  const [storage, setStorage] = useState<{ records: number; cache: number; bytes: number } | null>(null);
  const [compacting, setCompacting] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<AiSelfTest | null>(null);
  const [exportNote, setExportNote] = useState<string>();

  useEffect(() => {
    let active = true;
    void getServiceStatus().then((current) => {
      if (!active) return;
      const next = { serviceOne: current.serviceOne === 'configured' ? '已配置' : '未配置', serviceTwo: current.serviceTwo === 'configured' ? '已配置' : '未配置' } as Record<ServiceId, DisplayStatus>;
      setSelected(current.selectedService); setStatuses(next); setStatus(next[current.selectedService]);
    }).catch(() => { if (active) setStatus('保存失败'); });
    return () => { active = false; };
  }, []);
  const refreshStorage = async () => {
    const stats = await getStorageStats();
    setStorage({ records: stats.records, cache: stats.cacheEntries, bytes: stats.dbBytes });
  };
  useEffect(() => {
    let active = true;
    void getStorageStats().then((stats) => { if (active) setStorage({ records: stats.records, cache: stats.cacheEntries, bytes: stats.dbBytes }); }).catch(() => { if (active) setStorage(null); });
    return () => { active = false; };
  }, []);
  async function compress() {
    setCompacting(true);
    try { await compactRecords(); await refreshStorage(); } catch { /* 保留原值 */ }
    finally { setCompacting(false); }
  }
  const downloadBlob = (blob: Blob, name: string) => {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.click();
    URL.revokeObjectURL(url);
  };
  async function exportSQLite() {
    try {
      const records = await listBaziRecords();
      const bytes = await exportRecordsSQLite(records);
      const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      downloadBlob(new Blob([ab], { type: 'application/x-sqlite3' }), 'mingli-data-' + new Date().toISOString().slice(0, 10) + '.sqlite');
      setExportNote('已导出真 SQLite(.sqlite)，共 ' + records.length + ' 条记录——可与桌面版 data\\bazi_records.sqlite3 同构打开。');
    } catch (error) {
      setExportNote('导出失败：' + (error instanceof Error ? error.message : String(error)));
    }
  }
  async function exportJson() {
    try {
      const records = await listBaziRecords();
      downloadBlob(new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), records }, null, 2)], { type: 'application/json' }), 'mingli-data-' + new Date().toISOString().slice(0, 10) + '.json');
      setExportNote('已导出 JSON 备份，共 ' + records.length + ' 条记录。');
    } catch (error) {
      setExportNote('导出失败：' + (error instanceof Error ? error.message : String(error)));
    }
  }
  async function selfTest() {
    setTesting(true); setTestResult(null);
    try { setTestResult(await runAiSelfTest()); } catch (error) { setTestResult({ ok: false, message: error instanceof Error ? error.message : String(error) }); }
    finally { setTesting(false); }
  }

  async function selectService(service: ServiceId) {
    try { await setSelectedService(service); setSelected(service); setStatus(statuses[service]); }
    catch { setStatus('保存失败'); }
  }
  async function save() {
    if (!secret) { setStatus('保存失败'); return; }
    setStatus('保存中');
    try {
      const result = await saveServiceCredential(selected, secret);
      const nextStatus = result === 'configured' ? '已配置' : '未配置';
      setStatuses((current) => ({ ...current, [selected]: nextStatus })); setStatus(nextStatus);
      setSecret('');
    } catch { setStatus('保存失败'); }
  }
  async function clear() {
    try {
      const result = await clearServiceCredential(selected);
      const nextStatus = result === 'configured' ? '已配置' : '未配置';
      setStatuses((current) => ({ ...current, [selected]: nextStatus })); setStatus(nextStatus);
    } catch { setStatus('保存失败'); }
    finally { setSecret(''); }
  }

  return <main className="settings-page">
    <header className="page-heading"><p className="eyebrow">LOCAL SETTINGS</p><h1>设置</h1><p className="page-description">管理内部服务的访问配置。</p></header>
    <section aria-label="服务选择"><h2>当前服务</h2><div className="button-group">{services.map((service) => <button key={service.id} type="button" className={selected === service.id ? 'choice-button selected' : 'choice-button'} onClick={() => void selectService(service.id)} aria-pressed={selected === service.id}>{service.label}</button>)}</div></section>
    <form className="settings-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <label>访问凭据<input aria-label="访问凭据" type="password" autoComplete="off" value={secret} onChange={(event) => setSecret(event.target.value)} /></label>
      <div className="button-group"><button className="primary-button" type="submit">保存</button><button className="text-button" type="button" onClick={() => void clear()}>清除</button></div>
    </form>
    <p className="ai-status" role="status">配置状态：{status}　·　数据库：{storage ? `${storage.records} 条记录 / 缓存 ${storage.cache} 条 / ${(storage.bytes / 1024).toFixed(0)} KB` : '读取中…'}</p>
    <div className="button-group"><button className="text-button" type="button" disabled={compacting || !storage} onClick={() => void compress()}>{compacting ? '压缩中…' : '压缩旧记录（缩小数据库）'}</button><button className="text-button" type="button" disabled={testing} onClick={() => void selfTest()}>{testing ? '自检中…' : 'AI 连通自检（微小消耗）'}</button><button className="text-button" type="button" onClick={() => void exportSQLite()}>导出数据库(.sqlite)</button><button className="text-button" type="button" onClick={() => void exportJson()}>导出JSON备份</button></div>
    {exportNote && <p role="status">{exportNote}</p>}
    {testResult && <p role="status">{testResult.ok ? `自检通过：${testResult.provider} · ${testResult.model} · ${testResult.latencyMs ?? ''}ms · 回复“${testResult.reply ?? ''}”` : `自检失败：${testResult.message ?? '未知错误'}`}</p>}
    {testResult && <button className="text-button" type="button" onClick={() => setTestResult(null)}>关闭自检结果</button>}
  </main>;
}