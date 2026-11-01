#!/usr/bin/env bash
# 启动无窗口模拟器并等它开机完成。已经在跑就直接返回。
set -euo pipefail
source "$(dirname "$0")/env.sh"

AVD=xiaodouya
IMAGE="system-images;android-35;google_apis;x86_64"

if adb devices | grep -q '^emulator-.*device$'; then
  echo "模拟器已在运行"
  exit 0
fi
if ! avdmanager list avd -c | grep -qx "$AVD"; then
  echo no | avdmanager create avd -n "$AVD" -k "$IMAGE" -d pixel_6 --force
  cat >> "$HOME/.android/avd/$AVD.avd/config.ini" <<CONF
hw.keyboard=yes
disk.dataPartition.size=4G
CONF
fi
nohup emulator -avd "$AVD" -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect \
  -memory "${EMULATOR_MEMORY:-3072}" -cores 3 -no-snapshot -camera-back none -camera-front none \
  > "$ROOT/.artifacts/emulator.log" 2>&1 &
adb wait-for-device
for _ in $(seq 1 180); do
  [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ] && break
  sleep 2
done
[ "$(adb shell getprop sys.boot_completed | tr -d '\r')" = "1" ] || { echo "模拟器启动超时" >&2; exit 1; }
# 动画关掉，测试更稳定、更快。
adb shell settings put global window_animation_scale 0
adb shell settings put global transition_animation_scale 0
adb shell settings put global animator_duration_scale 0
adb shell input keyevent 82 || true
echo "模拟器已就绪"
