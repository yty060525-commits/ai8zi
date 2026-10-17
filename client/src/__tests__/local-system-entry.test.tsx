import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SettingsPage } from '../features/settings/SettingsPage';
import { initializeMockSession } from '../data/clientRepository';
import { computePillarsFromDate } from '../features/chart/nonAiCalculator';
import { isOfflineMode, resetAiSettingsForTests } from '../data/aiSettings';
import { isLocalSystemEnabled, isLocalSystemUnlocked, preferLocalFromHash, resetLocalSystemForTests, setLocalSystemEnabled, unlockLocalSystem } from '../data/localSystem';
import { App } from '../App';
import { invoke } from '@tauri-apps/api/core';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

/** 用户手里的解锁码明文，源码里已改成异或表（见 localSystem.ts）。 */
const LOCAL_SYSTEM_KEY = 'mingli-local-2026';

const notConfigured = { selectedProvider: 'deepseek', deepseek: 'not_configured', kimi: 'not_configured', qwen: 'not_configured' };
const happyPath = async (command: string) => command === 'get_ai_provider_status' ? notConfigured
  : command === 'save_ai_credential' ? 'configured'
  : command === 'set_ai_provider' ? 'deepseek'
  : 'not_configured';
vi.mocked(invoke).mockImplementation(happyPath);

/* jsdom 不提供 navigator.clipboard（`navigator.clipboard.writeText` 直接 TypeError），
   「复制两套链接」在真实浏览器走它、在非安全上下文 reject 后回落到手动复制文案。
   这里给一个可控桩：成功分支才写剪贴板，失败分支用 mockRejectedValueOnce 造。 */
Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });

afterEach(() => { cleanup(); resetAiSettingsForTests(); resetLocalSystemForTests(); vi.mocked(invoke).mockImplementation(happyPath); vi.clearAllTimers?.(); });

// 这一组钉的是**跨版本一直没变的那条底线**：解锁码永远不当云端凭据用，凭据也永远不当解锁码用。
// （分流版被否掉后改回独立密钥框；2026-09-25 一度把框整个藏进地址栏，2026-09-28 又按用户要求摆回来
//  ——「输入密钥就是第四服务，qwen 就不要亮绿色了，不要覆盖 qwen 的密钥」。
//  但「不许把两者搅在一起」这条判据一直留着：谁再合并这两个入口，这里就会红。）
const credInput = () => screen.getByLabelText('通道三千问访问凭据') as HTMLInputElement;
const localKeyInput = () => screen.getByLabelText('本地系统密钥') as HTMLInputElement;
/** Qwen 那格的绿点/文字：只该由云端凭据决定，与第四服务开没开通无关。 */
const qwenBadge = () => (document.querySelector('[aria-label="通道三千问通道"] .channel-status') as HTMLElement);

