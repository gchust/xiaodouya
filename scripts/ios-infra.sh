#!/usr/bin/env bash
# macOS Runner 上没有 Docker，用原生进程搭出和 deploy/docker-compose.dev.yml 一样的环境：
# Postgres 16（55432）和 SeaweedFS（59000），账号、密码、Bucket 都相同。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
DATA="${IOS_INFRA_DIR:-${RUNNER_TEMP:-$ROOT/.artifacts}/ios-infra}"
LOGS="$ROOT/.artifacts"
mkdir -p "$DATA" "$LOGS"

# 和 Android 同一个 S3 实现，只是不走容器。版本和校验值都固定，不执行未校验的下载。
WEED_VERSION=4.51
WEED_SHA256=80000b9ee9129194740d5a766851a536ab8b14c46d18895399fc4bbef2d53c8d
curl -fsSL --retry 3 -o "$DATA/weed.tar.gz" \
  "https://github.com/seaweedfs/seaweedfs/releases/download/$WEED_VERSION/darwin_arm64.tar.gz"
echo "$WEED_SHA256  $DATA/weed.tar.gz" | shasum -a 256 -c -
tar -xzf "$DATA/weed.tar.gz" -C "$DATA"
mkdir -p "$DATA/weed-data"
nohup "$DATA/weed" server -dir="$DATA/weed-data" -ip=127.0.0.1 -ip.bind=127.0.0.1 -volume.max=20 \
  -s3 -s3.port=59000 -s3.port.grpc=19000 -s3.config=deploy/dev/s3.json >"$LOGS/seaweedfs.log" 2>&1 &

HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_CLEANUP=1 brew install postgresql@16
PG_BIN="$(brew --prefix postgresql@16)/bin"
PWFILE="$DATA/pgpass"
printf 'devpassword' >"$PWFILE"
"$PG_BIN/initdb" -D "$DATA/pg" -U xiaodouya --pwfile="$PWFILE" -A scram-sha-256 -E UTF8 --locale=C >/dev/null
"$PG_BIN/pg_ctl" -D "$DATA/pg" -o "-p 55432 -c listen_addresses=127.0.0.1" -l "$LOGS/postgres.log" -w start
PGPASSWORD=devpassword "$PG_BIN/createdb" -h 127.0.0.1 -p 55432 -U xiaodouya xiaodouya

for _ in $(seq 1 60); do
  # 任何 HTTP 响应都说明 S3 网关已经起来了；没带签名的请求本来就会被拒绝。
  curl -s -o /dev/null http://127.0.0.1:59000/ && break
  sleep 2
done
curl -s -o /dev/null http://127.0.0.1:59000/ || {
  tail -50 "$LOGS/seaweedfs.log" >&2
  exit 1
}

# 手机和服务端都走 localhost。服务端真正监听 18787，8787 留给 e2e/net-proxy.mjs，
# 这样流程能“断网”：iOS 模拟器的飞行模式不存在，见 e2e/README.md。
sed -e 's#^S3_PUBLIC_ENDPOINT=.*#S3_PUBLIC_ENDPOINT=http://localhost:59000#' \
  -e 's#^PORT=.*#PORT=18787#' \
  apps/server/.env.example >apps/server/.env

# SeaweedFS 刚起来时可能还没有可写的卷，建 Bucket 要多试几次。
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if pnpm --filter @xiaodouya/server dev:bucket; then
    exit 0
  fi
  echo "建 Bucket 第 $attempt 次失败，稍后重试" >&2
  sleep 5
done
exit 1
