# iPad(iPadOS)打包指南

本工程是 Tauri 2(React+TS+Rust)。**iPad 包只能在 macOS + Xcode 上构建**(本工程在 Windows 开发机上无法产出 iOS 包)。

## 代码侧已做的适配(已完成)
- 数据目录按系统切换：iOS/iPadOS/Android 用系统沙盒目录；桌面仍为 exe 同目录 data(便携)。
- 密钥：iOS 启用 keyring apple-native(Keychain)；设置页在移动端如不可用会自动降级提示(Keychain 需真机/签名)。
- 前端布局为普通 Web 视图，可在 iPad 全屏自适应(默认窗口尺寸仅桌面用)。

## 在 Mac 上的打包步骤
前置：macOS 14+、Xcode 15+、Apple Developer 账号(个人免费也可真机 7 天)。

1) 安装依赖(终端)：
   brew install node rustup-init
   rustup default stable
   rustup target add aarch64-apple-ios aarch64-apple-ios-sim
2) 前端依赖：
   cd client && npm ci
3) 生成 iOS 工程并初始化(需在 Mac 上)：
   npm run tauri ios init
   # 若提示缺少权限/平台，先: cargo tauri android/ios 相关, 或 npm run tauri icon
4) 真机调试(连 iPad)：
   npm run tauri ios dev
5) 出正式包：
   npm run tauri ios build
   产物在 src-tauri/gen/apple/build/*/*.ipa(需在 Xcode 里配置签名 Team)。

## 分发建议
- 个人自用：Xcode → Product → Archive → Distribute App → 选 'Ad Hoc' 或 'Development'，把 .ipa 用 Apple Configurator/爱思助手装到你的 iPad。
- 对外发布：TestFlight(需 App Store Connect)或 App Store。

## 注意
- AI 请求为 HTTPS，iPad 上请保持网络可用；
- 密钥存 Keychain(随 Apple ID/设备)，与 Windows 的凭据管理器互不可见；
- 数据库自动放在 App 沙盒 Documents/Library 下(系统管理，无法像桌面那样随意拷贝，但 iCloud 备份可含)。