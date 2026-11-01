#!/usr/bin/env bash
# 备份数据库到 ./backups，保留最近 30 份。建议用 cron 每天执行。
# 文件在 S3 里，请同时开启 Bucket 的版本控制或定期备份。
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p backups
FILE="backups/xiaodouya-$(date +%Y%m%d-%H%M%S).sql.gz"
docker compose -f docker-compose.prod.yml --env-file .env exec -T postgres \
  pg_dump -U xiaodouya xiaodouya | gzip > "$FILE"
[ -s "$FILE" ] || { echo "备份文件是空的" >&2; exit 1; }
ls -1t backups/*.sql.gz | tail -n +31 | xargs -r rm --
echo "已备份到 $FILE"
