# 小豆芽部署文档

这份文档讲四件事：[推荐的部署方式：Supabase + R2](#零推荐部署supabase--r2)、[备选方式：自己的服务器加 Docker](#一服务端部署备选自己的服务器和-docker)、[App 怎么构建和分发](#二app-构建和分发)、[每个参数怎么填](#三参数说明)。

两种方式跑的是同一份服务端代码，App 的接口完全一样：

```
推荐：手机 App ──HTTPS──> Supabase Edge Function（Hono）──> Supabase Postgres
备选：手机 App ──HTTPS──> Caddy ──> 服务端（Hono）──> Postgres
          │                             │
          │                             │ 签发短时效链接
          └──────直传/下载───────> S3 兼容存储（Cloudflare R2 / AWS S3 / ...）
```

照片和视频从手机直接传到存储，不经过服务器，所以服务器配置要求很低。

---

## 零、推荐部署：Supabase + R2

不用自己维护服务器，免费版够一家人用。只用 Supabase 的 Postgres 和 Edge Functions，账号、同步还是自己的，文件放在 R2。**不用** Supabase Auth、Realtime、Storage，也不让 App 直接访问数据库。

> **已在新加坡项目验证。** Edge Function 部署、数据库迁移、R2 签名上传下载、加密备份及本地恢复均已跑通（见 [PROGRESS.md](PROGRESS.md) 的 F-80）。真机访问和项目暂停后的恢复还未验证。

### 两个必须知道的限制

| 限制 | 影响 | 怎么办 |
| ---- | ---- | ------ |
| **免费版没有自动备份** | 数据库出事就全没了 | 必须配置第 8 步的备份，并且演练一次恢复 |
| **一周没有足够的数据库活动，项目会被暂停** | 暂停后 App 连不上服务器，手机上的记录还在，恢复后接着同步 | 全家天天用一般不会触发，每天的备份也是真实的数据库活动，但 Supabase 没有承诺这样一定不会暂停。暂停后到控制台点 Restore。不要为了防暂停写假请求 |

其他额度（以 [Supabase 定价页](https://supabase.com/pricing)为准）：数据库 500 MB、流量 5 GB、Edge Function 调用每月 50 万次。App 在前台时每台手机每 25 秒调用一次长轮询，也就是每小时 144 次。能放多少家庭、什么时候要升级，算法见 [CAPACITY.md](CAPACITY.md)：免费版最先到的是调用次数，约 100 家。

新记录最多晚 2 秒通知到家人：跨实例只能查数据库，每 2 秒查一次。

### 1. 创建 Supabase 项目

1. 到 [Supabase 控制台](https://supabase.com/dashboard) 新建项目，区域选 **Southeast Asia (Singapore)**，也就是 `ap-southeast-1`。
2. 数据库密码用 `openssl rand -hex 24` 生成，只含十六进制字符才不会破坏连接串。记下来。
3. 记下 **Project ref**，就是项目地址 `https://<project-ref>.supabase.co` 里的那一段。

### 2. 关掉 Data API（必须）

Supabase 默认通过 Data API 把 `public` 里的表开放出去，用的 anon key 本来就是公开的。这个项目用不到它，而表里有密码哈希和存储密钥。

到控制台的 **Integrations → Data API**（或创建项目时的同名选项），把 **Enable Data API** 关掉。

迁移里已经给每张表开了 RLS 并收回了 `anon`、`authenticated` 的权限，这是第二道防线，不能代替这一步。第 5 步之后用下面的命令确认，**不能**返回 200：

```bash
curl -i "https://<project-ref>.supabase.co/rest/v1/users?select=id" -H "apikey: <控制台里的 anon key>"
```

### 3. 创建 R2 Bucket

按[第一节第 2 步](#2-创建存储)创建 Bucket 和 API 令牌，记下 Account ID、Access Key ID、Secret Access Key。

备份也放在这个 Bucket 的 `backups/` 前缀下。到 Bucket 的 **Settings → Object lifecycle rules** 加一条规则：前缀 `backups/`，30 天后删除。备份脚本自己不删旧文件。

> **不要开 Bucket 的公开访问。** 备份是加密的，但证件文件不是，见下文“公开 CDN 域名要不要填”。

### 4. 准备工具和连接串

需要 Node 和 pnpm（版本见 `.mise.toml`）、Docker（Supabase CLI 打包函数时要用）和 [Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started)。CLI 可以直接从 [Releases](https://github.com/supabase/cli/releases) 下载，或者把下面的 `supabase` 换成 `npx supabase@latest`。

```bash
git clone https://github.com/gchust/xiaodouya.git
cd xiaodouya
pnpm install
supabase login
supabase link --project-ref <project-ref>
```

在控制台点项目顶部的 **Connect**，复制两个连接串。主机名里有编号，不能自己拼：

| 连接串 | 端口 | 用途 |
| ------ | ---- | ---- |
| **Transaction pooler** | 6543 | Edge Function 用，第 6 步的 `DATABASE_URL` |
| **Session pooler** | 5432 | 迁移、备份、恢复用 |

两个的用户名都是 `postgres.<project-ref>`。免费版的 Direct connection 只有 IPv6，GitHub Actions 和很多家庭宽带连不上，所以这里不用它。

### 5. 执行迁移

Edge Function 不会自己建表。**第一次部署前和每次升级前**都要执行一次，重复执行没有副作用：

```bash
DATABASE_URL='<Session pooler 连接串>' DB_SSL=require \
  pnpm --filter @xiaodouya/server cli migrate
# 迁移已完成
```

### 6. 设置 Secret

```bash
cp supabase/.env.example supabase/.env
chmod 600 supabase/.env
```

填好 `supabase/.env`（已被 `.gitignore` 忽略），然后上传：

```bash
supabase secrets set --env-file supabase/.env
```

| 名称 | 值 |
| ---- | -- |
| `DATABASE_URL` | Transaction pooler 连接串（6543） |
| `APP_SECRET` | `openssl rand -base64 32`。**不要更换，要单独备份** |
| `ALLOW_SIGNUP` | 先填 `true`，全家注册完改成 `false` |
| `S3_ENDPOINT` | `https://<account-id>.r2.cloudflarestorage.com` |
| `S3_REGION` | `auto` |
| `S3_BUCKET` | Bucket 名称 |
| `S3_ACCESS_KEY_ID`、`S3_SECRET_ACCESS_KEY` | R2 令牌 |
| `S3_FORCE_PATH_STYLE` | `true` |
| `MAIL_PROVIDER` | 可选。`resend` 打开找回密码和邮箱验证；不设置就不发邮件，见[邮件和验证码](#邮件和验证码) |
| `RESEND_API_KEY` | `MAIL_PROVIDER=resend` 时必填，Resend 控制台生成的 API Key |
| `MAIL_FROM` | `MAIL_PROVIDER=resend` 时必填，比如 `小豆芽 <no-reply@baby.example.com>`，域名要先在 Resend 验证 |

函数上不能用 `MAIL_PROVIDER=log`，设了函数会启动失败：日志在云端，验证码不能进去。

Supabase 保留了 `SUPABASE_` 开头的名字，不要用它自动提供的 `SUPABASE_DB_URL`，这里要的是事务模式连接池。`DB_POOL_MAX=1`、`DB_PREPARE=false`、`DB_SSL=require` 是函数的默认值，不用设置。

### 7. 部署函数

```bash
pnpm build:edge
supabase functions deploy api
```

`pnpm build:edge` 把服务端打成 `supabase/functions/api/_bundle/server.mjs`，这个文件不提交，**每次部署前都要重新生成**。`supabase/config.toml` 里已经写了 `verify_jwt = false`，接口用自己的令牌。部署时默认用 Docker 在本地打包；镜像仓库无法访问时可加 `--use-api` 改为服务端打包，已在真实 Supabase 项目部署成功。

验证：

```bash
curl https://<project-ref>.supabase.co/functions/v1/api/healthz
# {"ok":true}
curl https://<project-ref>.supabase.co/functions/v1/api/v1/me
# {"error":{"code":"unauthenticated","message":"请先登录"}}
```

第二条如果返回的不是这个格式，而是 Supabase 自己的 401，说明 JWT 校验没关，在部署命令后面加 `--no-verify-jwt` 重新部署。

然后回到第 2 步，确认 Data API 读不到表。

把 App 指向这个地址（配置方法见[第二节](#二app-构建和分发)），末尾不带 `/v1`：

```
EXPO_PUBLIC_API_URL=https://<project-ref>.supabase.co/functions/v1/api
```

全家注册完之后关闭注册，陌生人就注册不了了：

```bash
supabase secrets set ALLOW_SIGNUP=false
```

### 8. 配置备份（务必）

`deploy/cloud-backup.sh` 用 `pg_dump` 导出 `public`，用 `openssl` 加密，上传到 R2 的 `backups/`。明文不落盘，上传前会解密检查一遍。

先准备一个口令，**丢了备份就打不开**，存到密码管理器里，不要和备份放在一起：

```bash
openssl rand -base64 32
```

| 配置 | 说明 |
| ---- | ---- |
| `BACKUP_DATABASE_URL` | Session pooler 连接串（5432）。事务模式不能 `pg_dump` |
| `BACKUP_PASSPHRASE` | 上面生成的口令 |
| `S3_ENDPOINT`、`S3_REGION`、`S3_BUCKET`、`S3_ACCESS_KEY_ID`、`S3_SECRET_ACCESS_KEY` | 和第 6 步相同 |
| `BACKUP_PREFIX` | 可选，默认 `backups/` |
| `BACKUP_PG_IMAGE` | 可选，用 Docker 镜像里的 `pg_dump`，比如 `postgres:17`。`pg_dump` 版本不能比服务器旧，本机不够新时用它 |

下面两种方式选一种。

**方式 A：GitHub Actions（推荐）。** 在仓库 Settings → Secrets and variables → Actions 里添加 Secret `BACKUP_DATABASE_URL`、`BACKUP_PASSPHRASE`、`S3_ENDPOINT`、`S3_BUCKET`、`S3_ACCESS_KEY_ID`、`S3_SECRET_ACCESS_KEY`，再添加 Variable `CLOUD_BACKUP_ENABLED`，值是 `true`。然后到 Actions 页面手动运行一次“云端数据库备份”，确认成功。之后每天新加坡时间凌晨 3 点左右自动运行。

> 这是公开仓库，任何人都能看日志和产物。这个流程不上传产物，日志里只有对象名和大小。**不要改成上传备份文件。**
>
> 仓库 60 天没有活动时，GitHub 会自动停用定时任务，并发邮件提醒。Actions 失败时也会发邮件，要留意。

**方式 B：自己电脑上的 cron。** 需要 `bash`、`curl`（7.75 以上）、`openssl`（1.1.1 以上）、`gzip`，还有 `pg_dump` 或 Docker。把配置写进 `deploy/.env.backup`（已被 `.gitignore` 忽略），`chmod 600`，然后：

```bash
deploy/cloud-backup.sh backup
# 已备份：backups/xiaodouya-20261101T031700Z.sql.gz.enc（12345 字节）
```

执行 `crontab -e`，加一行（路径换成实际路径）：

```
17 3 * * * /path/to/xiaodouya/deploy/cloud-backup.sh backup >> $HOME/xiaodouya-backup.log 2>&1
```

电脑关机的时候不会备份。

### 9. 恢复

先演练一次，备份只有恢复过才算数。在本机起一个临时的 Postgres，恢复进去看看（`deploy/.env.backup` 或环境变量里要有上面的口令和 S3 配置）：

```bash
docker run -d --rm --name xiaodouya-restore-check -e POSTGRES_PASSWORD=throwaway -p 55499:5432 postgres:17
deploy/cloud-backup.sh list
RESTORE_DATABASE_URL=postgres://postgres:throwaway@localhost:55499/postgres \
  BACKUP_PG_IMAGE=postgres:17 deploy/cloud-backup.sh restore latest
docker exec xiaodouya-restore-check psql -U postgres -c 'SELECT count(*) FROM records'
docker rm -f xiaodouya-restore-check
```

真正要恢复时，`RESTORE_DATABASE_URL` 填目标项目的 Session pooler 连接串：

```bash
RESTORE_DATABASE_URL='<Session pooler 连接串>' BACKUP_PG_IMAGE=postgres:17 \
  deploy/cloud-backup.sh restore backups/xiaodouya-XXXX.sql.gz.enc
```

- 脚本先解密并检查备份是否完整，口令不对或文件不完整都不会动数据库。
- 要求输入 `restore` 确认。导入在一个事务里，失败时自动回滚，旧数据还在。
- 恢复的 Postgres 大版本不能比导出时用的 `pg_dump` 旧。比如用 17 导出的备份恢复到 16 会报错并回滚。
- 换了新项目时，`APP_SECRET` 要用原来的，并重新做第 5 到第 7 步（迁移会跳过已经执行过的部分）。App 打包时写死了地址，换项目要重新打包。

> **恢复的是备份那一刻的数据。** 备份之后写入的记录不在服务器上了。手机发现同步进度比服务器新时，会自动从头拉取。

### 10. 日常维护

```bash
# 升级：顺序不能反，新代码可能用到新表
git pull
pnpm install
DATABASE_URL='<Session pooler 连接串>' DB_SSL=require pnpm --filter @xiaodouya/server cli migrate
pnpm build:edge
supabase functions deploy api

# 重置密码（没有配置邮件时，忘记密码由部署者处理）
DATABASE_URL='<Session pooler 连接串>' DB_SSL=require \
  pnpm --filter @xiaodouya/server cli reset-password someone@example.com

# 想马上清掉账号删除留下的文件时手动执行。平时由下面的定时清理处理。
DATABASE_URL='<Session pooler 连接串>' DB_SSL=require APP_SECRET='<和函数相同>' \
S3_ENDPOINT=... S3_REGION=auto S3_BUCKET=... S3_ACCESS_KEY_ID=... S3_SECRET_ACCESS_KEY=... S3_FORCE_PATH_STYLE=true \
  pnpm --filter @xiaodouya/server cli purge-objects
```

**定时清理（必须配，只有这一个定时任务）：** 清理放弃的上传、删除满 30 天的文件、账号删除后留下的文件和过期的限流计数。不配的话，这些文件一直占着 R2，已删除账号的文件也还在。在仓库添加 Variable `MAINTENANCE_ENABLED`，值是 `true`，`.github/workflows/maintenance.yml` 每天跑一次，用备份已有的那些 Secret。

`APP_SECRET` 可选：只有已删除账号的家庭用过自带存储时才用到，因为要解密当时的存储密钥。平台存储（R2）的文件不需要它。

- 不设置：平台存储的照常删；自带存储的留在队列里，不计重试次数，退出码不算失败，日志写明还有多少条。
- 要处理这些文件：添加仓库 Secret `APP_SECRET`，值和函数里的相同。工作流已经读取它，没设置时是空的，不影响运行。设置了错误的值时这些记录会算失败，退出码是 1。

到 Actions 页面手动运行一次，日志里是计数：

```json
{"pendingRemoved":0,"trashPurged":0,"unattachedPurged":0,"rescued":0,"failed":0,"rateLimitsRemoved":3,"deletionsDone":0,"deletionsFailed":0,"deletionsRemaining":0,"deletionsWaitingForSecret":0}
```

`rescued` 不是 0 说明同步时的标记有 Bug（文件没被删，已经救回来了），要查。`failed` 或 `deletionsFailed` 不是 0 时命令退出码是 1，下次会重试。`deletionsWaitingForSecret` 不是 0 不算失败，但这些文件要设置 `APP_SECRET` 才会删。

**给单个家庭调配额**（默认值见下面的参数表）：

```sql
UPDATE families SET quota_mb = 20480 WHERE id = '<家庭 id>';  -- 20 GB；0 表示不限；NULL 恢复默认
```

**升级到带配额的版本（已上线的项目，只需要做一次）：** v0.1.0 的 APK 不用更新也能继续用：空间满时它显示服务端的那句话，有重试按钮。S3 表单还在它的界面上，保存时显示“这台服务器不允许自定义存储”。

```bash
# 1. 先确认 R2 接受把大小签进链接。不通过的话所有上传都会失败，要先 supabase secrets set S3_BIND_UPLOAD_SIZE=false
S3_ENDPOINT=... S3_REGION=auto S3_BUCKET=... S3_ACCESS_KEY_ID=... S3_SECRET_ACCESS_KEY=... S3_FORCE_PATH_STYLE=true \
DATABASE_URL='<Session pooler 连接串>' DB_SSL=require pnpm --filter @xiaodouya/server cli check-upload-size
# 2. 迁移。旧函数在新表结构上能继续跑，出问题可以只回滚函数
DATABASE_URL='<Session pooler 连接串>' DB_SSL=require pnpm --filter @xiaodouya/server cli migrate
# 3. 部署函数，见上面
```

已有家庭的文件从第一天起就算配额，超额的只是传不了新文件。迁移时，已删除记录里的文件进入待清理，从迁移当天算 30 天。

**打开 `MAINTENANCE_ENABLED` 之前先看一眼会清掉什么。** 上传超过 30 天、从没有未删除的记录提到的文件，第一次运行就会被彻底删除，不再等宽限期。这些文件在 App 里本来就看不到，但它们是升级前就有的数据，不能恢复：

```sql
SELECT count(*), sum(size) FROM media
WHERE status = 'ready' AND storage_config_id IS NULL AND NOT attached AND unreferenced_at IS NULL
  AND created_at < now() - interval '30 days';
```

部署后**确认取到的是客户端地址**。依据只是一条没有官方回复的[社区讨论](https://github.com/orgs/supabase/discussions/34647)，它说 `x-forwarded-for` 是“伪造的,真实的”，而且讨论的是数据库接口，不是函数：

1. 用一个**已注册**的邮箱，连续注册 21 次，每次在 `X-Forwarded-For` 里换一个假地址。前 20 次应该是 409，第 21 次是 429。如果一直是 409，说明地址能被伪造。
2. 马上换一个网络（比如手机热点）再试一次，应该是 409。如果是 429，说明大家被算成了同一个来源，**全站每小时只能注册 20 个人**。

任何一步不对，就改成 `CLIENT_IP_HEADER=cf-connecting-ip`（同一条讨论里提到它带真实地址，也没有官方确认）再试。都不行就设 `RATE_REGISTER_PER_IP_HOUR=0`，只留全站上限。

升级顺序不能反的原因：新函数要读新加的列，没迁移就部署，所有需要登录的接口都会报错。反过来没问题，迁移只增加可空的列和新表，旧函数照常工作。

日志在控制台的 **Edge Functions → api → Logs**。

本地调试函数（需要 `pnpm dev:infra` 和 Deno）：`pnpm test:edge`。

---

## 一、服务端部署（备选：自己的服务器和 Docker）

不想依赖 Supabase，或者想要完全自己掌控时用这种方式。

### 1. 准备

| 需要什么          | 建议                                                     |
| ----------------- | -------------------------------------------------------- |
| 一台 Linux 服务器 | 1 核 1 GB 内存够运行，选新加坡机房离你们最近             |
| Docker            | 带 Compose 插件的版本（`docker compose version` 能运行） |
| 一个域名          | 比如 `baby.example.com`，A 记录指向服务器 IP             |
| 防火墙            | 放行 80 和 443                                           |
| 对象存储          | 见下面第 2 步                                            |

三个容器空闲时共占约 100 MB 内存。在服务器上构建镜像（下面的方式 B）要多用不少内存，没有在 1 GB 的机器上验证过，内存小的话先加 swap。

### 2. 创建存储

**推荐 Cloudflare R2**：下载流量不收费。

1. Cloudflare 控制台 → R2 → 创建 Bucket，名字比如 `xiaodouya`，位置提示（Location）选 **Asia-Pacific (APAC)**。
2. R2 → Manage R2 API Tokens → 创建令牌，权限选 **Object Read & Write**，限定这个 Bucket。
3. 记下 **Account ID**、**Access Key ID**、**Secret Access Key**。Secret 只显示一次。

> R2 的 APAC 只是位置提示，不保证数据在新加坡。如果必须留在新加坡，用 AWS S3 的 `ap-southeast-1`（下载流量收费）。

**不需要配置 CORS**：App 是原生应用，不是浏览器。

### 3. 启动

```bash
git clone https://github.com/gchust/xiaodouya.git
cd xiaodouya
cp deploy/.env.example deploy/.env
chmod 600 deploy/.env
```

生成密钥并写入 `deploy/.env`，域名换成你自己的：

```bash
sed -i "s|^DOMAIN=.*|DOMAIN=baby.example.com|" deploy/.env
sed -i "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(openssl rand -hex 24)|" deploy/.env
sed -i "s|^APP_SECRET=.*|APP_SECRET=$(openssl rand -base64 32)|" deploy/.env
```

> 不要把 `$(openssl ...)` 原样写进 `.env`。这个文件不会执行命令，密码会真的变成这串文字。

存储可以在这里填（见[参数说明](#三参数说明)），也可以留空，之后由管理员在 App 的「家人 → 存储」里填。

然后启动。两种方式任选：

```bash
# 方式 A：用发布好的镜像（打过 v* 标签后才有，见下文“发布新版本”）
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env up -d

# 方式 B：在服务器上自己构建镜像，第一次要几分钟
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env up -d --build
```

> 方式 A 拉不到镜像时（还没有发布过，或者仓库的镜像不公开，拉取时提示 `denied`），Compose 不会停下，而是自动改成在本机构建，所以看到它在构建不是出错。发布的镜像只有 x86-64 版本，ARM 服务器请用方式 B。

### 4. 验证

```bash
curl https://baby.example.com/healthz
# {"ok":true}
```

数据库迁移在服务启动时自动执行。服务刚启动的几秒内可能返回 502，稍等再试。

### 5. 全家注册完之后

把 `deploy/.env` 里的 `ALLOW_SIGNUP` 改成 `false`，再执行一次 `up -d`。之后只有拿到邀请码的人才能注册，陌生人注册不了你的服务器。

### 6. 备份（务必配置）

宝宝的记录丢了就找不回来了。

先手动跑一次，确认能生成备份：

```bash
deploy/backup.sh
```

然后执行 `crontab -e`，在打开的编辑器里加一行，每天凌晨 3 点备份（路径换成实际路径）：

```
0 3 * * * /path/to/xiaodouya/deploy/backup.sh >> /path/to/xiaodouya/deploy/backups/backup.log 2>&1
```

备份文件在 `deploy/backups/`，只保留最近 30 份，只有部署者能读。请定期复制到**另一台机器或云存储**，只放在同一台服务器上不算备份。文件本身在 S3 里，建议打开 Bucket 的版本控制，防止误删。

**恢复：**

```bash
# 新机器上先按第 3 步启动，用原来的 APP_SECRET。旧机器上先备份一次当前数据，恢复会覆盖它。
deploy/restore.sh deploy/backups/xiaodouya-XXXX.sql.gz
```

脚本会先检查备份是否完整，不完整就不动数据库。恢复期间服务端会短暂停止，导入失败时自动回滚，旧数据还在。

> **恢复的是备份那一刻的数据。** 备份之后写入的记录不在服务器上了。手机发现同步进度比服务器新时，会自动从头拉取，不需要家人做任何操作。备份之后才写的记录只留在写它的那台手机上，不会重新上传给其他家人。

> **`APP_SECRET` 要单独备份。** 它加密了 App 里配置的存储密钥，丢失后需要在 App 里重新填写存储配置（文件本身不受影响）。

### 7. 日常维护

```bash
# 升级（方式 A，用发布好的镜像。只执行 up -d 不会更新已经下载过的镜像）
git pull
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env pull server
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env up -d

# 升级（方式 B，自己构建）
git pull
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env up -d --build

# 查看日志
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env logs -f server

# 重置密码（没有配置邮件时，忘记密码由部署者处理）
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env exec server \
  node dist/cli.mjs reset-password someone@example.com

# 想马上清掉账号删除留下的文件时手动执行。平时由下面的定时清理处理。
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env exec -T server \
  node dist/cli.mjs purge-objects
```

每天清理一次，这是唯一要配置的定时任务。它清理默认存储（`S3_*`）里放弃的上传和删除满 30 天的文件，也处理账号删除后留下的文件。只用 App 里配置的存储时也要配：还在用的家庭的 Bucket 它不碰，但已删除账号的文件要靠它删。容器里有 `APP_SECRET`，两种存储都能处理：

```cron
37 4 * * * cd /path/to/xiaodouya && docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env exec -T server node dist/cli.mjs maintenance
```

---

## 二、App 构建和分发

### 方式 A：用 GitHub Actions（推荐）

不需要在本地装 Android 环境。

**第一次配置（只做一次）：**

1. 生成签名密钥：

   ```bash
   keytool -genkeypair -v -keystore release.keystore -alias xiaodouya \
     -keyalg RSA -keysize 2048 -validity 10000
   base64 -w0 release.keystore   # 复制输出
   ```

   > **这个文件和密码要妥善备份。** 丢了之后，新版本无法覆盖安装旧版本，只能卸载重装。不要提交到仓库。
   >
   > 现在的 `keytool` 默认生成 PKCS12 格式，密钥密码和密钥库密码是同一个，下面两个 Secret 填一样的值。

2. 在 GitHub 仓库 → Settings → Secrets and variables → Actions 里添加：

   | 类型     | 名称                        | 值                         |
   | -------- | --------------------------- | -------------------------- |
   | Secret   | `ANDROID_KEYSTORE_BASE64`   | 上一步的 base64 输出       |
   | Secret   | `ANDROID_KEYSTORE_PASSWORD` | 密钥库密码                 |
   | Secret   | `ANDROID_KEY_ALIAS`         | `xiaodouya`                |
   | Secret   | `ANDROID_KEY_PASSWORD`      | 密钥密码                   |
   | Variable | `EXPO_PUBLIC_API_URL`       | `https://baby.example.com` |
   | Variable | `EXPO_PUBLIC_API_REGION`    | Supabase 部署在新加坡时填 `ap-southeast-1`；其他部署留空 |

**发布新版本：**

```bash
git tag v0.1.0
git push origin v0.1.0
```

大约 20–30 分钟后，签名 APK 和上传 Google Play 用的 AAB 会出现在 GitHub 的 Releases 页面，服务端镜像也会推到 GHCR。

> 第一次发布后，确认一下 GitHub 上这个镜像的可见性。如果它不是公开的，服务器拉取时会提示 `denied`，要到包的设置里改成公开，或者在服务器上先执行 `docker login ghcr.io`。这个流程还没有实际跑过。

### 方式 B：本地构建

需要 Node、Java 17、Android SDK。版本由 `.mise.toml` 固定。

```bash
pnpm install
export EXPO_PUBLIC_API_URL=https://baby.example.com
export ANDROID_KEYSTORE_PATH=/绝对路径/release.keystore
export ANDROID_KEYSTORE_PASSWORD=... ANDROID_KEY_ALIAS=xiaodouya ANDROID_KEY_PASSWORD=...
pnpm android:build release --clean
# 产物：.artifacts/xiaodouya-release.apk 和 .artifacts/xiaodouya-release.aab
```

缺少任何一个签名参数，脚本会直接报错退出，不会用调试密钥签出正式版。之后想在同一个目录编 `debug` 或 `e2e`，也要加 `--clean`，否则 Gradle 会继续读上次写入的正式签名配置。

### 分发给家人

**Android**

1. 把 Releases 里的 APK 链接发给家人，用手机浏览器下载。
2. 第一次安装时，系统会提示允许这个来源安装应用。
3. 打开 App：
   - 第一位：点「开始记录」，注册并填写宝宝资料。
   - 其他人：管理员在「家人 → 邀请家人」生成邀请码，对方点「我有邀请码」。

构建时设置了 `EXPO_PUBLIC_API_URL` 的话，家人不需要手动填服务器地址。

> 现在没有自动更新，有新版本时再发一次 APK，覆盖安装即可，数据不会丢。

**iPhone**

通过 TestFlight，见下面的“上架 App Store”。iOS 没有 APK 那样的直接安装方式。

### 需要你自己准备的东西

Agent 不能注册账号、拿不到你的签名，也不能上传到商店。下面这些只有你能做：

| 要准备什么 | 用在哪里 | 费用 |
| ---------- | -------- | ---- |
| [Apple Developer Program](https://developer.apple.com/programs/) 账号 | TestFlight、App Store、推送证书 | 99 美元/年 |
| 一台 Mac，Xcode 26 或更新 | 给 iOS 版签名和归档。[2026-04-28 起](https://developer.apple.com/news/upcoming-requirements/)上传必须用 Xcode 26 和 iOS 26 SDK | — |
| 一台 iPhone | 真机验证模拟器测不了的东西（见下） | — |
| [Google Play 开发者账号](https://play.google.com/console/signup) | 上架 Google Play | 一次性 25 美元 |
| Android 上传密钥 | 就是上面“第一次配置”生成的 `release.keystore`。启用 Play App 签名后它是上传密钥，丢了可以找 Google 重置 | — |
| 隐私政策网址 | 两个商店都必填（F-94） | — |
| App 内删除账号 | 两个商店都要求（F-93） | — |

### 上架 Google Play

发布流程已经同时产出 APK 和 AAB。Google Play 只收 AAB。

1. 打一个 `v*` 标签（见上文），从 GitHub Releases 下载 `xiaodouya-<版本>.aab`。AAB 里有 `arm64-v8a` 和 `armeabi-v7a`，构建脚本用 `scripts/check-native-libs.mjs` 检查过 [64 位](https://developer.android.com/google/play/requirements/64-bit)和 [16 KB 页面](https://developer.android.com/guide/practices/page-sizes)的要求，不符合就直接失败。`targetSdk` 是 36，符合 [2026-08-31 起的要求](https://support.google.com/googleplay/android-developer/answer/11926878)。
2. 在 [Play Console](https://play.google.com/console) 创建应用，包名 `com.gchust.xiaodouya`（或你的 `ANDROID_PACKAGE`，**上传后不能再改**）。
3. 第一次上传时选择 **Play App 签名**：Google 保管正式的签名密钥，你的 keystore 只作为上传密钥。这样装 GitHub Releases 里 APK 的用户和从商店装的用户签名不同，不能互相覆盖安装，要选一个渠道。
4. 测试和发布 → 测试 → **内部测试** → 创建新版本，上传 AAB，填写测试人员的邮箱，把链接发给他们。内部测试不需要审核，几分钟就能装。
5. 上架前要填：商店资料、内容分级、目标受众、[数据安全表](https://support.google.com/googleplay/android-developer/answer/10787469)、健康应用声明。AAB 现在声明了 `FOREGROUND_SERVICE_MEDIA_PLAYBACK`（expo-audio 默认加的，App 没有用到后台播放），Play Console 会要求说明用途，见下面的待决定事项。
6. 2023-11-13 之后注册的**个人**账号，要先让[至少 12 名测试人员连续参加封闭测试 14 天](https://support.google.com/googleplay/android-developer/answer/14151465)才能申请正式发布。

> 只验证过构建：`android-bundle.yml` 用临时密钥走了一遍 AAB（结果见 PROGRESS 的 F-98）。真实密钥、`release.yml`、Play Console 上传都没有执行过。

**待决定：** expo-audio 的 `enableBackgroundPlayback` 默认为真，Android 上因此多了前台服务和 `FOREGROUND_SERVICE_MEDIA_PLAYBACK`。App 不在后台放声音，在 `app.config.ts` 里关掉就不用向 Google 申报，但这会改变 Android 的清单，改完要重跑 Android E2E。iOS 上这个声明已经去掉。

### 构建 iOS

CI 的 `ios.yml` 编译的是模拟器版，只用本地签名（`-`），不能装到真机。正式版要在 Mac 上签名。

**模拟器（不需要账号）：** 需要 Xcode 26、CocoaPods、Node、pnpm。

```bash
pnpm install
pnpm ios:build                # 产物：.artifacts/xiaodouya-e2e.app，连 http://localhost:8787
```

`pnpm ios:e2e` 跑端到端测试，它依赖的 Postgres 和 SeaweedFS 用 `scripts/ios-infra.sh` 启动，见 `e2e/README.md`。

**真机和 TestFlight：**

1. 在 [Certificates, Identifiers & Profiles](https://developer.apple.com/account/resources/identifiers/list) 注册 Bundle ID `com.gchust.xiaodouya`（或你的 `IOS_BUNDLE_ID`），打开 **Push Notifications**。`expo-notifications` 给工程加了推送权限，这个能力没开的话签名会失败。
2. 在 [App Store Connect](https://appstoreconnect.apple.com) 新建 App，选这个 Bundle ID。
3. 在 Mac 上生成工程：

   ```bash
   pnpm install
   cd apps/mobile
   # 地址在 Xcode 归档时才写进 JS，而从访达或 open 打开的 Xcode 读不到终端里的环境变量，所以写进 .env（已被 git 忽略）。
   # 必须是 https：iOS 的 ATS 不允许连公网的 http 服务器，没有 ANDROID_ALLOW_HTTP 那样的开关。
   # 不要设置 EXPO_PUBLIC_E2E，那会把系统相册换成内置样例。
   echo 'EXPO_PUBLIC_API_URL=https://baby.example.com' > .env
   export APP_VERSION=0.1.0 APP_VERSION_CODE=1   # 每次上传 APP_VERSION_CODE 都要变大
   CI=1 npx expo prebuild --platform ios --no-install --clean
   (cd ios && pod install)
   open ios/app.xcworkspace
   ```

4. 在 Xcode 里选中 `app` target → Signing & Capabilities → 勾选 Automatically manage signing，选你的 Team。
5. 设备选 Any iOS Device → Product → Archive。
6. 归档完成后 Distribute App → App Store Connect → Upload。
7. 在 App Store Connect 的 TestFlight 页把家人加为测试人员，他们用 TestFlight App 安装。第一次外部测试要等 Apple 审核，内部测试不用。

### 上架 App Store

除了上面的步骤，还要在 App Store Connect 填：

- **App 隐私**：App 收集邮箱、姓名、照片、视频、录音、健康数据和设备标识，都用于 App 功能，不用于追踪。隐私清单 `ios.privacyManifests` 只声明了系统 API 的使用理由，收集的数据要在这里填。
- 隐私政策网址、年龄分级、截图（6.9 英寸 iPhone）。
- 出口合规：`app.config.ts` 里写了 `usesNonExemptEncryption: false`（只用系统的 HTTPS 和哈希），如果以后加了自己的加密要改。
- 审核备注和测试账号：审核员要能登录，服务器要在线。

上线前必须在真机上验证（模拟器都测不了）：相册和相机、麦克风录音、静音键打开时的播放、面容解锁证件夹、喂奶本地提醒、后台切回后的同步。

### 远程推送（可选）

不配置也能正常使用：**喂奶提醒是手机本地通知**，App 打开时家人的记录也会实时同步并弹出横幅。

**产品已决定不做远程推送（PROGRESS 的 F-47），新版 App 也不再注册推送令牌，保持 `PUSH_ENABLED=false` 即可。** 服务端代码还在，是因为已发布的 v0.1.0 还会调用这些接口。下面的步骤只对 v0.1.0 有效：

1. 在 [Firebase](https://console.firebase.google.com) 创建项目，添加 Android 应用，包名 `com.gchust.xiaodouya`（或你设置的 `ANDROID_PACKAGE`），下载 `google-services.json`。
2. 在 [Expo](https://expo.dev) 创建项目，记下 Project ID；在项目的 Credentials 里上传 FCM V1 服务账号密钥。
3. 配置构建：

   | 类型     | 名称                          | 值                                |
   | -------- | ----------------------------- | --------------------------------- |
   | Secret   | `GOOGLE_SERVICES_JSON_BASE64` | `base64 -w0 google-services.json` |
   | Variable | `EAS_PROJECT_ID`              | Expo 的 Project ID                |

4. 在服务器的 `deploy/.env` 里设置 `PUSH_ENABLED=true`，如果在 Expo 开了访问令牌保护，再填 `EXPO_ACCESS_TOKEN`。
5. iOS 另外要在 Apple Developer 创建 APNs 密钥（.p8），上传到 Expo 项目的 Credentials。这一步没有验证过：模拟器拿不到推送令牌。

---

## 邮件和验证码

不配置邮件也能完整使用：跳过邮箱验证，`/v1/me` 的 `emailVerified` 是 `true`，登录页显示“请部署者重置”的说明，`/v1/auth/password/*` 返回 503。自建和 CI 的 E2E 都是这样。

配置 `MAIL_PROVIDER=resend` 之后：

- 登录页出现“忘记密码”（App 问 `/v1/config`），凭邮件里的验证码改密码，改完所有设备都要重新登录。
- 注册后发验证码，新版 App 在建家庭之前显示验证这一步，**可以跳过**，之后在「家人」的设置里验证。
- 服务端不因为没验证拒绝任何操作。线上有不认识这一步的旧版 APK（v0.1.0），拒绝就等于把人锁在外面。旧版 APK 注册时用户也会收到验证邮件，只是没地方填。
- 开启邮件之前注册的账号 `emailVerified` 是 `false`，不会被拦。设置里有“验证邮箱”，没验证也能找回密码，找回成功就算验证过。

开启步骤（上线前再做，真实发信还没有验证过）：

1. 在 Resend 添加并验证发件域名（SPF、DKIM）。没验证的域名发不到别人的邮箱。
2. 把三个参数写进 `supabase secrets set` 或 `deploy/.env`，重启或重新部署。配错时服务拒绝启动，不会悄悄关掉邮件。
3. 用一个真实邮箱走一遍注册和找回密码。发信失败只记在日志里（`验证码邮件发送失败`，只有状态码），响应不变，所以不看日志发现不了。

限制：验证码 6 位，有效期 30 分钟，每个最多猜 5 次；重发冷却 60 秒。同一个邮箱的找回邮件每小时 5 封、每天 10 封，超过后响应不变但不发信；提交验证码每小时 20 次。这也意味着知道邮箱的人可以把这些额度用完，让本人一段时间内收不到邮件（已登录的设备不受影响）。

## 账号删除和文件清理

删除账号的请求在一个事务里删完数据库里的内容，存储里的文件写进 `pending_object_deletions` 队列，响应之后在后台开始删。后台没做完（函数被回收、存储暂时不可用）的留在队列里，失败的按 1 分钟起、最长约 17 小时退避重试。还没传完的文件要等预签名链接过期（65 分钟）后再删一次，因为手机手里的链接还有效。

**兜底的是每天的定时清理 `cli maintenance`，不用单独配定时任务**，配置方法见上面两种部署的“日常维护”。没配的话，这些文件只有下一次有人删除账号时才顺带处理。想马上处理时手动跑 `cli purge-objects`，它只处理这个队列，对 `APP_SECRET` 的要求和定时清理一样。

有失败时命令退出码非 0。查原因（不含密钥）：

```sql
SELECT object_key, attempts, next_attempt_at, last_error FROM pending_object_deletions ORDER BY attempts DESC LIMIT 20;
```

队列的 `storage` 列是家庭自带存储配置的快照，Secret 仍然是 `APP_SECRET` 加密的，所以更换 `APP_SECRET` 后这些记录会一直失败。对方的密钥被吊销时也会一直重试，确认不用再删后，手动删掉那一行。

已经进入加密备份的数据要等备份过期才消失，公开的 CDN 域名也可能缓存文件一段时间。

## 三、参数说明

### 服务端（`deploy/.env`；Supabase 方案用 `supabase secrets`，不需要 `DOMAIN`、`POSTGRES_PASSWORD`、`SERVER_IMAGE`）

| 参数                              | 必填 | 默认值                                   | 说明                                                                                                      |
| --------------------------------- | ---- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `DOMAIN`                          | 是   | —                                        | 服务端域名，Caddy 用它自动申请 HTTPS 证书                                                                 |
| `POSTGRES_PASSWORD`               | 是   | —                                        | 数据库密码。用 `openssl rand -hex 24` 生成，只含十六进制字符才不会破坏连接串                              |
| `APP_SECRET`                      | 是   | —                                        | 至少 32 字节的 base64，用 `openssl rand -base64 32` 生成。加密存储密钥。不要更换，要单独备份              |
| `ALLOW_SIGNUP`                    | 否   | `true`                                   | `false` 时只有持邀请码才能注册                                                                            |
| `MAX_UPLOAD_MB`                   | 否   | `4096`                                   | 单个文件的总上限。R2 和 S3 单次上传上限都是 5 GB，不要超过                                                |
| `MAX_IMAGE_MB`、`MAX_AUDIO_MB`、`MAX_DOCUMENT_MB` | 否 | `50`、`200`、`50`                   | 各类文件的上限，同时受 `MAX_UPLOAD_MB` 限制。证件不管是照片还是 PDF 都算证件                              |
| `MAX_VIDEO_MB`                    | 否   | `1024`（Compose 是 `4096`）              | 视频的上限                                                                                                |
| `FAMILY_QUOTA_MB`                 | 否   | `5120`（Compose 是 `0`）                 | 每个家庭在默认存储上的配额，`0` 不限。依据见 [CAPACITY.md](CAPACITY.md)。单个家庭可以单独设置，见上文     |
| `FAMILY_RECORDS_MB`               | 否   | `100`                                    | 每个家庭的记录总量，`0` 不限。正常家庭每年约 0.7 MB，防的是有人把数据库写满                               |
| `MEDIA_TRASH_DAYS`                | 否   | `30`                                     | 记录删除后文件保留多少天。**函数和定时任务要设成一样**                                                    |
| `CLIENT_IP_HEADER`                | 否   | `x-forwarded-for`                        | 从哪个请求头取客户端地址。Caddy 覆盖了这个头，是可信的；Supabase 要按上文确认                             |
| `CLIENT_IP_POSITION`              | 否   | `last`                                   | 取这个头的第一段还是最后一段（`first`、`last`）。代理通常是追加，客户端能伪造前面的。取到内网地址算取不到 |
| `RATE_REGISTER_PER_IP_HOUR`       | 否   | `20`                                     | 每个来源每小时能注册几次，`0` 不限。取不到来源时不按来源限制                                              |
| `RATE_REGISTER_GLOBAL_HOUR`       | 否   | `1000`                                   | 全站每小时能注册几次，`0` 不限。换地址绕不过。爆发式增长时要调高                                          |
| `RATE_UPLOAD_URL_PER_HOUR`        | 否   | `2000`                                   | 每人每小时申请上传链接的次数，`0` 不限。一次传 100 张照片是 200 次                                        |
| `RATE_SYNC_PER_10MIN`             | 否   | `600`                                    | 每人每 10 分钟同步的次数，`0` 不限。被限流时 App 退避后自动重试，不丢数据                                 |
| `SERVER_IMAGE`                    | 否   | `ghcr.io/gchust/xiaodouya-server:latest` | 服务端镜像，可以固定到某个版本，比如 `:v0.1.0`                                                            |
| `ALLOW_CUSTOM_STORAGE`            | 否   | 配了 `S3_*` 时 `false`，否则 `true`（Compose 是 `true`） | `false` 时只用下面的默认存储，App 显示用量页，没有 S3 表单。已经在用自己存储的家庭不受影响，还能改配置 |
| `ALLOW_PRIVATE_STORAGE_ENDPOINTS` | 否   | `false`                                  | 是否允许内网或 http 的存储地址。自建内网 MinIO 才需要打开。默认关闭是为了防止管理员探测服务器内网（SSRF） |
| `PUSH_ENABLED`                    | 否   | `false`                                  | 启用家人记录的远程推送                                                                                    |
| `EXPO_ACCESS_TOKEN`               | 否   | —                                        | Expo 开启推送安全时需要                                                                                   |
| `MAIL_PROVIDER`                   | 否   | 不发邮件                                 | `resend`、`none` 或 `log`。`log` 把验证码打到终端，只能本地开发用，`NODE_ENV=production`（镜像里已设置）和 Edge Function 上会拒绝启动。拼错也拒绝启动 |
| `RESEND_API_KEY`                  | resend 时必填 | —                               | Resend 的 API Key。是密钥，不要提交                                                                       |
| `MAIL_FROM`                       | resend 时必填 | —                               | 发件人，比如 `小豆芽 <no-reply@baby.example.com>`，域名要先在 Resend 验证                                  |
| `DB_POOL_MAX`                     | 否   | `10`（Edge Function 是 `1`）             | 数据库连接池大小                                                                                          |
| `DB_PREPARE`                      | 否   | `true`（Edge Function 是 `false`）       | 是否用命名预处理语句。事务模式的连接池不支持，必须是 `false`                                              |
| `DB_SSL`                          | 否   | 不设置（Edge Function 是 `require`）     | `require` 或 `verify-full`。不设置时遵守连接串里的 `sslmode`                                              |

### 默认存储（可选）

不填就由管理员在 App 里配置。**只有服务器上的人能改这里；App 里的配置优先于这里。**

| 参数                   | 说明                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------ |
| `S3_ENDPOINT`          | 存储 API 地址。AWS S3 留空                                                                       |
| `S3_PUBLIC_ENDPOINT`   | 手机访问存储的地址，默认同 `S3_ENDPOINT`。只有服务器和手机走不同地址时才需要（比如 Docker 内网） |
| `S3_REGION`            | 区域。R2 填 `auto`                                                                               |
| `S3_BUCKET`            | Bucket 名称，需要提前创建                                                                        |
| `S3_ACCESS_KEY_ID`     | 访问密钥 ID                                                                                      |
| `S3_SECRET_ACCESS_KEY` | 访问密钥 Secret                                                                                  |
| `S3_FORCE_PATH_STYLE`  | R2 和大多数兼容存储用 `true`，AWS S3 用 `false`                                                  |
| `S3_BIND_UPLOAD_SIZE`  | 默认 `true`，把声明的大小签进上传链接。`cli check-upload-size` 不通过时才关掉，文件大小仍会在上传完成时校验 |

各服务商怎么填：

| 服务商               | `S3_ENDPOINT`                                   | `S3_REGION`      | `S3_FORCE_PATH_STYLE` |
| -------------------- | ----------------------------------------------- | ---------------- | --------------------- |
| Cloudflare R2        | `https://<account-id>.r2.cloudflarestorage.com` | `auto`           | `true`                |
| AWS S3（新加坡）     | 留空                                            | `ap-southeast-1` | `false`               |
| 阿里云 OSS（新加坡） | `https://oss-ap-southeast-1.aliyuncs.com`       | `ap-southeast-1` | `false`               |
| MinIO                | `https://minio.example.com`                     | `us-east-1`      | `true`                |

### App 内的存储设置（「家人 → 存储」，仅管理员，且服务器允许自定义存储）

| 字段                          | 说明                                             |
| ----------------------------- | ------------------------------------------------ |
| 服务商                        | Cloudflare R2、AWS S3、其他 S3 兼容              |
| Account ID                    | 仅 R2                                            |
| Endpoint                      | 仅“其他”，必须是 https（除非服务器开了内网放行） |
| Region                        | R2 不需要；AWS 比如 `ap-southeast-1`             |
| Bucket、Access Key ID、Secret | 同上                                             |
| 公开 CDN 域名                 | 可选，见下方说明                                 |

保存前服务端会**真实地写入、读回、删除一个小文件**，失败就不保存。Secret 加密存在服务器上，任何接口都不会把它返回给 App。

换存储后，**旧文件不会自动搬家**，但仍然能从原来的存储读取，请不要立刻删除旧 Bucket。

#### 公开 CDN 域名要不要填？

建议**先留空**。

|        | 留空（默认）                           | 填写                                       |
| ------ | -------------------------------------- | ------------------------------------------ |
| 链接   | 签名链接，1 小时后失效（证件 10 分钟） | 回忆的照片和视频用公开地址，不会过期       |
| 私密性 | 最好                                   | 地址里有随机 ID 猜不到，但谁拿到链接都能看 |
| 速度   | 走存储 API，通常已经够用               | 走 CDN 缓存，更快                          |
| 证件   | 签名链接                               | **仍然是签名链接，不受影响**               |

如果要填：先在 Cloudflare 给 R2 Bucket 绑定自定义域名并开启公开访问，然后填 `https://media.example.com`。注意公开访问对整个 Bucket 生效，**包括证件文件**（它们的地址同样不可猜，但不再受签名保护）。如果要严格隔离，请把证件放在另一个未公开的存储，或者保持留空。

> R2 的预签名链接不能用于自定义域名，这是 Cloudflare 的限制，所以“自定义域名 + 短时效链接”这种组合不可用。

### App 构建参数

| 参数                               | 必填       | 说明                                                                          |
| ---------------------------------- | ---------- | ----------------------------------------------------------------------------- |
| `EXPO_PUBLIC_API_URL`              | 正式版必填 | 服务端地址，比如 `https://<project-ref>.supabase.co/functions/v1/api` 或 `https://baby.example.com`。会打包进 App，**不要放任何密钥** |
| `EXPO_PUBLIC_API_REGION`           | 否         | Supabase Edge Function 执行区域，比如新加坡 `ap-southeast-1`；只对 Supabase 函数地址附加 `x-region` 请求标头 |
| `EXPO_PUBLIC_TERMS_URL`            | 否         | 用户协议的网址，注册页的同意说明链接到这里。发布流程从同名的仓库变量读取。没有设置时不提这份文件 |
| `EXPO_PUBLIC_PRIVACY_URL`          | 否         | 隐私政策的网址，同上。两个都没有设置时不显示同意说明。公开发布前必须设置      |
| `ANDROID_PACKAGE`                  | 否         | 包名，默认 `com.gchust.xiaodouya`                                             |
| `ANDROID_ALLOW_HTTP`               | 否         | 正式版默认 `0`，只允许 https。自建 http 服务器才设为 `1`                      |
| `ANDROID_ARCHS`                    | 否         | 正式版默认 `arm64-v8a,armeabi-v7a`。Google Play 要求有 64 位，32 位给旧手机   |
| `IOS_BUNDLE_ID`                    | 否         | iOS 的 Bundle ID，默认 `com.gchust.xiaodouya`                                 |
| `APP_VERSION` / `APP_VERSION_CODE` | 否         | 版本号，发布流程自动从标签设置                                                |
| `GOOGLE_SERVICES_JSON`             | 否         | `google-services.json` 的路径，启用推送时需要                                 |
| `EAS_PROJECT_ID`                   | 否         | 启用推送时需要                                                                |
| `ANDROID_KEYSTORE_PATH` 等         | 正式版必填 | 签名配置，见上文                                                              |

---

## 四、常见问题

**App 提示“连不上服务器”**：确认 `curl https://域名/healthz` 能通（Supabase 方案是 `https://<project-ref>.supabase.co/functions/v1/api/healthz`）；确认手机不是用 http 连正式版。Supabase 项目可能被暂停了，到控制台看一下。

**函数日志里有 `write CONNECT_TIMEOUT` 或 `invalid peer certificate`**：函数连不上数据库。先确认 `DATABASE_URL` 是 Transaction pooler 的地址（6543）。Deno 即使在 `DB_SSL=require` 时也校验证书，所以连自签名证书的数据库会失败。

**上传一直失败**：先在「家人 → 存储」点「测试连接」。如果是用环境变量配置的存储，确认 `S3_PUBLIC_ENDPOINT` 是手机能访问的地址。

**视频一直不上传**：默认只在 Wi-Fi 下上传视频，顶部会显示“等 Wi-Fi”。可以在存储页关闭这个选项。

**App 被杀之后上传还会继续吗**：不会在后台继续，下次打开 App 时自动接着传（从这个文件的开头重新传）。这是当前版本已知的限制。

**数据在哪里**：记录在 Postgres，文件在 S3，手机上有一份离线副本。退出登录时清除手机上的副本。
