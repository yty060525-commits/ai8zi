# 客户端前端 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use compose:subagent (recommended) or compose:execute to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立一个可一键启动的 Tauri 单体本地工具前端，用户未提供数据时保持空数据状态，并严格实现排盘/记录双分类及移动端、桌面端数据查看边界。

**Architecture:** 使用独立 `client/` 的 React + TypeScript 界面，并以 Tauri 作为最终独立应用窗口容器；Vite 浏览器地址仅用于开发预览。页面组件只处理展示和交互，类型与本地数据适配集中在 `src/data/`；未来 SQLite、非 AI 计算和 DeepSeek 账户模块都以内置本地模块加入，不拆分服务端。生产初始数据为空，测试数据只能在测试 fixture 中注入。

**Tech Stack:** Vite、React、TypeScript、Vitest、原生 CSS、Tauri 窗口容器；不引入 UI 组件库，不引入颜色主题。

## Global Constraints

- 本阶段只实现单体本地工具前端，不拆分客户端/服务端，不考虑公网服务器。
- 最终交付是 Tauri 独立应用窗口，不是浏览器网页；浏览器预览只用于开发调试。
- 规划、规格、报告放在 `docs/compose/`；本地工具实现统一放在 `client/`，不拆分客户端/服务端。
- 底部固定分类只有 `排盘`、`记录`，启动默认显示排盘。
- 所有视觉呈现只使用黑、白、灰、线条、文字、字号、字重和间距。
- 所有页面文本保持可选择和复制，不使用禁止选择文本的 CSS。
- 额度与费用不展示 mock 数字；未接入真实 DeepSeek 模块时显示“DeepSeek 额度未连接”。
- 用户未提供数据时，生产启动状态不包含任何预置人物、命盘、运势或假额度。
- 公历输入不包含真太阳时字段或文案。
- 用户已明确暂不处理 Git；执行任务不创建或要求 Git commit。

## Revised Local-Tool Constraints

- 本计划已改为单体 Tauri 本地工具；不再创建或维护独立 server 工程。
- 生产初始数据必须为空；`mockData.ts` 中的数据只能由测试显式注入，不能由启动 repository 自动加载。
- 公历输入不得出现真太阳时字段或文案。
- DeepSeek 额度/费用不允许使用 mock 数字；未实现本地 DeepSeek 账户模块时显示未连接状态，后续真实数据由本地模块读取并依据历史实际消耗预测。

## 文件结构

- Create: `client/package.json` — 前端依赖和脚本。
- Create: `client/index.html` — Vite HTML 入口。
- Create: `client/tsconfig.json` — TypeScript 配置。
- Create: `client/vite.config.ts` — Vite 与 Vitest 配置。
- Create: `client/src/main.tsx` — React 挂载入口。
- Create: `client/src/App.tsx` — 页面级状态和路由式视图切换。
- Create: `client/src/types/domain.ts` — 前端领域类型。
- Create: `client/src/data/mockData.ts` — 仅测试 fixture，不作为生产初始数据。
- Create: `client/src/data/clientRepository.ts` — 可替换的本地数据适配接口。
- Create: `client/src/components/BottomNav.tsx` — 底部双分类导航。
- Create: `client/src/components/Modal.tsx` — 通用出生信息弹窗壳。
- Create: `client/src/features/chart/ChartPage.tsx` — 排盘页和提交状态。
- Create: `client/src/features/chart/BirthInputModal.tsx` — 公历/农历/八字输入弹窗。
- Create: `client/src/features/records/RecordsPage.tsx` — 筛选、搜索和列表/网格。
- Create: `client/src/features/person/PersonDetail.tsx` — 人物四区详情与复制行为。
- Create: `client/src/styles.css` — 黑白灰数据呈现样式和响应式布局。
- Create: `client/src/__tests__/domain.test.ts` — 类型适配和筛选排序单测。
- Create: `client/src/__tests__/app-flow.test.tsx` — 导航、弹窗、提交和详情流程测试。

### Task 1: 建立本地工具项目与空数据边界

**Covers:** [S1], [S5]

**Input:** 当前目录只有需求文档，没有可复用前端工程。

**Output:** 可启动的 `client/` React + TypeScript + Tauri 项目；领域类型和空数据 repository 接口可被页面消费。

