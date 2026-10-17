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
| Sol high 诊断修复接管 | 完成并冻结 | — | 明确配置 GPT-6.1 Sol high；修补全、中文显示/复制、来源与版本复用、旧 local 读清理、云端别名保留及版本加载停止窗口；原 reset 恢复于首 await 前，相关短测与完整重跑全部通过 |
| Wiki 与交付账本迁移、本地精准提交 | 完成 | — | 7948962 提交 28 文件，0f43e2f 提交一行返修及点评 Wiki；HEAD 交付账本 89/89；仅原 auto WIP 未提交，无 push/部署 |
| 全量、类型/构建、服务器与 Wiki 终验 | 完成，全部通过 | — | 第二轮前端 954/954、123/123 文件、517.48 秒、退出 0；类型/构建退出 0；服务器 141/141、Rust 21/21；Wiki 扫描 OK 11 465 0，文档套件 4/4 |
| GPT-6.1 Sol low 最终审查 | 源码与需求覆盖通过 | — | 亲读实际 diff、HEAD、最终全量/type/build/server/Rust 日志；两项 P2 均返修后复审关闭，当前无未解决 P1/P2；最终结果文档收口后仅复核文档与版本产物 |
| 主代理独立验收 | 完成 | — | 主代理亲跑不筛选的前端全量、类型/构建、server/Rust，核对 HEAD 账本、stop 仅类型一行、auto 原摘要及未提交边界；本节保留首轮失败证据 |

本轮服务器回归已由主代理独立执行：`node --test` 141/141 通过，退出码 0，约 1.61 秒（`.scratch/restore-server.log`）。原有 auto WIP 的 SHA256 仍为 `2063B6AD382AD2996D2BF98CAE8ABE20EEEC5DAE58A3B9E0C39024BB65287290`；stop 测试对照备份仅新增 `as HTMLButtonElement`，无断言或其余内容改动。

接管证据：`client/.scratch/restore-local-sol-eight-final.log` 为 8 文件 122/122（66.88 秒）；末次 UI 停止竞态变更相关短测 `client/.scratch/restore-local-sol-stop-final.log` 为 3 文件 34/34（9.19 秒），`client/.scratch/restore-local-sol-tsc-final.log` 对应退出 0。主代理独立复跑点评 23/23（`.scratch/restore-notes-root.log`），Wiki 扫描 `OK 11 456 0`。这些短测不代替下方尚待完成的全量与 HEAD 账本验收。按 Wiki 的三套测试口径，主代理另执行 Rust `cargo test --lib`；不修改 Rust 源码。

首次 HEAD 终验：`.scratch/restore-delivered-head.log` 为 89/89，`.scratch/restore-types.log` 对应 `tsc --noEmit` 退出 0，`.scratch/restore-build.log` 对应 `tsc -b && vite build` 退出 0；`.scratch/restore-rust.log` 为 21/21、退出 0。首轮全量 `.scratch/restore-full.log` 实际退出 1（953 通过/1 失败，123 文件，417.64 秒），唯一失败为原 auto 用户 WIP 的“三处停止意愿重置”结构判据：取消竞态修复时删除了带注释的冗余 reset。复核可在 controller 同步建立处、首个 await 之前恢复原句而不重开停止窗口；Sol high 已接回最小返修，用户 WIP 不改。完整全量需在此返修提交和构建之后重新运行，不能以其余 953 项通过替代。

该返修仅恢复 PersonDetail 一行；`client/.scratch/restore-local-sol-reset-lifecycle.log` 为 34/34（8.77 秒），`client/.scratch/restore-local-sol-reset-structure.log` 通过指定的 4 条结构测试（其余 6 条因 `-t` 未选择，仅为定向证据），`client/.scratch/restore-local-sol-reset-tsc.log` 对应退出 0。low 亲读实际 diff 与日志，确认同步 reset 不复活等待中的旧轮；必须继续不筛选的全量测试。

最终验收（生产代码 HEAD `0f43e2f`）：主代理执行原样、不筛选的完整前端，`.scratch/restore-full-final.log` 实际为 `Test Files 123 passed (123)`、`Tests 954 passed (954)`，517.48 秒，退出码 0，无跳过汇总。`.scratch/restore-build-final-code.log` 对应 `tsc -b && vite build` 退出 0；独立 `tsc --noEmit` 和最后返修后的类型检查也均退出 0。服务器 141/141（`.scratch/restore-server.log`）、Rust 21/21（`.scratch/restore-rust.log`）。Luna 补齐点评的 UI/存储/隐私/删盘 Wiki 后扫描 `OK 11 465 0`，文档回归 4/4（`.scratch/restore-notes-wiki-suite.log`）。GPT-6.1 Sol low 已亲读上述真实日志及提交边界，确认本轮需求覆盖与源码无未解决 P1/P2；之后只收口 PLAN/Wiki 验收记录，并复核最终文档提交的构建版本产物。

