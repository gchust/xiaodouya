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

**未完成的分片上传：** App 传大文件用 S3 分片。取消、放弃和账号删除都会主动中止，中止失败也会重试，生命周期规则是最后的兜底。R2 文档写的是默认 7 天自动中止未完成的分片，不用额外配置，上线后可以在同一页确认。AWS S3 和其他兼容存储没有这个默认值，要自己加一条 `AbortIncompleteMultipartUpload` 规则。用户自带存储的家庭也一样，定时清理不碰他们的 Bucket（账号删除和用户主动取消除外）。

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

**升级用手动工作流最省事。** 到 Actions 页面运行“部署后端”（`.github/workflows/deploy-backend.yml`），它依次做：备份、确认存储支持把大小签进上传链接、迁移、部署函数、冒烟。任何一步失败都会停下。只能从 `main` 运行。

第一次要在仓库 Secrets 里添加 `SUPABASE_ACCESS_TOKEN`，在 Supabase 控制台的 [Access Tokens](https://supabase.com/dashboard/account/tokens) 页面创建。这个令牌能操作你账号下的所有项目，用完可以撤销，下次再建。其他都沿用备份已有的 Secret，所以 `BACKUP_DATABASE_URL` 要用能改表结构的账号（Session pooler 连接串）。

新函数有问题时，可以在本机检出旧版本重新部署函数。迁移只增不改，旧函数在新表结构上能继续跑，不需要回滚数据库。

也可以在本机手动执行：

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
UPDATE families SET quota_mb = 204800 WHERE id = '<家庭 id>';  -- 200 GB；0 表示不限；NULL 恢复默认
```

单家设置了 `quota_mb` 时优先于默认值，改默认值不影响这些家庭。

**调所有家庭的默认配额：** Supabase Secret 优先于代码默认值；没有设置 Secret 时，部署新版函数后才会使用新版代码的默认值。按旧 `supabase/.env.example` 设置过 Secret 的项目会继续使用旧值，要单独更新：

```bash
supabase secrets set FAMILY_QUOTA_MB=102400 --project-ref <项目 ID>   # 100 GB
```

本项目已于 2026-11-03 设置 `FAMILY_QUOTA_MB=102400`，并在[后端部署流程](https://github.com/gchust/xiaodouya/actions/runs/41614313014)中部署了新版函数。CLI 返回的 Secret 摘要与 `102400` 一致；线上现有 1 个家庭，没有单家 `quota_mb` 覆盖。`v0.3.3` 签名 APK 已[发布](https://github.com/gchust/xiaodouya/releases/tag/v0.3.3)。家人页显示“共 100.0 GB”仍待登录 App 实测。

**升级到带配额的版本（已上线的项目，只需要做一次）：** v0.1.0 的 APK 不用更新也能继续用：空间满时它显示服务端的那句话，有重试按钮。S3 表单还在它的界面上，保存时显示“这台服务器不允许自定义存储”。

```bash
# 1. 先确认 R2 接受把大小签进链接。不通过的话所有上传都会失败，要先 supabase secrets set S3_BIND_UPLOAD_SIZE=false
S3_ENDPOINT=... S3_REGION=auto S3_BUCKET=... S3_ACCESS_KEY_ID=... S3_SECRET_ACCESS_KEY=... S3_FORCE_PATH_STYLE=true \
DATABASE_URL='<Session pooler 连接串>' DB_SSL=require pnpm --filter @xiaodouya/server cli check-upload-size
# 同样的环境变量再跑一次 cli check-multipart，确认预签名分片上传能用。不通过时先 supabase secrets set S3_MULTIPART_ENABLED=false，App 会退回单个 PUT
DATABASE_URL='<Session pooler 连接串>' DB_SSL=require pnpm --filter @xiaodouya/server cli check-multipart
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

大约 20–30 分钟后，签名 APK 会出现在 GitHub 的 Releases 页面，服务端镜像也会推到 GHCR。

> 第一次发布后，确认一下 GitHub 上这个镜像的可见性。如果它不是公开的，服务器拉取时会提示 `denied`，要到包的设置里改成公开，或者在服务器上先执行 `docker login ghcr.io`。这个流程还没有实际跑过。

### 方式 B：本地构建

需要 Node、Java 17、Android SDK。版本由 `.mise.toml` 固定。

```bash
pnpm install
export EXPO_PUBLIC_API_URL=https://baby.example.com
export ANDROID_KEYSTORE_PATH=/绝对路径/release.keystore
export ANDROID_KEYSTORE_PASSWORD=... ANDROID_KEY_ALIAS=xiaodouya ANDROID_KEY_PASSWORD=...
pnpm android:build release --clean
# 产物：.artifacts/xiaodouya-release.apk
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

> 装了带应用内更新的版本之后，新版本在 App 里就能更新，见下面的“应用内更新”。`v0.3.2` 及更早的 APK 没有这个功能，要像第一次一样再手动装一次，覆盖安装，数据不会丢。

### 应用内更新（旁加载的 APK）

打 `v*` 标签发布时，`release.yml` 把签名 APK 和一个清单传到存储（和备份同一个 R2 Bucket，前缀 `releases/android/`）。App 每天第一次打开时、以及「家人 → 设置 → 检查更新」时问服务端；服务端读清单，签一个 15 分钟的下载链接，Bucket 保持私有。App 下载、核对大小和 sha256，再调起系统安装界面。设计见 [ARCHITECTURE.md](ARCHITECTURE.md#应用内更新android-旁加载)。

**用户要做的：** 不用打开浏览器下载。有新版本时 App 底部提示一句，点「看看」或在设置里点「检查更新」→「更新」，下载完点「安装」，**系统还会弹一个确认窗口，要再点一次「安装」**：没有 root 或设备所有者权限的 App 不能跳过这一步。第一次更新时系统还要求允许小豆芽“安装未知应用”，App 里有「去设置」。Android 会核对新 APK 的签名和已经装的一致，**签名密钥丢了或换了，新版本就装不上**，只能卸载重装（服务器上的数据还在，手机上没同步的会丢）。

**配置：** 复用备份已有的 Secret `S3_ENDPOINT`、`S3_BUCKET`、`S3_ACCESS_KEY_ID`、`S3_SECRET_ACCESS_KEY`，不用新加。服务端（Supabase 函数的 `S3_*`）读的必须是同一个 Bucket，按上面第 6 步配置的就是。

| 类型     | 名称                         | 说明 |
| -------- | ---------------------------- | ---- |
| Variable | `EXPO_PUBLIC_SELF_UPDATE`    | 不设置等于 `1`：APK 带应用内更新，发布时必须传到存储，缺少上面的 Secret 时发布流程在第一步就失败。`0`：没有入口，清单里没有 `REQUEST_INSTALL_PACKAGES`，也不上传。**上架 Google Play 的构建必须是 `0`**：Play 不允许 App 自己下载安装更新 |
| Variable | `APP_RELEASE_PREFIX`         | 可选，默认 `releases/android/`。改了的话服务端要一起改（`supabase secrets set APP_RELEASE_PREFIX=...`） |
| Variable | `RELEASE_MIN_SUPPORTED_CODE` | 可选。低于这个 versionCode 的 App 每次检查都提示“已经停止支持，请尽快更新”。只是提示，不拦着用。服务端不再兼容旧版本时才设 |

versionCode 是发布流程的运行编号（`GITHUB_RUN_NUMBER`），只增不减；`v0.3.2` 之前的发布已经用过的编号都比它小。发布脚本先用 `aapt2` 核对 APK 里的版本号和清单一致，不会把清单换成更低的 versionCode，APK 传完并下载回来核对 sha256 之后才写清单，所以 App 不会看到一个还没传完的版本。

**发布后核对：**

1. Actions 里“上传到存储（应用内更新）”这一步的日志有 `已发布：releases/android/xiaodouya-<版本>-<编号>.apk（N 字节，sha256 …）` 和 `清单：releases/android/latest.json → <版本>（<编号>）`。sha256 应该和 GitHub Release 上那个 APK 的 `sha256sum` 一样。
2. 在装着上一个带应用内更新版本的手机上：「家人 → 检查更新」看到新版本，更新、安装，打开后同一行写着新的版本号。

Bucket 是私有的，不能用浏览器直接打开这些对象。

**不要给 `releases/` 加生命周期过期规则：** 当前版本的 APK 也会被删掉，清单还指着它，所有人都下载失败。旧版本每个几十 MB，要清理就在 R2 控制台手动删，**不要删 `latest.json` 指向的那个**。`cli maintenance` 只删 `media` 表里登记过的对象，不碰 `releases/`。

**发布说明：** 清单支持中英文的 `notes`，发布脚本读 `RELEASE_NOTES_ZH`、`RELEASE_NOTES_EN`。发布流程现在没有传，App 里就没有“这次更新”这一块。

**不经过 Actions 发布：**

```bash
S3_ENDPOINT=... S3_BUCKET=... S3_ACCESS_KEY_ID=... S3_SECRET_ACCESS_KEY=... \
  bash scripts/publish-apk.sh .artifacts/xiaodouya-release.apk 0.4.0 <构建时的 APP_VERSION_CODE>
```

需要 `curl`（7.75 以上）、`node` 和 Android SDK 的 `aapt2`（`ANDROID_HOME`）。

**自建服务器：** 没有配置默认存储（`S3_*`）的服务器不提供更新，App 里显示已经是最新版本。

**iPhone**

代码已经是跨平台的，但**还没有在 iOS 上测试过**，需要：

- Apple Developer 账号（99 美元/年）；
- 一台 Mac 或 macOS 构建服务（`npx expo prebuild --platform ios`，然后用 Xcode 归档）；
- 通过 TestFlight 分发给家人。

上线前请先在真机上把录音、相册、通知和证件夹解锁都走一遍。

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

## 分享页（Cloudflare Worker 静态资源）

对方不用装 App 打开的网页。**没有配置时什么都不影响：** App 没有 `EXPO_PUBLIC_SHARE_BASE_URL` 就不显示入口，发布流程没有 `SHARE_PAGE_ENABLED=true` 就什么都不做。

Worker 只出静态文件（`apps/share-web/wrangler.toml` 没有 `main`），不跑代码、不代理 API，也收不到令牌：令牌在 URL 片段里，浏览器不会发给托管网页的服务器。响应头（`X-Robots-Tag`、`Referrer-Policy`、CSP 等）在构建时生成的 `dist/_headers` 里，页面的 meta 标签是兜底。**2026-11-03 已绑定自定义域名 [xdy.nfvd.net](https://xdy.nfvd.net/)**，原来的 [workers.dev 地址](https://xiaodouya-share.nfvd.workers.dev/)保留供旧版 APK 的分享链接使用。两个地址的线上首页都返回 200；自定义域名的证书、CSP、`Referrer-Policy`、`X-Robots-Tag` 响应头已核对。无令牌时页面显示“这个链接已失效或已撤销”。

当前项目的 GitHub Actions 已设置 `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`、`SHARE_PAGE_ENABLED=true`、`SHARE_PAGE_DOMAIN=xdy.nfvd.net` 和 `EXPO_PUBLIC_SHARE_BASE_URL=https://xdy.nfvd.net`。合并后的[自动发布流程](https://github.com/gchust/xiaodouya/actions/runs/41595897162)已通过，日志显示新旧两个触发器，线上均返回 200；以后 `apps/share-web/**` 变化会自动发布。后端仍在 Supabase 新加坡项目，网页通过 HTTPS 调用它。真实 Supabase 网关从该网页 Origin 发出的 OPTIONS 预检已返回 204，并允许 `content-type,x-region`。

### 发布顺序

**不能反：**

1. **部署后端：** GitHub Actions 手动运行“部署后端”（要有新的 `shares` 表和公开接口）。
2. **发布网页：** 配好下面的 Secret 和变量后，手动运行“发布分享页”。打开 `https://<你的域名>/` 应该显示“这个链接已失效或已撤销”，这说明页面能打开。
3. **发布 APK：** 设置仓库变量 `EXPO_PUBLIC_SHARE_BASE_URL`，再发版。`v0.3.1` 的分享链接仍用 `workers.dev`，`v0.3.2` 改用 `xdy.nfvd.net`；两个地址都保留。

### 第一次配置

1. **创建 API 令牌：** Cloudflare 控制台 → Account API tokens → Create Token → 模板 **Edit Cloudflare Workers**，范围限制到这一个账号（和这一个域名）。这是 [Cloudflare 文档](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)给 CI 的做法。这个模板的权限比发布静态文件需要的多，只保留账号下的 `Workers Scripts: Edit` 理论上够用（域名在控制台绑定时），**没有实际试过**，收窄后要跑一次发布确认。
2. **账号 ID：** 控制台的账号首页能找到。只放进 Secret，不要写进仓库。
3. **在 GitHub 仓库 → Settings → Secrets and variables → Actions 里添加：**

   | 类型     | 名称                         | 值 |
   | -------- | ---------------------------- | -- |
   | Secret   | `CLOUDFLARE_API_TOKEN`       | 第 1 步的令牌 |
   | Secret   | `CLOUDFLARE_ACCOUNT_ID`      | 账号 ID |
   | Variable | `SHARE_PAGE_ENABLED`         | `true`，不设置时发布流程跳过 |
   | Variable | `EXPO_PUBLIC_API_URL`        | 已有，页面调用这个地址，必须是 https |
   | Variable | `EXPO_PUBLIC_API_REGION`     | 已有，页面和 App 一样把请求固定到这个区域 |
   | Variable | `SHARE_PAGE_DOMAIN`          | 当前为 `xdy.nfvd.net`；每次 CI 发布都带这个域名 |
   | Variable | `EXPO_PUBLIC_SHARE_BASE_URL` | 第 3 步发 APK 时用，比如 `https://share.example.com`。换托管只改这个，不用改代码 |

4. **第一次运行“发布分享页”**，Worker（名字 `xiaodouya-share`）会自动创建。
5. **绑定域名：** Workers & Pages → `xiaodouya-share` → Settings → Domains & Routes → Add → Custom Domain。域名要已经托管在这个 Cloudflare 账号（[文档](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)写明了不能用别人的域名，也不能用已有 CNAME 记录的主机名），DNS 和证书由 Cloudflare 创建。不想绑域名时用 `https://xiaodouya-share.<账号子域>.workers.dev`。
6. **保留 `workers.dev` 地址：** 带 `--domain` 发布时，Wrangler 在没有明确配置 `workers_dev` 的情况下会关闭原地址。`apps/share-web/wrangler.toml` 明确写了 `workers_dev = true`，以便旧 APK 已生成的分享链接继续打开。设置 `SHARE_PAGE_DOMAIN=xdy.nfvd.net`，让后续 CI 发布始终带上自定义域名。

### 价格（2026-11-02 读 Cloudflare 文档）

[静态资源计费](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)：对静态文件的请求免费且不限量，存储也不收钱。这个 Worker 没有代码，也没开 `run_worker_first`，所以不会产生 Worker 调用（[Free 计划](https://developers.cloudflare.com/workers/platform/pricing/)的 Worker 请求是每天 10 万次，这里用不到）。[限制](https://developers.cloudflare.com/workers/platform/limits/)：Free 计划每个版本 2 万个文件，单文件 25 MiB，这里只有几个文件，共几百 KB。价格会变，发布前再看一眼。

**费用真正在别处：** 打开页面要调用 Supabase 函数（每次打开至少一次）和数据库，图片视频从 R2 下载。这些没有量过。

### 还没有验证的

- `v0.3.2` 签名 APK 已在[发布流程](https://github.com/gchust/xiaodouya/actions/runs/41596044189)构建，包内确认使用 `xdy.nfvd.net`；真机安装、创建有效分享链接待验证。
- 已验证真实 Supabase 网关的 OPTIONS 预检，但还没有用有效分享令牌在真实浏览器里走完整链路；`x-region` 对公开接口的实际执行区域、R2 签名文件加载也待核对。注册并创建家庭后，用 App 创建一个真实链接再检查。
- **中国大陆能否打开没有验证**，`workers.dev`、自定义域名、Supabase、R2 哪一段都可能不通。
- `x-forwarded-for` 在 Supabase 上是不是客户端地址（F-97）。不是的话按来源的限流不生效，按令牌的还在。

### 取消

删除仓库变量 `SHARE_PAGE_ENABLED` 不会下线已经发布的页面。要下线就在 Cloudflare 控制台删除这个 Worker。已经发出去的链接随之打不开，数据还在。接口要彻底停用可以把 `shares` 表的 `revoked_at` 全部写上。

---

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
| `FAMILY_QUOTA_MB`                 | 否   | `102400`（Compose 是 `0`）               | 每个家庭在默认存储上的配额，`0` 不限。依据见 [CAPACITY.md](CAPACITY.md)。单个家庭可以单独设置，见上文     |
| `FAMILY_RECORDS_MB`               | 否   | `100`                                    | 每个家庭的记录总量，`0` 不限。正常家庭每年约 0.7 MB，防的是有人把数据库写满                               |
| `MEDIA_TRASH_DAYS`                | 否   | `30`                                     | 记录删除后文件保留多少天。**函数和定时任务要设成一样**                                                    |
| `CLIENT_IP_HEADER`                | 否   | `x-forwarded-for`                        | 从哪个请求头取客户端地址。Caddy 覆盖了这个头，是可信的；Supabase 要按上文确认                             |
| `CLIENT_IP_POSITION`              | 否   | `last`                                   | 取这个头的第一段还是最后一段（`first`、`last`）。代理通常是追加，客户端能伪造前面的。取到内网地址算取不到 |
| `RATE_REGISTER_PER_IP_HOUR`       | 否   | `20`                                     | 每个来源每小时能注册几次，`0` 不限。取不到来源时不按来源限制                                              |
| `RATE_REGISTER_GLOBAL_HOUR`       | 否   | `1000`                                   | 全站每小时能注册几次，`0` 不限。换地址绕不过。爆发式增长时要调高                                          |
| `RATE_PUBLIC_SHARE_PER_IP_15MIN`  | 否   | `120`                                    | 分享页的公开接口，每个来源 15 分钟几次，`0` 不限。取不到来源时不按来源限制 |
| `RATE_PUBLIC_SHARE_PER_TOKEN_HOUR` | 否  | `600`                                    | 分享页的公开接口，每个链接每小时几次，`0` 不限。换地址绕不过 |
| `RATE_UPLOAD_URL_PER_HOUR`        | 否   | `2000`                                   | 每人每小时申请上传链接的次数，`0` 不限。一次传 100 张照片是 300 次，1 GB 的视频是 17 次                   |
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
| `S3_MULTIPART_ENABLED` | 默认 `true`，大文件用分片上传，能断点续传。`cli check-multipart` 不通过时关掉，App 自动退回单个 PUT，大文件断了就要从头传 |
| `APP_RELEASE_PREFIX`   | 默认 `releases/android/`，应用内更新的清单和 APK 在这个存储里的位置，要和发布流程的同名变量一样。见“应用内更新” |

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
| `EXPO_PUBLIC_SHARE_BASE_URL`       | 否         | 分享页的地址，见“分享页”一节。发布流程从同名的仓库变量读取。没有设置时 App 不显示分享入口 |
| `EXPO_PUBLIC_SELF_UPDATE`          | 否         | `1` 打开应用内更新（加 `REQUEST_INSTALL_PACKAGES`），其他值关闭。本地构建默认关闭；发布流程默认 `1`，仓库变量设成 `0` 关闭。上架应用商店的构建必须关闭，见“应用内更新” |
| `ANDROID_PACKAGE`                  | 否         | 包名，默认 `com.gchust.xiaodouya`                                             |
| `ANDROID_ALLOW_HTTP`               | 否         | 正式版默认 `0`，只允许 https。自建 http 服务器才设为 `1`                      |
| `ANDROID_ARCHS`                    | 否         | 正式版默认 `arm64-v8a`，覆盖几乎所有现役手机                                  |
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
