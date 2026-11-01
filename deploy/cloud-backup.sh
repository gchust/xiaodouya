#!/usr/bin/env bash
# Supabase 方案的数据库备份：pg_dump，加密，上传到 R2 的单独前缀。说明见 docs/DEPLOYMENT.md。
#
#   deploy/cloud-backup.sh backup
#   deploy/cloud-backup.sh list
#   deploy/cloud-backup.sh restore <latest | 对象名 | 本地 .enc 文件>
#
# 这是公开仓库：不要加 set -x，不要把备份文件传成 Actions 产物，日志里只能有对象名和大小。
#
# 配置来自环境变量，或者 deploy/.env.backup（已被 .gitignore 忽略）：
#   BACKUP_DATABASE_URL   备份来源。Supabase 用 Session pooler（5432），事务模式不能 pg_dump
#   RESTORE_DATABASE_URL  只有 restore 用。特意和上面分开，防止误把备份导回线上
#   BACKUP_PASSPHRASE     加密口令，至少 20 个字符。丢了备份就打不开，要单独保管
#   S3_ENDPOINT S3_REGION S3_BUCKET S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY
#   BACKUP_PREFIX         默认 backups/，和 App 的文件（families/）分开
#   BACKUP_PG_IMAGE       用这个 Docker 镜像里的 pg_dump 和 psql，比如 postgres:17。
#                         pg_dump 不能比服务器旧，本机版本不够新时用它
set -euo pipefail
# 下面的临时文件虽然只有密文，也不让别的用户读。
umask 077

ENV_FILE="$(dirname "$0")/.env.backup"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

die() {
  echo "$1" >&2
  exit 1
}

need() {
  local name
  for name in "$@"; do
    [ -n "${!name:-}" ] || die "缺少环境变量 $name"
  done
}

# pg_dump 和 curl 报错时会打印主机名和用户名。GitHub 只遮盖完整的 Secret，这些片段要单独登记，
# 否则会出现在公开仓库的日志里。
mask_in_ci() {
  [ "${GITHUB_ACTIONS:-}" = true ] || return 0
  local value="${1#*://}"
  case "$value" in
    *@*)
      local credentials="${value%%@*}"
      echo "::add-mask::${credentials%%:*}"
      value="${value#*@}"
      ;;
  esac
  echo "::add-mask::${value%%[:/?]*}"
}
mask_in_ci "${BACKUP_DATABASE_URL:-}"
mask_in_ci "${RESTORE_DATABASE_URL:-}"
mask_in_ci "${S3_ENDPOINT:-}"

need BACKUP_PASSPHRASE S3_ENDPOINT S3_BUCKET S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY
[ "${#BACKUP_PASSPHRASE}" -ge 20 ] || die "BACKUP_PASSPHRASE 至少要 20 个字符"
export BACKUP_PASSPHRASE
S3_ENDPOINT="${S3_ENDPOINT%/}"
S3_REGION="${S3_REGION:-auto}"
PREFIX="${BACKUP_PREFIX:-backups/}"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# openssl enc 不能用 GCM，所以没有认证：改动密文的人可以让内容变乱，读不到内容。
# 损坏靠 gzip 的校验和和 dump complete 标记发现。-pass env: 不会把口令放进命令行。
encrypt() {
  openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -md sha256 -salt -pass env:BACKUP_PASSPHRASE "$@"
}
decrypt() {
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -md sha256 -pass env:BACKUP_PASSPHRASE -in "$1"
}

# 密钥从标准输入交给 curl，放在参数里 ps 就能看到。
s3() {
  local key="$1"
  shift
  printf 'user = "%s:%s"\n' "$S3_ACCESS_KEY_ID" "$S3_SECRET_ACCESS_KEY" |
    curl --config - --fail --silent --show-error --retry 3 \
      --aws-sigv4 "aws:amz:${S3_REGION}:s3" "$@" "${S3_ENDPOINT}/${S3_BUCKET}/${key}"
}

list_keys() {
  s3 "?list-type=2&prefix=${PREFIX//\//%2F}" | grep -o '<Key>[^<]*</Key>' |
    sed -e 's/<Key>//' -e 's#</Key>##' | sort
}

