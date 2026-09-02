# SQL 与八字排盘流程改造 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use compose:subagent (recommended) or compose:execute to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让三种出生信息都能完成基础计算并持久化到 SQLite，提交后自动进入记录页，并以 DeepSeek 补充格局、身强身弱和喜忌。

**Architecture:** React 页面只调用 typed repository；Tauri 正式运行通过 Rust commands 访问 SQLite，浏览器测试使用内存 repository。提交链路先做确定性计算并保存，再尝试 AI 分析并更新同一条记录，AI 失败不回滚基础记录。

**Tech Stack:** React、TypeScript、Vitest、lunar-javascript、Tauri 2、Rust、SQLite、DeepSeek OpenAI 兼容 API。

## Global Constraints

- 三种输入均必须生成基础命理数据，八字模式通过 `Solar.fromBaZi` 先列出候选年份，由用户选择后接入统一计算路径。
- 基础事实由程序计算，AI 只负责格局、身强身弱、喜忌及解释。
- 正式 Tauri 运行使用 SQLite；浏览器/Vitest 只使用内存 adapter。
- 提交成功后关闭弹窗并切换到底部第二分类“记录”，不得在排盘页展开结果。
- 删除加载动画和 queued/running 的长时间模拟流程。
- API 密钥不得出现在源码、规格、测试 fixture 或提交内容中。
- 不实现服务器同步、年度/月度批量 AI 运势生成和账户计费。

## 文件地图

- Modify `client/src/types/domain.ts`: 扩展基础计算和 AI 状态类型。
- Create `client/src/data/baziCalculator.ts`: 四柱校验、四柱反推和统一基础计算映射。
- Modify `client/src/data/nonAiCalculator.ts`: 移除 `any` 主路径并复用四柱计算。
- Modify `client/src/data/clientRepository.ts`: 增加保存、刷新和详情读取接口；保留测试内存实现。
- Create `client/src/data/aiAnalyzer.ts`: DeepSeek 请求、结构化解析和未配置/失败状态。
- Create/modify `client/src-tauri/src/db.rs`, `client/src-tauri/src/lib.rs`, `client/src-tauri/Cargo.toml`: SQLite schema、commands 和启动初始化。
- Modify `client/src/features/chart/ChartPage.tsx`, `client/src/App.tsx`: 提交链路和记录页跳转。
- Modify `client/src/features/chart/BirthInputModal.tsx`: 公历/农历统一日期时间输入。
- Modify `client/src/features/records/RecordsPage.tsx`, `client/src/features/person/PersonDetail.tsx`: 展示保存的基础结果和 AI 状态。
- Modify `client/src/styles.css`: 移除加载动画相关样式。
- Test `client/src/__tests__/non-ai-calculator.test.ts`, `app-flow.test.tsx`, new repository/AI tests, and Rust unit tests.

### Task 1: 先固定三种输入的确定性基础计算

**Covers:** [S2], [S6]

**Files:**
- Create: `client/src/data/baziCalculator.ts`
- Modify: `client/src/data/nonAiCalculator.ts`
- Modify: `client/src/types/domain.ts`
- Test: `client/src/__tests__/non-ai-calculator.test.ts`

**Interfaces:**
- Produce `getBaziYearCandidates(input: BaziBirthInput): number[]` and `calculateNonAi(input: BirthInput, gender: Gender): NonAiChart` for solar, lunar, and bazi; extend `BaziBirthInput` with `selectedYear: number` so the selected candidate is explicit.
- Add `NonAiChart` fields for `solarDate`, `lunarDate`, pillars, zodiac, five elements, hidden stems, ten gods, nayin, day master, fortune start and da yun.

- [ ] **Step 1: Write failing tests** for a valid bazi input such as `甲子 丙寅 庚午 壬午`, expecting multiple candidate years, then pass one selected year and expect returned pillars and non-empty `zodiac`, `dayMaster`, `hiddenStems`, `nayin`; add a solar/lunar parity assertion for the existing known fixture.
- [ ] **Step 2: Run `npm test -- --run src/__tests__/non-ai-calculator.test.ts`** and confirm the old “暂不生成” assertion fails after replacing it with the new expected behavior.
- [ ] **Step 3: Implement the smallest mapping** using `Solar.fromBaZi(yearPillar, monthPillar, dayPillar, hourPillar, 2, 1900)` to return candidate years and require a selected year before calling `getLunar().getEightChar()`; route all modes through one result mapper and reject malformed or impossible stem/branch pairs with the existing error style.
- [ ] **Step 4: Run the focused calculator test and `npm run build`**; both must pass before moving on.

### Task 2: 建立 SQLite 适配层和 DeepSeek 分析边界

**Covers:** [S3], [S4]

**Files:**
- Modify: `client/src/types/domain.ts`
- Modify: `client/src/data/clientRepository.ts`
- Create: `client/src/data/aiAnalyzer.ts`
- Modify: `client/src-tauri/Cargo.toml`, `client/src-tauri/src/lib.rs`
- Create: `client/src-tauri/src/db.rs`
- Test: `client/src/__tests__/repository.test.ts`, `client/src/__tests__/ai-analyzer.test.ts`, Rust unit tests in `src-tauri/src/db.rs`

