#!/usr/bin/env bash
# 后台运行：CI 的模拟器很慢，系统桌面偶尔会弹“isn't responding”挡住 App。
# 发现是系统组件卡住就强制关掉它，弹窗随之消失。
# 卡住的如果是我们自己的 App 就不处理：那是真 Bug，应该让测试失败。
set -u
APP=com.gchust.xiaodouya
while true; do
  line="$(adb shell dumpsys window 2>/dev/null | grep -m1 'Application Not Responding: ' || true)"
  if [ -n "$line" ]; then
    pkg="$(printf '%s' "$line" | sed -E 's/.*Application Not Responding: ([^ }]+).*/\1/' | tr -d '\r')"
    if [ -n "$pkg" ] && [ "$pkg" != "$APP" ]; then
      echo "已关闭卡住的系统组件：$pkg"
      adb shell am force-stop "$pkg" || true
    fi
  fi
  sleep "${ANR_CHECK_SECONDS:-3}"
done
