#!/usr/bin/env bash
# 端到端测试：真实服务端 + 真实 S3 协议 + 真实 App。
# 前置：pnpm dev:infra、模拟器已启动、.artifacts/xiaodouya-e2e.apk 已构建。
# 用法：
#   scripts/e2e.sh                  串行跑全部分组，每组重装 App、用新账号（约 1 小时）
#   scripts/e2e.sh --group 组名     只跑一组（CI 每台模拟器跑一组），分组见 e2e/groups.json
#   scripts/e2e.sh 流程文件...      只跑这几条，依赖的流程要自己带上
set -euo pipefail
source "$(dirname "$0")/env.sh"
cd "$ROOT"

# 模拟器只有一台，多个 Agent 同时跑时排队。
exec 9>"${TMPDIR:-/tmp}/xiaodouya-emulator.lock"
flock 9

APK="$ROOT/.artifacts/xiaodouya-e2e.apk"
[ -f "$APK" ] || { echo "找不到 $APK，先运行 pnpm android:build e2e" >&2; exit 1; }

SERVER_PID=""
ANR_PID=""
cleanup() {
  # 负号是杀整个进程组：npx 下面还有 node，只杀 npx 的话服务端会留下来。
  [ -n "$SERVER_PID" ] && kill -- "-$SERVER_PID" 2>/dev/null || true
  [ -n "$ANR_PID" ] && kill "$ANR_PID" 2>/dev/null || true
}
trap cleanup EXIT

if curl -fs http://localhost:8787/healthz >/dev/null 2>&1; then
  echo "警告：8787 端口已有服务端在运行，将直接使用它。它可能是别的分支的代码。" >&2
else
  # 后台进程不能带着锁（9>&-）：否则这次跑完锁还在，下一次调用会一直排队。
  setsid bash -c 'cd apps/server && exec npx tsx --env-file-if-exists=.env src/index.ts' \
    > "$ROOT/.artifacts/server.log" 2>&1 9>&- &
  SERVER_PID=$!
  for _ in $(seq 1 60); do
    curl -fs http://localhost:8787/healthz >/dev/null 2>&1 && break
    sleep 1
  done
  curl -fs http://localhost:8787/healthz >/dev/null || { echo "服务端没有启动" >&2; exit 1; }
fi

# 系统桌面偶尔会卡住并弹窗挡住 App，全程在后台清掉。
bash scripts/dismiss-anr.sh 9>&- &
ANR_PID=$!

# 刚开机的模拟器很忙，等它稳定一下再开始。
sleep "${E2E_SETTLE_SECONDS:-30}"

# 重装 App，再按顺序跑完这些流程并核对文件。每次调用都是一个新账号，互不影响。
# CI 的模拟器偶尔整个断开（device offline），和 App 无关，有时一步都没执行就失败。
# 只有 Maestro 的日志里确实写了断开才重跑一次，断言失败绝不重跑，不能掩盖 App 的问题。
run_flow() {
  local flow="$1" run_id="$2" marker=".artifacts/maestro/.started"
  timeout 120 adb wait-for-device
  touch "$marker"
  maestro test --env "RUN_ID=$run_id" --debug-output .artifacts/maestro --flatten-debug-output "$flow" && return 0
  local status=$?
  find .artifacts/maestro -name maestro.log -newer "$marker" -exec grep -l 'device offline' {} + >/dev/null 2>&1 \
    || return "$status"
  echo "模拟器断开了，等连接恢复后重跑 $flow（不是断言失败）"
  sleep 15
  timeout 120 adb wait-for-device
  maestro test --env "RUN_ID=$run_id" --debug-output .artifacts/maestro --flatten-debug-output "$flow"
}

run_flows() {
  local flows=("$@") flow run_id
  adb uninstall com.gchust.xiaodouya >/dev/null 2>&1 || true
  adb install -r "$APK"
  run_id="$(date +%s)"
  mkdir -p .artifacts/maestro
  for flow in "${flows[@]}"; do
    echo "▶ $flow"
    run_flow "$flow" "$run_id"
  done
  node e2e/verify-uploads.mjs "$run_id" "${flows[@]}"
  # 流程 14b 存到相册的照片：不信界面提示，直接查系统媒体库。
  if printf '%s\n' "${flows[@]}" | grep -q '14b_'; then
    adb shell content query --uri content://media/external/images/media --projection _display_name \
      | grep -q '小豆芽 笑脸.*\.png' || { echo "相册里没有流程 14b 保存的照片" >&2; exit 1; }
  fi
}

run_group() {
  local flows
  mapfile -t flows < <(node scripts/e2e-groups.mjs plan "$1")
  [ ${#flows[@]} -gt 0 ] || { echo "分组 $1 是空的" >&2; exit 1; }
  echo "── 分组 $1 ──"
  run_flows "${flows[@]}"
}

node scripts/e2e-groups.mjs check
if [ "${1:-}" = "--group" ]; then
  run_group "${2:?--group 后面要写分组名}"
elif [ $# -gt 0 ]; then
  run_flows "$@"
else
  while IFS= read -r group; do
    run_group "$group"
  done < <(node scripts/e2e-groups.mjs names)
fi
echo "E2E 全部通过"
