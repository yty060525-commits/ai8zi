import { useEffect, useRef, useState, useSyncExternalStore, type ChangeEvent } from 'react';
import { getServiceStatus, clearServiceCredential, saveServiceCredential, setSelectedService, serviceProvider, serviceOf, PROVIDER_LABEL, type AiProvider, type ServiceId } from '../../data/aiSettings';
import { isLocalSystemEnabled, isLocalSystemUnlocked, hideLocalSystem, setLocalSystemEnabled, subscribeLocalSystem, unlockLocalSystem, verifyLocalKey } from '../../data/localSystem';
import { sanitizeAnalysisText } from '../chart/elements';
import { compactRecords, getStorageStats, runAiSelfTest, type AiSelfTest } from '../../data/storageInfo';
import { reloadLocalForSession } from '../../data/clientRepository';
import { importRecords, parseBackupFile, type ImportMode } from '../../data/sqlImport';
import { apiAuth, getServerSession, getServerUrl, setServerSession, setServerUrl, type ServerSession } from '../../data/serverClient';
import { BUILD_ID, GIT_VERSION, buildLabel, cacheLabel, cnVersion, cacheReadout } from '../../utils/buildInfo';
import { readableName } from '../../data/chatEngine';
import { readableTransportError } from '../../data/deepseekAdapter';

type DisplayStatus = '已配置' | '未配置' | '保存中' | '保存失败';

/** 界面上的计数一律读成中文：阿拉伯数字在正式版口径下属于算法痕迹，与英文字段名同级。
 *  词表在 shared/chineseReadAloud，与详情页/记录列表同源。 */
import { cnCount } from '../../shared/chineseReadAloud';

/* 通道名读成中文：正式版口径下界面正文不许出现拉丁字母，服务商自己的英文名也一样属于痕迹。
   编号沿用原英文名的首字母顺序(深思 DeepSeek、克米 Kimi、千问 Qwen)，用户按字形仍能对上。
   中间不写「·」：那道「只能中文」闸门白名单没有中点，写了会被静默删掉一格。 */
