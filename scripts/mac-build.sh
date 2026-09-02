#!/usr/bin/env bash
# 一键在 Mac 上打 iPhone/iPad 包(需 Xcode + Apple 开发者证书；也可先出模拟器包)
set -euo pipefail
cd "$(dirname "$0")/../client"

echo "[1/4] 依赖"
npm ci --no-audit --no-fund

echo "[2/4] 前端"
npm run build

echo "[3/4] iOS 工程初始化(幂等)"
npx tauri ios init >/dev/null 2>&1 || echo "已初始化"

echo "[4/4] 构建"
if [ "${APPLE_TEAM_ID:-}" != "" ]; then
  npx tauri ios build --team-id "$APPLE_TEAM_ID"
  echo "完成：src-tauri/gen/apple/build 下 .ipa 已签名"
else
  echo "未设置 APPLE_TEAM_ID → 先出模拟器包(无签名)："
  npx tauri ios build --target aarch64-apple-ios-sim --no-bundle
  echo "真机 ipa 需要: export APPLE_TEAM_ID=你的TeamID + 安装证书后重跑"
fi