#!/usr/bin/env bash
# 比较缓存里的 APK 和刚构建的 APK。键相同时 App 的代码和配置必须一样，不一样说明缓存键漏了输入。
# 用法：scripts/compare-apk.sh <缓存的 APK> <新构建的 APK>
set -euo pipefail
CACHED="$1"
FRESH="$2"
# 只比 JS 包和 Expo 配置：这两样决定 App 的行为，构建也是确定的。整个 APK 含签名和时间戳，每次都不同。
for entry in assets/index.android.bundle assets/app.config; do
  a="$(unzip -p "$CACHED" "$entry" | sha256sum | cut -d' ' -f1)"
  b="$(unzip -p "$FRESH" "$entry" | sha256sum | cut -d' ' -f1)"
  echo "$entry 缓存 $a 新构建 $b"
  if [ "$a" != "$b" ]; then
    echo "::error::相同的缓存键构建出了不同的 $entry：scripts/apk-key.mjs 漏了输入，PR 上可能在测旧代码"
    exit 1
  fi
done
echo "缓存里的 APK 和新构建的一致"
