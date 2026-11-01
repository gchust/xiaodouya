#!/usr/bin/env bash
# 备份数据库到 ./backups，保留最近 30 份。建议用 cron 每天执行。
# 文件在 S3 里，请同时开启 Bucket 的版本控制或定期备份。
set -euo pipefail
cd "$(dirname "$0")"
# 备份里是家庭的真实数据，只有部署者能读。
umask 077
mkdir -p backups
FILE="backups/xiaodouya-$(date +%Y%m%d-%H%M%S).sql.gz"
# 先写临时文件：中途失败时不能留下一份看起来正常的备份，也不能挤掉旧备份。
TMP="$FILE.tmp"
trap 'rm -f "$TMP"' EXIT
docker compose -f docker-compose.prod.yml --env-file .env exec -T postgres \
  pg_dump -U xiaodouya xiaodouya | gzip > "$TMP"
gzip -t "$TMP"
# 空的 gzip 也有内容，只检查文件大小发现不了问题。tail 读完全部内容，grep 提前退出才不会让 pipefail 误报。
gunzip -c "$TMP" | tail -n 10 | grep -q '^-- PostgreSQL database dump complete' || {
  echo "备份不完整" >&2
  exit 1
}
mv "$TMP" "$FILE"
ls -1t backups/*.sql.gz | tail -n +31 | xargs -r rm --
echo "已备份到 $FILE"