describe('本地系统入口：与 Qwen 凭据彻底分开', () => {
  it('第四服务有自己的密钥框，措辞不与云端凭据混同', () => {
    const { container } = render(<SettingsPage />);
    expect(localKeyInput()).toBeTruthy();
    // 三格占位仍是同一句，且没有第二格自称「凭据」
    expect(credInput().placeholder).toBe('粘贴访问凭据');
    expect(localKeyInput().placeholder).toBe('粘贴密钥');
    expect(document.body.textContent).not.toContain('既不是以 sk- 开头');
    expect(document.body.textContent).not.toContain('识别为本地系统密钥');
    // 未开通时这一节明写「未开通」，不借用云通道那套「已配置」措辞
    expect(container.textContent).toContain('本地系统，本机规则引擎');
    expect(qwenBadge().textContent).toBe('未配置');
  });

  /* 反方向也要钉住：把一串云端凭据粘进第四服务的框里，只会得到「密钥不正确」——
     它既不写 mingli.cred.*、也不清已有凭据（上一版的事故就出在这两个框被当成同一个）。
     ⚠ 这条跑在**桌面分支**（invoke 桩）上：浏览器分支会直写 localStorage，那是产品设定，
        所以这里用 invoke 桩来判「有没有替本路去动云端凭据」。 */
  it('云端凭据粘进密钥框：不开通、不写凭据、不动已有凭据', async () => {
    render(<SettingsPage />);
    await waitFor(() => expect(qwenBadge().textContent).toBe('未配置'));
    fireEvent.change(credInput(), { target: { value: 'sk-existing-qwen' } });
    fireEvent.click(screen.getAllByRole('button', { name: '保存' })[2]);
    await waitFor(() => expect(qwenBadge().textContent).toBe('已配置'));

    fireEvent.change(localKeyInput(), { target: { value: 'sk-some-cloud-secret' } });
    fireEvent.click(screen.getByRole('button', { name: '解锁' }));
    expect(isLocalSystemUnlocked(), '云端凭据不该被当成解锁码').toBe(false);
    expect(await screen.findByText(/密钥不正确/)).toBeTruthy();
    // 本路一个凭据接口都没调：既没覆盖 qwen，也没清掉它。
    // ⚠ 判的是**调用名集合**而不是「有没有新调用」：点「解锁」压根不发请求才是对的形态，
    //    所以这里问的是「从头到尾没出现过任何凭据写接口」（正向钉子见下一句的 save_ai_credential）。
    const names = vi.mocked(invoke).mock.calls.map(([c]) => c);
    expect(names.filter((n) => n === 'save_ai_credential' || n === 'clear_ai_credential'),
      '第四服务不该调任何凭据写接口').toEqual(['save_ai_credential']);   // 只有上面那次真实保存
    expect(qwenBadge().textContent, '原状态照旧').toBe('已配置');
  });

  it('在 Qwen 凭据框里填解锁码：既不写凭据、也不开通本地', async () => {
    render(<SettingsPage />);
    fireEvent.change(credInput(), { target: { value: LOCAL_SYSTEM_KEY } });
    fireEvent.click(screen.getAllByRole('button', { name: '保存' })[2]);
    await waitFor(() => expect(screen.getAllByText('未配置').length).toBeGreaterThan(0));
    expect(isLocalSystemUnlocked(), '凭据框不该再认解锁码').toBe(false);
    expect(localStorage.getItem('mingli.cred.qwen')).toBe(null);
    expect(document.body.textContent).not.toContain(LOCAL_SYSTEM_KEY);
  });

  /* 用户 2026-09-28 报的就是这个场景：他在 Qwen 那格里动了键，结果第四服务像是把 qwen 顶掉了。
     所以这里正面钉住：走专用框开通第四服务**只动本机的三个标记**，云端凭据、所选通道一个字不变。 */
  it('专用框输对密钥＝开通第四服务：不动 qwen 凭据、不改所选通道、qwen 不因此变绿', async () => {
    render(<SettingsPage />);
    await waitFor(() => expect(qwenBadge().textContent).toBe('未配置'));
    const before = localStorage.getItem('mingli.provider');
    fireEvent.change(localKeyInput(), { target: { value: LOCAL_SYSTEM_KEY } });
    fireEvent.click(screen.getByRole('button', { name: '解锁' }));
    await waitFor(() => expect(screen.getByText('已开通')).toBeTruthy());
    expect(isLocalSystemUnlocked()).toBe(true);
    expect(isLocalSystemEnabled(), '刚开通不该自动接管').toBe(false);
    // 云端侧零改动：没有新凭据、所选通道没被换、Qwen 那格还是「未配置」
    expect(localStorage.getItem('mingli.cred.qwen'), '绝不能覆盖 qwen 的密钥').toBe(null);
    expect(localStorage.getItem('mingli.provider'), '绝不能改所选通道').toBe(before);
    expect(qwenBadge().textContent, 'qwen 不许因为开了第四服务就亮绿').toBe('未配置');
    // 解锁码不留在页面上，也不落到任何凭据键里
    expect(document.body.textContent).not.toContain(LOCAL_SYSTEM_KEY);
    expect(localStorage.getItem('mingli.local.unlocked')).toBe('1');
    // 展开后仍要手动勾选才接管
    const box = screen.getByRole('checkbox', { name: /使用本地系统/ }) as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    await waitFor(() => expect(isLocalSystemEnabled()).toBe(true));
    expect(isOfflineMode()).toBe(true);
  });

  it('密钥填错：不开通、不改动任何东西', () => {
    render(<SettingsPage />);
    fireEvent.change(localKeyInput(), { target: { value: 'wrong-key-xxxxx' } });
    fireEvent.click(screen.getByRole('button', { name: '解锁' }));
    expect(isLocalSystemUnlocked(), '错码不该开通').toBe(false);
    expect(screen.queryByText('已开通')).toBeNull();
    expect(localStorage.getItem('mingli.cred.qwen')).toBe(null);
    // 正例钉子：同一个框、同一个按钮，换成对的码就能开通（否则上面那句否定式是恒假）。
    fireEvent.change(localKeyInput(), { target: { value: LOCAL_SYSTEM_KEY } });
    fireEvent.click(screen.getByRole('button', { name: '解锁' }));
    expect(isLocalSystemUnlocked()).toBe(true);
  });

  it('开着第四服务时 qwen 仍可随取随用：点「设为使用」照旧上行 set_ai_provider', async () => {
    expect(unlockLocalSystem(LOCAL_SYSTEM_KEY), '解锁码不对，前提没成立').toBe(true);
    setLocalSystemEnabled(true);
    // 已开通 + 已勾选接管，但三条云通道一条凭据都没填。
    render(<SettingsPage />);
    expect(await screen.findByText('已开通')).toBeTruthy();
    /* 「设为使用」按钮的归属只能按**它所在的那一格**判：三格里两条是「选中·未填凭据/使用中」类
       文字、只有未选中的那条才有按钮 —— 用 `getAllByRole(...)[i]` 取序号会把 Kimi/Qwen 搞混
       （实测就踩在这里）。closest 到通道格外壳再读它的 aria-label，才是「点的到底是哪一格」。 */
    const useButtons = () => [...screen.getAllByRole('button', { name: '设为使用' })]
      .map((b) => b.closest('[aria-label$="通道"]')?.getAttribute('aria-label') ?? '?');
    expect(useButtons().sort()).toEqual(['通道二克米通道', '通道三千问通道'].sort());
    // 「设为使用」的是哪一格由上面的归属判据决定，别靠序号：点 Qwen 那一格里的按钮。
    const qwenUse = [...screen.getAllByRole('button', { name: '设为使用' })]
      .find((b) => b.closest('[aria-label$="通道"]')?.getAttribute('aria-label') === '通道三千问通道')!;
    fireEvent.click(qwenUse);
    await waitFor(() => expect(vi.mocked(invoke)).toHaveBeenCalledWith('set_ai_provider', { provider: 'qwen' }));
    // 切回云端后第四服务的标记不因它而被动过
    expect(isLocalSystemUnlocked()).toBe(true);
    expect(isOfflineMode(), '切云端通道不该顺手关掉本机勾选').toBe(true);

    /* 「随时可以使用 qwen」的另一半：本用例开头它一条凭据都没填（所以先设用它、再存凭据），
       存完立刻变绿并标「使用中」—— 第四服务开着也不影响这一步。 */
    fireEvent.change(credInput(), { target: { value: 'sk-qwen-secret' } });
    fireEvent.click(screen.getAllByRole('button', { name: '保存' })[2]);
    await waitFor(() => expect(qwenBadge().textContent).toBe('已配置'));
    expect(document.body.textContent, '正文里不许回显刚存的凭据').not.toContain('sk-qwen-secret');
    // 三格里唯一亮的就是 qwen（第四服务不参与这套绿点判据），且它标的就是「使用中」。
    const oks = [...document.querySelectorAll('.channel-block .channel-status.ok')];
    expect(oks.map((el) => el.textContent), '绿点只该由云端凭据决定').toEqual(['已配置']);
    expect(qwenBadge().className).toContain('ok');
    expect(document.querySelector('[aria-label="通道三千问通道"] .channel-current')?.textContent).toBe('使用中');
    expect(isLocalSystemEnabled(), '把 qwen 设成当前通道不该顺手接管或关掉本地系统').toBe(true);
  });

  /* 第四服务**只有一个入口**（用户 2026-09-28：「不要展现第四入口了…给我两套链接」）：
     地址栏 `?local=<解锁码>` 那条备用路已经删掉，函数也不再导出。谁想加第二种开启方式，这里会红。 */
  it('没有第二种开启方式：unlockFromLocation 已删除', async () => {
    const mod = await import('../data/localSystem');
    expect((mod as Record<string, unknown>).unlockFromLocation).toBeUndefined();
    // 正向钉子：真入口仍在同一个模块里（否则上面那句只是模块没加载）。
    expect(typeof mod.unlockLocalSystem).toBe('function');
  });

  /* 正例钉子：证明「出现勾选框」真的是那次解锁带来的，而不是这块 UI 恒在。
     未开通时摆出的是密钥框，勾选框与「关起来」都不该存在。 */
  it('没解锁就没有勾选框与「关起来」：只有待输入的密钥框', () => {
    unlockLocalSystem(' ');
    render(<SettingsPage />);
    expect(screen.queryByRole('checkbox', { name: /使用本地系统/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /关起来/ })).toBeNull();
    expect(localKeyInput(), '入口本身必须一直在，否则机主找不到输码的地方').toBeTruthy();
  });

  /* 「两套链接」的复制入口只在已开通后才出现（未开通时机主拿到 #local 也接管不了，给了反而误导），
     且未开通那一节仍然只有密钥框 —— 这条同时钉住「没有第三种入口」。 */
  it('已开通才有「复制两套链接」，未开通时这一格都没有', async () => {
    const { rerender } = render(<SettingsPage />);
    expect(screen.queryByRole('button', { name: /复制两套链接/ })).toBeNull();
    unlockLocalSystem(LOCAL_SYSTEM_KEY);
    rerender(<SettingsPage />);
    expect(await screen.findByRole('button', { name: /复制两套链接/ })).toBeTruthy();
  });
});

