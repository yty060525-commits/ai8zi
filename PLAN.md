# AI 批断调度算法优化计划

## 本次范围与定位

- 用户请求：读取当前业务，优化算法。本次围绕可验证的请求重复消耗、调度死锁与取消恢复问题做精准修改；保持确定性排盘、命理评分、提示词和缓存键不变。
- 工程根目录：`C:\Users\yty06\Documents\ai\bbazi\ai 8zi\ai 8zi\ai 8zi`。该目录具有 `.git`、`client`、`server` 与 Wiki；应用当前目录仅有导入本工程编排器的测试探针。候选目录来自 `list_projects`，用户已明确确认“以找到的完整项目为准”。
- 业务：客户端确定性排盘 → 按本命/年度/月度/大运任务编排 → 三通道 AI 解释 → 逐任务保存、缓存复用 → 失败补跑与用户停止。
- 已存在且不属于本次改动的文件：已修改的 `client/src/__tests__/auto-retry-schedule.test.tsx`、未跟踪的 `client/src/__tests__/stop-analysis-recovery.test.tsx`。可运行验收，但不可覆盖或改写。

## 分工与文件归属

| 角色 | 显式配置 | 归属与交付 |
| --- | --- | --- |
| 规划 | GPT-6.1 Sol high (`gpt-6.1-sol`) | 只读调查、建立本计划、定义验收；主代理整合确认 |
| 实现与测试 | GPT-6-Luna medium (`gpt-6-luna`) | `client/src/data/baziOrchestrator.ts`；新增 `client/src/__tests__/scheduler-lifecycle.test.ts`；精准更新 `client/src/__tests__/pool-retry-budget.test.ts` 的扣账结构断言；同步 `docs/wiki/12-客户端-数据层.md` 与 `docs/wiki/51-测试矩阵.md` |
| 最终审查 | GPT-6.1 Sol low (`gpt-6.1-sol`) | 审查实际 diff、测试输出、需求覆盖、原有未提交修改边界；发现问题退回实现 |
| 整合验收 | 主代理 | 维护本计划状态、自修次数与验收记录；不得仅凭子代理报告宣称完成 |

## 实施步骤、依赖与接口

1. **先建立有限重试和取消的回归证据。** 新测试使用真实导出的编排器/并发池与可控 runner、fake timers，覆盖 `retries >= 2` 的恒失败与缺段输出，worker 抛错，以及并发阶段/冷却阶段停止。避免无限微任务使测试自身挂死；测试桩须有可诊断的调用次数上界。
2. **修复主跑重试扣账。** `step` 每次额外 `attemptOnce` 之前扣减同一任务主跑账本。保留 `retries: 0/1` 主跑一次、失败补跑一次的默认成本；明确 `retries` 为历史主跑额度、有效主跑额度为 `max(1, retries)`，更正“首发之外额外重试次数”的误称。保留独立补跑账本与现有并发池一次冷却重发语义；不得借此扩大默认请求次数。
3. **修复并发池拒绝与停止生命周期。** worker 抛错时立即拒绝池 Promise、清理冷却 timer，停止发出排队任务。使用独立错误状态布尔标记，正确处理 `throw undefined/null/0` 等非真值错误原因。按需要为 `fixedMapLimit` 增加可选 `AbortSignal` 参数并接入编排器调用，保持现有调用兼容；取消时中断冷却和重试等待。已完成任务保留，迟到结果不能作为本轮新结果落库。
4. **同步 Wiki 并审查。** 数据层页面记录重试额度和取消契约；测试矩阵记录新增覆盖及命令。只改本次职责涉及的文字与代码。新增循环扣账必然使原有结构断言从扣账点三处/主跑一处变为四处/主跑两处，精准更新对应断言，保留行为调用数断言；不能通过改行形状绕过断言。Wiki 有严格总链接计数判据，新增链接时同步测试矩阵记载的当前读数。

接口约束：`orchestrateBaziAnalysis` 的返回类型与现有选项对象保持兼容；`TaskRunner`、`ProgressFn`、持久化结构与三个 AI 通道保持不变。并发池可选 signal 只追加兼容参数，不修改现有调用方必填接口。本次不修改 429 分类；真实 provider 文案已有“限流”，裸中文状态码的生产缺陷尚未确证。

## 验收条件

