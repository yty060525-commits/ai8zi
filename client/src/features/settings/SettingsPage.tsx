import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { getServiceStatus, clearServiceCredential, saveServiceCredential, setSelectedService, serviceProvider, serviceOf, PROVIDER_LABEL, type ServiceId } from '../../data/aiSettings';
import { compactRecords, getStorageStats, runAiSelfTest, type AiSelfTest } from '../../data/storageInfo';
import { exportableRecords, reloadLocalForSession } from '../../data/clientRepository';
import { exportRecordsSQLite, exportRecordsSQLText } from '../../data/sqliteExport';
import { importRecords, parseBackupFile, type ImportMode } from '../../data/sqlImport';
import { apiAuth, getServerSession, getServerUrl, setServerSession, setServerUrl, type ServerSession } from '../../data/serverClient';
import { BUILD_ID, buildLabel, cacheLabel } from '../../utils/buildInfo';

type DisplayStatus = '已配置' | '未配置' | '保存中' | '保存失败';

const services: Array<{ id: ServiceId; label: string }> = [
  { id: 'serviceOne', label: 'DeepSeek' },
  { id: 'serviceTwo', label: 'Kimi' },
  { id: 'serviceThree', label: 'Qwen3.8-Flash' },
];

export function SettingsPage() {
  const [statuses, setStatuses] = useState<Record<ServiceId, DisplayStatus>>({ serviceOne: '未配置', serviceTwo: '未配置', serviceThree: '未配置' });
  const [secrets, setSecrets] = useState<Record<ServiceId, string>>({ serviceOne: '', serviceTwo: '', serviceThree: '' });
  const [busyService, setBusyService] = useState<ServiceId | null>(null);
  const [currentProvider, setCurrentProvider] = useState<'deepseek' | 'kimi' | 'qwen'>('deepseek');
  const [switching, setSwitching] = useState(false);
  const [notice, setNotice] = useState<Partial<Record<ServiceId, string>>>({});
  const [status, setStatus] = useState<DisplayStatus>('未配置');
  const [storage, setStorage] = useState<{ records: number; cache: number; bytes: number } | null>(null);
  const [compacting, setCompacting] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<AiSelfTest | null>(null);
  const [exportNote, setExportNote] = useState<string>();
  const [importMode, setImportMode] = useState<ImportMode>('overwrite');
  const [importNote, setImportNote] = useState<string>();
  const [importing, setImporting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [serverUrl, setUrl] = useState<string>(() => getServerUrl());
  const [srvUser, setSrvUser] = useState('');
  const [srvPw, setSrvPw] = useState('');
  const [srvBusy, setSrvBusy] = useState(false);
  const [srvMsg, setSrvMsg] = useState<string>();
  const [session, setSession] = useState<ServerSession | null>(() => getServerSession());

  useEffect(() => {
    let active = true;
    void getServiceStatus().then((current) => {
      if (!active) return;
      setStatuses({
        serviceOne: current.serviceOne === 'configured' ? '已配置' : '未配置',
        serviceTwo: current.serviceTwo === 'configured' ? '已配置' : '未配置',
        serviceThree: current.serviceThree === 'configured' ? '已配置' : '未配置',
      });
      setCurrentProvider(serviceProvider(current.selectedService));
    }).catch(() => { if (active) setStatuses({ serviceOne: '保存失败', serviceTwo: '保存失败', serviceThree: '保存失败' }); });
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
      const records = await exportableRecords();
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
      const records = await exportableRecords();
      downloadBlob(new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), records }, null, 2)], { type: 'application/json' }), 'mingli-data-' + new Date().toISOString().slice(0, 10) + '.json');
      setExportNote('已导出 JSON 备份，共 ' + records.length + ' 条记录。');
    } catch (error) {
      setExportNote('导出失败：' + (error instanceof Error ? error.message : String(error)));
    }
  }
  async function onImportFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) { return; }
    setImporting(true); setImportNote(undefined);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const { records } = await parseBackupFile(bytes, file.name);
      if (records.length === 0) { setImportNote('文件中没有可导入的记录：' + file.name); return; }
      const summary = await importRecords(records, importMode);
      await refreshStorage();
      setImportNote('导入完成：新增 ' + summary.added + ' 条、覆盖 ' + summary.updated + ' 条、跳过 ' + summary.skipped + ' 条（文件共 ' + summary.total + ' 条）。' + (importMode === 'dedupe' ? '（同盘已去重，现有记录未被改动）' : ''));
    } catch (error) {
      setImportNote('导入失败：' + (error instanceof Error ? error.message : String(error)) + '。请确认选的是 .sqlite / .sqlite3 / .sql / .json 备份。');
    } finally {
      setImporting(false);
    }
  }
  async function exportSqlText() {
    try {
      const records = await exportableRecords();
      const text = exportRecordsSQLText(records);
      downloadBlob(new Blob([text], { type: 'text/plain;charset=utf-8' }), 'mingli-data-' + new Date().toISOString().slice(0, 10) + '.sql');
      setExportNote('已导出 SQL 文本(.sql)，共 ' + records.length + ' 条记录——与 .sqlite 同一套表结构。');
    } catch (error) {
      setExportNote('导出失败：' + (error instanceof Error ? error.message : String(error)));
    }
  }
  async function selfTest() {
    setTesting(true); setTestResult(null);
    try { setTestResult(await runAiSelfTest()); } catch (error) { setTestResult({ ok: false, message: error instanceof Error ? error.message : String(error) }); }
    finally { setTesting(false); }
  }


  /** 每个通道独立保存：同一屏可把 DeepSeek / Kimi / Qwen 三条通道都配好，无需先选再存。 */
  async function saveOne(service: ServiceId) {
    const value = secrets[service];
    if (!value) { setStatuses((c) => ({ ...c, [service]: '保存失败' })); return; }
    const hadCredential = statuses[service] === '已配置';
    setBusyService(service);
    setStatuses((c) => ({ ...c, [service]: '保存中' }));
    try {
      const result = await saveServiceCredential(service, value);
      const nextStatus: DisplayStatus = result === 'configured' ? '已配置' : '未配置';
      setStatuses((c) => ({ ...c, [service]: nextStatus }));
      setSecrets((c) => ({ ...c, [service]: '' }));
      if (result === 'configured') {
        setNotice((c) => ({ ...c, [service]: hadCredential ? '已用新凭据覆盖原有配置' : '已保存' }));
        setTimeout(() => setNotice((c) => ({ ...c, [service]: undefined })), 4000);
      }
    } catch { setStatuses((c) => ({ ...c, [service]: '保存失败' })); }
    finally { setBusyService(null); }
  }
  async function clearOne(service: ServiceId) {
    setBusyService(service);
    try {
      const result = await clearServiceCredential(service);
      setStatuses((c) => ({ ...c, [service]: result === 'configured' ? '已配置' : '未配置' }));
    } catch { setStatuses((c) => ({ ...c, [service]: '保存失败' })); }
    finally { setBusyService(null); setSecrets((c) => ({ ...c, [service]: '' })); setNotice((c) => ({ ...c, [service]: '已清除该通道的凭据' })); setTimeout(() => setNotice((c) => ({ ...c, [service]: undefined })), 4000); }
  }
  /** 切换当前应用使用的通道（持久保存：重启后仍生效）。 */
  async function useChannel(service: ServiceId) {
    setSwitching(true);
    try {
      const picked = await setSelectedService(service);
      setCurrentProvider(serviceProvider(picked));
    } catch { /* 保存失败保持原样 */ }
    finally { setSwitching(false); }
  }
  const configuredCount = services.filter((s) => statuses[s.id] === '已配置').length;


  function syncAfterLoginChange() {
    setSession(getServerSession());
    reloadLocalForSession();
    setSrvPw('');
  }
  async function saveServerUrl() { setServerUrl(serverUrl); setSrvMsg('服务器地址已保存：此后数据与分析默认走服务器，连不上时自动退回本机离线。'); }
  async function doLogin() {
    if (!serverUrl || !srvUser || !srvPw) { setSrvMsg('请先填服务器地址与账号密码'); return; }
    setSrvBusy(true); setSrvMsg(undefined);
    try {
      setServerUrl(serverUrl);
      const data = await apiAuth.login(srvUser.trim(), srvPw);
      setServerSession({ token: data.token, username: data.user.username, role: data.user.role });
      syncAfterLoginChange();
      setSrvMsg('登录成功：' + data.user.username + (data.user.role === 'admin' ? '（管理员，可看全部记录并管理 AI 密钥）' : '（只能看到自己的客户）') + '。本设备已记住，下次打开自动登录。');
    } catch (error) { setSrvMsg('登录失败：' + (error instanceof Error ? error.message : String(error))); }
    finally { setSrvBusy(false); }
  }
  async function doRegister() {
    if (!serverUrl || !srvUser || !srvPw) { setSrvMsg('请先填服务器地址、新账号与密码'); return; }
    setSrvBusy(true); setSrvMsg(undefined);
    try {
      setServerUrl(serverUrl);
      const data = await apiAuth.register(srvUser.trim(), srvPw);
      setServerSession({ token: data.token, username: data.user.username, role: data.user.role });
      syncAfterLoginChange();
      setSrvMsg('注册并登录成功：' + data.user.username + (data.user.role === 'admin' ? '（本机首个账号为管理员）' : ''));
    } catch (error) { setSrvMsg('注册失败：' + (error instanceof Error ? error.message : String(error))); }
    finally { setSrvBusy(false); }
  }
  async function doLogout() {
    setSrvBusy(true);
    try { await apiAuth.logout(); } catch { /* 忽略 */ }
    setServerSession(null);
    syncAfterLoginChange();
    setSrvMsg('已退出登录。数据仍留在本机可离线查看；重新登录后会自动同步。');
    setSrvBusy(false);
  }

  return <main className="settings-page">
    <header className="page-heading"><p className="eyebrow">LOCAL SETTINGS</p><h1>设置</h1><p className="page-description">管理内部服务的访问配置。</p></header>
    <section aria-label="AI 通道" aria-labelledby="channels-title"><h2 id="channels-title">AI 通道（三条可同时配置）</h2>
      <p className="page-description">三条通道各自独立保存，互不影响。当前生效的那条会标注「使用中」并优先调用，失败时自动依次回退到已配置的其它通道。</p>
      <p className="current-channel" role="status">当前使用：<strong>{PROVIDER_LABEL[currentProvider]}</strong>{statuses[currentProvider === 'deepseek' ? 'serviceOne' : currentProvider === 'kimi' ? 'serviceTwo' : 'serviceThree'] === '已配置' ? '' : '（该通道尚未配置，会直接使用其它已配置通道）'}　·　已配置 {configuredCount} / {services.length} 条</p>
      {services.map((service) => {
        const st = statuses[service.id];
        const busy = busyService === service.id;
        const isCurrent = serviceProvider(service.id) === currentProvider;
        return <div className={isCurrent ? 'channel-block current' : 'channel-block'} key={service.id} aria-label={service.label + ' 通道'}>
          <div className="channel-head">
            <strong>{service.label}</strong>
            <span className={st === '已配置' ? 'channel-status ok' : st === '保存失败' ? 'channel-status bad' : 'channel-status'}>{st}</span>
            {isCurrent ? <span className="channel-current">使用中</span> : <button className="text-button tiny channel-use" type="button" disabled={switching} onClick={() => void useChannel(service.id)}>设为使用</button>}
            {notice[service.id] && <span className="channel-notice" role="status">{notice[service.id]}</span>}
          </div>
          <div className="channel-row">
            <input aria-label={service.label + ' 访问凭据'} type="password" autoComplete="off" placeholder={st === '已配置' ? '已保存（重新填写可覆盖）' : '粘贴访问凭据'} value={secrets[service.id]} disabled={busy}
              onChange={(event) => { const v = event.target.value; setSecrets((c) => ({ ...c, [service.id]: v })); }} />
            <button className="primary-button" type="button" disabled={busy} onClick={() => void saveOne(service.id)}>{busy ? '处理中…' : '保存'}</button>
            <button className="text-button" type="button" disabled={busy} onClick={() => void clearOne(service.id)}>清除</button>
          </div>
        </div>;
      })}
    </section>
    <p className="ai-status" role="status">数据库：{storage ? `${storage.records} 条记录 / 缓存 ${storage.cache} 条 / ${(storage.bytes / 1024).toFixed(0)} KB` : '读取中…'}</p>
    <div className="button-group"><button className="text-button" type="button" disabled={compacting || !storage} onClick={() => void compress()}>{compacting ? '压缩中…' : '压缩旧记录（缩小数据库）'}</button><button className="text-button" type="button" disabled={testing} onClick={() => void selfTest()}>{testing ? '自检中…' : 'AI 连通自检（微小消耗）'}</button><button className="text-button" type="button" onClick={() => void exportSQLite()}>导出数据库(.sqlite)</button><button className="text-button" type="button" onClick={() => void exportJson()}>导出JSON备份</button><button className="text-button" type="button" onClick={() => void exportSqlText()}>导出SQL文本(.sql)</button></div>
    {exportNote && <p role="status">{exportNote}</p>}
    <section aria-label="数据导入"><h2>数据导入（.sqlite / .sqlite3 / .sql / .json 备份）</h2>
      <p className="page-description">导入后可继续离线查看；桌面版会写入本机数据库，联网账号会自动同步到服务器。遇到同名记录时按下方选择处理。</p>
      <div className="import-mode-row">
        <label className="checkbox-label"><input type="radio" name="importMode" checked={importMode === 'overwrite'} onChange={() => setImportMode('overwrite')} />追加并覆盖（同 id 覆盖、新记录追加）</label>
        <label className="checkbox-label"><input type="radio" name="importMode" checked={importMode === 'dedupe'} onChange={() => setImportMode('dedupe')} />同盘去重（性别+四柱+出生年相同则跳过）</label>
      </div>
      <div className="button-group">
        <button className="text-button" type="button" disabled={importing} onClick={() => fileRef.current?.click()}>{importing ? '导入中…' : '导入备份文件…'}</button>
        <span className="copy-help">支持 .sqlite（含桌面版同目录的 data\bazi_records.sqlite3）、.sqlite3、.sql 文本 dump 与 .json 备份。</span>
      </div>
      <input ref={fileRef} type="file" accept=".sqlite,.sqlite3,.sql,.json,application/json,application/octet-stream,text/plain" style={{ display: 'none' }} aria-hidden="true"
        onChange={(event: ChangeEvent<HTMLInputElement>) => { void onImportFile(event); }} />
      {importNote && <p role="status">{importNote}</p>}
    </section>
    {testResult && <p role="status">{testResult.ok ? `自检通过：${testResult.provider} · ${testResult.model} · ${testResult.latencyMs ?? ''}ms · 回复“${testResult.reply ?? ''}”` : `自检失败：${testResult.message ?? '未知错误'}`}</p>}
    {testResult && <button className="text-button" type="button" onClick={() => setTestResult(null)}>关闭自检结果</button>}
    <section className="server-section" aria-label="服务器 API 服务"><h2>服务器通道（默认）</h2>
      <p className="page-description">客户端可独立运行：连得上服务器时，数据与分析都走服务器通道；连不上时自动使用本机离线数据继续，联网后自动汇总同步。</p>
      <div className="settings-form">
        <label>服务器地址<input aria-label="服务器地址" value={serverUrl} onChange={(e) => setUrl(e.target.value)} placeholder="https://你的服务器:8787" /></label>
        <div className="button-group"><button className="text-button" type="button" onClick={() => void saveServerUrl()}>保存服务器地址</button></div>
        {!session && <><label>账号<input aria-label="服务器账号" value={srvUser} onChange={(e) => setSrvUser(e.target.value)} autoComplete="username" /></label>
          <label>密码<input aria-label="服务器密码" type="password" value={srvPw} onChange={(e) => setSrvPw(e.target.value)} autoComplete="current-password" /></label>
          <div className="button-group"><button className="primary-button" type="button" disabled={srvBusy} onClick={() => void doLogin()}>{srvBusy ? '处理中…' : '登录并记住此设备'}</button><button className="text-button" type="button" disabled={srvBusy} onClick={() => void doRegister()}>注册新账号</button></div></>}
        {session && <p className="ai-status">已连接：{session.username}（{session.role === 'admin' ? '管理员' : '普通用户'}）· 本设备自动登录</p>}
        {session && <div className="button-group"><button className="text-button" type="button" disabled={srvBusy} onClick={() => void doLogout()}>退出登录</button></div>}
        {srvMsg && <p role="status">{srvMsg}</p>}
      </div>
    </section>
    <VersionInfo />
  </main>;
}