## 配套 Wiki

- [Wiki 入口](docs/wiki/README.md)
- [架构与完整业务流程](docs/wiki/01-架构总览.md)
- [客户端数据层：编排器、通道与仓库](docs/wiki/12-客户端-数据层.md)
- [类型与接口契约](docs/wiki/31-类型契约.md)
- [运行与构建](docs/wiki/41-构建与发布.md)
- [测试验收与已知缺项](docs/wiki/51-测试矩阵.md)

## 续轮：排盘时刻、十神与关系事实校正及扫描去重（2026-10-17）

### 范围、证据与基线

用户要求继续检查八字排盘和本地批断核心算法，优化准确性与性能，并保持全量测试、类型检查与构建通过。本轮基线 HEAD 为 `21e1703`；上一轮实际前端 954/954、123 文件，服务器 141/141、Rust 21/21，类型与构建退出 0。本轮必须重新取证，不以此历史计数替代验收。唯一原有未提交文件 `client/src/__tests__/auto-retry-schedule.test.tsx` 不得覆盖、暂存或提交，SHA256 应一直为 `2063B6AD382AD2996D2BF98CAE8ABE20EEEC5DAE58A3B9E0C39024BB65287290`。

已审读架构、数据层、确定性排盘、本地规则引擎及编排器，收敛为以下可验证问题：

1. `computePillarsFromDate` 虽接收出生时分，却以正午取年/月柱；`ChartPage` 保存时又只保留修正后的出生日期，`computeLuckStart` 因而继续取正午。例：二〇二六年二月四日北京时间三点在立春前，正午取法却排为立春后年/月柱。香港天文台二〇二六历书给出当日立春约四点零二分；精确秒界以依赖库交节数据作边界回归，不用分钟级历书去断言秒值。若只改四柱、不改起运，立春日年干阴阳还可能让大运排列方向与 `getYun` 取的顺逆起运基点相反。
2. `localAnalysis.groupElements` 将一组正偏十神误当作两个相邻五行。内部 `ELEMENTS`、`stemElementIndex` 与 `stemGodOf` 的代数已证明正偏只差阴阳，同组只有一个五行：庚日财星只有木，现返回木、火；乙日财星只有土，现返回土、金。财运措辞与配偶星判定都实际消费此函数；男乙日遇辛金本为七杀，却可能误写妻星引动。
3. `factBetween` 的三合同余判断没有排除相同地支，子与子也写入 `sanHe`；同模块 `pairHits` 却已要求至少两个不同支，事实与明细自相矛盾，本地配偶宫解释亦会消费错误三合事实。
4. 出生月搜索完整失败后，扩展搜索再次扫描原月份。现有完全无匹配夹具（一九〇〇年一月配甲子、丙寅、庚午、壬午）会重复检查原月三十一天：合计一百零二个候选；保留顺序并跳过已失败原月可降为七十一个唯一候选。仅做这项有界去重，不缓存带三合/三刑集合上下文的关系计算。
5. 时间精度进入起运后，任务及聊天缓存必须区分同四柱而不同出生时分的记录。已核实服务端 `cacheKey` / `chatCacheKey` 与 Rust `cache_key` / `chat_cache_key` 只拼性别、四柱、任务或问题、出生年和语气档，**没有对完整 payload 作哈希**；仅更改正文输入不能让缓存自然分叉。

扫描整合复查补充：原 `new Date(year, month, 0).getDate()` 会受宿主跳日影响。主代理在真实 `TZ=Pacific/Kiritimati` 子进程读得 `new Date(1994,12,0)` 为一九九五年一月一日，日号 1，UTC 月末日号则为 31，导致一九九四年十二月的手录反查窗口被截短。chart owner 在既有扫描归属内复用 `daysInMonth` 的 UTC 口径，并添加该月下旬反查及真实异时区回归；不新增时间策略或抽象。

