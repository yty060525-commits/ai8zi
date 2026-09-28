# 手动在 GitHub Actions 点 Run 并下载 .ipa（保姆级）

## 0) 你要先有的东西
- 一个 GitHub 账号（github.com 免费注册）。
- （可选，出真机 ipa 才需要）Apple 开发者证书；只要模拟器包/截图则不需要。

## 1) 创建仓库并推送
- 浏览器登录 GitHub → New repository（名字随意，例如 mingli）→ 选 Private 或 Public → Create。
- 命令行（需已装 git；没有可用 winget install Git.Git 安装）：
  cd 项目根目录(含 client/ 和 .github/)
  git init && git add -A && git commit -m init
  git branch -M main
  git remote add origin https://github.com/<你的用户名>/mingli.git
  git push -u origin main

## 2) 触发 Actions 工作流
- 仓库页面 → 顶部 Actions → 左侧选 build-ios-ipad → 右侧 Run workflow（下拉选 main，绿色按钮）。
- 第一次跑会自动：装 Node/Rust(iOS target)→npm ci→前端构建→tauri ios init→编译→装进 iPhone 模拟器→点图标启动→截图上传。

## 3) 下载产物
- 跑完（约 10-20 分钟）回到该页面刷新，Artifacts 区会出现：
  - mingli-ios-simulator：模拟器 .app（Mac 上 Xcode 可打开，先验证 UI）
  - mingli-ios-screenshot：启动截图（立刻能看它在 iPhone 上的样子）
- 点击下载即可。

## 4) 出“真机能装”的 .ipa（需要证书）
在你任一台 Mac 或云 Mac 上（或用免费 Apple ID 7 天方案）：
- Xcode → Settings → Accounts 登录 Apple ID；
- 下载本机 Developer 证书（Distribution 或 Apple Development）并导出为 .p12（含密码）。
- 把 .p12 用 base64 编码，得到三样：
   APPLE_CERT_B64 = base64(你的证书.p12)
   APPLE_CERT_PASSWORD = p12 密码
   APPLE_TEAM_ID = 你 Apple ID 的 Team ID（Accounts 页可看到）
- 回到仓库 → Settings → Secrets and variables → Actions → New repository secret 分别添加这三项。
- 再去 Actions 手动 Run workflow，真机 .ipa 会以 mingli-ios-device 出现在 Artifacts。

## 5) 装到你的 iPad/iPhone
- 个人自用：下载 .ipa → 用 Apple Configurator（Mac）或爱思助手/第三方在线安装传到设备；
- 免费 Apple ID 签名的包每 7 天需重签重装；正式长期使用建议开发者账号(99美元/年)或 TestFlight。

## 常见卡点
- 触发后立刻失败：多半是仓库没有我们的 workflow 文件（请确认推的是本项目根目录，含 .github/workflows/build-ios.yml）。
- 真机 ipa 步骤没跑：因为没配 Secrets，属预期；先下载 simulator/screenshot 验证即可。
- 首次 tauri ios init 失败：看日志报错发我。