**Interfaces:**
- Add `saveChart(record: ChartRecord): Promise<Person>` and `getSavedDetails(): Promise<PersonDetailData[]>` to the async production adapter contract.
- Define `ChartRecord` with raw `BirthInput`, `NonAiChart`, AI status (`not_configured|completed|failed`) and optional `AiAnalysis` (`pattern`, `strength`, `usefulElements`, `avoidElements`, `explanation`).
- Export `analyzeWithDeepSeek(chart: NonAiChart, config: AiConfig): Promise<AiResult>`; config reads `VITE_DEEPSEEK_API_KEY` only in local development and Tauri settings, never a literal key.
- Rust commands: `init_database`, `save_chart`, `list_people`, `get_person_detail`.

- [ ] **Step 1: Write failing repository tests** that save one computed record, list it, and retrieve its detail; assert the raw input and computed pillars survive the round trip.
- [ ] **Step 2: Write failing AI tests** for unconfigured key, valid JSON content, malformed content, and non-2xx response; assert failures return status objects rather than throwing away the chart.
- [ ] **Step 3: Add SQLite schema and commands** with parameterized SQL for people, chart_inputs, non_ai_results, and ai_results; initialize the database under Tauri app data directory and serialize structured JSON in text columns.
- [ ] **Step 4: Implement the DeepSeek adapter** with the default official compatible URL and `deepseek-chat`, parse only the required structured fields, and return explicit failure status for missing configuration or invalid responses.
- [ ] **Step 5: Run repository, AI, Rust tests and `npm run build`**; no secret-like literal may appear in tracked source via `rg -n "sk-[A-Za-z0-9]" client/src client/src-tauri`.

### Task 3: 提交后保存并跳转记录页

**Covers:** [S1], [S5], [S6]

**Files:**
- Modify: `client/src/features/chart/ChartPage.tsx`
- Modify: `client/src/App.tsx`
- Modify: `client/src/features/records/RecordsPage.tsx`
- Modify: `client/src/features/person/PersonDetail.tsx`
- Modify: `client/src/data/clientRepository.ts`
- Test: `client/src/__tests__/app-flow.test.tsx`, `client/src/__tests__/records-page.test.tsx`

**Interfaces:**
- `ChartPage` receives `onSaved: () => void` and invokes repository save after calculation.
- `RecordsPage` receives `refreshKey` and reloads records from the repository.
- `PersonDetail` displays deterministic base fields and AI status/content from `PersonDetailData`.

- [ ] **Step 1: Replace old flow tests** so a valid submission expects no `基础排盘结果` on the chart page, expects the modal closed, and expects the new name on the records page.
- [ ] **Step 2: Add a test** asserting AI failure still leaves the new person in records with a visible failed/not-connected status.
- [ ] **Step 3: Implement submission** as calculate → save base record → best-effort AI update → call `onSaved`; remove local chart result state and all fake job progress state.
- [ ] **Step 4: Make App switch to `records`** inside `onSaved`, increment refresh key, and make RecordsPage reload adapter data; preserve explicit empty state.
- [ ] **Step 5: Add base/AI rendering to details** without changing existing copy behavior; run focused flow and records tests.

### Task 4: 统一公历/农历表单并移除加载动画

**Covers:** [S2], [S5], [S6]

**Files:**
- Modify: `client/src/features/chart/BirthInputModal.tsx`
- Modify: `client/src/styles.css`
- Test: `client/src/__tests__/app-flow.test.tsx`

- [ ] **Step 1: Add tests** that the lunar dialog has a date input and a time input with the same accessible semantics as solar, while retaining the leap-month control.
- [ ] **Step 2: Replace lunar split selects** with `input type=date` plus `input type=time`, parse values into the existing lunar payload, and validate date/time before submit.
- [ ] **Step 3: Remove progress/job markup and any loading animation selectors** from chart UI and CSS; retain only synchronous submit error feedback.
- [ ] **Step 4: Run focused UI tests and `npm run build`**.

### Task 5: 全量验收与桌面构建检查

**Covers:** [S1], [S2], [S3], [S4], [S5], [S6]

**Files:**
- Modify: `docs/compose/reports/2026-05-18-sql-bazi-flow-report.md`

- [ ] **Step 1: Run `npm test -- --run` and `npm run build`** from `client/` and record actual output.
- [ ] **Step 2: Run `cargo test`** from `client/src-tauri` and verify SQLite unit tests pass.
- [ ] **Step 3: Run `npm run tauri:build`**; if native packaging dependencies are unavailable, record the exact environment error without claiming success.
- [ ] **Step 4: Start the dev UI and manually verify** solar/lunar/bazi submit, immediate records navigation, base fields, AI disconnected state, no loading animation, and record persistence in a Tauri build.
- [ ] **Step 5: Write the report** with commands, pass/fail evidence, and any environment limitation; do not include the exposed API key.
