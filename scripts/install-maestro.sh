#!/usr/bin/env bash
# 固定版本，不执行远程安装脚本。
set -euo pipefail
VERSION="${MAESTRO_VERSION:-cli-2.12.0}"
DEST="$HOME/.maestro"
if [ -x "$DEST/bin/maestro" ]; then
  "$DEST/bin/maestro" --version
  exit 0
fi
TMP="$(mktemp -d)"
curl -fsSL --retry 3 -o "$TMP/maestro.zip" \
  "https://github.com/mobile-dev-inc/maestro/releases/download/$VERSION/maestro.zip"
unzip -q "$TMP/maestro.zip" -d "$TMP"
mkdir -p "$DEST"
cp -r "$TMP/maestro/." "$DEST/"
rm -rf "$TMP"
"$DEST/bin/maestro" --version
