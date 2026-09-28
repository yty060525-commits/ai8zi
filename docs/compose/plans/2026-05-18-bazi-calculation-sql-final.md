# 八字复杂基础计算与 SQLite 同步 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use compose:subagent (recommended) or compose:execute to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 恢复复杂非 AI 八字基础计算，将原始输入与计算 JSON 同步保存到 SQLite，并重新构建双击可运行的 Tauri 程序。

**Architecture:** `lunar-javascript` 在前端确定性生成基础结果；`BaziRecord` 保存 raw input 与 `nonAiResult`；Tauri Rust 用 SQLite 持久化 JSON，列表/详情统一从该适配器读取；DeepSeek 只做解释字段，原始保存先于 AI。

**Tech Stack:** React、TypeScript、Vitest、lunar-javascript、Tauri 2、Rust、rusqlite、DeepSeek OpenAI-compatible API。

## Global Constraints

- 保留姓名、性别、出生年、出生月和四柱八字；不恢复分类、公历/农历入口。
- 非 AI 程序计算四柱、农历、生肖、五行、藏干、十神、纳音、日主、大运及库支持的神煞/十二长生。
- 录入时保存运行设备的当前日期/时间；批量 AI 运势范围为当前年份起的未来十年，包含大运、流年、流月。
- 原始输入和完整非 AI 结果同步保存到同一 SQLite 记录。
- AI 失败不能阻止原始输入和非 AI 结果保存。
- 界面不得显示 DeepSeek、模型名称、API 地址、额度、费用或厂商相关信息；界面只显示通用的分析状态和分析内容。
- 提交成功立即进入记录页；不显示加载动画。
- 必须重新运行 `npm run tauri:build` 生成最新双击程序；不把密钥写入项目。

### Task 1: 恢复复杂非 AI 计算并扩展模型

**Covers:** [S1], [S2]

**Files:** `client/package.json`, `client/src/types/domain.ts`, `client/src/data/nonAiCalculator.ts`, `client/src/features/chart/ChartPage.tsx`, calculator tests.

- [ ] 先写失败测试：给定年月和四柱，结果包含四柱、农历日期、生肖、五行、藏干、十神、纳音、日主和大运；测试结果不依赖 API。
- [ ] 恢复 `lunar-javascript` 依赖和类型声明，使用已确认的四柱年月路径；不要静默猜测年份。
- [ ] 实现统一 `calculateNonAi(recordInput): NonAiChart`，将结果放到 `BaziRecord.nonAiResult`，四柱无效时提交前报错。
- [ ] 运行计算器测试、全量前端测试和 build。

### Task 2: 同步保存非 AI 结果到 SQLite

**Covers:** [S3], [S4]

**Files:** `client/src/data/clientRepository.ts`, `client/src/data/deepseekAdapter.ts`, `client/src/App.tsx`, `client/src-tauri/src/lib.rs`, repository/Rust tests.

- [ ] 先写失败 round-trip 测试，断言 raw input 与 `nonAiResult` JSON 保存后完全一致。
- [ ] 扩展内存和 Tauri adapter 的 `saveBaziRecord`，SQLite 增加 `non_ai_result` TEXT 列并用参数绑定保存/读取。
- [ ] 提交链路执行 calculate → save(raw + nonAiResult) → 立即导航 → 后台 AI update 同一 ID。
- [ ] AI 失败时更新状态但不清空非 AI 结果；测试覆盖未配置、慢请求和失败。
- [ ] 运行 Vitest、`cargo test` 和 build。

### Task 3: 展示计算结果并重建双击程序

**Covers:** [S3], [S5]

**Files:** `client/src/features/records/RecordsPage.tsx`, `client/src/features/person/PersonDetail.tsx`, `client/src/__tests__/*`, `client/src-tauri/target` generated output.

- [ ] 先写详情测试，断言记录页和详情显示 raw input、四柱和关键非 AI 结果。
- [ ] 接入 `nonAiResult` 展示，保留 AI 状态/结果；不恢复旧运势/提问壳和加载动画。
- [ ] 运行 `npm test -- --run`、`npm run build`、`cargo test`。
- [ ] 运行 `npm run tauri:build`，确认 `src-tauri/target/release/mingli-client` 与 AppImage/安装包生成时间晚于源码修改，并记录实际路径。
- [ ] 写入 `docs/compose/reports/2026-05-18-bazi-calculation-sql-final-report.md`，不得包含 API 密钥。
