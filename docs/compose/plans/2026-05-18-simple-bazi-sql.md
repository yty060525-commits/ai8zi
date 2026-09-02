# 简化八字直接入库 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use compose:subagent (recommended) or compose:execute to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 只接收姓名、性别、出生年月和四柱八字，原样保存到 SQLite，提交后立即进入记录页，并可选调用 AI 补充三项判断。

**Architecture:** React 表单只收集并提交 typed `BaziRecord`；Tauri Rust commands 负责 SQLite 建表、插入和查询；浏览器测试使用内存 repository。保存先于 AI，AI 失败不会影响记录。

**Tech Stack:** React、TypeScript、Vitest、Tauri 2、Rust、SQLite、DeepSeek OpenAI 兼容 API。

## Global Constraints

- 只保留姓名、性别、出生年、出生月和四柱八字。
- 删除分类、公历/农历模式、复杂历法转换和复杂常规计算。
- 提交直接保存 SQLite，成功后自动切换到底部“记录”分类。
- 删除加载动画和 queued/running mock 状态。
- AI 只补格局、身强身弱、喜忌；AI 失败不能阻止原始记录保存。
- API 密钥不得出现在源码、测试或文档中。

## 文件地图

- Modify `client/src/types/domain.ts`: 定义简化 `BaziRecord`、`AiAnalysis` 和 repository 接口。
- Modify `client/src/data/clientRepository.ts`: 增加内存保存/查询实现。
- Modify `client/src/features/chart/ChartPage.tsx`: 简化表单和保存回调。
- Replace `client/src/features/chart/BirthInputModal.tsx`: 只保留四柱字段。
- Modify `client/src/App.tsx`, `RecordsPage.tsx`, `PersonDetail.tsx`: 保存后跳转和数据展示。
- Create `client/src/data/aiAnalyzer.ts`: 最小 DeepSeek 适配器。
- Create/modify `client/src-tauri/src/db.rs`, `src-tauri/src/lib.rs`, `Cargo.toml`: SQLite commands。
- Modify relevant tests and add `repository.test.ts`, `ai-analyzer.test.ts`。

### Task 1: 简化领域模型与表单

**Covers:** [S1], [S4], [S5]

**Files:** `client/src/types/domain.ts`, `client/src/features/chart/ChartPage.tsx`, `client/src/features/chart/BirthInputModal.tsx`, related UI tests.

- [ ] 先写测试：表单只出现姓名、性别、年、月、四柱；分类、公历、农历、加载动画均不存在。
- [ ] 运行聚焦测试确认失败。
- [ ] 实现简化字段和校验：四柱均为两个汉字干支，年月为整数；提交回调携带 `BaziRecord`。
- [ ] 运行 UI 测试和 `npm run build` 确认通过。

### Task 2: 内存 repository、SQLite 和 AI 适配

**Covers:** [S2], [S3], [S5]

**Files:** `client/src/data/clientRepository.ts`, `client/src/data/aiAnalyzer.ts`, `client/src/types/domain.ts`, `client/src-tauri/src/db.rs`, `src-tauri/src/lib.rs`, `Cargo.toml`, new tests.

- [ ] 先写 repository 测试：保存一条原始记录后可列表读取，字段完全一致。
- [ ] 先写 AI 测试：未配置、成功 JSON、失败响应分别返回明确状态。
- [ ] 实现内存 adapter 和 SQLite 表 `bazi_records`，保存姓名、性别、出生年、出生月、四柱、AI 状态和 AI JSON。
- [ ] 实现 typed Tauri commands `init_database`, `save_bazi_record`, `list_bazi_records`, `get_bazi_record`，SQL 使用参数绑定。
- [ ] 实现最小 DeepSeek 兼容请求；地址/模型/密钥从配置读取，不写死密钥。
- [ ] 运行前端测试、Rust 测试和 build。

### Task 3: 保存后进入记录页并展示

**Covers:** [S2], [S4], [S5]

**Files:** `client/src/App.tsx`, `client/src/features/records/RecordsPage.tsx`, `client/src/features/person/PersonDetail.tsx`, `client/src/features/chart/ChartPage.tsx`, flow tests.

- [ ] 先写流程测试：填写简化表单并提交后，弹窗关闭、排盘页无结果展开、自动显示记录页和新姓名。
- [ ] 实现 `onSaved` 导航和记录刷新；列表展示原始字段，详情展示 AI 状态。
- [ ] 保留复制文本能力，但不引入运势计算或分类筛选。
- [ ] 运行流程测试和 build。

### Task 4: 验收

**Covers:** [S1], [S2], [S3], [S4], [S5]

**Files:** `docs/compose/reports/2026-05-18-simple-bazi-sql-report.md`

- [ ] 运行 `npm test -- --run`、`npm run build`、`cargo test`。
- [ ] 运行 `npm run tauri:build`；环境不满足时记录真实错误。
- [ ] 检查源码不存在分类入口、公历/农历入口、加载动画和密钥。
- [ ] 写入测试结果、SQLite 状态和已知限制，不记录密钥。
