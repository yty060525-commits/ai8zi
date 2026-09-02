# 命理客户端（AI 八字分析）

Windows 桌面端( Tauri 2 + React + TypeScript + Rust/SQLite )。原则：**程序负责确定性计算，AI 只做解释**；AI 用思考模式(deepseek-reasoner)，结果全部落本地 SQLite 并带命中缓存。

## 功能
- 排盘：输入姓名/性别/出生年月 + 四柱 → 本地确定性引擎一次算出 四柱/五行/十神(含藏干)/纳音/十二长生/经典神煞(逐柱)/三合六合冲刑害破克/袁天罡称骨/大运·流年·流月(干支+关系)，并给出“生肖人际适配(我属X→三合/六合/冲/害属相)”。
- AI 分析(按任务独立调 API，思考模式)：
  ① 本命(身强身弱/格局/喜忌 + 健康/事业/财运/爱情 + 总评)——只算一次；
  ② 后天调整与职业适配(按喜用五行取内置知识库)——只算一次；
  ③ 所处大运(未来十年)、④ 未来十年·每年、⑤ 从今天起·未来十二个月——不再重复喜忌，正文含【健康】【事业】【财运】【爱情】与(有命中时)【刑冲克害批注】；
  - 批文标题只引用古籍原文/口诀(《三命通会》《渊海子平》等)，并禁止输出 /* */、HTML 注释、代码块等草稿标记。
- 命中缓存(ai_cache)：同八字+性别+任务+年/月+模型 只算一次；断点续跑跳过已完成；脏结果(空正文)自动重算。

## 运行与打包
- 桌面窗口开发：`启动-桌面版开发.cmd`(需 Rust MSVC 工具链)；网页版预览仅看布局：`启动-网页版预览.cmd`(无数据库/AI)。
- 正式构建：双击 `client\build-windows.cmd` → 产出 exe 与安装包；也可用 GitHub Actions(`.github/workflows/build-windows-exe.yml`)云构建。
- 成品目录：`release\windows\命理客户端.exe`(免安装双击版)、`命理客户端-安装版.exe`(NSIS)。
- 编译中间件默认放到**项目外** `%LOCALAPPDATA%\mingli-client-target`，项目本体不膨胀(见下)。

## 体积：为什么大 & 怎么保持小
- 源码+依赖(含前端包)约 0.2GB；**几十 GB 级的都是 Rust 编译中间件 target/**，只影响开发机、不影响成品(成品 exe 仅 12MB)。
- 已把编译输出改到项目外：`set CARGO_TARGET_DIR=%LOCALAPPDATA%\mingli-client-target`(脚本内已内置)；日常双击 `清理体积.cmd` 可再清 debug 与旧中间件。
- 需重新构建时：双击 `client\build-windows.cmd`(自动 npm ci → 前端 → tauri build，约 1-3 分钟增量)。

## 数据库位置(相对路径，绿色便携)
- 数据库放在 **exe 同目录的 `data\bazi_records.sqlite3`**(记录+全部 AI 结果+缓存)。整个文件夹拷贝/移动，数据随行；首次启动若发现旧版 %APPDATA% 数据会自动迁入。
- 安装版(NSIS currentUser)默认装在 `%LOCALAPPDATA%\命理客户端\`，其 exe 同目录也会生成 `data\`；设置页可看体积/缓存条数并可“压缩旧记录”。

## AI 配置
- 设置页：服务一/服务二 = DeepSeek/Kimi，密钥存 Windows 凭据管理器(不落盘)；有“AI 连通自检(微小消耗)”。

## 测试
- 前端：`client` 内 `npm test`(72 项)；Rust：`client\src-tauri` 内 `cargo test --lib`。

## 目录速览
- `client/src/features/chart` 非AI引擎(nonAiCalculator/shenSha/称骨等) 与 排盘输入；`data/` AI编排/适配/仓库/知识库；`person/` 详情展示；
- `client/src-tauri` Rust：SQLite、密钥、AI 请求(最小上下文+缓存+reasoner 参数)；`docs/` 设计文档。

## iPhone / iPad(点图标启动=苹果的“双击”)
- 苹果没有“双击 exe”，对应为**安装后点图标启动**；打 iOS 包必须 macOS 工具链。
- 不买 Mac 也行：用 **GitHub Actions macos 云 Runner**——仓库已含 `.github/workflows/build-ios.yml`，Actions 手动触发即在云端 Mac 编出 iPhone/iPad 包。
- 详见 `docs/iphone-ipad发布FAQ.md`(虚拟机/证书/安装) 与 `docs/ipad打包指南.md`(自有 Mac 的详细命令)。

## 已知边界(请知悉)
- Kimi 思考模式参数待厂商文档确认(现作降级)；DeepSeek reasoner 已验证(需 max_tokens=32768 + 思考从简提示)。
- 袁天罡称骨骨重表为通行版本(ruleVersion chenggu-v1)，请用古本抽查校准(改 nonAiCalculator.ts 顶部表即可)。
- 六破口诀为通行口诀(未见统一古本)；如你有更权威原文，发我可替换 prompt 中的引用片段表。
- 古风标题引用语料在 Rust prompt 内(仅允许所列古籍原文，禁止模型自创)。

## 版本
v0.1.0 · Tauri 2 / React / Vite 8 / Rust / SQLite