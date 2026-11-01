#!/usr/bin/env bash
# iOS 端到端测试：真实服务端 + SeaweedFS + 模拟器里的 App，只能在 macOS 上跑。
# 前置：scripts/ios-infra.sh 已启动依赖，scripts/ios-build.sh 已产出 .artifacts/xiaodouya-e2e.app。
# 用法：scripts/ios-e2e.sh [流程文件...]，默认跑 e2e/flows 下全部。
#
# 和 Android 的 e2e.sh 不同，一条流程失败后会继续跑完，最后列出每条的结果：
# macOS Runner 跑一轮很贵，一次要看到所有问题。流程之间有依赖，靠前的失败可能连带后面的失败。
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export PATH="$HOME/.maestro/bin:$PATH"
# 第一次在模拟器上装 Maestro 的 XCTest 驱动很慢，默认的超时在 CI 上不够。
export MAESTRO_DRIVER_STARTUP_TIMEOUT="${MAESTRO_DRIVER_STARTUP_TIMEOUT:-300000}"
export MAESTRO_CLI_NO_ANALYTICS=1

APP="$ROOT/.artifacts/xiaodouya-e2e.app"
BUNDLE_ID=com.gchust.xiaodouya
DEVICE_TYPE="${IOS_DEVICE_TYPE:-iPhone 17}"
[ -d "$APP" ] || {
  echo "找不到 ${APP}，先运行 scripts/ios-build.sh" >&2
  exit 1
}
mkdir -p .artifacts/maestro

SERVER_PID=""
PROXY_PID=""
LOG_PID=""
cleanup() {
  for pid in "$SERVER_PID" "$PROXY_PID" "$LOG_PID"; do
    [ -n "$pid" ] && kill "$pid" 2>/dev/null
  done
  return 0
}
trap cleanup EXIT

(cd apps/server && exec npx tsx --env-file-if-exists=.env src/index.ts) >.artifacts/server.log 2>&1 &
SERVER_PID=$!
node e2e/net-proxy.mjs >.artifacts/net-proxy.log 2>&1 &
PROXY_PID=$!
for _ in $(seq 1 60); do
  curl -fs http://localhost:8787/healthz >/dev/null 2>&1 && break
  sleep 1
done
curl -fs http://localhost:8787/healthz >/dev/null || {
  echo "服务端没有启动" >&2
  tail -50 .artifacts/server.log >&2
  exit 1
}

# 默认接着 Mac 的硬件键盘，软键盘不会弹出来，弹层遇到键盘的布局就测不到了。要在开机前设置。
defaults write com.apple.iphonesimulator ConnectHardwareKeyboard -bool false

RUNTIME="$(xcrun simctl list runtimes available -j |
  node -e 'const r=JSON.parse(require("fs").readFileSync(0)).runtimes.filter((x)=>x.name.startsWith("iOS "));console.log(r.at(-1).identifier)')"
UDID="$(xcrun simctl create xiaodouya-e2e "$DEVICE_TYPE" "$RUNTIME")"
echo "模拟器：${DEVICE_TYPE}，${RUNTIME}，${UDID}"
xcrun simctl boot "$UDID"
xcrun simctl bootstatus "$UDID" -b >/dev/null
open -a Simulator --args -CurrentDeviceUDID "$UDID"
xcrun simctl status_bar "$UDID" override --time 9:41 --batteryState charged --batteryLevel 100 || true

# 崩溃和原生报错只留在这份日志里，失败时才知道发生了什么。
xcrun simctl spawn "$UDID" log stream --level info \
  --predicate "process == \"app\"" >.artifacts/simulator.log 2>&1 &
LOG_PID=$!

xcrun simctl install "$UDID" "$APP"

# 不依赖 Maestro 的启动验证：哪怕后面的驱动装不上，也能证明编译的产物真的跑得起来。
xcrun simctl launch "$UDID" "$BUNDLE_ID"
sleep 25
xcrun simctl io "$UDID" screenshot .artifacts/ios-launch.png
if xcrun simctl spawn "$UDID" launchctl list | grep -q "$BUNDLE_ID"; then
  echo "启动 25 秒后 App 仍在运行"
else
  echo "启动 25 秒后 App 不在运行，看 .artifacts/simulator.log 和 ios-launch.png" >&2
fi
xcrun simctl terminate "$UDID" "$BUNDLE_ID" || true

FLOWS=("$@")
if [ ${#FLOWS[@]} -eq 0 ]; then
  while IFS= read -r flow; do FLOWS+=("$flow"); done < <(ls e2e/flows/*.yaml)
fi

RUN_ID="$(date +%s)"
PASSED=()
FAILED=()
for flow in "${FLOWS[@]}"; do
  echo "▶ $flow"
  if maestro --device "$UDID" test --env "RUN_ID=$RUN_ID" \
    --debug-output .artifacts/maestro --flatten-debug-output "$flow"; then
    PASSED+=("$(basename "$flow")")
  else
    FAILED+=("$(basename "$flow")")
    name="$(basename "$flow" .yaml)"
    # iOS 上控件是否可见取决于无障碍树，失败时留一份，不用猜。
    maestro --device "$UDID" hierarchy >".artifacts/hierarchy-$name.json" 2>/dev/null || true
    xcrun simctl io "$UDID" screenshot ".artifacts/failed-$name.png" || true
    # 其他流程都从建好的账号开始。它失败时后面每条都要等满超时，白白占一个小时。
    case "$name" in
      01_*)
        echo "流程 01 失败，后面的流程都依赖它，不再继续" >&2
        break
        ;;
    esac
  fi
done

echo "校验上传的文件"
VERIFY=0
node e2e/verify-uploads.mjs "$RUN_ID" || VERIFY=1

{
  echo "## iOS 流程结果（${DEVICE_TYPE}，${RUNTIME}）"
  echo
  echo "通过 ${#PASSED[@]} 条：${PASSED[*]:-无}"
  echo
  echo "失败 ${#FAILED[@]} 条：${FAILED[*]:-无}"
  echo
  [ "$VERIFY" -eq 0 ] && echo "上传校验：通过" || echo "上传校验：失败"
} | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"

[ ${#FAILED[@]} -eq 0 ] && [ "$VERIFY" -eq 0 ]