- 恒失败/结构缺段在 `retries: 2/3` 下有限完成，逐任务调用数符合主跑额度；`retries: 0/1` 现有默认调用次数和补跑行为不变。
- worker 抛出的普通错误和 `undefined/null/0` 原因均使池立即 settle 为拒绝；队列未继续发出，冷却 timer 无泄漏。
- 并发请求在途、冷却等待、重试等待期间停止均可及时拒绝；已保存结果仍可续跑，停止后无额外排队请求、无迟到结果写回。
- 原有池重发顺序、最大并发、不漏任务、断点续跑、进度与自动重试测试保持通过。
- 新测试证明修复前存在对应缺陷，不能以删断言、跳过失败测试或缩小需求制造通过。
- Wiki 与实际实现一致；最终审查核对代码 diff 和实际测试输出，记录尚未完成项。

## 测试命令

以下前端命令工作目录为工程根目录下的 `client`；本机依赖若不在预期路径，先定位可用依赖，保留命令等价性并记录环境限制。

```powershell
.\node_modules\.bin\vitest.cmd run src/__tests__/scheduler-lifecycle.test.ts --testTimeout=30000
.\node_modules\.bin\vitest.cmd run src/__tests__/pool-retry-budget.test.ts src/__tests__/orchestration.test.ts src/__tests__/concurrency-pool.test.ts --testTimeout=30000
.\node_modules\.bin\vitest.cmd run src/__tests__/stop-analysis-recovery.test.tsx src/__tests__/auto-retry-schedule.test.tsx src/__tests__/retry-gate-real-texts.test.ts --testTimeout=30000
.\node_modules\.bin\tsc.cmd --noEmit
.\node_modules\.bin\vitest.cmd run --pool=forks --maxWorkers=2 --testTimeout=30000
```

服务器回归（工作目录 `server`）：

```powershell
node --test
```

## 执行状态与自修次数

| 阶段 | 状态 | 自修次数 | 验收证据 |
| --- | --- | --- | --- |
| 业务与算法调查 | 完成 | 0 | 确认真实 Git 根；定位 step 未扣额外尝试余额、池错误分支永不 finish |
| 计划 | 完成，主代理已确认 | 0 | 本文件；用户已确认工程路径 |
| Luna 实现与相关测试 | 完成 | 1 / 2 | 修复前安全回归 4/4 失败；修复后新测试 9/9，扣账与新测试 21/21 通过；审查修正计时器断言空转后重跑 9/9 通过 |
| 扩展回归与类型检查 | 完成取证，无本次新增失败；存量阻塞保留 | — | 全量 839 通过/3 原有失败，116 文件，418.71 秒；类型检查仅原有 stop-analysis-recovery.test.tsx:122 的 TS2339 |
| GPT-6.1 Sol low 最终审查 | 本次限定范围通过 | — | 亲读实际 diff 与最终日志，核对默认成本、错误/取消路径、原有文件 SHA256；未发现新增阻塞问题 |
| 主代理验收 | 本次调度优化完成 | — | 独立复跑新增测试 9/9、完整前端；核对已知缺口与类型错误均非本次新增；未提交或部署 |

主代理已跑基线 `orchestration + retry-gate-real-texts + stop-analysis`：29 项通过、1 项超时。唯一超时为 retry-gate 机制用例：默认五秒低于冷却多波次理论九秒；使用 `--testTimeout=30000` 原样重跑后 3 文件、30 项全部通过，退出码 0（9.89 秒），未修改行为断言。服务器 `node --test`：141 项通过，退出码 0（约 1.77 秒）。

存量问题取证（修改业务代码前）：单独运行 `delivered-files-in-tree.test.ts` 为 76 通过、3 失败，正是 Wiki 已登记的 `scopeNotes.ts`、`localAnalysis.ts`、`localSystem.ts` 不在 HEAD 树，未删除或跳过断言。类型检查另发现原有未跟踪的 `stop-analysis-recovery.test.tsx:122` 将 `HTMLElement` 当作按钮读取 `disabled`，报 TS2339；该文件在本次范围外，保留用户现有内容。全量按 Wiki 要求限制 forks/两 worker，避免这台机器默认过多 worker 的内部错误。

