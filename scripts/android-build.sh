#!/usr/bin/env bash
# 用法：scripts/android-build.sh [e2e|debug|release] [--clean]
#   e2e     内置 JS、用样例代替系统相册，连 10.0.2.2:8787，模拟器和 CI 用
#   debug   开发版，配合 pnpm dev:mobile 热更新
#   release 正式版，需要 ANDROID_KEYSTORE_* 和 EXPO_PUBLIC_API_URL（见 docs/DEPLOYMENT.md）
set -euo pipefail
source "$(dirname "$0")/env.sh"

MODE="${1:-e2e}"
CLEAN="${2:-}"
cd "$ROOT/apps/mobile"

case "$MODE" in
  e2e)
    source "$ROOT/scripts/e2e-build-env.sh"
    TASK=assembleRelease
    ;;
  debug)
    export ANDROID_ARCHS="${ANDROID_ARCHS:-x86_64}"
    TASK=assembleDebug
    ;;
  release)
    : "${EXPO_PUBLIC_API_URL:?正式版必须设置 EXPO_PUBLIC_API_URL}"
    # 少了这些不能继续：否则 APK 会用调试密钥签名，换正式密钥后家人无法覆盖安装。
    : "${ANDROID_KEYSTORE_PATH:?正式版必须设置 ANDROID_KEYSTORE_PATH}"
    : "${ANDROID_KEYSTORE_PASSWORD:?正式版必须设置 ANDROID_KEYSTORE_PASSWORD}"
    : "${ANDROID_KEY_ALIAS:?正式版必须设置 ANDROID_KEY_ALIAS}"
    : "${ANDROID_KEY_PASSWORD:?正式版必须设置 ANDROID_KEY_PASSWORD}"
    export ANDROID_ARCHS="${ANDROID_ARCHS:-arm64-v8a}"
    export ANDROID_ALLOW_HTTP="${ANDROID_ALLOW_HTTP:-0}"
    TASK=assembleRelease
    ;;
  *)
    echo "未知模式：$MODE" >&2
    exit 1
    ;;
esac

PREBUILD_ARGS=(--platform android --no-install)
[ "$CLEAN" = "--clean" ] && PREBUILD_ARGS+=(--clean)
CI=1 npx expo prebuild "${PREBUILD_ARGS[@]}"

if [ "$MODE" = "release" ]; then
  node "$ROOT/scripts/android-signing.mjs" android/app/build.gradle
fi

cd android
# 限制内存：本机同时还在跑模拟器和其他项目。CI 上可以用环境变量放开。
./gradlew ":app:$TASK" \
  --max-workers="${GRADLE_WORKERS:-3}" \
  -PreactNativeArchitectures="$ANDROID_ARCHS" \
  -Porg.gradle.jvmargs="-Xmx${GRADLE_HEAP:-3g} -XX:MaxMetaspaceSize=1g -Dfile.encoding=UTF-8" \
  -Porg.gradle.daemon=false

VARIANT=release
[ "$MODE" = "debug" ] && VARIANT=debug
OUT="$ROOT/.artifacts/xiaodouya-$MODE.apk"
cp "app/build/outputs/apk/$VARIANT/app-$VARIANT.apk" "$OUT"
ls -lh "$OUT"
