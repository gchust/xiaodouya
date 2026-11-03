#!/usr/bin/env bash
# 把签名 APK 和清单传到存储（R2），App 的“检查更新”从这里取。说明见 docs/DEPLOYMENT.md 的“应用内更新”。
#
#   scripts/publish-apk.sh <apk 文件> <versionName> <versionCode>
#
# 环境变量（和备份用的是同一组）：
#   S3_ENDPOINT S3_BUCKET S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY  必填，缺了直接失败
#   S3_REGION                     默认 auto
#   APP_RELEASE_PREFIX            默认 releases/android/，要和服务端的同名变量一样
#   RELEASE_MIN_SUPPORTED_CODE    可选，低于这个 versionCode 的 App 会被要求更新
#   RELEASE_NOTES_ZH RELEASE_NOTES_EN  可选，发布说明
#
# 顺序不能反：先传 APK，下载回来核对 sha256，最后才写清单。清单写好之前 App 看到的还是上一版，
# 不会拿到一个还没传完的 APK。不会覆盖成更低的 versionCode：Android 不允许降级安装。
#
# 这是公开仓库：不要加 set -x，日志里只有对象名、大小和哈希。
set -euo pipefail
umask 077

die() {
  echo "$1" >&2
  exit 1
}

[ "$#" -eq 3 ] || die "用法：scripts/publish-apk.sh <apk 文件> <versionName> <versionCode>"
APK="$1"
NAME="$2"
CODE="$3"
[ -f "$APK" ] || die "找不到 APK：$APK"
[[ "$CODE" =~ ^[1-9][0-9]{0,9}$ ]] || die "versionCode 必须是正整数：$CODE"
[[ "$NAME" =~ ^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$ ]] || die "versionName 只能有字母、数字和 . _ + -：$NAME"

for name in S3_ENDPOINT S3_BUCKET S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY; do
  [ -n "${!name:-}" ] || die "缺少环境变量 $name。应用内更新要把 APK 传到存储，见 docs/DEPLOYMENT.md"
done
# Endpoint 里有 Cloudflare 的账号 ID。GitHub 只遮盖完整的 Secret，curl 报错时会打印主机名。
if [ "${GITHUB_ACTIONS:-}" = true ]; then
  host="${S3_ENDPOINT#*://}"
  echo "::add-mask::${host%%[:/?]*}"
fi
S3_ENDPOINT="${S3_ENDPOINT%/}"
S3_REGION="${S3_REGION:-auto}"
PREFIX="${APP_RELEASE_PREFIX:-releases/android/}"
[[ "$PREFIX" =~ ^[A-Za-z0-9._/-]+/$ ]] || die "APP_RELEASE_PREFIX 要以 / 结尾：$PREFIX"
MIN_CODE="${RELEASE_MIN_SUPPORTED_CODE:-}"
[ -z "$MIN_CODE" ] || [[ "$MIN_CODE" =~ ^[1-9][0-9]{0,9}$ ]] || die "RELEASE_MIN_SUPPORTED_CODE 必须是正整数"

sha256_of() {
  if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# 密钥从标准输入交给 curl，放在参数里 ps 就能看到。
s3() {
  local key="$1"
  shift
  printf 'user = "%s:%s"\n' "$S3_ACCESS_KEY_ID" "$S3_SECRET_ACCESS_KEY" |
    curl --config - --silent --show-error --retry 3 \
      --aws-sigv4 "aws:amz:${S3_REGION}:s3" "$@" "${S3_ENDPOINT}/${S3_BUCKET}/${key}"
}

SIZE="$(wc -c < "$APK" | tr -d ' ')"
SHA="$(sha256_of "$APK")"
KEY="${PREFIX}xiaodouya-${NAME}-${CODE}.apk"
MANIFEST_KEY="${PREFIX}latest.json"

# 现在的清单。404 是第一次发布，其他错误不能当成没有，否则可能覆盖掉更新的版本。
status="$(s3 "$MANIFEST_KEY" -o "$WORK/current.json" -w '%{http_code}')" || die "读取现在的清单失败"
case "$status" in
  200)
    current="$(node -e 'const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); console.log(Number.isInteger(m.versionCode) ? m.versionCode : 0)' "$WORK/current.json")" \
      || die "现在的清单读不懂，先人工核对 ${MANIFEST_KEY}"
    if [ "$current" -gt "$CODE" ]; then
      die "存储里已经是 versionCode ${current}，比这次的 ${CODE} 新，不覆盖（Android 不允许降级安装）"
    fi
    ;;
  404) ;;
  *) die "读取现在的清单失败（HTTP ${status}）" ;;
esac

s3 "$KEY" --fail -H 'x-amz-content-sha256: UNSIGNED-PAYLOAD' \
  -H 'content-type: application/vnd.android.package-archive' -T "$APK" >/dev/null \
  || die "上传 APK 失败"
# 读回来核对，确认存储里的就是这个文件，再让 App 看到它。
s3 "$KEY" --fail -o "$WORK/check.apk" || die "读回 APK 失败"
[ "$(sha256_of "$WORK/check.apk")" = "$SHA" ] || die "存储里的 APK 和本地的不一样，没有写清单"

NAME="$NAME" CODE="$CODE" SIZE="$SIZE" SHA="$SHA" KEY="$KEY" MIN_CODE="$MIN_CODE" node -e '
  const e = process.env;
  const notes = {};
  if (e.RELEASE_NOTES_ZH) notes.zh = e.RELEASE_NOTES_ZH;
  if (e.RELEASE_NOTES_EN) notes.en = e.RELEASE_NOTES_EN;
  const manifest = {
    schema: 1,
    platform: "android",
    versionCode: Number(e.CODE),
    versionName: e.NAME,
    apk: { key: e.KEY, size: Number(e.SIZE), sha256: e.SHA },
    ...(e.MIN_CODE ? { minSupportedVersionCode: Number(e.MIN_CODE) } : {}),
    ...(Object.keys(notes).length ? { notes } : {}),
    publishedAt: new Date().toISOString(),
  };
  process.stdout.write(JSON.stringify(manifest, null, 2));
' > "$WORK/latest.json"

s3 "$MANIFEST_KEY" --fail -H 'x-amz-content-sha256: UNSIGNED-PAYLOAD' \
  -H 'content-type: application/json' -T "$WORK/latest.json" >/dev/null \
  || die "写清单失败。APK 已经在 ${KEY}，重新运行这个脚本即可"

echo "已发布：${KEY}（${SIZE} 字节，sha256 ${SHA}）"
echo "清单：${MANIFEST_KEY} → ${NAME}（${CODE}）"