原有未提交测试的 SHA256（本次不得改写）：`auto-retry-schedule.test.tsx` 为 `2063B6AD382AD2996D2BF98CAE8ABE20EEEC5DAE58A3B9E0C39024BB65287290`；`stop-analysis-recovery.test.tsx` 为 `17D4D0CE93CBEA6CB4875609D43498D754962148EF3190B12CAF1DDE2DBF37DE`。

实现证据：修复前安全夹具使用调用次数触发 abort 的硬上界，实际为 4 项失败：较高额度重试越界后被安全中止、普通 worker 抛错不收尾、falsey 抛错错误地成功、冷却阶段停止不收尾。修复后覆盖 retries:2/3、缺段 completed、普通/falsey 拒绝、并发与冷却停止、重试等待取消、进度队列停止、timer/listener 清理，共 9 项通过。主跑普通失败每条次数为 retries:1 → 2（含补跑）、retries:2 → 3、retries:3 → 4；限流/超时仍保留池内最多一次冷却重发的历史语义。Wiki 扫描 `OK 11 446 0`。审查发现最初的 clearTimeout spy 可能命中测试 helper 自己的计时器，已移动至同步 abort 之后、helper 之前断言，并加 listener 清理断言；本轮计为自修 1/2。

最终验收（2026-10-17）：主代理独立运行新增生命周期回归 9/9 通过（977ms，`.scratch/scheduler-lifecycle.log`）；完整前端为 `Test Files 1 failed | 115 passed (116)`、`Tests 3 failed | 839 passed (842)`（418.71s，`.scratch/scheduler-full.log`）。唯一三个失败与修改前的缺失文件判据一致；类型检查日志 `.scratch/scheduler-types.log` 仅有上述原有 TS2339。两个原有测试文件 SHA256 与初始值一致。GPT-6.1 Sol low 已亲读最终日志与冻结 diff，判定本次限定范围可验收；不代表存量功能缺口、类型检查或整个项目已全部通过。

自修按一次修改后运行相关测试计数，最多两轮；仍失败交由 GPT-6.1 Sol high 诊断修复。出现环境/既有测试失败需记录原始输出并区分本次引入与原有问题，不降低验收标准。

## 续轮：恢复三项历史缺失功能并清除类型阻塞（2026-10-17）

### 范围、历史基线与非目标

用户已追加要求：继续修复全量中余下三项历史失败与一处类型错误，验收为全量前端测试、类型检查均通过。三项失败不是三个空文件问题：点评的存储、详情入口和删盘清理，以及本地规则批断的解锁、开关、运行、结果来源与切换复用整条链均被历史回退摘掉。只创建同名文件不算恢复。

历史证据：`lost-scope-notes` 指向 `8fb8d03`（2026-09-26），`snap-20260928-2022-pre-rollback` 指向 `70d0f5f`（2026-09-28）。两者均保存三模块与六份核心测试；点评模块相同。本地批断已从前者 v2 演进到后者 v6，后者有时段关系、喜忌、爱情解释、版本戳与补全修正，不能把早期版本当最新恢复。恢复以较新快照的三模块和相应核心行为为参照，只移植必要接线，绝不整份覆盖当前业务文件。解锁交互同样按较新快照：设置页独立密钥框，`#local/#cloud` 选择方式；不恢复已被后续方案替换的 `?local=密钥` 入口。

本轮恢复范围为：公开逐条点评；可用的本地规则批断及独立本地预览；本机开通/启停/收起/订阅；本地/云端来源区分、切换重算与同源续跑；瘦身命盘时段补全；与其必需的版本戳契约。快照中新出现的本地聊天（三份 local-chat 套件及 chatEngine 离线路由）、更丰富断语专项重校或其他 UI/云端/排盘改动不随快照整批引入。本地批断在此范围必须真实可达，不能以“仅模块导出”替代产品入口。

### 分工与文件归属

