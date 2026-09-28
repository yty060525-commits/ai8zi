---
feature: ai-provider-fallback
status: delivered
specs: []
plans:
  - docs/compose/plans/2026-09-01-ai-provider-fallback.md
branch: workspace
commits: none
---

# AI 服务回退与分析展示 — Final Report

## What Was Built

记录详情页点击“AI 分析”后会启动现有 25 项分析任务。默认优先使用服务一（DeepSeek）；首选服务未配置、网络失败、HTTP 错误或返回格式错误时，自动尝试服务二（Kimi，当前模型 `kimi-k2.6`）。任一服务成功即可保存分析结果，两边都失败时返回安全的失败类别。

最终结论区域现在展开显示格局、强弱、喜忌和解释文本。设置页保存凭据时显示保存中，成功后显示已配置，失败时保留输入内容便于重试。

## Architecture

`client/src-tauri/src/lib.rs` 根据当前选择生成服务尝试顺序，并在单个 AI 任务内依次读取系统钥匙串、发起请求、校验 HTTP 与 JSON 响应。`client/src/data/deepseekAdapter.ts` 负责将前端对象序列化为 Rust 命令所需格式；`baziOrchestrator.ts` 只复用已完成任务，失败或未配置任务会重新请求。

### Design Decisions

默认顺序由当前选择决定，首次安装默认服务一；这样保留用户主动切换服务二的能力，同时对服务故障提供自动回退。密钥始终只在 Rust/系统钥匙串侧使用，前端只接收状态或安全错误。

## Usage

在设置页选择服务一并保存对应 API Key。点击记录详情页的“AI 分析”按钮后等待状态变为“已完成”；如果服务一失败，程序会自动尝试服务二。最终结论会直接展开在 AI 分析区域。

## Verification

- 前端：12 个测试文件、50 个测试全部通过。
- Rust：5 个测试全部通过。
- 生产前端构建通过；仅存在 bundle 体积提示。
- 覆盖了 Tauri 结构化字段序列化、失败任务重试、服务顺序、保存失败反馈和最终结果展示。
- 真实 API 验证：DeepSeek HTTP 200；Kimi `kimi-k2.6` HTTP 200，均返回可解析结构化 JSON。

## Journey Log

- [lesson] 前端直接把结构化记录对象传给 Rust 会导致命令参数反序列化失败，必须在 Tauri 边界统一 JSON 序列化。
- [pivot] 失败任务不能永久缓存为完成状态；只有 `completed` 才复用，其他状态在再次分析时重试。
- [lesson] Kimi 当前可用模型要求 `temperature=1`；旧模型名和统一 `temperature=0` 会分别触发 404/400。

## Source Materials

| File | Role | Notes |
|---|---|---|
| `docs/compose/plans/2026-09-01-ai-provider-fallback.md` | Implementation plan | Completed |
| `client/src-tauri/src/lib.rs` | Provider routing | Keyring and fallback execution |
| `client/src/data/deepseekAdapter.ts` | Frontend adapter | Tauri payload serialization |
| `client/src/features/person/PersonDetail.tsx` | UI | Expanded final conclusion |