# 把密码从连接串里拿出来放进 PGPASSWORD，同样是因为 ps。结果写到全局变量 CLEAN_URL。
split_url() {
  if [[ "$1" =~ ^([a-z]+://[^:/@]+):([^@]*)@(.*)$ ]]; then
    local password="${BASH_REMATCH[2]}"
    PGPASSWORD="$(printf '%b' "${password//%/\\x}")"
    export PGPASSWORD
    CLEAN_URL="${BASH_REMATCH[1]}@${BASH_REMATCH[3]}"
  else
    CLEAN_URL="$1"
  fi
}

pg_tool() {
  if [ -n "${BACKUP_PG_IMAGE:-}" ]; then
    docker run --rm -i --network host -e PGPASSWORD "$BACKUP_PG_IMAGE" "$@"
  else
    "$@"
  fi
}

# 必须在动数据库之前检查：不完整的备份也可能是合法的 SQL。tail 读完全部内容，grep 提前退出才不会让 pipefail 误报。
verify() {
  decrypt "$1" | gunzip | tail -n 10 | grep -q '^-- PostgreSQL database dump complete'
}

backup() {
  need BACKUP_DATABASE_URL
  split_url "$BACKUP_DATABASE_URL"
  local file="$WORK/backup.enc"
  local key
  key="${PREFIX}xiaodouya-$(date -u +%Y%m%dT%H%M%SZ).sql.gz.enc"
  # 只备份 public：Supabase 的 auth、storage 这些 schema 不是我们的，也恢复不了。
  # 不带属主和权限，才能恢复到别的项目或自建 Postgres。明文全程不落盘。
  pg_tool pg_dump --schema=public --no-owner --no-privileges "$CLEAN_URL" | gzip -9 | encrypt -out "$file"
  verify "$file" || die "备份不完整，没有上传"
  s3 "$key" -H 'x-amz-content-sha256: UNSIGNED-PAYLOAD' -T "$file" >/dev/null
  local size remote
  size="$(wc -c <"$file" | tr -d ' ')"
  remote="$(s3 "$key" --head | tr -d '\r' | awk 'tolower($1) == "content-length:" { print $2 }')"
  [ "$remote" = "$size" ] || die "上传后的大小不一致：本地 $size，远端 ${remote:-未知}"
  echo "已备份：$key（$size 字节）"
}

restore() {
  [ $# -eq 1 ] || die "用法：deploy/cloud-backup.sh restore <latest | 对象名 | 本地 .enc 文件>"
  need RESTORE_DATABASE_URL
  local source="$1"
  local file="$WORK/restore.enc"
  if [ -f "$source" ]; then
    cp "$source" "$file"
  else
    if [ "$source" = latest ]; then
      source="$(list_keys | tail -n 1)"
      [ -n "$source" ] || die "${PREFIX} 下面没有备份"
    fi
    s3 "$source" -o "$file"
  fi
  verify "$file" || die "备份打不开或不完整（口令不对也是这样），没有改动数据库：$source"

  split_url "$RESTORE_DATABASE_URL"
  # 确认时显示目标，不显示密码。
  local target="${CLEAN_URL#*://}"
  target="${target#*@}"
  target="${target%%\?*}"
  if [ "${BACKUP_ASSUME_YES:-}" != 1 ]; then
    echo "即将用 $source 覆盖 $target 的 public schema，里面现有的数据都会被替换。"
    local answer=''
    read -r -p "确认请输入 restore：" answer || true
    [ "$answer" = restore ] || die "已取消，没有改动数据库"
  fi

  # 备份不带 DROP，直接导入已有表的库时 psql 只报错不退出。备份里有 CREATE SCHEMA public，所以这里只删不建。
  # 失败时事务回滚，旧数据还在。
  {
    echo 'SET client_min_messages = warning; DROP SCHEMA IF EXISTS public CASCADE;'
    decrypt "$file" | gunzip
  } | pg_tool psql -v ON_ERROR_STOP=1 --single-transaction -q "$CLEAN_URL" >/dev/null
  echo "已恢复到 $target：$source"
}

command="${1:-}"
[ $# -gt 0 ] && shift
case "$command" in
  backup) backup ;;
  list) list_keys ;;
  restore) restore "$@" ;;
  *) die "用法：deploy/cloud-backup.sh backup | list | restore <latest | 对象名 | 本地 .enc 文件>" ;;
esac
