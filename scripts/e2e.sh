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

ART="$ROOT/.artifacts"
DEBUG_DIR="$ART/maestro"
# 每次环境重跑记一行，CI 汇总时数行数。文件一定存在，0 次也看得出来是“统计过、没发生”。
RERUN_LOG="$ART/e2e-env-reruns.log"
: > "$RERUN_LOG"
# 流程失败且判定为环境断开时，run_flow 返回这个值。
ENV_FAILURE=75
LAST_ENV_FLOW=""
LAST_ENV_REASON=""

SERVER_PID=""
ANR_PID=""
MONITOR_PID=""
cleanup() {
  # 负号是杀整个进程组：npx 下面还有 node，只杀 npx 的话服务端会留下来。
  [ -n "$SERVER_PID" ] && kill -- "-$SERVER_PID" 2>/dev/null || true
  [ -n "$ANR_PID" ] && kill "$ANR_PID" 2>/dev/null || true
  [ -n "$MONITOR_PID" ] && kill -- "-$MONITOR_PID" 2>/dev/null || true
}
trap cleanup EXIT

if curl -fs http://localhost:8787/healthz >/dev/null 2>&1; then
  echo "警告：8787 端口已有服务端在运行，将直接使用它。它可能是别的分支的代码。" >&2
else
  # 后台进程不能带着锁（9>&-）：否则这次跑完锁还在，下一次调用会一直排队。
  setsid bash -c 'cd apps/server && exec npx tsx --env-file-if-exists=.env src/index.ts' \
    > "$ART/server.log" 2>&1 9>&- &
  SERVER_PID=$!
  for _ in $(seq 1 60); do
    curl -fs http://localhost:8787/healthz >/dev/null 2>&1 && break
    sleep 1
  done
  curl -fs http://localhost:8787/healthz >/dev/null || { echo "服务端没有启动" >&2; exit 1; }
fi

# 流程 23（应用内更新）要存储里有一个新版本。
bash e2e/helpers/fake-release.sh 9>&-

# 系统桌面偶尔会卡住并弹窗挡住 App，全程在后台清掉。
bash scripts/dismiss-anr.sh 9>&- &
ANR_PID=$!
# 断开的现场：adb 的状态变化、负载和内存。setsid 让 cleanup 能连同子进程一起结束。
setsid bash scripts/e2e-monitor.sh "$ART" 9>&- &
MONITOR_PID=$!

# 刚开机的模拟器很忙，等它稳定一下再开始。
sleep "${E2E_SETTLE_SECONDS:-30}"

# adb 说 device 之后还可能马上掉线，要连续几秒都在线才算恢复。
wait_for_device() {
  local need="$1" stable=0 deadline=$((SECONDS + 120))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if [ "$(adb get-state 2>/dev/null)" = device ]; then
      stable=$((stable + 1))
      [ "$stable" -ge "$need" ] && return 0
    else
      stable=0
    fi
    sleep 1
  done
  echo "两分钟内模拟器都没有稳定连上" >&2
  return 1
}

# 跑一条流程。失败时判断是不是模拟器环境断开：只看这条流程自己的第一个错误，断言失败、找不到元素、App 崩溃都不算。
run_flow() {
  local flow="$1" run_id="$2" log="$DEBUG_DIR/maestro.log" offset status reason logcat
  wait_for_device 2 || return 1
  offset=$(stat -c %s "$log" 2>/dev/null || echo 0)
  maestro test --env "RUN_ID=$run_id" --debug-output "$DEBUG_DIR" --flatten-debug-output "$flow" && return 0
  status=$?
  # 同名流程第二次跑时目录带 -2 后缀，取最新的那个。
  logcat="$(ls -td "$DEBUG_DIR/$(basename "$flow" .yaml)"*/logs/device-logcat.txt 2>/dev/null | head -1 || true)"
  if reason="$(node scripts/e2e-env-failure.mjs "$log" "$offset" "$logcat")"; then
    echo "模拟器断开了（$reason），流程 $flow 没跑完，不是断言失败"
    LAST_ENV_FLOW="$flow"
    LAST_ENV_REASON="$reason"
    return "$ENV_FAILURE"
  fi
  return "$status"
}

media_count() {
  # 系统媒体库里流程 14b 存的照片张数。查询失败时输出空，调用方当成失败，不能当成 0 张。
  local rows
  rows="$(adb shell content query --uri content://media/external/images/media --projection _display_name)" || return 0
  printf '%s\n' "$rows" | grep -c '小豆芽 笑脸.*\.png' || true
}

