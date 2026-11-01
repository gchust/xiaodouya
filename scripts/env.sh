#!/usr/bin/env bash
# 所有 Android 脚本共用的环境。
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$ANDROID_HOME/cmdline-tools/latest/bin:$HOME/.maestro/bin:$PATH"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export ROOT
if [ -z "${JAVA_HOME:-}" ] && command -v mise >/dev/null; then
  JAVA_HOME="$(cd "$ROOT" && mise where java 2>/dev/null || true)"
  export JAVA_HOME
fi
[ -n "${JAVA_HOME:-}" ] && export PATH="$JAVA_HOME/bin:$PATH"
mkdir -p "$ROOT/.artifacts"
