#!/usr/bin/env bash
# 端到端测试：真实服务端 + 真实 S3 协议 + 真实 App。
# 前置：pnpm dev:infra、模拟器已启动、.artifacts/xiaodouya-e2e.apk 已构建。
# 用法：scripts/e2e.sh [流程文件...]，默认跑 e2e/flows 下全部。
set -euo pipefail
source "$(dirname "$0")/env.sh"
cd "$ROOT"

# 模拟器只有一台，多个 Agent 同时跑时排队。
exec 9>"${TMPDIR:-/tmp}/xiaodouya-emulator.lock"
flock 9

APK="$ROOT/.artifacts/xiaodouya-e2e.apk"
[ -f "$APK" ] || { echo "找不到 $APK，先运行 pnpm android:build e2e" >&2; exit 1; }

SERVER_PID=""
cleanup() { [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true; }
trap cleanup EXIT

if curl -fs http://localhost:8787/healthz >/dev/null 2>&1; then
  echo "警告：8787 端口已有服务端在运行，将直接使用它。它可能是别的分支的代码。" >&2
else
  (cd apps/server && npx tsx --env-file-if-exists=.env src/index.ts > "$ROOT/.artifacts/server.log" 2>&1) &
  SERVER_PID=$!
  for _ in $(seq 1 60); do
    curl -fs http://localhost:8787/healthz >/dev/null 2>&1 && break
    sleep 1
  done
  curl -fs http://localhost:8787/healthz >/dev/null || { echo "服务端没有启动" >&2; exit 1; }
fi

# 刚开机的模拟器很忙，系统桌面可能弹“isn't responding”挡住界面，和 App 无关。
adb shell settings put global hide_error_dialogs 1 || true
sleep "${E2E_SETTLE_SECONDS:-30}"

adb uninstall com.gchust.xiaodouya >/dev/null 2>&1 || true
adb install -r "$APK"

FLOWS=("$@")
[ ${#FLOWS[@]} -eq 0 ] && mapfile -t FLOWS < <(ls e2e/flows/*.yaml)
RUN_ID="$(date +%s)"
mkdir -p .artifacts/maestro
for flow in "${FLOWS[@]}"; do
  echo "▶ $flow"
  maestro test --env "RUN_ID=$RUN_ID" --debug-output .artifacts/maestro --flatten-debug-output "$flow"
done
node e2e/verify-uploads.mjs "$RUN_ID"
echo "E2E 全部通过"