# 一次完整的尝试：重装 App、新 RUN_ID（新账号），按顺序跑完再核对文件。
# 返回 0 通过，ENV_FAILURE 是环境断开，其他是真的失败。
run_attempt() {
  local flows=("$@") flow run_id status media_before media_after
  wait_for_device 5 || return 1
  # 上一次尝试可能断在飞行模式里（流程 03b、06、19 会开）。
  adb shell cmd connectivity airplane-mode disable >/dev/null 2>&1 || true
  adb uninstall com.gchust.xiaodouya >/dev/null 2>&1 || true
  # 安装是幂等的，断开时等连上再装一次就行，不用整组重跑。
  adb install -r "$APK" || { wait_for_device 5 && adb install -r "$APK"; } || return 1
  run_id="$(date +%s)"
  mkdir -p "$DEBUG_DIR"
  # 相册里的照片不随卸载消失。按张数比较，否则重跑或本地第二次跑时，上一次留下的照片会让检查直接通过。
  media_before="$(media_count)"
  [ -n "$media_before" ] || { echo "查不了系统媒体库" >&2; return 1; }
  for flow in "${flows[@]}"; do
    echo "▶ $flow"
    status=0
    run_flow "$flow" "$run_id" || status=$?
    [ "$status" -eq 0 ] || return "$status"
  done
  node e2e/verify-uploads.mjs "$run_id" "${flows[@]}" || return 1
  # 流程 14b 存到相册的照片：不信界面提示，直接查系统媒体库。
  if printf '%s\n' "${flows[@]}" | grep -q '14b_'; then
    wait_for_device 2 || return 1
    media_after="$(media_count)"
    [ -n "$media_after" ] && [ "$media_after" -gt "$media_before" ] \
      || { echo "相册里没有流程 14b 保存的照片（之前 $media_before 张，之后 ${media_after:-查不了} 张）" >&2; return 1; }
  fi
}

record_rerun() {
  local label="$1" line
  line="$(date -u +%FT%TZ)	$label	$LAST_ENV_FLOW	$LAST_ENV_REASON"
  echo "$line" >> "$RERUN_LOG"
  if [ -n "${GITHUB_ACTIONS:-}" ]; then
    echo "::warning title=E2E 环境重跑::$label 在 $LAST_ENV_FLOW 断开（$LAST_ENV_REASON），整组从头重跑一次"
    [ -n "${GITHUB_STEP_SUMMARY:-}" ] \
      && echo "- ⚠️ 环境重跑：\`$label\` 在 \`$LAST_ENV_FLOW\` 断开（$LAST_ENV_REASON），整组从头重跑" >> "$GITHUB_STEP_SUMMARY"
  fi
}

# 流程不是幂等的，断在中间再跑同一条会被留下的数据干扰。所以环境断开时整组从头再来一次：
# 重装 App、新账号、新 RUN_ID，verify-uploads 也只查新账号。只重跑一次，再断就算失败。
run_flows() {
  local label="$1" status=0
  shift
  run_attempt "$@" || status=$?
  [ "$status" -eq 0 ] && return 0
  [ "$status" -eq "$ENV_FAILURE" ] || exit "$status"
  record_rerun "$label"
  echo "↻ $label 整组从头重跑（第一次的调试输出在 ${DEBUG_DIR}-env-rerun-$label）"
  rm -rf "${DEBUG_DIR}-env-rerun-$label"
  mv "$DEBUG_DIR" "${DEBUG_DIR}-env-rerun-$label"
  status=0
  run_attempt "$@" || status=$?
  [ "$status" -eq 0 ] && return 0
  [ "$status" -eq "$ENV_FAILURE" ] && echo "重跑时模拟器又断开了，不再重试" >&2
  exit "$status"
}

run_group() {
  local flows
  mapfile -t flows < <(node scripts/e2e-groups.mjs plan "$1")
  [ ${#flows[@]} -gt 0 ] || { echo "分组 $1 是空的" >&2; exit 1; }
  echo "── 分组 $1 ──"
  run_flows "$1" "${flows[@]}"
}

node scripts/e2e-groups.mjs check
if [ "${1:-}" = "--group" ]; then
  run_group "${2:?--group 后面要写分组名}"
elif [ $# -gt 0 ]; then
  run_flows flows "$@"
else
  # 不能用 while read：循环里的 adb 和 maestro 会读走标准输入，后面的分组被悄悄跳过，还报全部通过。
  mapfile -t groups < <(node scripts/e2e-groups.mjs names)
  [ ${#groups[@]} -gt 0 ] || { echo "没有分组" >&2; exit 1; }
  for group in "${groups[@]}"; do
    run_group "$group"
  done
fi
reruns=$(wc -l < "$RERUN_LOG")
if [ "$reruns" -gt 0 ]; then
  echo "E2E 全部通过，其中 $reruns 次是模拟器断开后整组重跑的（见 $RERUN_LOG）"
else
  echo "E2E 全部通过"
fi