| 角色 | 显式配置 | 文件与输出 |
| --- | --- | --- |
| 规划 | GPT-6.1 Sol high (`gpt-6.1-sol`) | 只读历史调查；仅追加本节 PLAN，不改业务源码 |
| 点评与账本实现、测试和至多两轮自修 | GPT-6-Luna medium (`gpt-6-luna`)，notes owner | 仅新增 `client/src/data/scopeNotes.ts`、`client/src/features/person/ScopeNoteBox.tsx`、两份 scope-notes 核心测试；精准更新 `delivered-files-in-tree.test.ts` 与 stop-analysis 类型一行；不改 PersonDetail、仓储、样式与 Wiki |
| 本地系统实现、接线、测试和至多两轮自修 | GPT-6-Luna medium (`gpt-6-luna`)，local owner | 新增 `client/src/data/{localAnalysis,localSystem}.ts`；精准接线 `aiSettings.ts`、`baziOrchestrator.ts`、`clientRepository.ts`、`types/domain.ts`、`features/person/PersonDetail.tsx`、`features/settings/SettingsPage.tsx`、`main.tsx`、`styles.css`；四份 local 核心测试与 `local-orchestration.test.ts`；同步 Wiki。统一负责把 notes 组件插入详情与删盘清理，避免共享文件并改 |
| 失败升级 | GPT-6.1 Sol high (`gpt-6.1-sol`) | 同一 Luna 修改并运行相关测试累计两轮仍失败时接管诊断和修复 |
| 最终审查 | GPT-6.1 Sol low (`gpt-6.1-sol`) | 亲读 diff、真实日志、HEAD 提交内容及本轮前后 dirty 边界，发现问题返回实现 |
| 整合和验收 | 主代理 | 冻结初始 dirty、整合、本地精准提交、独立复跑与本节状态更新 |

六份核心历史测试为 `scope-notes.test.ts`、`scope-notes-ui.test.tsx`、`local-analysis.test.ts`、`local-system.test.ts`、`local-system-entry.test.tsx`、`local-system-design.test.tsx`。可为当前中文按钮、可达入口与现有接口精准适配测试查询，保留原行为断言，不把最新 UI 改回快照的英文显示。编排集成建议单列 `local-orchestration.test.ts`，从历史 orchestration 中移植本地专属行为，而不是覆盖现有 orchestration 套件。`stop-analysis-recovery.test.tsx:122` 仅将 button 查询结果收窄到 `HTMLButtonElement`，其余用户内容保持不变。

初始 dirty 边界仍包括上一轮编排器、pool 测试、scheduler lifecycle、两页 Wiki 和本 PLAN；另有用户 `auto-retry-schedule.test.tsx` 与 `stop-analysis-recovery.test.tsx`。本轮不得覆盖前者，也不得整体恢复任何已有文件。尤其 `baziOrchestrator.ts` 必须在当前工作副本的有限额度、falsey 错误、AbortSignal 和 timer/listener 修复之上融合本地 runner。

两位 Luna 的共享接口冻结如下：notes owner 导出命名组件 `ScopeNoteBox({ recordId, taskId, scopeLabel }: { recordId: string; taskId: string; scopeLabel: string })`，内部依赖 scopeNotes CRUD，不依赖 PersonDetail 或 describeScope，避免循环。local owner 在完成正文的结果下调用 `<ScopeNoteBox recordId={record.id ?? ''} taskId={item.task.taskId} scopeLabel={describeScope(item, record)} />`，仓储统一导入 `deleteScopeNotesForRecord` 接入成功删除记录链，并追加 `.note-*` 必需样式。notes owner 测试可暂待 local owner 接线；两人互相通报接口就绪，不改对方文件。local owner 的七套最终文件名应通知 notes owner 登记 CRITERIA；账本提交由主代理统一做，两位 Luna 不自行提交。主代理已保存 `.scratch/remaining-start.patch` 和 `.scratch/remaining-stop-analysis-before.tsx`，初始 index 为空。

### 依赖、接口与分阶段执行

