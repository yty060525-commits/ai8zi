# 十年运势与五行调整流水线 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use compose:subagent (recommended) or compose:execute to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用非 AI 程序生成完整运年月和关系事实，再以稳定并发批次生成并保存创建年起十年的 AI 纵览与五行调整建议。

**Architecture:** 确定性计算器输出稳定排序的基础事实和十年运年月；AI planner 将强弱/格局/喜忌与工作生活建议拆成固定请求，再将十年年度/月度任务按固定批次并发执行；SQLite 按 person/year/month 幂等保存。

**Tech Stack:** TypeScript、lunar-javascript、React、Tauri 2、Rust、rusqlite、DeepSeek/Kimi provider adapter。

## Global Constraints

- 基础事实、大运、流年、流月和刑冲克害由程序计算；AI 不计算事实。
- 大运默认采用三天一岁；现有输入缺少完整出生日期/分钟时，使用候选日期与时柱中点估算并标记。
- AI 先判断强弱、格局、喜忌，再输出工作和生活方式。
- 纵览从创建时间对应年份开始，范围十年，保存公历年月。
- 请求 schema、字段顺序、批次和提示模板稳定，独立任务可并发，结果幂等。
- API 调用严格为 25 次：1 次强弱/格局/喜忌、1 次十年总览、10 次逐年、12 次当前年度逐月、1 次最终八字总览与工作生活方式。
- 所有结果保存 SQLite，界面不显示厂商、模型、额度、费用或密钥。
- 创建时只做非 AI；AI 由数据详情页的通用“AI 分析”按钮手动触发。
- 详情页支持删除当前记录；神煞独立分组或折叠展示。
- 四柱、藏干、十神、纳音、神煞纵向单列；生肖展示本命及三合/六合/刑/冲/克/害；未来十年和流月干支只保存不在客户端展开。

### Task 1: 扩展非 AI 基础运年月与关系计算

**Covers:** [S1], [S3]

**Files:** `client/src/features/chart/nonAiCalculator.ts`, `client/src/types/domain.ts`, calculator tests.

- [ ] 先写失败测试：三合六合、刑冲克害、十年大运/流年/流月均有稳定公历年月和固定排序。
- [ ] 用 lunar-javascript 已支持 API 计算关系与运年月；对库不支持的关系使用明确的天干地支规则表，不能交给 AI。
- [ ] 输出 `relationships`、`greatFortunes`、`annualFortunes`、`monthlyFortunes` 和 `forecastRange`，所有数组按年份/月排序。
- [ ] 运行计算测试和 build。

### Task 2: AI planner、五行调整和并发批次

**Covers:** [S2], [S4]

**Files:** `client/src/data/fortunePlanner.ts`, `client/src/data/fiveElementAdvice.ts`, `client/src/data/deepseekAdapter.ts`, tests.

- [ ] 先写失败测试：固定基础 JSON 产生稳定请求 payload；年度/月度任务覆盖十年；批次可并发且不重复；输出包含免责声明。
- [ ] 建立木/水/火/金/土建议资料和免责声明常量；按喜忌选择建议，不做医疗或人生决策断言。
- [ ] 将强弱/格局/喜忌作为前置任务；成功后构建工作生活建议和十年纵览任务。
- [ ] 使用固定批次大小与 `Promise.all` 并发请求；失败任务单独记录，不丢失其它结果。
- [ ] 用可审计的 25 项任务清单驱动调用，保存序号、任务类型、年份/月和状态，禁止退化成单次请求。
- [ ] 运行 AI planner 测试、全量测试和 build。

### Task 3: SQLite 全量持久化与详情展示

**Covers:** [S5], [S6]

**Files:** `client/src-tauri/src/lib.rs`, `client/src/data/clientRepository.ts`, `RecordsPage.tsx`, `PersonDetail.tsx`, tests.

- [ ] 先写 SQLite round-trip 测试：基础事实、AI 判断、五行建议、年度/月度纵览和关系字段完整保存。
- [ ] 增加规范化表或 JSON 列，按 person/year/month 幂等写入，读取时按公历年月排序。
- [ ] 详情页展示公历年月、大运、流年、流月、刑冲克害、工作生活方式和免责声明；基础格子纵向单列；未来十年明细只留在 SQL，不在客户端展开；仍不显示 provider 信息。
- [ ] 增加详情页单条删除按钮和手动“AI 分析”按钮，创建流程不自动请求 AI。
- [ ] 运行前端/Rust 测试和 build。

### Task 4: Tauri 生产交付

**Covers:** [S5], [S6]

**Files:** `client/src-tauri/target/release/*`, `docs/compose/reports/2026-09-01-ten-year-fortune-pipeline.md`

- [ ] 运行 `npm run tauri:build -- --bundles deb,rpm`，确认最新可执行文件和安装包生成。
- [ ] 记录 SQLite 实际路径：Linux 默认 `~/.local/share/com.example.mingli-client/bazi_records.sqlite3`。
- [ ] 尝试 AppImage；若 linuxdeploy 失败，记录真实环境错误，不冒充成功。
- [ ] 运行全部测试、UI 禁止信息扫描和 SQLite round-trip，写入最终报告。
