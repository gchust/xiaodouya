#!/usr/bin/env bash
# 用备份覆盖当前数据库：deploy/restore.sh deploy/backups/xiaodouya-XXXX.sql.gz
# 当前数据库的内容会被替换。需要整套服务已经启动（新机器上先执行一次 up -d）。
set -euo pipefail
[ $# -eq 1 ] || {
  echo "用法：deploy/restore.sh <备份文件>" >&2
  exit 1
}
FILE="$(realpath "$1")"
cd "$(dirname "$0")"

# 必须在清空之前检查：不完整的备份也可能是合法的 SQL，psql 不会报错，结果是一个空数据库。
gzip -t "$FILE" || {
  echo "备份文件损坏，没有改动数据库：$FILE" >&2
  exit 1
}
gunzip -c "$FILE" | tail -n 10 | grep -q '^-- PostgreSQL database dump complete' || {
  echo "备份文件不完整，没有改动数据库：$FILE" >&2
  exit 1
}

compose() { docker compose -f docker-compose.prod.yml --env-file .env "$@"; }

compose stop server
# 失败时事务已回滚，旧数据还在，服务也要重新启动。
trap 'compose start server' EXIT
# 备份不带 DROP，直接导入已有表的库时 psql 只报错不退出，看起来成功，数据其实没有恢复。
{
  echo 'SET client_min_messages = warning; DROP SCHEMA public CASCADE; CREATE SCHEMA public;'
  gunzip -c "$FILE"
} | compose exec -T postgres psql -v ON_ERROR_STOP=1 --single-transaction -q -U xiaodouya xiaodouya >/dev/null
echo "已恢复：$FILE"
