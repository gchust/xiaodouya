# 小豆芽部署文档

这份文档讲三件事：[服务端怎么部署](#一服务端部署)、[App 怎么构建和分发](#二app-构建和分发)、[每个参数怎么填](#三参数说明)。

整体结构很简单：

```
手机 App ──HTTPS──> Caddy ──> 服务端（Hono）──> Postgres
    │                             │
    │                             │ 签发短时效链接
    └──────直传/下载───────> S3 兼容存储（Cloudflare R2 / AWS S3 / ...）
```

照片和视频从手机直接传到存储，不经过服务器，所以服务器配置要求很低。

---

## 一、服务端部署

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

# 重置密码（没有邮件服务，忘记密码由部署者处理）
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env exec server \
  node dist/cli.mjs reset-password someone@example.com
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

> 现在没有自动更新，有新版本时再发一次 APK，覆盖安装即可，数据不会丢。

**iPhone**

代码已经是跨平台的，但**还没有在 iOS 上测试过**，需要：

- Apple Developer 账号（99 美元/年）；
- 一台 Mac 或 macOS 构建服务（`npx expo prebuild --platform ios`，然后用 Xcode 归档）；
- 通过 TestFlight 分发给家人。

上线前请先在真机上把录音、相册、通知和证件夹解锁都走一遍。

### 远程推送（可选）

不配置也能正常使用：**喂奶提醒是手机本地通知**，App 打开时家人的记录也会实时同步并弹出横幅。

只有“App 没打开时，收到家人记录的通知”才需要推送：

1. 在 [Firebase](https://console.firebase.google.com) 创建项目，添加 Android 应用，包名 `com.gchust.xiaodouya`（或你设置的 `ANDROID_PACKAGE`），下载 `google-services.json`。
2. 在 [Expo](https://expo.dev) 创建项目，记下 Project ID；在项目的 Credentials 里上传 FCM V1 服务账号密钥。
3. 配置构建：

   | 类型     | 名称                          | 值                                |
   | -------- | ----------------------------- | --------------------------------- |
   | Secret   | `GOOGLE_SERVICES_JSON_BASE64` | `base64 -w0 google-services.json` |
   | Variable | `EAS_PROJECT_ID`              | Expo 的 Project ID                |

4. 在服务器的 `deploy/.env` 里设置 `PUSH_ENABLED=true`，如果在 Expo 开了访问令牌保护，再填 `EXPO_ACCESS_TOKEN`。

---

## 三、参数说明

### 服务端（`deploy/.env`）

| 参数                              | 必填 | 默认值                                   | 说明                                                                                                      |
| --------------------------------- | ---- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `DOMAIN`                          | 是   | —                                        | 服务端域名，Caddy 用它自动申请 HTTPS 证书                                                                 |
| `POSTGRES_PASSWORD`               | 是   | —                                        | 数据库密码。用 `openssl rand -hex 24` 生成，只含十六进制字符才不会破坏连接串                              |
| `APP_SECRET`                      | 是   | —                                        | 至少 32 字节的 base64，用 `openssl rand -base64 32` 生成。加密存储密钥。不要更换，要单独备份              |
| `ALLOW_SIGNUP`                    | 否   | `true`                                   | `false` 时只有持邀请码才能注册                                                                            |
| `MAX_UPLOAD_MB`                   | 否   | `4096`                                   | 单个文件的大小上限。R2 和 S3 单次上传上限都是 5 GB，不要超过                                              |
| `SERVER_IMAGE`                    | 否   | `ghcr.io/gchust/xiaodouya-server:latest` | 服务端镜像，可以固定到某个版本，比如 `:v0.1.0`                                                            |
| `ALLOW_CUSTOM_STORAGE`            | 否   | `true`                                   | `false` 时只用下面的默认存储，App 里不能改                                                                |
| `ALLOW_PRIVATE_STORAGE_ENDPOINTS` | 否   | `false`                                  | 是否允许内网或 http 的存储地址。自建内网 MinIO 才需要打开。默认关闭是为了防止管理员探测服务器内网（SSRF） |
| `PUSH_ENABLED`                    | 否   | `false`                                  | 启用家人记录的远程推送                                                                                    |
| `EXPO_ACCESS_TOKEN`               | 否   | —                                        | Expo 开启推送安全时需要                                                                                   |

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

各服务商怎么填：

| 服务商               | `S3_ENDPOINT`                                   | `S3_REGION`      | `S3_FORCE_PATH_STYLE` |
| -------------------- | ----------------------------------------------- | ---------------- | --------------------- |
| Cloudflare R2        | `https://<account-id>.r2.cloudflarestorage.com` | `auto`           | `true`                |
| AWS S3（新加坡）     | 留空                                            | `ap-southeast-1` | `false`               |
| 阿里云 OSS（新加坡） | `https://oss-ap-southeast-1.aliyuncs.com`       | `ap-southeast-1` | `false`               |
| MinIO                | `https://minio.example.com`                     | `us-east-1`      | `true`                |

### App 内的存储设置（「家人 → 存储」，仅管理员）

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
| `EXPO_PUBLIC_API_URL`              | 正式版必填 | 服务端地址，比如 `https://baby.example.com`。会打包进 App，**不要放任何密钥** |
| `ANDROID_PACKAGE`                  | 否         | 包名，默认 `com.gchust.xiaodouya`                                             |
| `ANDROID_ALLOW_HTTP`               | 否         | 正式版默认 `0`，只允许 https。自建 http 服务器才设为 `1`                      |
| `ANDROID_ARCHS`                    | 否         | 正式版默认 `arm64-v8a`，覆盖几乎所有现役手机                                  |
| `APP_VERSION` / `APP_VERSION_CODE` | 否         | 版本号，发布流程自动从标签设置                                                |
| `GOOGLE_SERVICES_JSON`             | 否         | `google-services.json` 的路径，启用推送时需要                                 |
| `EAS_PROJECT_ID`                   | 否         | 启用推送时需要                                                                |
| `ANDROID_KEYSTORE_PATH` 等         | 正式版必填 | 签名配置，见上文                                                              |

---

## 四、常见问题

**App 提示“连不上服务器”**：确认 `curl https://域名/healthz` 能通；确认手机不是用 http 连正式版。

**上传一直失败**：先在「家人 → 存储」点「测试连接」。如果是用环境变量配置的存储，确认 `S3_PUBLIC_ENDPOINT` 是手机能访问的地址。

**视频一直不上传**：默认只在 Wi-Fi 下上传视频，顶部会显示“等 Wi-Fi”。可以在存储页关闭这个选项。

**App 被杀之后上传还会继续吗**：不会在后台继续，下次打开 App 时自动接着传（从这个文件的开头重新传）。这是当前版本已知的限制。

**数据在哪里**：记录在 Postgres，文件在 S3，手机上有一份离线副本。退出登录时清除手机上的副本。
