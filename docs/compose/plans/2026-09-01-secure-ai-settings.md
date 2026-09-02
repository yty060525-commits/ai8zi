# 安全 AI 服务设置 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use compose:subagent (recommended) or compose:execute to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 增加不暴露密钥的设置页，用系统钥匙串保存 DeepSeek/Kimi 凭据，并让后台按用户选择调用统一 AI provider。

**Architecture:** React 设置页只提交密钥和 provider 选择；Tauri Rust 通过钥匙串命令保存/读取，前端只获取状态；分析 adapter 使用统一 provider 接口，测试环境使用 mock。

**Tech Stack:** React、TypeScript、Vitest、Tauri 2、Rust、keyring、SQLite 现有数据层。

## Global Constraints

- 密钥不得写入 localStorage、SQLite、源码、测试 fixture 或构建产物。
- 所有页面都不显示厂商名、模型名、API 地址、额度或费用；设置页使用中性服务名称。
- 前端只能获得通用配置状态，不能读取或回显密钥明文。
- AI 结果继续写回现有 SQLite 记录，不改变非 AI 计算链路。

### Task 1: Rust 钥匙串与 provider 配置接口

**Covers:** [S2], [S3]

**Files:** `client/src-tauri/Cargo.toml`, `client/src-tauri/src/lib.rs`, `client/src/data/aiSettings.ts`, Rust/TS tests.

- [ ] 先写失败测试：保存密钥后只能返回 configured 状态；读取命令不得返回明文给前端。
- [ ] 增加 keyring 依赖和命令 `save_ai_credential`, `clear_ai_credential`, `get_ai_provider_status`, `set_ai_provider`；provider 只允许两个内部枚举值。
- [ ] 实现前端 typed adapter，只返回状态和统一错误，不暴露 secret。
- [ ] 运行 Rust/前端测试并扫描 `sk-`、`localStorage`、明文 secret。

### Task 2: 设置页与服务选择

**Covers:** [S1], [S4]

**Files:** `client/src/features/settings/SettingsPage.tsx`, `client/src/App.tsx`, `client/src/styles.css`, UI tests.

- [ ] 先写失败 UI 测试：密码输入、保存/清除、服务选择和通用 configured 状态；页面不回显密钥。
- [ ] 实现设置页导航和最小黑白灰表单；设置项只显示“服务一/服务二”等中性名称，任何页面都不显示厂商名。
- [ ] 运行 UI 测试和 build。

### Task 3: 后台 provider 路由与验收

**Covers:** [S3], [S4]

**Files:** `client/src/data/deepseekAdapter.ts`, `client/src/data/aiSettings.ts`, tests, final report.

- [ ] 先写失败测试：当前 provider 被正确路由，未配置返回通用状态，分析结果字段不变。
- [ ] 接入 provider 配置和统一请求路由；密钥由 Rust 侧读取，前端测试使用 mock。
- [ ] 运行 `npm test -- --run`、`npm run build`、`cargo test`、`npm run tauri:build -- --bundles deb,rpm`。
- [ ] 生成 `docs/compose/reports/2026-09-01-secure-ai-settings.md`，记录验证结果，不记录任何密钥。