参考依据：[香港天文台二〇二六历书](https://www.hko.gov.hk/en/gts/astron2026/files/HKO_almanac_2026.pdf)、[6tail 干支 API](https://6tail.cn/calendar/lunar.ganzhi.html)。本轮“准确性”指时间边界、符号代数、数据传递与文本事实一致；不宣称传统命理预测有实证准确性。不调整扶抑权重、格局取法、真太阳时仅经度差的既定口径或子时开关。

### 角色、文件归属与接口冻结

| 角色 | 显式配置 | 唯一文件归属及输出 |
| --- | --- | --- |
| 规划 | GPT-6.1 Sol high（`gpt-6.1-sol`） | 只读审计，仅追加本节 PLAN；冻结范围和验收 |
| chart 实现、测试与自修 | GPT-6-Luna medium（`gpt-6-luna`） | `features/chart/nonAiCalculator.ts`、`ChartPage.tsx`、`types/domain.ts`、`features/person/PersonDetail.tsx`、`data/clientRepository.ts`、`data/localSystem.ts`；相关出生/修柱/仓储/导入导出/本地补算回归及新核心回归；统一维护全部本轮 Wiki |
| local 实现、测试与自修 | GPT-6-Luna medium（`gpt-6-luna`） | 仅 `data/localAnalysis.ts`、现有 `local-analysis.test.ts` 与新增本地代数/爱情回归；不改 localSystem、编排器、时间契约或 Wiki；把文档要点交 chart owner |
| cache 实现、测试与自修 | GPT-6-Luna medium（`gpt-6-luna`） | 仅 `server/ai.mjs`、`server/chat.mjs`、相应 server/test 缓存及协议判据、`client/src-tauri/src/lib.rs`、`client/src/data/chatEngine.ts` 的 Tauri 聊天缓存元数据、客户端跨端 cache/parity 必要判据；不改 domain、UI、仓储、引擎或 Wiki；把文档要点交 chart owner |
| 两轮仍失败后的诊断修复 | GPT-6.1 Sol high（`gpt-6.1-sol`） | 同一 Luna 自修两轮仍不通过时接管对应范围 |
| 最终审查 | GPT-6.1 Sol low（`gpt-6.1-sol`） | 亲读实际 diff、真实测试日志及需求覆盖，不采信实现者报告作为完成证据 |
| 整合与验收 | 主代理 | 冻结 WIP、统一暂存/提交（若需）、独立跑最终门禁、更新状态 |

以上客户端生产路径均相对 `client/src`。新增测试文件名由对应 owner 提前通报主代理，不得并改另一 owner 的文件。所有 owner 不自行提交，不使用 Qoder 或未经本项目授权的 Pi/外部模型。

主代理补充 chart 归属：`client/src/__tests__/delivered-files-in-tree.test.ts` 只在 CRITERIA 登记新核心判据 `chart-time-accuracy.test.ts`、`birth-time-cache-cross-end.test.ts`；保留原 GAPS、HEAD、自身字节一致等全部闸门。该套由主代理统一精准提交后再验，不把提交前预期的 HEAD 缺失当作功能失败或改闸门转绿。

冻结时间接口为 **一个**可选 `NonAiChart.birthTime?: { year: number; month: number; day: number; hour: number; minute: number }`。它表示农历转换完成后、经度修正前的完整朴素北京时间。`calculateNonAi` 输入兼容添加同型可选字段；`computePillarsFromDate` 的 options 兼容添加 `calendarTime?:` 同型字段。类型可复用一个明确的小接口，不能增加多个相互重叠的时间字段。

- 自动排盘先保存原始公历北京时间，再按现有经度口径修正另一份 `input`；`calendarTime` 只负责交节年/月柱，修正后 `input` 继续负责日柱、既有子时换日和时柱。未传 `calendarTime` 的函数调用按自身实际时分判交节；日柱不能交给库的默认二十三点换日行为重新定义。
- `birthDay` 和现有记录出生年月仍保持修正后日期的原语义；`birthTime` 可以因经度修正跨日而与它不同。`calculateNonAi` 用独立的原北京时间 Solar 对象调用 `getYun`，并以该原日期为起运跨度相加的锚点；显示公历/农历/称骨继续遵守原来的修正后日期契约。不得将修正后的钟点再次当作节气绝对时刻。
- 缺少 `birthTime` 的旧记录与手录记录保留正午近似，不伪造出生时分，也不擅自重排其已存四柱。新字段必须随 prune/hydrate、本地补算、重新排盘及 JSON/SQLite/Tauri/服务端往返保留。字段由真实时刻构造；外部备份带入的非法时刻不能被静默当作精确值。
- 手动“修正四柱”任一柱确实变化时，清除旧 `birthTime`，防止旧钟点为新四柱提供虚假精确起运依据；完全无变化可保留。重新排盘与自动 hydrate 不属于手工修柱，应原样传递该字段。不得改变当前手录四柱的其他校验与清除分析结果行为。
- cache owner 在既有各端任务与聊天缓存版本上分别升级，末尾追加规范出生时刻签名，旧盘为空签名；同一合法时刻在 JS/Rust 字节一致，分钟变化会分叉。保持 `[版本, 模型, 性别, 年柱, 月柱, 日柱, 时柱, …]` 段位，现有 `chart_sig` 按盘删除/索引、任务检索及语气档语义继续成立。Tauri `ChatRequest` 只新增缓存用可选 `birthTime` 元数据，由 `chatEngine` 传递；原始 `birthTime` 不加入 prompt/shared natal，不扩展其他聊天行为，只让已存在的起运事实随真实输入正确变化。

### 实施顺序与验收

1. **先建立红测。** 各 owner 在实现前以新增行为判据证明对应旧行为失败，保留真实失败日志。时间边界至少包含立春前/后、另一交节月边界、二十三点换日开/关、经度修正跨交节/跨日；三合与本地十神回归均有反例和正常正例。不能仅比较两处同一算法、仅查源码形状或删旧断言制造通过。
2. **修时间完整链与关系事实。** 自动保存的 `birthTime` 为原公历北京时间；新盘四柱年月按原时刻交节，日/时按修正后输入；真实起运与对应 Solar 时刻的库计算核对，且年干方向、首步运和起运跨度相互一致。追加出生元数据真实 UI 保存、仓储 prune→hydrate、本地补全、详情重算、手工改柱清理、JSON 与 SQLite 导入导出实际 roundtrip；服务端 DB 与 Rust JSON 透传也有实际判据，不能只看 spread/JSON.stringify 推断。
3. **修本地代数与文本一致性。** 五种日主元素×五种十神组都严格映射一个五行，十干阴阳的正偏分组与其一致。男乙日遇辛金不能仅凭天干误写妻星；女命对称反例、真实配偶星正例、地支本气与配偶宫独立引动仍保留。含/缺合法 `tenGod` 的同一事实不应产生相反配偶星结论；财运句不能把相邻五行称作财星。提高 `LOCAL_ANALYSIS_ENGINE_VERSION`，旧本地正文失效重算、同版复用与来源切换仍通过。
4. **排除同支假三合并去重扫描。** 本命与时段的相同地支不再产生三合；两不同支半合及三支成局继续存在，与明细一致。扫描保留原月优先、左扩优先于右扩的现有次序；月内命中、左扩命中（如一九九〇年六月输入原五月十五日四柱）、右扩命中（一九八四年一月输入原二月六日四柱）、完全失败都保持输出/错误契约。无匹配一月夹具必须通过可信候选调用计数证明一百零二降至七十一、每候选最多一次；记录同机固定夹具的实际耗时供参考，不用易抖动的毫秒阈值冒充性能保证。
5. **验证缓存与全链。** 对同四柱/性别/出生年/任务或同问题/语气而分钟不同的合法出生时刻，真实 server/Rust 任务及聊天 key 必须不同；同一时刻稳定，旧盘空签名两端一致，签名不能移动性别四柱段。预置另一时刻缓存不能被新时刻命中，按盘清缓存仍覆盖两个签名；Tauri 聊天元数据真实调用链可达，不能只测私有 helper。既有 provider、prompt parity、中文闸门、重试/取消、来源冻结和交付账本全部保留。
6. **Wiki 与终验。** chart owner 汇总更新架构/工作流、模块入口、类型接口、运行/测试与已知限制；主代理亲读最终 diff 与日志，执行不筛选的前端全量、独立类型、构建、服务器、Rust 和 Wiki。最终 Sol low 发现问题必须返回实现/测试环节，未关闭问题不得标完成。

不增加微服务、全局缓存或新的命理权重。服务器/桌面生产改动仅限必要任务/聊天缓存签名、版本与缓存元数据；完整 `nonAiResult` 本来就作为 JSON 透传，无需增加数据库列或把时间元数据塞进模型提示词。旧盘时分不可还原这一限制要写进 Wiki 与最终结果。

### 测试命令与证据

各 owner 先运行自己新增的回归（具体新增文件名写入执行日志），再运行相邻既有套件。client 目录可用命令：

```powershell
.\node_modules\.bin\vitest.cmd run src/__tests__/birth-to-pillars.test.ts src/__tests__/non-ai-calculator.test.ts src/__tests__/pillar-edit-rendered.test.tsx src/__tests__/pillar-edit-recompute.test.ts src/__tests__/export-hydrate.test.ts src/__tests__/import-roundtrip.test.ts --pool=forks --maxWorkers=2 --testTimeout=30000
.\node_modules\.bin\vitest.cmd run src/__tests__/local-analysis.test.ts src/__tests__/local-system.test.ts src/__tests__/local-orchestration.test.ts src/__tests__/local-system-design.test.tsx --pool=forks --maxWorkers=2 --testTimeout=30000
.\node_modules\.bin\vitest.cmd run src/__tests__/task-cache-key-cross-end.test.ts src/__tests__/cache-key-cross-end.test.ts src/__tests__/provider-follow-contract.test.ts --pool=forks --maxWorkers=2 --testTimeout=30000
.\node_modules\.bin\tsc.cmd --noEmit
npm.cmd run build
.\node_modules\.bin\vitest.cmd run --pool=forks --maxWorkers=2 --testTimeout=30000
```

server 目录 `node --test`；`client/src-tauri` 目录 `cargo test --lib`；工程根 `node scripts/check-wiki-links.cjs`。Wiki 链接总数取扫描器实际读数，并跑文档回归。所有输出记录实际退出码及原始日志位置，不能由历史计数推算本轮总数。不得对用户 WIP、既有断言使用 skip、缩小测试集合或覆盖测试内容来消除失败。

### 执行状态与自修次数

| 阶段 | 状态 | 自修次数 | 验收证据/待办 |
| --- | --- | --- | --- |
| Sol high 核心审计与接口规划 | 完成，主代理已冻结范围 | 0 | 四项核心缺陷及真实任务缓存键风险已逐段核对；本节保留兼容取舍 |
| Luna chart 时间链/关系/扫描实现 | 冻结，相关测试通过 | 2 / 2 | 11 套 116/116、真实异时区 10/10、tsc -b 退出 0；实际候选观测由 EightChar.fromLunar 完成，旧 102/新 71；日志位于 client/.scratch/core-chart-* |
| Sol high 日期输入校验接管 | 完成并冻结 | — | 显式 GPT-6.1 Sol high 接管 UTC 校验与真实 UI 回归，独立跳日时区由 1 失败/9 通过转为 10/10；常规时区 37/37、中文 UI 19/19、类型退出 0；root 已亲读日志 |
| Luna local 代数与正文实现 | 完成并冻结 | 2 / 2 | 最终 local-analysis 23/23，.scratch/local-analysis-v8-round2.log；相邻本地三套 49/49；第二轮补齐男女正反例、真实星与字段回退一致性 |
| Luna cache 签名与跨端实现 | 完成并冻结 | 2 / 2 | server 专项 4/4、client 三套 14/14、Rust 22/22；Sol low 发现整值 JSON 浮点接受差异后已修并复审关闭；原红测文件是工具失败输出摘要，绿测完整日志在 .scratch/core-cache-* |
| Wiki 与跨模块整合 | 完成 | — | 架构/时间/本地/缓存/测试 Wiki 已同步，扫描 OK 11 477 0；账本只登记两个新核心判据，已在正式全量中通过 |
| Sol high 扫描器兼容修复接管 | 完成并冻结 | — | 仅 scanner 与原测试两文件；来源/回退/混合读取/同名影射回归通过，46/46 后补影射 35/35；扫描未覆盖 0，Sol low 发现的影射 P2 已修并复审关闭 |
| 全量、类型、构建、服务器、Rust | 完成，均通过 | — | 14d3d61 原样前端 125 文件 982/982、退出 0；服务器 145/145、Rust 22/22、独立类型与提交后构建均退出 0；首轮 974/2 失败保留为返修历史 |
| GPT-6.1 Sol low 最终审查 | 源码与全量终验通过 | — | 亲读 982/982、145/145、22/22、类型与构建真实日志，实际 diff 和需求覆盖已核对；两项 P2 均关闭，无已知未解决 P1/P2；文档提交后只复核版本与 HEAD 短测 |

自修按失败后的“一次修改并运行相关测试”计数，每个 Luna owner 最多两轮；初次实现验证不算自修。仍失败由 GPT-6.1 Sol high 接管。主代理只在全部必要门禁实际通过、审查问题关闭后更新完成状态。

本轮主代理已独立执行服务器全量 145/145（`.scratch/core-server-full.log`）及 Rust 22/22（`.scratch/core-rust-full.log`），退出码均 0。扫描性能的真实红测为 `client/.scratch/core-chart-red.log`（指定性能项，旧工厂调用 102，非全量），绿测 `client/.scratch/core-chart-final-suite.log` 验证无匹配夹具只有 71 次且日期不重复，减少约 30.4% 的候选检查；暖态耗时仅作同机观测，不能推成整个应用加速比例。来源不完整的早期红测仅按工具摘要记录，不冒称完整原始日志。

主代理独立类型检查 `.scratch/core-types.log` 对应 `tsc --noEmit` 退出 0。Sol high 日期输入校验的真实红/绿日志在 `.scratch/core-chart-ui-tz-red.log` 和 `core-chart-ui-tz-green.log`，常规时区与中文界面日志为 `core-chart-ui-regular.log`（37/37）和 `core-chart-ui-chinese.log`（19/19）。Sol low 已复核这些日志、完整时间持久链及两项新判据登记，允许精准本地提交后进行正式全量；此处仍不代表前端全量已完成。

配套 Wiki：[入口与架构](docs/wiki/01-架构总览.md)、[排盘与界面链](docs/wiki/11-客户端-特性层.md)、[本地规则/仓储/缓存](docs/wiki/12-客户端-数据层.md)、[跨端契约](docs/wiki/13-跨端共享与三端一致性.md)、[类型接口](docs/wiki/31-类型契约.md)、[运行方式](docs/wiki/41-构建与发布.md)、[测试与缺项](docs/wiki/51-测试矩阵.md)。

首轮整合代码提交为 `ec78a5528786e3b1020092604244547086fb37d1`，仅包含本轮 31 个文件，原 auto WIP 未暂存。提交后构建 `.scratch/core-build.log` 退出 0；HEAD/文档两套 `.scratch/core-head-wiki.log` 为 95/95。原样前端全量 `.scratch/core-front-full.log` 实际为 124 文件通过/1 文件失败、974 项通过/2 项失败，耗时 419.14 秒、退出 1。失败均来自北京时间扫描器：`calendarEight.getMonth()` 与 `luckSolar.getMonth()` 属于 lunar-javascript 对象，旧的按变量名白名单不能辨认新增别名。Sol high 接管扫描器及其测试，用实际对象来源判别补齐兼容，并要求同名原生 Date 仍被拦截；不通过重命名业务对象、删除断言或跳过全量消除失败。修复后另行精准提交、构建并完整重跑前端，当前不能标全绿。

扫描器修复证据：`.scratch/core-scan-suite-red.log` 实际 2 项失败（基线误报 2、既有原生 Date 变异误报 3）；来源识别修复后 `.scratch/core-scan-suites-green.log` 五套 46/46。Sol low 进一步发现整文件变量名可能让其他函数同名 Date 参数继承豁免；`.scratch/core-scan-shadow-red.log` 两个影射新例实际 2 失败/6 通过，Sol high 添加同名参数/第二声明的保守拒绝后 `.scratch/core-scan-shadow-green.log` 三套 35/35。`.scratch/core-scan-shadow-cli.log` 为 49 文件、routed 5、neutral 64、uncovered 0；原 baseline=0、既有变异恰为 1 的断言保留。Sol low 亲读最终 diff 与日志后关闭该 P2；主代理独立 `.scratch/core-types-final.log` 为 TSC_EXIT=0。源码与相应 Wiki 已冻结，下一步提交、构建和不筛选前端全量。

最终源码提交 `14d3d61ed29ece2982fface1753d2585ecb50513`：主代理先完成生产构建（`.scratch/core-build-repaired.log`，退出 0），再运行原样、不筛选的完整前端（`.scratch/core-front-final.log`），实际为 `Test Files 125 passed (125)`、`Tests 982 passed (982)`，428.81 秒、退出 0，无跳过汇总。服务器 145/145、Rust 22/22、独立类型检查退出 0 的原始日志如上；扫描器返修未改变后端或 Rust。全量结束后 Wiki 扫描 `OK 11 477 0`，工作树仍仅有原 auto WIP，其 SHA256 与本轮基线完全相同。后续只更新本计划与 Wiki 验收记录、文档提交后重建版本产物并短验 HEAD/Wiki/版本链，不再改业务源码；首轮失败与中间“待验”描述均为当时状态，最终状态以本段和执行表为准。

GPT-6.1 Sol low 已亲读上述最终代码、完整前端/服务器/Rust/type/build 原始日志并验收通过，确认计划范围均覆盖、已报两项 P2 全部关闭，无已知未解决 P1/P2。文档收口仅修改 PLAN 与 Wiki 测试矩阵的本轮结果登记、当前命令计数及旧盘时刻限制；其后重建和短测日志使用 `.scratch/core-build-docs-final.log`、`.scratch/core-docs-head-final.log`，实际读数由最终执行输出确认，不预填成功。

## 2026-10-17 GitHub 下一版本与 Pages 正式发布

### 授权、范围与版本口径

用户已明确要求“上线到 GitHub 下一个版本，然后把链接发给我”，本节授权范围为将本聊天已验收源码推送至现有 `origin/main`，按既有 GitHub Pages 流程发布 Web/PWA，并回传可打开的线上链接和可核对的源码版本。真实仓库为 `yty060525-commits/ai8zi`；本节规划基线 HEAD 为 `bb52f9d`、提交计数为 115。源码全量验收证据沿用本计划上一节已核实记录：前端 125 文件 982/982、server 145/145、Rust 22/22、类型/构建通过，最终 HEAD/Wiki/版本短测 112 项通过。正式上线仍需本次新产物与真实远端结果，历史离线测试不能代替上线证据。

运行时版本由 `client/vite.config.ts` 读取 `git rev-list --count HEAD` 与短 SHA，UI 与 `scripts/version.sh` 同源；不是 `client/package.json` 的固定 `1.0.0`。本节精确提交后预计自然进入第 116 版，具体版本始终以构建前最后 HEAD 的实际计数和短 SHA 为准。主代理已真实核实 GitHub Releases 返回空数组，没有现有 Release 惯例；本轮采用既有 Pages 版本口径，不新建语义版本 Release，不改 package/锁文件或将桌面包声明为已发布。用户请求的必要结果是源码已到 GitHub、Pages 新版本真实可访问。

只允许本节 PLAN、发布必需的已有文档和生成产物变化；无需修改业务代码、部署策略或无关依赖。原用户 WIP `client/src/__tests__/auto-retry-schedule.test.tsx` 保持未暂存、未提交且 SHA256 逐字等于 `2063B6AD382AD2996D2BF98CAE8ABE20EEEC5DAE58A3B9E0C39024BB65287290`，不得 stash/restore/覆盖它。禁止 `git add -A`、main 强推、Qoder 与未经本项目授权的 Pi。无必要不重新生成 Windows 安装包、不部署服务器、不触及 `server/data`。

### 角色、文件归属、依赖与接口

| 角色 | 显式配置 | 归属与输出 |
| --- | --- | --- |
| 发布规划 | GPT-6.1 Sol high（`gpt-6.1-sol`） | 只读发布脚本/Wiki/版本链与仓库元数据；仅追加本节 PLAN；给出冻结的执行路径及风险 |
| 执行与必要自修 | GPT-6-Luna medium（`gpt-6-luna`） | 根据主代理冻结的源码 HEAD 构建 `client/dist`、执行现有 Pages 脚本、必要时同步本地 PWA zip；仅在主代理分配后精确维护发布证据文档；输出退出码、脱敏日志、构建版本、gh-pages SHA与HTTP核对结果 |
| 两轮失败接管 | GPT-6.1 Sol high（`gpt-6.1-sol`） | 同一 Luna 最多两次“修复后验证”仍失败时诊断；不删判据或降低发布验收 |
| 最终发布审查 | GPT-6.1 Sol low（`gpt-6.1-sol`） | 独立核对实际 diff、GitHub main/gh-pages/Pages 状态、产物版本及浏览器结果；未关闭的问题返回执行 |
| 主代理整合 | 当前主代理 | 保护 WIP，精确暂存/提交/推送、确定实际 Release 习惯、分配执行与独立复核、向用户回传链接；不声称自身模型已切换 |

依赖接口：前端构建依赖本地完整 git HEAD、现有 node_modules 与 TypeScript 门禁；`client/dist` 是 `scripts/deploy-pages2.mjs` 的唯一产物输入。脚本在仓库根执行，读取 `.git/config` 并优先使用进程内 `GH_TOKEN`；令牌由现有凭据途径取得且不得打印、写入日志或写入源码。网络按本机实际连通性使用现有代理；Wiki 提示 `HTTPS_PROXY=http://127.0.0.1:7897`，执行者须核实 Node fetch 的代理支持或采用已经验证的现有连接方式，不能只设置变量便断言有效。部署输出是 Git Data API 创建的新 gh-pages commit，parent 必须等于发布前 gh-pages HEAD；随后 Pages/CDN 异步生效。

### 执行顺序、命令与验收条件

1. **冻结与提交。** 主代理核对 `git status --short`、WIP 摘要、当前 main 与远端目标身份，检查实际 diff，仅暂存本节计划和本轮明确需要的发布文件。主代理已核实仓库公开，Pages为legacy、source为gh-pages:/、状态built；origin/main为`f04e7cf76c7602865d6493407bf912b8d6cd62be`，是规划基线HEAD祖先（0 behind/17 ahead）；发布前gh-pages为`e157b118a49b60c1bc23dda34a88e314f8b0a44e`。正式推送前再次确认远端没有并发变化；若main已变化，停止覆盖并整合，不强推。提交后记录 `git rev-parse HEAD`、`git rev-list --count HEAD`、`git rev-parse --short HEAD`；后续正式构建必须来自这个最终 HEAD。交付的GitHub源码链接绑定同一个已验证源码SHA，不把gh-pages产物SHA误作源码版本。
2. **新产物与发布短测。** 在 `client` 运行 `npm.cmd run build`，记录完整退出码与日志；运行下方版本、SW与部署保留判据，根目录跑 Wiki 链接检查。核对 dist JS 含最终 `计数-短SHA`、`dist/sw.js` 无 `__BUILD_ID__` 且缓存名已变化，index引用的静态文件存在。若文档又提交改变 HEAD，必须重新构建，不发布旧 HEAD 产物。原完整业务回归已通过，本次没有业务源码修改时不重复耗时全量。
3. **推送与实际发布。** 显式 `git push origin main` 并独立读回 GitHub main SHA；在仓库根将现有部署脚本复制至被忽略的`.scratch`临时脚本，精确且仅将`force: true`替换为`force: false`，断言原匹配恰为一处；保留全部chunk保留/parent/令牌策略及仓库根cwd，使用凭据仅留进程内的方式执行这个临时脚本。受测生产脚本保持不变。保存发布前与发布后 gh-pages SHA、提交 parent、文件清单与部署日志；旧哈希 chunk 保留规则继续生效。生产脚本目前 `PATCH force:true`，临时副本改成false以阻止并发覆盖；但其仍将HTTP 422视为不抛错，因此必须独立读回ref：新 ref 必须等于实际创建的提交 SHA，不能只凭脚本退出 0 或 `gh-pages updated` 日志判成功。若远端在发布期间被其他部署推进，先重读状态，不反复盲目强写。不要输出 Authorization/header、凭据填充结果或完整 .git/config。
4. **等待并真实验收。** 轮询 GitHub Pages 构建/部署状态；CDN约需30–90秒，但使用实际状态作判断。用 `https://yty060525-commits.github.io/ai8zi/` 的真实 HTTP 和浏览器验证入口、主JS/CSS及SW，确认线上版本等于本次最终HEAD、主要界面正常。可用不缓存请求或查询参数核对，不能由本地 dist 或旧缓存页面推断线上更新成功。若已有连接可实际显示版本，则直接核实；否则比对线上静态文件与本地 SHA/内容并保留证据。源码 main成功但 Pages失败只记录部分完成，继续处理，不能宣称上线完成。
5. **审查与交付。** Sol low独立读实际 diff/日志/远端状态；主代理复核原WIP摘要仍不变。本次无GitHub Release惯例，不新增Release或桌面附件。最终回复至少给出可打开的Pages地址、实际发布版本与GitHub源码链接，不把计划或部署触发当作已上线。

```powershell
# 仓库根：只读版本与文档门禁
 git status --short
 git rev-parse HEAD
 git rev-list --count HEAD
 git rev-parse --short HEAD
 node scripts/check-wiki-links.cjs
# client：最终源码提交后构建与本次发布相关判据
 npm.cmd run build
 .\node_modules\.bin\vitest.cmd run src/__tests__/version-chain.test.ts src/__tests__/sw-cache-version.test.ts src/__tests__/deploy-retain-rule.test.ts --pool=forks --maxWorkers=2 --testTimeout=30000
# 仓库根：显式推送；GH_TOKEN由执行进程内安全注入，临时部署副本只关闭强推
 git push origin main
 node .scratch/deploy-pages-release.mjs
```

配套 Wiki：[架构与模块入口](docs/wiki/01-架构总览.md)、[完整构建/发布/回退流程](docs/wiki/41-构建与发布.md)、[跨端契约](docs/wiki/13-跨端共享与三端一致性.md)、[测试验收及已知缺项](docs/wiki/51-测试矩阵.md)。发布无代码/接口变化时无需改写架构页；只有实际流程变化才精准同步对应Wiki。现有Wiki提及的Windows workflow在本地HEAD未见追踪文件，因此不能据此声称能用云构建完成桌面交付。

### 发布状态与自修次数

| 阶段 | 状态 | 自修次数 | 证据/待办 |
| --- | --- | --- | --- |
| Sol high发布审计与计划 | 完成，待主代理整合 | 0 | 基线115-bb52f9d；既有脚本、版本链与Wiki逐项读审；无网络写入/构建 |
| 主代理冻结、提交与远端核实 | 远端只读核实完成，提交待执行 | — | Releases为空；Pages built、gh-pages:/；main为HEAD祖先，精确SHA见执行步骤；保护原WIP |
| Luna新产物、短测与Pages执行 | 待执行 | 0 / 2 | 填实际命令/日志/退出码/构建版本/gh-pages SHA |
| 线上版本与浏览器验证 | 待执行 | — | 实际HTTP、静态资源及界面证据；不能由脚本exit0代替 |
| Sol low独立最终审查 | 待执行 | — | 核对远端结果与实际产物，关闭问题后方可交付 |

自修计数沿用用户规则：首次执行不是自修；失败后的每次修改并运行相关验证计一次，最多两轮，然后交Sol high。规划完成不等于发布完成；最终执行结果由主代理依据实际证据追加到本节，不预填成功。