/* ── 「两套链接」真正接电的地方：App 挂载时按地址栏锚点选生成路 ────────────────────────
   用户 2026-09-28：「不要展现第四入口了。关闭，给我两套链接一个是原本三样，另一个直接本地」。
   ⚠ 这里跑的是**整棵 App**（不是设置页）：判据必须碰真实组件，自己拼 URL 再调函数的写法
      在「effect 被删掉」这种变异下会全绿（§13.192 踩过）。 */
describe('两套链接：裸链走云端三通道，#local 直接走本机引擎', () => {
  /** jsdom 改 location.hash 不会触发导航也不会同步生效，用 window.location.replace 整段重写。 */
  const setHash = (hash: string) => window.location.replace(window.location.href.split('#')[0] + hash);
  const cloudCredKeys = () => Object.keys(localStorage).filter((k) => k.startsWith('mingli.cred.'));

  afterEach(() => { setHash(''); vi.mocked(navigator.clipboard.writeText).mockReset(); });

  it('已开通 + #local：进来即由本机引擎接管，云端凭据与所选通道一个字没动', async () => {
    unlockLocalSystem(LOCAL_SYSTEM_KEY);
    localStorage.setItem('mingli.provider', 'qwen');
    localStorage.setItem('mingli.cred.qwen', 'sk-existing-qwen');
    setHash('#local');
    render(<App />);
    await waitFor(() => expect(isLocalSystemEnabled()).toBe(true));
    expect(isOfflineMode()).toBe(true);
    expect(localStorage.getItem('mingli.provider')).toBe('qwen');
    expect(localStorage.getItem('mingli.cred.qwen'), '绝不能覆盖 qwen 的密钥').toBe('sk-existing-qwen');
    // 接管之后锚点不该留在地址栏里（和解锁码同理：不留历史、不随分享外泄）
    expect(window.location.hash, '接管成功要抹掉锚点').toBe('');
  });

  /* 这条是整套设计的承重墙：链接**不是第二种开通方式**。未开通的机器打开 #local，
     界面上依旧只有那一格密钥框，引擎也没被打开。正向钉子在同一句里：换成本地区已开通的
     同一台机器（同一个 localStorage），同一个锚点就接管 —— 所以否定式不是恒假。 */
  it('未开通 + #local：不开通、不接管，界面上仍然只有那一格密钥框', async () => {
    setHash('#local');
    render(<App />);
    // 等挂载 effect 真的跑过（首屏是排盘页），否则下面的否定式只是「组件还没渲染」。
    await waitFor(() => expect(document.querySelector('.app-shell')).toBeTruthy());
    expect(isLocalSystemUnlocked()).toBe(false);
    expect(isLocalSystemEnabled()).toBe(false);
    expect(isOfflineMode()).toBe(false);
    expect(cloudCredKeys(), '这条链接也不该写任何云端凭据').toEqual([]);
    // 没接管就不抹锚点：机主还没开通，留着它至少能看出自己走的是哪条链接。
    expect(window.location.hash).toBe('#local');
    // 想用的话只能在设置页那一格粘密钥 —— 界面没有第二种开启方式。
    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    expect(await screen.findByLabelText('本地系统密钥')).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: /使用本地系统/ })).toBeNull();
  });

  it('裸链（原本三样）：即使这台机器已开通也不接管，只保留开通标记', async () => {
    unlockLocalSystem(LOCAL_SYSTEM_KEY);
    setLocalSystemEnabled(true);
    expect(isLocalSystemEnabled(), '前提：刚才还接着管').toBe(true);
    setHash('');
    render(<App />);
    await waitFor(() => expect(isLocalSystemEnabled()).toBe(false));
    expect(isOfflineMode()).toBe(false);
    expect(isLocalSystemUnlocked(), '回到云端不该撤销开通').toBe(true);
    expect(cloudCredKeys(), '云端那条链接也不动凭据').toEqual([]);
  });

  /* 解锁码绝不从 URL 这条路进来：把它写在锚点上，既不开通也不接管。
     （曾经有过 `?local=<解锁码>`，用户否掉了；这条钉的是**它不能再回来**。） */
  it('解锁码写进锚点也不开通：URL 里没有密钥这条路', async () => {
    setHash('#' + LOCAL_SYSTEM_KEY);
    render(<App />);
    await waitFor(() => expect(document.querySelector('.app-shell')).toBeTruthy());
    expect(isLocalSystemUnlocked()).toBe(false);
    expect(isOfflineMode()).toBe(false);
    // 反向钉子：同一串码走设置页那一格确实能开通，所以上面两句否定式不是恒假。
    expect(unlockLocalSystem(LOCAL_SYSTEM_KEY)).toBe(true);
    expect(isLocalSystemUnlocked()).toBe(true);
  });

  /* 「#local 之后必须通知订阅者」的**界面级**判据（与 local-system.test.ts 里那条订阅计数成对）：
     详情页那句横幅读的是 useSyncExternalStore(subscribeLocalSystem, …)，而 #local 这一路走的是
     aiSettings 那颗底层开关（setOfflineMode），它自己不会 notifyLocalChange —— 少了补的那一声，
     存储里的标记翻了、已经挂在页面上的横幅却一个字都不动。
     ⚠ 必须**先 render 再改锚点**：新挂载的组件本来就会读一次 live 值，那种顺序下"没通知"完全看不出来
        （实测：把 App 里那句 notifyLocalChange() 删掉，反序写法仍全绿）。这里用「排盘」tab 退出详情
        —— App 只在切回 chart 时清 openedPersonId，见 App.tsx 的 handleSectionChange。 */
  it('#local 让已经挂在页面上的横幅当场出现：接管必须惊动订阅者', async () => {
    // 这一组原本不碰记录（只测设置页那一格与地址栏接线），所以要先摆一条命盘才进得去详情页。
    initializeMockSession(
      [{ id: 'p1', name: '横幅测试', nameInitial: 'H', gender: 'male', birthSummary: '甲子年' }],
      [{
        person: { id: 'p1', name: '横幅测试', nameInitial: 'H', gender: 'male', birthSummary: '甲子年' },
        record: {
          id: 'p1', name: '横幅测试', gender: 'male', birthYear: 1990, birthMonth: 5,
          createdAt: '2025-01-01T00:00:00.000Z', ...computePillarsFromDate({ year: 1990, month: 5, day: 15, hour: 10 }),
          aiStatus: 'not_started', aiTasks: {},
        } as never,
        aiAnalysis: { status: 'not_started', result: '' },
      }],
    );
    unlockLocalSystem(LOCAL_SYSTEM_KEY);
    render(<App />);
    // 挂到详情页上（此时本机没勾选 ⇒ 未接管 ⇒ 没有横幅）。
    fireEvent.click(screen.getByRole('button', { name: '记录' }));
    fireEvent.click(await screen.findByRole('button', { name: '查看横幅测试' }, { timeout: 4000 }));
    await screen.findByRole('heading', { name: '人物详情' });
    expect(screen.queryByText(/当前为本地系统/), '前提：还没接管，横幅不该在').toBeNull();

    setHash('#local');
    preferLocalFromHash(window.location.hash);
    await waitFor(() => expect(isLocalSystemEnabled()).toBe(true));
    const banner = await waitFor(() => {
      const node = document.querySelector('.ai-mode-note');
      expect(node, '本标签内已接管，详情页横幅却没跟着出现').toBeTruthy();
      return node as Element;
    }, { timeout: 4000 });
    expect(banner.textContent).toContain('当前为本地系统');
  });
});
