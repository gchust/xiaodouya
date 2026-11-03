#!/usr/bin/env bash
# 流程 23 用：在开发存储里发布一个假的新版本，再把存储里的 APK 换成同样大小的别的字节，
# App 下载回来后 sha256 对不上，必须拒绝安装。scripts/e2e.sh 在跑流程之前调用。
# 用真实的发布脚本，所以这里也顺带跑了一遍 release.yml 用的上传步骤。
# 真的装上新版本要过系统安装界面，Maestro 管不到，在模拟器上手动验证（见 docs/PROGRESS.md 的 F-120）。
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

ENV_FILE=apps/server/.env
[ -f "$ENV_FILE" ] || ENV_FILE=apps/server/.env.example
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a
S3_ENDPOINT="${S3_ENDPOINT%/}"
PREFIX="${APP_RELEASE_PREFIX:-releases/android/}"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
# 2 MB：模拟器上一下就下完，进度条闪一下就过去，这里只断言结果。
head -c 2000000 /dev/urandom > "$WORK/release.apk"
head -c 2000000 /dev/urandom > "$WORK/tampered.apk"

# versionCode 用到 Android 允许的上限附近，本机已经手动发布过的版本也不会挡住它（发布脚本不覆盖更新的版本）。
bash scripts/publish-apk.sh "$WORK/release.apk" 99.0.0-e2e 2000000000 >/dev/null

printf 'user = "%s:%s"\n' "$S3_ACCESS_KEY_ID" "$S3_SECRET_ACCESS_KEY" |
  curl --config - --fail --silent --show-error \
    --aws-sigv4 "aws:amz:${S3_REGION:-auto}:s3" \
    -H 'x-amz-content-sha256: UNSIGNED-PAYLOAD' -T "$WORK/tampered.apk" \
    "${S3_ENDPOINT}/${S3_BUCKET}/${PREFIX}xiaodouya-99.0.0-e2e-2000000000.apk" >/dev/null
echo "假版本 99.0.0-e2e 已发布（APK 被换过，校验应该失败）"