/** 版本信息：显示当前页面构建号，并对比已激活的 SW 缓存号。
 *  两者不一致＝页面还没换到最新版(旧缓存/旧页面)，是手机端「看不到新功能」的典型原因。 */
function VersionInfo() {
  const [swCache, setSwCache] = useState<string>('检测中…');
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        if (!('caches' in window)) { if (active) setSwCache('此环境不支持'); return; }
        const keys = await caches.keys();
        const mine = keys.filter((k) => k.startsWith('mingli-'));
        if (active) setSwCache(mine.length ? mine.join('、') : '（无）');
      } catch { if (active) setSwCache('读取失败'); }
    })();
    return () => { active = false; };
  }, []);
  const current = cacheLabel();
  const stale = swCache !== current && swCache !== '检测中…' && swCache !== '此环境不支持' && swCache !== '读取失败' && swCache !== '（无）';
  return <section aria-label="版本信息"><h2>版本信息</h2>
    <p className="ai-status">页面版本：{buildLabel()}（{BUILD_ID}）</p>
    <p className="ai-status">已缓存版本：{swCache}</p>
    {stale ? <p className="form-error" role="alert">页面与已缓存版本不一致：当前显示的可能不是最新版。请下拉刷新或清除站点数据后重开。</p> : null}
  </section>;
}