1. **冻结基线，恢复独立模块。** 记录本轮前 status/diff 与关键文件摘要；导出较新快照三模块、六套核心测试供逐段参照。恢复真实点评 CRUD 与规则引擎，保留损坏存储/配额失败、同盘不同任务隔离、空点评删除、500 字上限的历史契约。localSystem 只存本机标记，不写 provider 凭据、不扩 AiProvider/ServiceId、不修改服务器/Rust 通道选择。
2. **恢复点评完整链，先跑独立回归。** 当前详情每一条有正文的已完成批断（含总结）提供点评编辑/保存/取消/修改/删除；记录删盘的唯一仓储出口连带清理点评。点评不进入 record、不进入同步 payload、不进入复制正文，未开通本地系统也可以使用。只追加点评必要样式，不改相邻排版。
3. **恢复本地批断链并与当前调度融合。** aiSettings 只添加本机开关存取与测试清理；domain 仅兼容追加 `BaziTaskResult.source?: 'cloud' | 'local'`，保留 HEAD 的 required status、精确交运日、现有字段。设置页与详情共用 localSystem 的状态订阅；独立预览动态加载引擎，本命/总结/后天调整真实出文，预览不覆盖云端结果。主批断启动时冻结本轮模式，启用本地时走规则 runner，全部结果标 local，不触发 provider；停用或收起后按云端语义重算，不能复用 local 旧结果。同源完成结果仍可续跑复用，缺 source 的历史结果视作 cloud。详情页语气缓存与已有完成闸门同时检查来源，防止 UI 提前返回绕开编排器。缺时段事实返回明确不可重试的 local_unavailable，不制造正文、不自动回退云端。保留当前错误文案/三端凭据口径，新增用户可见文字遵守当前中文清洗规则。
4. **补全与版本一致性。** 复用现有确定性排盘与北京年月口径补齐瘦身数据；localSystem 通过动态 import 调排盘器，避免 orchestrator→localSystem→nonAiCalculator 初始化环。一次分析固定 now；必要时给补全函数追加兼容的可选时刻参数，不能让本地引擎与任务窗各读不同日期。较新快照的版本戳只管本机本地结果的陈旧识别，不把本机解锁/开关戳传到服务器。历史规则中的大运查找优先当前 task.decade，保留当前“与十年窗口有交集”的任务口径。不要为旧测试恢复已废弃的任务数/decadeSlots 计算。
5. **迁移交付账本，精准提交后终验。** 三项正式加入 DELIVERED，并把六套核心行为判据与新本地编排判据登记 CRITERIA。原 GAPS 三条保留作“历史缺口恢复义务表”，明确已恢复身份；保留 claimedDone=true、严格三条数量与原路径，不能留空或删除原三项。原 basename `toContain(code)` 与 fullpath 的比较本身有误，精准改为完整 `file` 比较。把旧“每项确实不在 HEAD”的负断言升级成“历史义务每项均在 DELIVERED、在 HEAD，且各自核心行为判据在 CRITERIA/HEAD”的正向闭合断言，同时更新 describe/注释为恢复后语义。保留读取 HEAD、判据自身与 HEAD 字节一致、三本账防掏空、标签存在和独立历史等闸门；HEAD 自证仍钉历史义务表恰三条，并检查 HEAD 字节中三路径在 DELIVERED 登记、核心行为测试在 CRITERIA 登记，不能仅以“GAPS 字样仍在”代替恢复凭证。闸门不改读 working tree/index，不以空数组或删除断言转绿。

本地 HEAD 提交的技术原因：`trackedPaths()` 调用 `git ls-tree HEAD`，MARKERS/判据自证用 `git show HEAD:`，且账本对自身源码作工作副本与 HEAD 的逐字比较。因此代码只留在工作副本或只 git add，功能测试可绿但交付账本必红；完成全绿需要一次精确本地提交，不需要 push 或部署。不得改闸门改读 working tree/index，也不得删除 claimedDone/skip 来绕过。

最小提交范围为本轮新增模块/功能测试、delivered 账本、必要生产接线、类型修正和对应 Wiki/计划。主代理整合决定：同一聊天上一轮已验收的编排器修复及其 pool/scheduler 判据也随本轮接线一起提交，以保证 HEAD 中的本地接线使用已验收的取消/有限重试实现；这些是本聊天已授权且由代理创建的改动，不能将依赖它们的接线单独放进旧调度代码而声称提交已验证。只显式暂存列出的文件并检查 `git diff --cached`；禁止 `git add -A`，原有 `auto-retry-schedule.test.tsx` 用户 WIP 必须保持未提交且摘要不变，任何其他无关 WIP 均排除。`stop-analysis` 原先未跟踪，本轮已授权修复其类型错误，纳入提交时保留它的其他全部内容，并与 `.scratch/remaining-stop-analysis-before.tsx` 逐字对照确认仅类型一行变化。没有 push 或部署。

按阶段独立跑相关测试便于定位；阶段一/二通过也不代表用户要求完成。阶段三量大时可先完成点评与本地模块，再完成 UI/编排，最后才迁移账本与提交；不能在中间阶段将整项标交付。Luna 自修预算按“修改后跑相关测试”计，阶段初次实现验证不算自修，失败后的修复循环最多两轮，不能删断言或降低能力。

