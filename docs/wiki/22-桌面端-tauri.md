# 22 桌面端（Tauri 2 + Rust）

位置：[client/src-tauri](../../client/src-tauri)。Rust 侧只有两个源文件，但它是「本机通道」的全部实现：SQLite、系统凭据、AI 请求与缓存。

| 文件 | 职责 |
| --- | --- |
| [src/main.rs](../../client/src-tauri/src/main.rs) | 仅 `windows_subsystem` 属性 + 调 `mingli_client_lib::run()`，不放业务代码 |
| [src/lib.rs](../../client/src-tauri/src/lib.rs) | 全部命令与复刻逻辑（约 1257 行，16 个 `#[tauri::command]`，21 个单测） |
| [Cargo.toml](../../client/src-tauri/Cargo.toml) | rusqlite(bundled)、reqwest(rustls)、keyring(按 OS 启用后端)、tokio |
| [tauri.conf.json](../../client/src-tauri/tauri.conf.json) | 窗口、打包、图标、前端产物路径 |

## 启动与数据目录

`run()`（lib.rs 第 900 行）在 setup 阶段决定库的位置：桌面取 **exe 同目录 `data\bazi_records.sqlite3`**（绿色便携，整个文件夹拷走数据随行），iOS/Android 用系统沙盒目录；旧版 `%APPDATA%` 数据首次启动自动迁入。数据库连接包在 `Mutex<Connection>` 里由 Tauri 托管。

<a id="schema"></a>
## 表结构

`initialize()`（第 23 行）建两张表：

- `bazi_records(id, name, gender, birth_year, birth_month, created_at, 四柱, non_ai_result, ai_status, ai_analysis, ai_overview, ai_error, ai_tasks)` —— 整条记录的大字段以 JSON 文本存。
- `ai_cache(cache_key PRIMARY KEY, chart_sig, payload, created_at)` —— 与服务器的缓存表同形。

配套内部函数：`chart_sig_from_key`（第 63 行，从缓存键派生签名）、`compact_records_in`（第 190 行）、`purge_chart_cache`（第 215 行，按签名索引精确删，不再前导通配 LIKE 全表扫）。

## 命令清单（前端 invoke 名 → lib.rs 定义处）

| 命令 | 定义 | 说明 |
| --- | --- | --- |
| `init_database` | 141 | 建表 |
| `save_bazi_record` / `list_bazi_records` / `get_bazi_record` / `delete_bazi_record` | 144–166 | 记录 CRUD |
| `clear_chart_cache` | 228 | 按命盘清任务与聊天缓存 |
| `get_storage_stats` / `compact_records` | 235 / 271 | 体积统计、压缩旧记录 |
| `ai_self_test` | 245 | 连通自检（微小消耗） |
| `save_ai_credential` / `clear_ai_credential` / `get_ai_provider_status` / `set_ai_provider` | 116–135 | 密钥进 Windows 凭据管理器，不落盘 |
| `run_ai_task` | 711 | 单任务执行：先查缓存，未命中才发请求；开跑前与每次重试前读会话取消标记 |
| `run_ai_chat` | 834 | 断网时的聊天兜底通道（**不读**会话取消标记，见下方「立即停止」一节） |
| `begin_ai_session` / `cancel_ai_session` | 698 / 701 | 全局取消标记 `AI_SESSION_CANCELLED` |

调用方集中在 [client/src/data](../../client/src/data)：见 [12-客户端-数据层](./12-客户端-数据层.md)。

## 「立即停止」在桌面这一侧接到哪里（#142 / #143）

会话开关 `AI_SESSION_CANCELLED` 是**进程级全局**，Rust 只在任务通道读它 —— `run_ai_task` 三处：开跑前(712)、每条通道的重试循环开头(741)、以及 `tokio::select!` 里与请求同时等(748)，命中一律 `Err("cancelled")` 且不发请求。聊天通道 `run_ai_chat`(834–895)**一条都没读**。这是有意还是漏要看清：详情页 `stopAnalysis()` 会调 `cancelAiSession()`，而聊天区的「清空对话」和「发起新一问」只 abort 本地控制器、不调它([ChartChat.tsx](../../client/src/features/chart/ChartChat.tsx) 第 52–56、102–108 行)，所以桌面聊天那一问在途时按停止，上游照样跑完、结果照样落本机缓存。

