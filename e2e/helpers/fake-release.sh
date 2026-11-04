#!/usr/bin/env bash
# 流程 23、23a 用：在开发存储里发布一个假的新版本。scripts/e2e.sh 在跑流程之前调用。
# 用真实的发布脚本，所以这里也顺带跑了一遍 release.yml 用的上传步骤。
# 真的装上新版本要过系统安装界面，Maestro 管不到，在模拟器上手动验证（见 docs/PROGRESS.md 的 F-120、F-130）。
#
# 用法：
#   fake-release.sh            发布清单，再把存储里的 APK 换成同样大小的别的字节（tampered）
#   fake-release.sh tampered   存储里放换过的字节：下载回来 sha256 对不上，必须拒绝安装（流程 23）
#   fake-release.sh intact     存储里放和清单一致的字节：自动下载后能校验通过（流程 23a）
# 后两种只换 APK，不动清单，要先发布过一次。e2e.sh 在流程 23、23a 开始前各调一次，
# 整组重跑时两条流程也各自拿到自己要的文件。
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
MODE="${1:-publish}"

ENV_FILE=apps/server/.env
[ -f "$ENV_FILE" ] || ENV_FILE=apps/server/.env.example
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a
S3_ENDPOINT="${S3_ENDPOINT%/}"
PREFIX="${APP_RELEASE_PREFIX:-releases/android/}"
KEY="${PREFIX}xiaodouya-99.0.0-e2e-2000000000.apk"

# 两份字节留在 .artifacts 里（已忽略），后面的 tampered / intact 要用同一份。
WORK="$ROOT/.artifacts/fake-release"

put_apk() {
  printf 'user = "%s:%s"\n' "$S3_ACCESS_KEY_ID" "$S3_SECRET_ACCESS_KEY" |
    curl --config - --fail --silent --show-error \
      --aws-sigv4 "aws:amz:${S3_REGION:-auto}:s3" \
      -H 'x-amz-content-sha256: UNSIGNED-PAYLOAD' -T "$1" \
      "${S3_ENDPOINT}/${S3_BUCKET}/${KEY}" >/dev/null
}

case "$MODE" in
  publish)
    rm -rf "$WORK"
    mkdir -p "$WORK"
    # 2 MB：模拟器上一下就下完，进度条闪一下就过去，这里只断言结果。
    head -c 2000000 /dev/urandom > "$WORK/release.apk"
    head -c 2000000 /dev/urandom > "$WORK/tampered.apk"
    # 不是真的 APK，跳过版本号核对。versionCode 用到 Android 允许的上限附近，本机已经手动发布过的版本也不会挡住它（发布脚本不覆盖更新的版本）。
    RELEASE_APK_CHECK=0 bash scripts/publish-apk.sh "$WORK/release.apk" 99.0.0-e2e 2000000000 >/dev/null
    put_apk "$WORK/tampered.apk"
    echo "假版本 99.0.0-e2e 已发布（APK 被换过，校验应该失败）"
    ;;
  tampered | intact)
    file="$WORK/tampered.apk"
    [ "$MODE" = intact ] && file="$WORK/release.apk"
    [ -f "$file" ] || { echo "还没发布过假版本，先不带参数运行一次" >&2; exit 1; }
    put_apk "$file"
    echo "假版本 99.0.0-e2e 的 APK 换成了 $MODE"
    ;;
  *)
    echo "未知参数：$MODE" >&2
    exit 1
    ;;
esac
