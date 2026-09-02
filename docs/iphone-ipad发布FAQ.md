# iPhone / iPad 封装与“双击启动”FAQ

## 1. 苹果上根本没有“双击启动”这个动作
- Windows 的“双击 exe”对应苹果是：**安装后点 App 图标启动**(或主屏幕点图标)。
- 苹果系统不允许“把一个可执行文件拷进去双击运行”，必须安装签名过的 .app/.ipa。
- 所以目标应表述为：**生成 iPhone 版与 iPad 版，能一键安装、点图标启动**。装好后体验接近“双击启动”。

## 2. 一定要 Mac 吗？虚拟机行不行？
- 打 iOS 包必须用 macOS 的 Xcode 工具链(Apple 规定)。
- **Windows 上开 macOS 虚拟机**：官方许可只允许在苹果硬件上运行 macOS；普通 PC 上的 macOS VM 属灰色 Hackintosh，不稳定且可能过不了签名/公证，不推荐。
- **合法又省事的“远程 Mac”方案(推荐)**：
  1) GitHub Actions 的 macos-15 云 Runner(本质是一台托管 Mac)。本仓库已写好工作流：
     .github/workflows/build-ios.yml → Actions 页手动 Run，自动在 Mac 上编出 iPad/iPhone 包。
  2) 付费云 Mac(MacStadium/ AWS EC2 Mac 等)：需要长期打包也可用。
  3) 借/买一台 Mac(哪怕二手 Mac mini)最直接。

## 3. 云端打包能出什么、还差什么
- **模拟器包(.app，未签名)**：CI 每次都能产出，可在 Mac 上 Xcode 模拟器打开看效果——用于验收 UI。
- **真机 .ipa**：需要 Apple 开发者证书。在仓库 Settings→Secrets 配置：
  - APPLE_CERT_B64(你的 .p12 证书 base64)
  - APPLE_CERT_PASSWORD(证书密码)
  - APPLE_TEAM_ID(开发者 Team ID)
  配置后 CI 自动签名生成可安装的 .ipa(个人免费账号限 7 天/真机)。
  或下载“模拟器包/未签名产物”后用 Xcode(Archive→Ad Hoc)补签名。

## 4. 安装到你的 iPhone/iPad
- 个人自用：Apple Configurator / 爱思助手 / Xcode Device 安装 .ipa；
- 发布：TestFlight(最省事)或 App Store(需审核)。

## 5. 代码侧状态(已就绪)
- 数据目录按系统切换(沙盒)；iOS 密钥走 Keychain；图标资源齐全。
- 因此 CI 一次通过后即可得到可直接安装的苹果版本。