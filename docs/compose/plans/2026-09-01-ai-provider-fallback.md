# AI Provider Fallback Implementation Plan

> [!NOTE]
> This document may not reflect the current implementation.
> See the final report for up-to-date state:
> [Final Report](../reports/ai-provider-fallback.md)

> **For agentic workers:** REQUIRED SUB-SKILL: Use compose:subagent (recommended) or compose:execute to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make AI analysis prefer service one, retry service two when the first configured service fails, and make credential failures visible and diagnosable without exposing secrets.

**Architecture:** Keep provider credentials in the existing system keyring. Add a Rust command that reports status for both providers and runs one requested provider, then let the frontend adapter try configured providers in deterministic order (`deepseek`, then `kimi`) while preserving the existing task/result schema. The settings page confirms save progress and retains input on failure.

**Tech Stack:** React, TypeScript, Vitest, Tauri 2, Rust, keyring, reqwest.

## Global Constraints

- Credentials must never be returned to the frontend or written to SQLite, source, fixtures, or build output.
- Service one is the neutral UI mapping for DeepSeek; service two maps to Kimi.
- AI calls must continue to use structured non-AI facts and the existing 25-task orchestration.
- Error messages may expose only safe categories such as not configured, network failure, HTTP status, or invalid response.

### Task 1: Provider status and fallback adapter

**Covers:** provider selection, automatic fallback, safe failure reporting.

**Files:**
- Modify: `client/src/data/aiSettings.ts`
- Modify: `client/src/data/deepseekAdapter.ts`
- Test: `client/src/__tests__/ai-settings.test.ts`, `client/src/__tests__/deepseek-adapter.test.ts`

**Interfaces:**
- Consume the existing `get_ai_provider_status`, `set_ai_provider`, and `run_ai_task` Tauri commands.
- Produce a deterministic adapter path that tries configured service one first and service two second, returning the first completed result or a safe combined failure.

- [ ] Write failing tests that verify both service statuses are read, service one is attempted first, service two is attempted after a safe failure, and no secret is returned.
- [ ] Run the focused tests and confirm they fail for the missing fallback behavior.
- [ ] Implement the smallest provider status/fallback adapter change; serialize structured record fields before Tauri invocation and keep existing task result types.
- [ ] Run focused adapter/settings/orchestration tests and confirm they pass.

### Task 2: Settings confirmation and end-to-end verification

**Covers:** visible save state and actionable diagnostics.

**Files:**
- Modify: `client/src/features/settings/SettingsPage.tsx`
- Test: `client/src/__tests__/settings-page.test.tsx`, `client/src/__tests__/app-flow.test.tsx`

**Interfaces:**
- Consume the status-only settings adapter from Task 1.
- Produce clear `保存中`/`已配置`/`保存失败` UI states while never rendering the credential.

- [ ] Add a failing test for save progress and failed-save retry behavior.
- [ ] Implement status feedback and preserve the entered credential only on failure.
- [ ] Run all frontend tests, `npm run build`, and `cargo test`.
- [ ] Scan source and build output for credential literals and provider secrets; record any remaining limitation as an environment issue rather than hiding it.