**Interfaces:**
- Produces `Person`, `BirthInput`, `ChartJob`, `NatalSummary`, `Fortune`, `ActionAdvice`, `AgentMessage`, `Quota` 类型。
- Produces `ClientRepository`：`listPersons(): Person[]`、`getPerson(id: string): PersonDetailData | undefined`、`getQuota(): Quota`、`createMockJob(input: BirthInput): ChartJob`。

- [ ] **Step 1: 写领域边界测试**：在 `client/src/__tests__/domain.test.ts` 测试 `listPersons` 返回分类可筛选的人物、姓名首字母排序稳定、`createMockJob` 初始状态为 `queued` 且保留输入模式。
- [ ] **Step 2: 运行失败测试**：在 `client/` 运行 `npm test -- --run`；预期因 `src/data/clientRepository.ts` 和类型尚不存在而失败。
- [ ] **Step 3: 创建项目文件**：写入 `package.json`（脚本 `dev`、`build`、`test`）、Vite 配置、TS 配置和 React 入口；创建 `domain.ts` 的明确联合类型，禁止用 `any` 表示领域数据。
- [ ] **Step 4: 实现 mock repository**：在 `mockData.ts` 提供至少 3 个人物、包含三种分类和男女；提供至少一个大运下的年份及两个月文本；在 `clientRepository.ts` 实现测试所需函数，job 使用固定 mock 进度数据。
- [ ] **Step 5: 运行通过测试**：运行 `npm test -- --run`，预期 `domain.test.ts` 全部 PASS；运行 `npm run build`，预期 TypeScript 构建 PASS。

### Task 2: 实现应用外壳与排盘输入流程

**Covers:** [S2], [S3]

**Input:** Task 1 的领域类型和 `ClientRepository`。

**Output:** 启动默认显示排盘；底部可在排盘/记录间切换；排盘表单具备性别开关、三种模式按钮、弹窗、未连接额度位和本地任务状态；记录初始为空。

**Interfaces:**
- Consumes `Quota`, `ChartJob`, `BirthInput` 和 `createMockJob`。
- Produces `App` 对子视图的 `onOpenPerson(personId: string)` 回调；`BirthInputModal` 的 `mode`、`open`、`onClose`、`onSubmit` props。

- [ ] **Step 1: 写交互失败测试**：在 `app-flow.test.tsx` 测试启动出现“排盘”、记录导航可切换；点击“公历”出现弹窗；男女按钮从男切换为女；提交后出现任务状态和进度。
- [ ] **Step 2: 运行测试确认失败**：运行 `npm test -- --run src/__tests__/app-flow.test.tsx`；预期组件尚不存在导致 FAIL。
- [ ] **Step 3: 实现最小组件**：创建 `App.tsx`、`BottomNav.tsx`、`Modal.tsx`、`ChartPage.tsx`、`BirthInputModal.tsx`；三种模式使用同一弹窗壳但分别渲染对应字段，提交时调用 `createMockJob` 并展示 queued → running 的 mock 状态。
- [ ] **Step 4: 加入额度展示**：排盘页只渲染 `Quota.remaining`、`Quota.unitPrice` 和费用说明文本；不创建支付 handler，不发送网络请求。
- [ ] **Step 5: 运行通过测试**：运行 `npm test -- --run src/__tests__/app-flow.test.tsx` 和 `npm run build`，预期全部 PASS。

### Task 3: 实现记录筛选、搜索与响应式数据呈现

**Covers:** [S4], [S6]

**Input:** Task 1 的人物 mock 数据；Task 2 的 `App` 导航和 `onOpenPerson` 接口。

**Output:** 记录分类筛选、姓名搜索、首字母排序；窄屏列表、宽屏数据网格；点击人物进入详情。

**Interfaces:**
- Consumes `listPersons(): Person[]`。
- Produces `RecordsPage` props `{ onOpenPerson: (personId: string) => void }`。

- [ ] **Step 1: 写记录筛选测试**：测试输入姓名关键字只保留匹配项、分类“客户”只保留客户、首字母排序按 `nameInitial` 和姓名排序；测试每项显示姓名、性别和八字摘要。
- [ ] **Step 2: 运行测试确认失败**：运行对应 Vitest 测试，预期筛选函数或组件不存在而 FAIL。
- [ ] **Step 3: 实现记录页**：创建 `RecordsPage.tsx`，用本地状态保存分类、搜索词；派生过滤排序结果；使用语义化按钮打开人物；不在页面内直接访问 mock 数组以外的存储细节。
- [ ] **Step 4: 实现响应式样式**：在 `styles.css` 使用媒体查询将同一数据在窄屏显示为列表、宽屏显示为网格；性别同时显示文字，使用灰度/实虚线边界；hover 仅使用黑白灰边框运动反馈。
- [ ] **Step 5: 运行通过测试**：运行记录测试、全量 `npm test -- --run` 和 `npm run build`，预期 PASS。

