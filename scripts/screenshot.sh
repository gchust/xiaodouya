#!/usr/bin/env bash
# 用法：pnpm screenshot today  → 存到 .artifacts/today.png
set -euo pipefail
source "$(dirname "$0")/env.sh"
OUT="$ROOT/.artifacts/${1:-screen}.png"
adb exec-out screencap -p > "$OUT"
echo "$OUT"
