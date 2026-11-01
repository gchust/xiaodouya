#!/usr/bin/env bash
# 用法：scripts/ios-build.sh
# 编译给 iOS 模拟器用的 E2E 版（Release 配置、内置 JS、不用 Apple 账号），只能在 macOS 上跑。
# 产物：.artifacts/xiaodouya-e2e.app。正式版的归档和上传见 docs/DEPLOYMENT.md。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$ROOT/.artifacts"

# EXPO_PUBLIC_* 是 Xcode 的打包脚本运行 Metro 时才写进 JS 的，所以要在 xcodebuild 之前导出，
# 只在 prebuild 时设置不起作用。
export EXPO_PUBLIC_E2E=1
# 模拟器和宿主机共用网络，用 localhost。10.0.2.2 只有 Android 模拟器才有。
export EXPO_PUBLIC_API_URL="${EXPO_PUBLIC_API_URL:-http://localhost:8787}"
# CocoaPods 在非 UTF-8 环境下会直接报错。
export LANG="${LANG:-en_US.UTF-8}"
export LC_ALL="${LC_ALL:-en_US.UTF-8}"

cd "$ROOT/apps/mobile"
CI=1 npx expo prebuild --platform ios --no-install --clean

# 工程名由 App 名决定。“小豆芽”里没有 ASCII 字符，Expo 退回到 app，所以 workspace 和 scheme 都叫 app。
(cd ios && pod install)

echo "--- 合并后的隐私清单 ---"
cat ios/app/PrivacyInfo.xcprivacy
echo "--- Info.plist ---"
plutil -p ios/app/Info.plist

# 只编 arm64 能省一半时间，Runner 本身就是 arm64。
# 用 “-” 做本地签名，不需要 Apple 账号。不能写 CODE_SIGNING_ALLOWED=NO：没有签名就没有钥匙串权限，
# SecureStore 读令牌时报 -34018，App 一直停在空白页。
xcodebuild \
  -workspace ios/app.xcworkspace \
  -scheme app \
  -configuration Release \
  -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath ios/build \
  ARCHS=arm64 \
  ONLY_ACTIVE_ARCH=YES \
  CODE_SIGN_IDENTITY=- \
  build 2>&1 | tee "$ROOT/.artifacts/xcodebuild.log" | xcbeautify --quiet

APP="ios/build/Build/Products/Release-iphonesimulator/app.app"
rm -rf "$ROOT/.artifacts/xiaodouya-e2e.app"
cp -R "$APP" "$ROOT/.artifacts/xiaodouya-e2e.app"
du -sh "$ROOT/.artifacts/xiaodouya-e2e.app"