### 本轮验收与命令

- 点评真实 UI CRUD、刷新持久化、分盘分任务隔离、取消不写、删盘清理、配额错误可见；record/复制内容中无点评。
- 设置页可开通/启用/停用/收起；错误密钥不改状态，不改三云端凭据/默认通道。未开通时不启用本地 runner；本机标记不进 record。
- 真实本地引擎产出 baseline/annual/monthly/decade/adjustment/overview 的必需小节，含具体年份节点；无 provider 调用；缺数据如实失败且不重试。原始结果来源标注清楚，经现有中文渲染/复制管线通过。
- 模式切换双向覆盖、同源复用、一轮中途改开关保持启动模式、设置变更后详情状态及时更新、旧版本本地结果失效重算；停止/续跑/限流与上一轮调度生命周期回归均保持通过。
- 交付账本保留原三功能的 HEAD 正向路径与功能判据；本轮代码进入本地 HEAD 后交付套件、前端全量、类型/构建、服务器测试、Wiki 链接全部通过。日志必须来自本轮实际运行，不凭历史计数推算。

工程根运行 `node scripts/check-wiki-links.cjs`，同步 `docs/wiki/11-客户端-特性层.md`、`12-客户端-数据层.md`、`31-类型契约.md`、`51-测试矩阵.md`，必要时只在 `01-架构总览.md` 追加流程说明；文档新增链接后取扫描器实际条数更新测试矩阵，不能口算。参阅上方配套 Wiki 入口与页面链接。

client 目录命令（本机等效 `.cmd` 可执行路径）：

```powershell
.\node_modules\.bin\vitest.cmd run src/__tests__/scope-notes.test.ts src/__tests__/scope-notes-ui.test.tsx --testTimeout=30000
.\node_modules\.bin\vitest.cmd run src/__tests__/local-analysis.test.ts src/__tests__/local-system.test.ts src/__tests__/local-system-entry.test.tsx src/__tests__/local-system-design.test.tsx src/__tests__/local-orchestration.test.ts --pool=forks --maxWorkers=2 --testTimeout=30000
.\node_modules\.bin\vitest.cmd run src/__tests__/scheduler-lifecycle.test.ts src/__tests__/pool-retry-budget.test.ts src/__tests__/orchestration.test.ts src/__tests__/stop-analysis-recovery.test.tsx src/__tests__/auto-retry-schedule.test.tsx src/__tests__/provider-follow-contract.test.ts src/__tests__/cache-key-cross-end.test.ts src/__tests__/wiki-links-reachable.test.ts --pool=forks --maxWorkers=2 --testTimeout=30000
.\node_modules\.bin\tsc.cmd --noEmit
npm run build
.\node_modules\.bin\vitest.cmd run src/__tests__/delivered-files-in-tree.test.ts --testTimeout=30000
.\node_modules\.bin\vitest.cmd run --pool=forks --maxWorkers=2 --testTimeout=30000
```

服务器目录仍用 `node --test`；本次不改变云端/桌面协议生产实现，三端 parity 测试必须持续通过。无需生成或声称真实云端 AI 视频/接口产物，本轮真实输出证据为本地引擎正文与实际 UI/编排交互回归。

### 本轮状态与自修记录