缺陷 #142 不在 Rust，在 JS 这两处：`analyzeBazi` / `analyzeTask` 的 `inTauri()` 分支把 `Err("cancelled")` 交给 `readableTransportError()`，那里只认限流那类英文关键词，中文里没有可留片段就兜底成「服务未给出可显示的原因」——于是用户主动停止被编排器当成**一条失败批断**存进 `aiTasks`，还会被自动重试追一次。现在由 `cancelledBySession()` 认出这一个串：`analyzeBazi` 走 `abortResult()`，`analyzeTask` 直接写 `error: '已取消'`（它的返回类型在有分析结果那支不带 `error`，绕一圈读 `abortResult().error` 会被类型收窄判成不存在的属性）。

判据在 [tauri-task-abort.test.ts](../../client/src/__tests__/tauri-task-abort.test.ts)（6 条），桩替身按 Rust 的真实语义实现（置位后 `run_ai_task` 抛 `cancelled`），取消走真实导出 `cancelAiSession()` 而不是直接改桩里的布尔，免得自证。变异读数六条全杀：删掉任务支识别 → 红；两个入口一起中性化(识别恒假) → 2 红；删掉聊天「发前已中止」预检 → 红；删掉「回包时已中止」拦下 → 红；删掉服务器分支取证后的预检 → 红。

⚠ 两条**记录现状而非理想**的反向钉子，别当 bug 顺手改：① 中止时 `askChatLocal` 仍会进入一次（实测读数 1）；② 桌面聊天那一问被中止后仍会落一次本机缓存（实测读数 1）—— 客户端拦不住已经花掉的那次，要闭合得先给 `run_ai_chat` 补 Rust 侧闸门，或让「清空对话／新一问」也调 `cancelAiSession()`，两者都还没做。

## 概念复刻对照（本端 ↔ 另两端）

Rust 不 import TypeScript，所以以下每一项都是**有意复刻**，改动必须三处同步：

| 概念 | Rust 位置 | 对端位置 |
| --- | --- | --- |
| 通道标签 | `AiProvider::label()` 第 89–91 行 | `PROVIDER_LABEL`（[ai.mjs](../../server/ai.mjs) 第 14 行）、[aiSettings.ts](../../client/src/data/aiSettings.ts) |
| 状态码读中文 | `cn_code` 第 95 行 | [chineseReadAloud.ts](../../client/src/shared/chineseReadAloud.ts) |
| 语气 | `clamp_tone` / `tone_instruction` / `tone_bucket` 第 308–316 行 | `ai.mjs` 第 34–40 行 |
| 缓存键 | `cache_key`，当前 `v11`(与服务器 v15 **各自演进**，两边查各自的库) | `ai.mjs` `v15` |
| 聊天缓存键 | `chat_cache_key` + `fnv1a`，当前 `chatv6` —— **必须等于服务端读数**([cache-key-cross-end.test.ts](../../client/src/__tests__/cache-key-cross-end.test.ts)) | `chatCacheKey`（[chat.mjs](../../server/chat.mjs)） |
| 时段提示词 | `SCOPE_PREFIX` 第 367 行 | 两端同名常量 |
| 本命提示词 | `BASELINE_PREFIX` 第 383 行 | 同上 |
| 失败分类 | `classify_failure` 第 470 行、`final_ai_status` 第 487 行 | `classifyFailure`（[deepseekAdapter.ts](../../client/src/data/deepseekAdapter.ts) 第 37 行） |
| 请求体整形 | `api_request_payload` 第 348 行、`apply_reasoner_settings` 第 356 行 | 适配层 |
| 证据裁剪 | `compact_shen_sha` / `pick_by_year` / `pick_by_month` / `pick_decade` / `summarize_hits` 第 397–424 行 | 聊天检索层 |

完整口径与判据见 [13-跨端共享与三端一致性](./13-跨端共享与三端一致性.md)。

## 构建与测试

```bash
cd client && npm run tauri dev          # 桌面开发（需 Rust MSVC 工具链）
client\build-windows.cmd                # 正式构建：npm ci → 前端 → tauri build
cd client/src-tauri && cargo test --lib # 21 项
```

编译中间件默认输出到项目外 `%LOCALAPPDATA%\mingli-client-target`（脚本内置 `CARGO_TARGET_DIR`），避免项目本体膨胀几十 GB。成品在 `release\windows\`：免安装 exe 与 NSIS 安装版。详见 [41-构建与发布](./41-构建与发布.md)。

## iOS / iPad

打 iOS 包必须 macOS 工具链；无 Mac 可用 GitHub Actions 的 macos 云 Runner（工作流 `.github/workflows/build-ios.yml`）。文档：[iphone-ipad 发布 FAQ](../iphone-ipad发布FAQ.md)、[ipad 打包指南](../ipad打包指南.md)、[GitHub Actions 下载 ipa](../github-actions-下载ipa.md)。
