import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { getServiceStatus, clearServiceCredential, saveServiceCredential, setSelectedService, serviceProvider, serviceOf, PROVIDER_LABEL, type ServiceId } from '../../data/aiSettings';
import { isLocalSystemEnabled, isLocalSystemHidden, isLocalSystemUnlocked, lockLocalSystem, setLocalSystemEnabled, setLocalSystemHidden, unlockLocalSystem } from '../../data/localSystem';
import { useSecretTitleTap } from './secretEntrance';
import { compactRecords, getStorageStats, runAiSelfTest, type AiSelfTest } from '../../data/storageInfo';
import { reloadLocalForSession } from '../../data/clientRepository';
import { importRecords, parseBackupFile, type ImportMode } from '../../data/sqlImport';
import { apiAuth, getServerSession, getServerUrl, setServerSession, setServerUrl, type ServerSession } from '../../data/serverClient';
import { BUILD_ID, GIT_VERSION, buildLabel, cacheLabel } from '../../utils/buildInfo';

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
  const [currentProvider, setCurrentProvider] = useState<'deepseek' | 'kimi' | 'qwen'>('qwen');
  const [switching, setSwitching] = useState(false);
  const [notice, setNotice] = useState<Partial<Record<ServiceId, string>>>({});
  const [status, setStatus] = useState<DisplayStatus>('未配置');
  const [storage, setStorage] = useState<{ records: number; cacheEntries: number | null; bytes: number } | null>(null);
  const [compacting, setCompacting] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<AiSelfTest | null>(null);

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

  // 本地系统（本机规则引擎）：要先在自己的密钥框里开通，再手动勾选才接管「AI 分析」。
  // **它和 Qwen 的云端凭据是两个互不相干的输入框**：解锁码不当凭据用、凭据也不开解锁。
  const [localUnlocked, setLocalUnlocked] = useState<boolean>(() => isLocalSystemUnlocked());
  const [localOn, setLocalOn] = useState<boolean>(() => isLocalSystemEnabled());

  // 解锁块默认**不渲染**：设置页上看不到任何「本地系统」字样，只有走暗门才现身。
  // 已在用的设备例外——否则开着本地引擎的人既看不到状态、也没法关掉它。
  // hidden 是压过这条例外的显式标记（就是用户要的「隐藏按钮」，见下面的连点）。
  const [hidden, setHidden] = useState<boolean>(() => isLocalSystemHidden());
  const [revealed, setRevealed] = useState<boolean>(false);
  // 「隐藏按钮」＝同一个连点手势的第二次触发：放出来之后再连点 5 下，整块收回、恢复原貌。
  // 判据用**当前渲染里的表达式**(localUnlocked || revealed)，不用 setRevealed 刚排队的 state：
  // 同步连点(fireEvent / 手速极快)期间 React 还没重渲染，闭包里的 `revealed` 会停在旧值 ——
  // 已开通的设备上第一次连点本该是「收起」，读旧值却会判成「再显示一次」，永远收不掉。
  const { onClick: onHeadingTap } = useSecretTitleTap(() => {
    if (localUnlocked || revealed) {
      setRevealed(false);
      setHidden(setLocalSystemHidden(true));
      return;
    }
    setRevealed(true);
    if (hidden) setHidden(setLocalSystemHidden(false));
  }, true);
  // 渲染用的最终可见性：显式藏起来时一律不显示（包括已开通的设备）。
  const showLocalBlock = !hidden && (revealed || localUnlocked);
  const [localKey, setLocalKey] = useState('');
  const [localNote, setLocalNote] = useState<string>();
  const flashLocalNote = (text: string) => { setLocalNote(text); setTimeout(() => setLocalNote(undefined), 4000); };
  function doUnlockLocal() {
    if (!unlockLocalSystem(localKey)) {
      flashLocalNote('密钥不正确：未开通本地系统，也没有改动任何已有配置');
      return;
    }
    setLocalUnlocked(true);
    setLocalKey('');
    flashLocalNote('已开通本地系统，勾选「使用本地系统」才接管 AI 分析');
  }
  function doLockLocal() {
    lockLocalSystem();
    setLocalUnlocked(false); setLocalOn(false); setLocalKey('');
    flashLocalNote('已撤销开通：本地系统已关闭并清除本机密钥标记');
  }
  function toggleLocal(on: boolean) {
    const applied = setLocalSystemEnabled(on);
    setLocalOn(applied);
    flashLocalNote(applied ? '已启用本地系统：点「AI 分析」改由本机规则引擎批断（仅本机）' : '已关闭本地系统：切回云端通道');
  }

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
    setStorage({ records: stats.records, cacheEntries: stats.cacheEntries, bytes: stats.dbBytes });
  };
  useEffect(() => {
    let active = true;
    void getStorageStats().then((stats) => { if (active) setStorage({ records: stats.records, cacheEntries: stats.cacheEntries, bytes: stats.dbBytes }); }).catch(() => { if (active) setStorage(null); });
    return () => { active = false; };
  }, []);
  async function compress() {
    setCompacting(true);
    try { await compactRecords(); await refreshStorage(); } catch { /* 保留原值 */ }
    finally { setCompacting(false); }
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
  async function saveServerUrl() {
    setServerUrl(serverUrl);
    // 只填了地址就顺手探一次 /api/health：否则用户要等到点登录才知道地址写错了，
    // 而那时报出的「登录失败」看起来像账号问题。
    if (!serverUrl.trim()) { setServerUrl(''); setSrvMsg('服务器地址已清空：此后只用本机离线数据。'); return; }
    setSrvBusy(true);
    // 局域网里连不上的地址可能要几秒才失败(手机浏览器更慢)，探活最多等 5 秒，
    // 超时就按「连不上」提示 —— 不能让保存按钮卡住不动。
    const probe = new AbortController();
    const timer = setTimeout(() => probe.abort(), 5000);
    try {
      const res = await fetch(serverUrl.replace(/\/+$/, '') + '/api/health', { signal: probe.signal });
      clearTimeout(timer);
      const data = await res.json().catch(() => null) as { service?: string } | null;
      setSrvMsg(data?.service === 'mingli-server'
        ? '服务器地址已保存并连通：' + serverUrl + '。填账号登录即可同步；连不上时自动退回本机离线。'
        : '地址已保存，但它没答话(返回的不是本服务)。请核对是否写成 http://局域网IP:8787。');
    } catch {
      clearTimeout(timer);
      setSrvMsg('地址已保存，但现在连不上：检查服务器上 node server.mjs 是否在跑、手机与电脑是否同一 WiFi、防火墙是否放行端口。');
    } finally { setSrvBusy(false); }
  }
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
    <header className="page-heading"><p className="eyebrow">LOCAL SETTINGS</p><h1 onClick={onHeadingTap}>设置</h1><p className="page-description">管理内部服务的访问配置。</p></header>
    <section aria-label="AI 通道" aria-labelledby="channels-title"><h2 id="channels-title">AI 通道（三条可同时配置）</h2>
      <p className="page-description">三条通道各自独立保存，互不影响。当前生效的那条会标注「使用中」并优先调用，失败时自动依次回退到已配置的其它通道。</p>
      {/* 「使用中」曾被理解成「这条已经配好了、正在跑」：一条凭据都没填时，页面同时摆出
          「使用中」和「已配置 0 / 3 条」两句互相矛盾的话。这里说清楚它是被选中的那条、但还没填。 */}
      <p className="current-channel" role="status">当前使用：<strong>{PROVIDER_LABEL[currentProvider]}</strong>{statuses[currentProvider === 'deepseek' ? 'serviceOne' : currentProvider === 'kimi' ? 'serviceTwo' : 'serviceThree'] === '已配置' ? '' : '（该通道尚未配置，会直接使用其它已配置通道）'}　·　已配置 {configuredCount} / {services.length} 条{configuredCount === 0 ? '：三条通道都还没填凭据，先在下面任一条里粘贴凭据并保存' : ''}</p>
      {services.map((service) => {
        const st = statuses[service.id];
        const busy = busyService === service.id;
        const isCurrent = serviceProvider(service.id) === currentProvider;
        // 本地系统那块挂在 Qwen 一格的位置里（用户指定「跟 qwen 走一个系统」），但它有**自己的密钥框**，
        // 与上面的云端凭据互不影响 —— 用户 2026-09-25 明确否掉了「一个框按内容分流」：那等于拿解锁码
        // 去顶替原本存 Qwen 密钥的地方。
        const isQwen = service.id === 'serviceThree';
        return <div className={isCurrent ? 'channel-block current' : 'channel-block'} key={service.id} aria-label={service.label + ' 通道'}>
          <div className="channel-head">
            <strong>{service.label}</strong>
            <span className={st === '已配置' ? 'channel-status ok' : st === '保存失败' ? 'channel-status bad' : 'channel-status'}>{st}</span>
            {isCurrent ? <span className="channel-current">{st === '已配置' ? '使用中' : '选中·未填凭据'}</span> : <button className="text-button tiny channel-use" type="button" disabled={switching} onClick={() => void useChannel(service.id)}>设为使用</button>}
            {notice[service.id] && <span className="channel-notice" role="status">{notice[service.id]}</span>}
          </div>
          <div className="channel-row">
            {/* 占位文字三格**同一句**（用户 2026-09-25：「输入框显示的文字跟别的保持一致」）。
                Qwen 这格只管云端凭据，解锁码走下面那块自己的输入框，两者互不相干。 */}
            <input aria-label={service.label + ' 访问凭据'} type="password" autoComplete="off" placeholder={st === '已配置' ? '已保存（重新填写可覆盖）' : '粘贴访问凭据'} value={secrets[service.id]} disabled={busy}
              onChange={(event) => { const v = event.target.value; setSecrets((c) => ({ ...c, [service.id]: v })); }} />
            <button className="primary-button" type="button" disabled={busy} onClick={() => void saveOne(service.id)}>{busy ? '处理中…' : '保存'}</button>
            <button className="text-button" type="button" disabled={busy} onClick={() => void clearOne(service.id)}>清除</button>
          </div>
          {isQwen && showLocalBlock && <div className="local-unlock" aria-label="本地系统">
            <div className="local-unlock-head">
              <strong>本地系统（本机规则引擎）</strong>
              <span className={localUnlocked ? 'channel-status ok' : 'channel-status'}>{localUnlocked ? '已开通' : '未开通'}</span>
              {localNote && <span className="channel-notice" role="status">{localNote}</span>}
            </div>
            <p className="copy-help">不联网、不消耗用度：由本机规则引擎就排盘事实直接批断，结果同样写入命盘并随账号同步。需粘贴密钥开通（与上面的云端凭据是两个独立的框，互不影响），开通后再勾选才接管「AI 分析」；仅影响本机，随时可取消勾选切回云端。</p>
            {!localUnlocked
              ? <div className="channel-row"><input aria-label="本地系统密钥" type="password" autoComplete="off" placeholder="粘贴密钥以开通本地系统" value={localKey} onChange={(event) => setLocalKey(event.target.value)} />
                <button className="primary-button" type="button" onClick={doUnlockLocal}>开通</button></div>
              : <div className="local-unlock-row">
                <label className="checkbox-inline"><input type="checkbox" checked={localOn} onChange={(event) => toggleLocal(event.target.checked)} />使用本地系统（不联网批断）</label>
                <button className="text-button" type="button" onClick={doLockLocal}>撤销开通（清除密钥）</button>
              </div>}
          </div>}
        </div>;
      })}
    </section>
    <p className="ai-status" role="status">数据库：{storage ? `${storage.records} 条记录 / 缓存 ${storage.cacheEntries === null ? '未知(网页版不统计服务器缓存)' : storage.cacheEntries + ' 条'}${storage.bytes ? ` / ${(storage.bytes / 1024).toFixed(0)} KB` : ''}` : '读取中…'}</p>
    <div className="button-group"><button className="text-button" type="button" disabled={compacting || storage === null || storage.cacheEntries === null} onClick={() => void compress()}>{compacting ? '压缩中…' : '压缩旧记录（缩小数据库）'}</button><button className="text-button" type="button" disabled={testing} onClick={() => void selfTest()}>{testing ? '自检中…' : 'AI 连通自检（微小消耗）'}</button></div>
    {/* 导出一律走「记录」页(按人勾选、三种格式都有)：这里曾另摆三个全量导出按钮，
        两处口径不同还容易点错，删掉。导入仍留在这里 —— 恢复备份不需要先有勾选。 */}
    <section aria-label="数据导入"><h2>数据导入（.sqlite / .sqlite3 / .sql / .json 备份）</h2>
      <p className="page-description">导入后可继续离线查看；桌面版会写入本机数据库，联网账号会自动同步到服务器。遇到同名记录时按下方选择处理。</p>
      <div className="import-mode-row">
        <label className="checkbox-label"><input type="radio" name="importMode" checked={importMode === 'overwrite'} onChange={() => setImportMode('overwrite')} />追加并覆盖（同 id 覆盖、新记录追加）</label>
        <label className="checkbox-label"><input type="radio" name="importMode" checked={importMode === 'dedupe'} onChange={() => setImportMode('dedupe')} />同盘去重（性别+四柱+出生年月相同则跳过）</label>
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
        <label>服务器地址<input aria-label="服务器地址" value={serverUrl} onChange={(e) => setUrl(e.target.value)} placeholder="例如 http://192.168.1.20:8787(手机与电脑连同一个 WiFi)" inputMode="url" autoComplete="off" /></label>
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
    {GIT_VERSION ? <p className="ai-status">版本号：{GIT_VERSION}（对应快照 build-{GIT_VERSION}，可用 scripts/version.sh restore 回退）</p> : null}
    <p className="ai-status">构建时间：{buildLabel()}（{BUILD_ID}）</p>
    <p className="ai-status">已缓存版本：{swCache}</p>
    {stale ? <p className="form-error" role="alert">页面与已缓存版本不一致：当前显示的可能不是最新版。请下拉刷新或清除站点数据后重开。</p> : null}
  </section>;
}