# Remove AI Configuration Gates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use compose:subagent (recommended) or compose:execute to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 保留服务一/服务二选择与凭据管理，但不再因本地“未配置”状态拦截 AI 请求。

**Architecture:** Rust 端继续按服务顺序读取凭据并尝试请求；找不到凭据时不直接返回 `not_configured`，而是继续走请求流程并返回真实失败结果。前端编排不再把 `not_configured` 当作拦截条件，配置页仍显示服务状态。

**Tech Stack:** React, TypeScript, Vitest, Tauri 2, Rust, reqwest, keyring.

## Global Constraints

- 只保留现有“服务一”和“服务二”，不新增服务。
- 删除所有拦截 AI 请求的“未配置”前置逻辑。
- 不暴露凭据，不改动无关的本地排盘和数据库逻辑。
- 完成前必须运行测试或构建验证。

---

### Task 1: Remove frontend not-configured request gate

**Files:**
- Modify: `client/src/data/deepseekAdapter.ts`
- Modify: `client/src/data/baziOrchestrator.ts`
- Test: `client/src/__tests__/deepseek.test.ts`
- Test: `client/src/__tests__/orchestration.test.ts`

**Interfaces:**
- Consumes: existing `analyzeBazi`, `analyzeTask`, `orchestrateBaziAnalysis` APIs.
- Produces: frontend calls Tauri `run_ai_task` whenever running in Tauri; browser injected runner remains supported.

- [ ] **Step 1: Write the failing test**

  Add a test that mocks the Tauri `run_ai_task` command to return a failed request and asserts the adapter reports `failed`, not `not_configured`; add an orchestration test that preserves the returned failure status and error.

- [ ] **Step 2: Run the focused tests and verify the regression**

  Run: `npm test -- --run src/__tests__/deepseek.test.ts src/__tests__/orchestration.test.ts`

  Expected: the new regression test fails against the current not-configured fallback behavior.

- [ ] **Step 3: Implement the minimal frontend change**

  Keep Tauri invocation unconditional in the Tauri branch. Remove only browser-side fallback paths whose sole purpose is to classify a missing runner as `not_configured`; use the injected runner when present and let the request result determine status. In orchestration, retain status aggregation but do not manufacture the `'未配置 AI 服务'` error as a request gate.

- [ ] **Step 4: Run focused tests**

  Run: `npm test -- --run src/__tests__/deepseek.test.ts src/__tests__/orchestration.test.ts`

  Expected: PASS.

### Task 2: Remove Rust-side credential existence gate

**Files:**
- Modify: `client/src-tauri/src/lib.rs`
- Test: `client/src-tauri/src/lib.rs` (unit tests)

**Interfaces:**
- Consumes: existing `run_ai_task(record, task)` and provider fallback order.
- Produces: configured providers still authenticate normally; absent/unreadable credentials no longer cause an immediate `not_configured` return before the request path is evaluated.

- [ ] **Step 1: Write the failing Rust test**

  Add a small pure helper test for the final status decision: when no provider can provide a credential, the result is a request failure status rather than `not_configured`.

- [ ] **Step 2: Run the Rust test and verify it fails**

  Run: `cargo test --manifest-path client/src-tauri/Cargo.toml`

  Expected: the new assertion fails against the current `if !configured { ... not_configured ... }` branch.

- [ ] **Step 3: Implement the minimal Rust change**

  Remove the `configured` tracking and the final `not_configured` return branch. If no provider credential is readable, return `failed` with the accumulated request/configuration error, while retaining provider order, API endpoints, models, and fallback behavior.

- [ ] **Step 4: Run Rust tests**

  Run: `cargo test --manifest-path client/src-tauri/Cargo.toml`

  Expected: PASS.

### Task 3: Build the latest double-clickable artifact and verify

**Files:**
- Generated: `client/src-tauri/target/release/mingli-client`
- Generated: `client/src-tauri/target/release/bundle/deb/命理客户端_0.1.0_amd64.deb`
- Generated: `client/src-tauri/target/release/bundle/rpm/命理客户端-0.1.0-1.x86_64.rpm`

- [ ] **Step 1: Run the full frontend test suite**

  Run: `npm test -- --run`

  Expected: PASS.

- [ ] **Step 2: Build the release application**

  Run: `npm run tauri:build`

  Expected: release executable and Linux bundles are regenerated under `client/src-tauri/target/release`.

- [ ] **Step 3: Verify artifact paths and executable metadata**

  Run: `find client/src-tauri/target/release -maxdepth 3 -type f -perm -111 -o -name '*.deb' -o -name '*.rpm'`

  Expected: the release executable is `client/src-tauri/target/release/mingli-client`; installable double-click packages are the generated `.deb` and `.rpm` files.