### Task 4: 实现人物详情四区与复制功能

**Covers:** [S4], [S6]

**Input:** `getPerson(id)` 的 `PersonDetailData`；Task 3 的打开人物回调。

**Output:** 基础信息、行动改变、运势、提问四区；运势大运/年份/月度逐层展开；所有长文本可选择复制，复制按钮可调用浏览器剪贴板。

**Interfaces:**
- Consumes `PersonDetailData`、`Fortune`、`ActionAdvice`、`AgentMessage`。
- Produces `PersonDetail` props `{ personId: string; onBack: () => void }`。

- [ ] **Step 1: 写详情失败测试**：测试打开详情显示四区标题、点击大运后显示年份、点击年份后显示月份文本、点击复制按钮调用 `navigator.clipboard.writeText`。
- [ ] **Step 2: 运行测试确认失败**：运行详情测试，预期组件不存在而 FAIL。
- [ ] **Step 3: 实现详情组件**：创建 `PersonDetail.tsx`；基础信息渲染结构化字段；行动改变直接显示 mock 规则结果；运势只在展开时渲染下一级；提问绑定当前 `personId` 并展示 mock 回复。
- [ ] **Step 4: 实现复制操作**：提供“复制本段/复制本年/复制全部”按钮，统一生成纯文本内容并调用 `navigator.clipboard.writeText(text)`；正文使用普通可选择文本元素。
- [ ] **Step 5: 运行通过测试**：运行详情测试、全量测试和构建，预期 PASS；手动运行开发服务器确认移动宽度和桌面宽度均无横向溢出。

### Task 5: 客户端阶段验收与边界检查

**Covers:** [S1], [S2], [S3], [S4], [S5], [S6]

**Input:** Tasks 1–4 的可运行 `client/`。

**Output:** 阶段 A 验收证据和问题清单；确认没有提前混入服务端、算法、SQL 或 AI。

- [ ] **Step 1: 运行自动验证**：在 `client/` 运行 `npm test -- --run` 和 `npm run build`，记录实际 PASS 输出。
- [ ] **Step 2: 运行边界搜索**：从仓库根目录搜索 `client/src` 是否出现 `fetch(`、`axios`、`sqlalchemy`、`sqlite`、`deepseek`、真实 API key；若出现，删除越界实现并重新验证。
- [ ] **Step 3: 运行人工验收路径**：启动 `npm run dev -- --host 127.0.0.1`，依次验证默认排盘、三种弹窗、男女切换、mock 进度、额度费用、记录筛选搜索、详情展开和三种复制按钮。
- [ ] **Step 4: 产出阶段报告**：将命令、结果、已知 mock 限制写入 `docs/compose/reports/2026-05-18-client-frontend-report.md`；报告只记录阶段 A，不描述未实现的服务端功能为已完成。

### Task 6: 封装为 Tauri 独立应用窗口

**Covers:** [S1], [S6]

**Input:** Tasks 1–5 已验证通过的 `client/` React 界面。

**Output:** 可由 Tauri 启动的独立客户端窗口；浏览器预览仍仅作为开发调试入口，不作为交付形态。

**Interfaces:**
- Consumes Vite 构建产物和 `client/src/` 前端入口。
- Produces `client/src-tauri/tauri.conf.json`、`client/src-tauri/Cargo.toml`、Rust 最小入口及 `npm run tauri:dev`/`npm run tauri:build` 脚本。

- [ ] **Step 1: 写窗口启动验收**：增加一个不依赖浏览器 DOM 的配置检查，断言 Tauri 配置存在、窗口有明确宽高、前端 dev URL 与 build 路径已配置。
- [ ] **Step 2: 运行失败检查**：运行该检查，确认缺少 `src-tauri` 配置时失败。
- [ ] **Step 3: 创建最小 Tauri 壳**：只配置一个应用窗口、标题、最小宽高和 Vite dev/build 路径；不加入文件系统、数据库或网络权限。
- [ ] **Step 4: 运行窗口构建验证**：在安装 Rust/Tauri 依赖的环境运行 `npm run tauri:build`；若环境缺少 Rust，只记录明确环境限制，并用 `npm run build` 验证前端产物。