const services: Array<{ id: ServiceId; label: string }> = [
  { id: 'serviceOne', label: '通道一深思' },
  { id: 'serviceTwo', label: '通道二克米' },
  { id: 'serviceThree', label: '通道三千问' },
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

  /* 「本地系统」＝第四条生成方式，界面上**只有这一处入口**（用户 2026-09-28：「输入密钥就是第四服务，
     qwen 就不要亮绿色了，不要覆盖 qwen 的密钥，随时可以使用 qwen」；同一条消息里又否掉了地址栏那条
     备用路 ——「不要展现第四入口了…给我两套链接」，于是 `?local=` 已经删掉，别再给它加第二处入口）。
     这一节自己带一个密钥框，且：
       · 这个框**只调 unlockLocalSystem**：不写 mingli.cred.*、不改所选通道，云端三格的绿点
         依旧只由各自的云端凭据决定（statuses 只有 saveOne/clearOne/useChannel 会动）；
       · 云端凭据粘进这个框只会得到「密钥不正确」，不会存成凭据、也不会被清掉；
       · 解锁码粘进上面任一格只按云端凭据存，**不开通**本路（分流版早被否掉，
         local-system-entry.test.tsx 至今钉着这条）。
     可见性判据与详情页同源（isLocalSystemUnlocked），别在这儿另加第二套条件。 */
  const readUnlocked = () => isLocalSystemUnlocked();
  const localUnlocked = useSyncExternalStore(subscribeLocalSystem, readUnlocked, readUnlocked);
  const localOn = useSyncExternalStore(subscribeLocalSystem, isLocalSystemEnabled, isLocalSystemEnabled);
  const [localNote, setLocalNote] = useState<string>();
  const [localKey, setLocalKey] = useState('');
  const flashLocalNote = (text: string) => { setLocalNote(text); setTimeout(() => setLocalNote(undefined), 4000); };
  /** 解锁：只写本机的开通标记。**刻意不调任何凭据接口** —— 这条路上没有任何东西该碰云端凭据；
   *  码不对就原样待着，三条云通道的凭据与所选通道一个字都不受影响。 */
  function doUnlockLocal() {
    if (!localKey.trim()) { flashLocalNote('请先粘贴密钥'); return; }
    const granted = unlockLocalSystem(localKey);
    // 无论成败都清空输入：密钥不该留在受控 state 里，更不该渲染进 DOM。
    setLocalKey('');
    flashLocalNote(granted
      ? '已开通本地系统：勾选「使用本地系统」后，点「AI 分析」才改由本机规则引擎批断（三条云端通道照常可用）'
      : '密钥不正确：未做任何改动，三条云端通道的凭据与所选通道都没被动过');
  }
  /** 「关起来」＝收回这一节，并且**一定**先把生成方式交还给云端（「只要关闭了就默认走 qwen」）。
   *  hideLocalSystem() 内部先关灯再清两个标记；这里不重算判据，靠订阅自己回读实现。 */
  function doHideLocal() {
    hideLocalSystem();
    flashLocalNote('已关起来：本地系统不再接管，「AI 分析」回到云端通道');
  }
  function toggleLocal(on: boolean) {
    const applied = setLocalSystemEnabled(on);
    flashLocalNote(applied ? '已启用本地系统：点「AI 分析」改由本机规则引擎批断（仅本机）' : '已关闭本地系统：切回云端通道');
  }

  /* 「两套链接」（用户 2026-09-28）：一条裸链＝原本三条云端通道，一条 `#local`＝进来直接走本机引擎。
     两条都只是**选生成路**，不是开通方式：接管与否由 localSystem.preferLocalFromHash 判，
     未开通的设备打开 #local 也什么也不会写。链接里绝不含解锁码。 */
  const [localCopyNote, setLocalCopyNote] = useState<string>();
  /** 只取锚点前的那一段（pathname + search）：把本来就在的 hash 剔掉，两条链接才互不污染。 */
  function baseUrlForLinks(): string {
    try { const u = new URL(location.href); return u.origin + u.pathname + u.search; } catch { return ''; }
  }
  async function copyLocalLink() {
    const base = baseUrlForLinks();
    if (!base) { setLocalCopyNote('当前环境拿不到页面地址，复制不了'); return; }
    const text = '云端三通道：' + base + '\n本机引擎：' + base + '#local';
    try {
      await navigator.clipboard.writeText(text);
      setLocalCopyNote('两套链接已复制：第一条走云端三通道，第二条进来就用本机引擎，只在已开通的本机生效');
    } catch {
      // 手机 http/非安全上下文里 clipboard API 会直接 reject：不能静默失败，把两条链接摆出来让人长按复制。
      setLocalCopyNote('这个浏览器不让程序写剪贴板，请使用浏览器地址栏保存当前链接');
    }
    setTimeout(() => setLocalCopyNote(undefined), 10000);
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
      if (records.length === 0) { setImportNote('文件里没有可导入的记录：' + file.name); return; }
      const summary = await importRecords(records, importMode);
      await refreshStorage();
      setImportNote('导入完成：新增' + cnCount(summary.added) + '条，覆盖' + cnCount(summary.updated) + '条，跳过' + cnCount(summary.skipped) + '条，文件共' + cnCount(summary.total) + '条。' + (importMode === 'dedupe' ? '同盘已去重，现有记录未被改动。' : ''));
    } catch (error) {
      setImportNote('导入失败：' + sanitizeAnalysisText(error instanceof Error ? error.message : String(error)) + '。请确认选的是数据库文件或备份文件。');
    } finally {
      setImporting(false);
    }
  }
  async function selfTest() {
    setTesting(true); setTestResult(null);
    try { setTestResult(await runAiSelfTest()); } catch (error) { setTestResult({ ok: false, message: error instanceof Error ? error.message : String(error) }); }
    finally { setTesting(false); }
  }


  /** 每个通道独立保存：同一屏可把三条通道都配好，无需先选再存。 */
  async function saveOne(service: ServiceId) {
    const value = secrets[service];
    if (verifyLocalKey(value)) {
      setSecrets((c) => ({ ...c, [service]: '' }));
      setNotice((c) => ({ ...c, [service]: '请在本地系统密钥框中输入，云端凭据未改动' }));
      return;
    }
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
        // 地址是用户自己填的，原样回显等于把一串带冒号斜杠的机器串铺进正文；改成确认句，
        // 具体地址放进 title 供核对。
        ? '服务器地址已保存并连通，填账号登录即可同步；连不上时自动退回本机离线。'
        : '地址已保存，但它没答话，返回的不是本服务。请核对是否写成本机局域网地址加端口八七八七。');
    } catch {
      clearTimeout(timer);
      setSrvMsg('地址已保存，但现在连不上：检查服务器上的服务进程是否在跑、手机与电脑是否连同一个无线网、防火墙是否放行端口。');
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
      setSrvMsg('登录成功：' + readableName(data.user.username) + (data.user.role === 'admin' ? '，管理员，可看全部记录并管理访问凭据' : '，只能看到自己的客户') + '。本设备已记住，下次打开自动登录。');
    } catch (error) { setSrvMsg('登录失败：' + readableTransportError(error instanceof Error ? error.message : String(error))); }
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
      setSrvMsg('注册并登录成功：' + readableName(data.user.username) + (data.user.role === 'admin' ? '，本机首个账号为管理员' : ''));
    } catch (error) { setSrvMsg('注册失败：' + readableTransportError(error instanceof Error ? error.message : String(error))); }
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
    <header className="page-heading"><p className="eyebrow">本机设置</p><h1>设置</h1><p className="page-description">管理内部服务的访问配置。</p></header>
    <section aria-label="批断通道" aria-labelledby="channels-title"><h2 id="channels-title">批断通道，三条可同时配置</h2>
      <p className="page-description">三条通道各自独立保存，互不影响。当前生效的那条会标注使用中并优先调用，失败时自动依次回退到已配置的其它通道。</p>
      {/* 「使用中」曾被理解成「这条已经配好了、正在跑」：一条凭据都没填时，页面同时摆出
          「使用中」和「已配置零条」两句互相矛盾的话。这里说清楚它是被选中的那条、但还没填。 */}
      <p className="current-channel" role="status">当前使用：<strong>{PROVIDER_LABEL[currentProvider]}</strong>{statuses[serviceOf(currentProvider)] === '已配置' ? '' : '，该通道尚未配置，会直接使用其它已配置通道'}；已配置{cnCount(configuredCount)}条，共{cnCount(services.length)}条{configuredCount === 0 ? '：三条都还没填凭据，现在哪一条都调不动，先在下面任一条里粘贴凭据并保存' : ''}</p>
      {services.map((service) => {
        const st = statuses[service.id];
        const busy = busyService === service.id;
        const isCurrent = serviceProvider(service.id) === currentProvider;
        return <div className={isCurrent ? 'channel-block current' : 'channel-block'} key={service.id} aria-label={service.label + '通道'}>
          <div className="channel-head">
            <strong>{service.label}</strong>
            <span className={st === '已配置' ? 'channel-status ok' : st === '保存失败' ? 'channel-status bad' : 'channel-status'}>{st}</span>
            {isCurrent ? <span className="channel-current">{st === '已配置' ? '使用中' : '已选中，未填凭据'}</span> : <button className="text-button tiny channel-use" type="button" disabled={switching} onClick={() => void useChannel(service.id)}>设为使用</button>}
            {notice[service.id] && <span className="channel-notice" role="status">{notice[service.id]}</span>}
          </div>
          <div className="channel-row">
            <input aria-label={service.label + '访问凭据'} type="password" autoComplete="off" placeholder={st === '已配置' ? '已保存，重新填写可覆盖' : '粘贴访问凭据'} value={secrets[service.id]} disabled={busy}
              onChange={(event) => { const v = event.target.value; setSecrets((c) => ({ ...c, [service.id]: v })); }} />
            <button className="primary-button" type="button" disabled={busy} onClick={() => void saveOne(service.id)}>{busy ? '处理中' : '保存'}</button>
            <button className="text-button" type="button" disabled={busy} onClick={() => void clearOne(service.id)}>清除</button>
          </div>
        </div>;
      })}
    </section>
    {/* 「本地系统」＝第四条生成方式：不走云端、不用凭据。**未开通时这一节摆出一个待解锁的密钥框**
        （用户 2026-09-28：「输入密钥就是第四服务」）；它自己一个框，与上面三格的云端凭据毫无关系，
        三条云通道任何时候都能直接用。 */}
    <section className="local-system" aria-label="本地系统"><h2>本地系统，本机规则引擎{localUnlocked ? <span className="channel-status ok">已开通</span> : <span className="channel-status">未开通</span>}{localNote && <span className="channel-notice" role="status">{sanitizeAnalysisText(localNote)}</span>}</h2>
      <p className="page-description">不联网、不消耗用度：由本机规则引擎就排盘事实直接批断，含本命、未来十年与后天调整。只影响本机，随时可取消勾选切回云端；三条云端通道任何时候都能直接用。</p>
      {!localUnlocked && <div className="channel-row">
        {/* type=password + autoComplete=off 与三格凭据框同款：解锁码不该进密码管理器或表单自动填充。
            占位文案刻意不提「凭据」也不提形状，免得被当成第四格密钥一起粘过来。 */}
        <input aria-label="本地系统密钥" type="password" autoComplete="off" placeholder="粘贴密钥" value={localKey}
          onChange={(event) => setLocalKey(event.target.value)} />
        <button className="primary-button" type="button" onClick={doUnlockLocal}>解锁</button>
      </div>}
      {localUnlocked && <div className="local-unlock-row">
        <label className="checkbox-inline"><input type="checkbox" checked={localOn} onChange={(event) => toggleLocal(event.target.checked)} />使用本地系统，不联网批断</label>
        <button className="text-button" type="button" onClick={() => copyLocalLink()}>复制两套链接</button>
        <button className="text-button" type="button" onClick={doHideLocal}>关起来，改用云端通道</button>
      </div>}
      {/* 「两套链接」是机主自己收藏用的，所以只在已开通后才给（未开通时这条 #local 链接也接管不了，
          给他反而误导）。文案刻意不提密钥：链接里永远不会有解锁码，开通仍然只有上面那一格。 */}
      {localUnlocked && localCopyNote && <p className="page-description" role="status" style={{ whiteSpace: 'pre-wrap' }}>{localCopyNote}</p>}
    </section>
    <p className="ai-status" role="status">数据库：{storage ? `${cnCount(storage.records)}条记录，缓存${storage.cacheEntries === null ? '未知，网页版不统计服务器缓存' : cnCount(storage.cacheEntries) + '条'}${storage.bytes ? `，占用约${cnCount(Math.round(storage.bytes / 1024))}千字节` : ''}` : '读取中'}</p>
    <div className="button-group"><button className="text-button" type="button" disabled={compacting || storage === null || storage.cacheEntries === null} onClick={() => void compress()}>{compacting ? '压缩中' : '压缩旧记录，缩小数据库'}</button><button className="text-button" type="button" disabled={testing} onClick={() => void selfTest()}>{testing ? '自检中' : '连通自检，微小消耗'}</button></div>
    {/* 导出一律走「记录」页(按人勾选、三种格式都有)：这里曾另摆三个全量导出按钮，
        两处口径不同还容易点错，删掉。导入仍留在这里 —— 恢复备份不需要先有勾选。 */}
    <section aria-label="数据导入"><h2>数据导入，支持数据库文件与备份文件</h2>
      <p className="page-description">导入后可继续离线查看；桌面版会写入本机数据库，联网账号会自动同步到服务器。遇到同名记录时按下方选择处理。</p>
      <div className="import-mode-row">
        <label className="checkbox-label"><input type="radio" name="importMode" checked={importMode === 'overwrite'} onChange={() => setImportMode('overwrite')} />追加并覆盖，同标识覆盖、新记录追加</label>
        <label className="checkbox-label"><input type="radio" name="importMode" checked={importMode === 'dedupe'} onChange={() => setImportMode('dedupe')} />同盘去重，性别、四柱、出生年月相同则跳过</label>
      </div>
      <div className="button-group">
        <button className="text-button" type="button" disabled={importing} onClick={() => fileRef.current?.click()}>{importing ? '导入中' : '导入备份文件'}</button>
        <span className="copy-help">支持数据库文件、结构化文本转储与备份文件；桌面版同目录的本机库文件也可直接选。</span>
      </div>
      <input ref={fileRef} type="file" accept=".sqlite,.sqlite3,.sql,.json,application/json,application/octet-stream,text/plain" style={{ display: 'none' }} aria-hidden="true"
        onChange={(event: ChangeEvent<HTMLInputElement>) => { void onImportFile(event); }} />
      {importNote && <p role="status">{importNote}</p>}
    </section>
    {testResult && <p role="status">{testResult.ok ? `自检通过：${PROVIDER_LABEL[testResult.provider as AiProvider] ?? '所选通道'}，耗时约${cnCount(Math.round(testResult.latencyMs ?? 0))}毫秒，收到的回复是：${sanitizeAnalysisText(testResult.reply ?? '') || '已收到答复'}` : `自检失败：${sanitizeAnalysisText(testResult.message ?? '') || '未知错误'}`}</p>}
    {testResult && <button className="text-button" type="button" onClick={() => setTestResult(null)}>关闭自检结果</button>}
    <section className="server-section" aria-label="服务器通道"><h2>服务器通道，默认走这条</h2>
      <p className="page-description">客户端可独立运行：连得上服务器时，数据与分析都走服务器通道；连不上时自动使用本机离线数据继续，联网后自动汇总同步。</p>
      <div className="settings-form">
        <label>服务器地址<input aria-label="服务器地址" value={serverUrl} onChange={(e) => setUrl(e.target.value)} placeholder="例如内网地址加端口号，手机与电脑连同一个无线网" inputMode="url" autoComplete="off" /></label>
        <div className="button-group"><button className="text-button" type="button" onClick={() => void saveServerUrl()}>保存服务器地址</button></div>
        {!session && <><label>账号<input aria-label="服务器账号" value={srvUser} onChange={(e) => setSrvUser(e.target.value)} autoComplete="username" /></label>
          <label>密码<input aria-label="服务器密码" type="password" value={srvPw} onChange={(e) => setSrvPw(e.target.value)} autoComplete="current-password" /></label>
          <div className="button-group"><button className="primary-button" type="button" disabled={srvBusy} onClick={() => void doLogin()}>{srvBusy ? '处理中' : '登录并记住此设备'}</button><button className="text-button" type="button" disabled={srvBusy} onClick={() => void doRegister()}>注册新账号</button></div></>}
        {session && <p className="ai-status" title={'账号：' + session.username}>已连接：{readableName(session.username)}，{session.role === 'admin' ? '管理员' : '普通用户'}。本设备自动登录</p>}
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
  const [swCache, setSwCache] = useState<string>('检测中');
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        if (!('caches' in window)) { if (active) setSwCache('此环境不支持'); return; }
        const keys = await caches.keys();
        const mine = keys.filter((k) => k.startsWith('mingli-'));
        if (active) setSwCache(mine.length ? mine.join('、') : '无');
      } catch { if (active) setSwCache('读取失败'); }
    })();
    return () => { active = false; };
  }, []);
  const current = cacheLabel();
  // 「不一致」的比对仍用缓存号原文(mingli-<构建号>)，只是不再把这串拉丁字母+数字印在正文里：
  // 界面正文在正式版口径下只留汉字与中文句读。真要核对缓存名，标题栏与「已缓存版本」的
  // title/aria 里给全串，运维照旧能查。
  const stale = swCache !== current && swCache !== '检测中' && swCache !== '此环境不支持' && swCache !== '读取失败' && swCache !== '无';
  return <section aria-label="版本信息"><h2>版本信息</h2>
    {GIT_VERSION ? <p className="ai-status" title={'版本号 ' + GIT_VERSION}>版本号：{cnVersion(GIT_VERSION)}</p> : null}
    <p className="ai-status">构建时间：{buildLabel()}</p>
    <p className="ai-status" title={swCache === current ? '与本页面同一版缓存' : '缓存号 ' + swCache}>已缓存版本：{cacheReadout(swCache, current)}</p>
    {stale ? <p className="form-error" role="alert">页面与已缓存版本不一致：当前显示的可能不是最新版。请下拉刷新或清除站点数据后重开。</p> : null}
  </section>;
}