| 阶段 | 状态 | 自修次数 | 证据/待办 |
| --- | --- | --- | --- |
| 规划与历史审计 | 完成，主代理已整合 | 0 | 采用较新快照，两个 Luna 按独立文件归属并行；保留上一轮记录 |
| Luna 点评/账本/类型恢复 | 完成并冻结 | 0 / 2 | scope 两套件 23/23，`.scratch/restore-notes-suites-final.log`；stop 仅类型一行变化；账本提交前 74 通过/15 个 HEAD 待提交失败，无绕过 |
| Luna 本地引擎与统一接线 | 两轮后未通过，已按规则移交 | 2 / 2 | 初始 45 失败/28 通过；自修1后 27 失败/46 通过；自修2后 15 失败/59 通过，见 client/.scratch/restore-local-integrated-2.log；Luna 已停止编辑 |
| Sol high 诊断修复接管 | 返修完成并冻结，重新全量待验 | — | 明确配置 GPT-6.1 Sol high；App.tsx 接管模式挂载/hashchange，main 恢复原字节；修补全、中文显示/复制、来源与版本复用、旧 local 读清理及独立云端别名保留。8 套 122/122；审查新增版本懒加载期间停止竞态后，controller 提前建立并按本轮身份收尾。首轮全量要求保留的原 reset 已恢复于首 await 前；最新取消相关 34/34、auto 结构 4/4、tsc 退出 0，low 已复审通过 |
| Wiki 与交付账本迁移、本地精准提交 | 首次提交完成，补充返修提交待执行 | — | 源码提交 7948962，显式暂存 28 文件，HEAD 交付账本 89/89；仅原 auto WIP 未提交；点评 Wiki 流程补充中，无 push/部署 |
| 全量、类型/构建、服务器与 Wiki 终验 | 首轮全量未通过，返修后重跑 | — | 首轮 953 通过/1 失败、123 文件、417.64 秒；类型/构建、服务器 141、Rust 21 及 Wiki 扫描均通过；唯一 auto 源码结构判据需恢复原 reset，不能删断言或改用户 WIP |
| GPT-6.1 Sol low 最终审查 | 源码审查中，终验日志待补 | — | 亲读 diff 发现旧 local 误清独立 cloud 别名、懒加载停止两项 P2，均退回 Sol high 修复并补行为回归；最终需 HEAD 与全量/type/build 证据 |
| 主代理独立验收 | 待执行 | — | 未完成本表全部必要阶段前不得宣称全绿 |

本轮服务器回归已由主代理独立执行：`node --test` 141/141 通过，退出码 0，约 1.61 秒（`.scratch/restore-server.log`）。原有 auto WIP 的 SHA256 仍为 `2063B6AD382AD2996D2BF98CAE8ABE20EEEC5DAE58A3B9E0C39024BB65287290`；stop 测试对照备份仅新增 `as HTMLButtonElement`，无断言或其余内容改动。

接管证据：`client/.scratch/restore-local-sol-eight-final.log` 为 8 文件 122/122（66.88 秒）；末次 UI 停止竞态变更相关短测 `client/.scratch/restore-local-sol-stop-final.log` 为 3 文件 34/34（9.19 秒），`client/.scratch/restore-local-sol-tsc-final.log` 对应退出 0。主代理独立复跑点评 23/23（`.scratch/restore-notes-root.log`），Wiki 扫描 `OK 11 456 0`。这些短测不代替下方尚待完成的全量与 HEAD 账本验收。按 Wiki 的三套测试口径，主代理另执行 Rust `cargo test --lib`；不修改 Rust 源码。

首次 HEAD 终验：`.scratch/restore-delivered-head.log` 为 89/89，`.scratch/restore-types.log` 对应 `tsc --noEmit` 退出 0，`.scratch/restore-build.log` 对应 `tsc -b && vite build` 退出 0；`.scratch/restore-rust.log` 为 21/21、退出 0。首轮全量 `.scratch/restore-full.log` 实际退出 1（953 通过/1 失败，123 文件，417.64 秒），唯一失败为原 auto 用户 WIP 的“三处停止意愿重置”结构判据：取消竞态修复时删除了带注释的冗余 reset。复核可在 controller 同步建立处、首个 await 之前恢复原句而不重开停止窗口；Sol high 已接回最小返修，用户 WIP 不改。完整全量需在此返修提交和构建之后重新运行，不能以其余 953 项通过替代。

该返修仅恢复 PersonDetail 一行；`client/.scratch/restore-local-sol-reset-lifecycle.log` 为 34/34（8.77 秒），`client/.scratch/restore-local-sol-reset-structure.log` 通过指定的 4 条结构测试（其余 6 条因 `-t` 未选择，仅为定向证据），`client/.scratch/restore-local-sol-reset-tsc.log` 对应退出 0。low 亲读实际 diff 与日志，确认同步 reset 不复活等待中的旧轮；必须继续不筛选的全量测试。

## 配套 Wiki

- [Wiki 入口](docs/wiki/README.md)
- [架构与完整业务流程](docs/wiki/01-架构总览.md)
- [客户端数据层：编排器、通道与仓库](docs/wiki/12-客户端-数据层.md)
- [类型与接口契约](docs/wiki/31-类型契约.md)
- [运行与构建](docs/wiki/41-构建与发布.md)
- [测试验收与已知缺项](docs/wiki/51-测试矩阵.md)
