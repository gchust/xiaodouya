# 架构

## 为什么是这个技术栈

| 选择                            | 原因                                                                                         |
| ------------------------------- | -------------------------------------------------------------------------------------------- |
| Expo + React Native             | 一套代码支持 Android 和 iOS；改 JS 不用重新编译；需要时能用 Expo Modules 写原生代码          |
| 自己的服务端（Hono + Postgres） | 本地和 CI 能完整跑起来，Agent 可以闭环测试。同一份代码能跑在 Supabase Edge Function 上，也能用 `docker compose` 自建，不绑定平台 |
| S3 直传                         | 文件不经过服务器，服务器配置要求低；兼容 R2、S3 和其他存储                                   |
| 长轮询而不是 WebSocket          | 反向代理和 Edge Function 都不用特殊配置，代码量小。一家人的规模足够实时                      |

## 两种部署方式

生产推荐 Supabase 免费版（新加坡）：API 跑在 Edge Function，数据在 Supabase Postgres，文件在 Cloudflare R2。Docker 自建是备选。步骤见 [DEPLOYMENT.md](DEPLOYMENT.md)。

```
apps/server/src/app.ts   createApp：全部业务逻辑，两边共用
    ├── index.ts         Node 入口，启动时执行迁移，Docker 用
    └── edge.ts          Edge 入口，由 scripts/build-edge.mjs 打包，supabase/functions/api/index.ts 调用
```

|            | Docker                 | Edge Function                                     |
| ---------- | ---------------------- | ------------------------------------------------- |
| 迁移       | 服务启动时             | 部署时手动执行 `cli migrate`，冷启动不跑          |
| 数据库连接 | 直连，连接池 10，预处理语句 | 事务模式连接池，连接池 1，不用预处理语句，TLS |
| 路径       | `/v1/...`              | `/functions/v1/api/v1/...`，函数里是 `/api/v1/...` |
| 响应后的工作 | 进程一直在           | 交给 `EdgeRuntime.waitUntil`                      |

因为 Edge Function 的 isolate 随时被回收、可能同时有多个，**进程内存不能放任何需要共享的状态**：

- `/v1/sync/wait` 每 2 秒查一次 `families.seq`，两次检查之间不占数据库连接。新记录最多晚 2 秒通知。
- 登录、邀请码、注册和上传链接的限流计数放在 `rate_limits` 表。同一个邮箱还有一条不看来源的总量限制，注册也有全站上限，因为来源不一定可信（`CLIENT_IP_HEADER`，见 DEPLOYMENT）。
- 同步的限流不写 `rate_limits`：它每次本来就要更新 `memberships.last_seen_at`，计数放进同一条语句，不多一次写入。`/v1/sync/wait` 不限流，它自己每 25 秒才结束一次。
- 事务里只用 `tx`，不能用 `sql`：连接池只有 1 个连接时，事务内再用 `sql` 会死锁。

Supabase 的 Data API 会把 `public` 里的表开放给 `anon` 角色。这个项目不用它，部署时要关掉。所有表还开了 RLS，不写策略，并收回了 `anon`、`authenticated` 的权限。服务端用表的所有者连接，不受影响。新增的表也要开 RLS，`portable.test.ts` 会检查。

## 数据流

**记录：**写入内存 → 落盘 SQLite → 界面立即更新 → 后台同步。任何一步都不等网络。

```
RecordStore（内存 + SQLite）
    │ dirtyRecords
    ▼
SyncEngine ──POST /v1/sync {cursor, changes}──> 服务端
    ▲                                              │ 按家庭加锁，分配递增 seq
    └──────────── {records, cursor, rejected} ─────┘
```

- **主键：**客户端生成 UUID，所以离线重试是幂等的。
- **游标：**服务端给每个家庭维护单调递增的 `seq`。写入时对家庭行加锁，保证 seq 的顺序和提交顺序一致。如果按时间戳拉取，或并发分配序号，都可能漏掉正在提交的记录。
- **冲突：**按客户端 `updatedAt` 后写胜出。客户端的新版本号至少比它基于的版本大 1，手机时钟走慢也不会丢修改。被判定为旧版本时，服务端把当前版本显式补发回去，让客户端收敛。
- **删除：**软删除，作为一次普通修改同步。
- **未知数据：**校验不过的记录保留在本地但不显示，这样旧版 App 不会把新版数据弄丢。

**文件：**

```
选文件 → 复制到 App 私有目录 → 生成缩略图 → 写入上传队列（SQLite）→ 写入记录（只含引用）
                                              │
              POST /v1/media/upload-url ──────┤ 服务端创建 pending 记录，返回预签名 PUT 链接
              PUT  直传到 S3              ────┤ 带进度
              POST /v1/media/:id/complete ────┘ 服务端 HEAD 校验大小后标记 ready
```

记录和文件上传是分开的：记录先同步，家人马上能看到文字，图片传到后再显示。队列持久化，App 被杀后下次启动接着传。永久错误（比如类型被拒、空间已满）显示失败并可重试，不会卡住后面的文件。

**一张照片三个变体（`mediaJobs`、`photoPreview.ts`）：**

| 变体 | 内容 | 用在哪 |
|---|---|---|
| `thumb` | JPEG，宽 720 | 时间线、照片墙、查看器加载时的占位、分享页 |
| `preview` | JPEG，长边不超过 2048（小的不放大），质量 0.8 | 查看器默认显示、分享页的大图 |
| `original` | 用户的文件，永远不压缩，EXIF 原样留着 | “查看原图”、下载到手机 |

- **只有回忆里的照片有预览。** 证件要看清小字，也不值得多存一份副本；头像用不到；GIF 变成 JPEG 就不动了。视频没有预览，流式播放原文件。
- **队列按缩略图 → 预览 → 原图传**（`variantRank`），家人很快能看到清晰的照片。预览和缩略图一样是队列里现场解码生成的，不在选图时做。生成失败、被服务端拒绝（比如旧服务端不认识这个变体）就丢掉这个任务，原图照传，用户看不到失败。配额满除外：显示失败，腾出空间后能重试。
- **记录里没有 `hasPreview`：** 有没有预览以 `media` 表为准。预览可能做不出来，旧版 App 保存时还会丢掉不认识的字段，这个字段说明不了什么。查看器把三个变体放在一批里问 `/media/urls`，空的就是没有。
- **查看器（`usePhotoSources`、`photoPlan`）：** 本机有原图（上传队列的副本，或看过之后留在 expo-image 磁盘缓存里、大小对得上的那份）就直接用。否则有预览看预览，没有预览看原图（旧照片）。缩略图垫在最下面，只有缩略图时也不算打不开。“查看原图”点了才下载，盖在预览上，好了才看得出变化；原图的 URL 是空的就说明还没传完，隔一阵再问一次。只有当前页和前后各一页会取来源。
- **解码：** expo-image 默认按屏幕大小解码，这样放大时预览和原图一样糊，点“查看原图”也没有变化。所以预览和 2400 万像素以内的原图不缩小解码（`allowDownscaling={false}`）。更大的原图不行：Android 画不了超过 100 MB 的位图，直接闪退。
- **下载永远是原图。** 旧版 App 只请求自己认识的变体，`/media/urls` 按请求回答，所以它收不到 `preview`；`/family/export` 的结果它只是写进文件，不校验。
- **旧照片不补做预览。** 一直走回退。

**大文件分片上传（超过 16 MB，每片 8 MB，常量在 `packages/shared/src/domain/multipart.ts`）：**

```
POST /v1/media/multipart                     开始。配额预留和大小限制同单个 PUT，同一把锁。同一个文件再调一次返回同一个 uploadId
POST /v1/media/:id/multipart/parts           已传了哪些片。服务端当场 ListParts，以存储为准，数据库不记账
POST /v1/media/:id/multipart/part-urls       一批（最多 8 片）的预签名链接，分片大小签进去。每次续一下预留
PUT  直传到 S3                               手机把这一片写成临时文件，再流式上传，onProgress 能到片内字节
POST /v1/media/:id/multipart/complete        服务端 ListParts 取 ETag，核对每片大小，CompleteMultipartUpload，再走同样的 HEAD 和配额复查
POST /v1/media/:id/cancel                    取消：删 pending 记录，存储的清理（含中止分片）进待删除队列
```

- **一个文件同时传 3 片（`MULTIPART_PARALLEL`）**，整个队列还是一次一个文件。一片失败时同时在传的继续传完，不开始新的，下一轮只补缺的。每路有自己的临时文件（`<本地副本>-part-<路>`）。
- **手机不碰 ETag，也不记哪些片传了。** `job.uploadId`、`partSize` 持久化在上传队列里，断网、失败重试、App 被杀后都走同一条路：先问服务端缺哪些片，只传缺的。`confirmedBytes` 只用来显示进度，重启后还没联网也不从 0 开始。
- **片的大小记在 `media.upload_part_size`：** 常量以后可能变，没传完的文件还要按当初的算。R2 要求除最后一片外每片一样大。
- **`upload_gone`（404）：** uploadId 在存储里没了（被清理、过期）。服务端清掉它，手机从头开始，不算失败。ListParts 报 NoSuchUpload 时先 HEAD 一次：可能上次已经合并成功，只是没收到响应，这种情况返回 `complete: true`。
- **退回单个 PUT：** 接口 404（旧服务端）、501 `multipart_unsupported`（存储拒绝 CreateMultipartUpload，或 `S3_MULTIPART_ENABLED=false`）、预签名分片返回 501/405，都在同一次任务里改用单个 PUT，并记在 `job.singlePut` 上不再试。`upload-url` 看到还有 `upload_id` 的行会清掉并中止。5xx 是暂时的，不退回：退回就丢了已传的片。
- **文件被改动：** 每片之前比较大小和修改时间，变了就是永久失败，提示取消后重选，不会拼出一个坏文件。
- **Deno：** `platform: browser` 打包时 AWS SDK 的 XML 解析是 DOMParser，Deno 没有。`scripts/build-edge.mjs` 换成 SDK 里纯 JS 的版本。
- **没有清理的情况：** 中止失败时转进 `pending_object_deletions`（带 `upload_id`）重试。放弃的上传（24 小时）由 `cli maintenance` 中止，只管平台存储，自带存储的分片要靠用户 Bucket 自己的生命周期规则（`cli maintenance` 不碰用户的 Bucket）。账号删除和取消都是主人要求，队列带着存储快照，自带存储也会中止。

**取消上传（`data/uploadCancel.ts`、`UploadQueue.cancel`）：** 这是用户明确的删除，只有这里会丢任务，失败、断网、App 被杀都不会。

1. 先从记录里去掉文件引用（`withoutMedia`，通过正常的 `write` 同步给家人）。回忆的文字、其他文件、未知字段都保留。只剩空壳的回忆不删，确认时会说明。
2. 再取消任务：内存里马上拿掉，`AbortController` 中断正在传的（Android 上 `File.upload` 的 `signal` 真的会 `call.cancel()`，见 expo-file-system 的 `FileSystemUploadTask.kt`），删本地副本，写一个墓碑（`${id}/cancel`）。
3. 墓碑排在队列最前，有网时调 `/cancel`，离线也能取消。通知不到有次数上限，放弃的上传 24 小时后服务端也会清。

顺序不能反：写完记录后被杀，最多是一个没人引用的文件传了上去（服务端 30 天后清）；反过来会留下一个永远打不开的占位。服务端只处理 `pending`，已经 `ready` 的变体等记录去掉引用后走 `unreferenced_at`。

**后台上传（Android，`modules/upload-service`、`data/uploadServiceController.ts`）：** 上传还是 JS 队列在做，没有另写原生上传。本地 Expo 模块只提供一个 `dataSync` 前台服务，让进程活着：

- **清单放在模块里**（`FOREGROUND_SERVICE_DATA_SYNC`、`WAKE_LOCK`、`stopWithTask=false`），`app.config.ts` 不用改，iOS 不带这些。`expo-module.config.json` 只写了 `android`，iOS 上 `requireOptionalNativeModule` 返回 null，什么都不做。
- **何时启停是纯函数**（`shouldRunUploadService`）：有能传的任务才跑。传完、全部等 Wi-Fi、队列停了（退出登录、登录失效、到系统上限）马上停，通知跟着消失。断网撑 10 分钟再停，因为 Android 12 起后台不能启动前台服务，停了之后网络回来也起不来；一直没有进展 30 分钟也停，不能常驻。所以 **全部等 Wi-Fi 时 Wi-Fi 在后台回来不会自动接着传，要等下次打开。**
- **定时器：** RN 的定时器在 App 暂停后不走（`JavaTimerManager`），只有 Headless JS 任务在跑时例外。fetch 是 whatwg-fetch，完成后要 `setTimeout(0)` 才 resolve，所以没有这个任务的话后台第一个请求就永远等不到结果。服务运行时模块挂一个不结束的 Headless 任务（`XiaodouyaUploadKeepAlive`）。
- **CPU 和网络：** 前台服务不让 CPU 保持唤醒，要部分唤醒锁（6 小时超时兜底）和 Wi-Fi 锁。
- **队列是单例**（`lib/uploadRuntime.ts`）：从最近任务划掉后进程还在，React 界面卸载；再打开时界面重新挂载，要接上同一个队列，否则两个队列同时传。`load` 重复调用不重读。网络和前后台的监听也在这里，不跟着界面走。
- **Android 15 的 6 小时上限（targetSdk 36 适用）：** `dataSync` 24 小时内最多 6 小时，用户回到前台后重新计时。到了系统调 `onTimeout`，几秒内必须 `stopSelf`，否则抛 `RemoteServiceException`。这时队列也停下，任务留着，留一条“上传暂停了”的通知，回到前台接着传。之后再启动会抛 `ForegroundServiceStartNotAllowedException`，模块接住返回 false。
- **没进前台就停服务会崩：** 系统报 `did not then call startForeground`。小文件可能在 `onStartCommand` 之前就传完了，所以先进前台再停（`stopRequested`）。
- **通知：** 标题和速度由 JS 给，跟随 App 语言；每秒最多刷新一次。点通知打开详情页。`全部取消` 打开详情页的确认弹层，不直接删，取消都要确认。**没有通知权限时服务照常运行**，只是通知栏看不到（官方文档：出现在任务管理器里）。详情页用现有的提示卡提示打开，不主动弹系统对话框。
- **登录失效：** 队列收到 `unauthenticated` 就停，任务留着，重新登录后接着传。不依赖 React 状态，界面卸载时也生效。

**上传详情页（`app/uploads.tsx`）：** 队列按“文件 id”把原图和缩略图合成一项（`UploadItem`），卡片和详情页只看这一层。文件属于哪条记录不存在任务里，每次从记录反查（入队发生在写记录之前，升级前的任务也没有这个信息）。速度是最近 8 秒的滑动平均（`data/uploadSpeed.ts`），等 Wi-Fi、排队、断网、刚开始、5 秒没有新字节时不显示。

**配额和清理：**

平台存储（`storage_config_id` 为空）上的文件才算配额，用自己存储的家庭不花平台的钱。配额对已有家庭从第一天起就算，超额的家庭什么都不丢，只是传不了新文件。

| 状态 | 判断 | 算不算配额 |
|---|---|---|
| 正在上传 | `pending`，`reserved_at` 在 6 小时内 | 算（防止并行上传超出） |
| 放弃的上传 | `pending`，超过 6 小时 | 不算；24 小时后连对象一起清掉 |
| 在用 | `ready`，`unreferenced_at` 为空 | 算 |
| 待清理 | `ready`，`unreferenced_at` 不为空 | 配额以内不算，超出的部分算 |
| 没人引用 | `ready`，从没被记录引用过 | 算；30 天后清掉 |

- 检查和预留在同一个事务里，持有家庭行锁，所以并行上传不会一起通过检查。`complete` 时再查一次，超了就删掉对象。
- 待清理不算配额，是为了删除后马上能腾出空间；超出配额的部分要算，否则反复“上传再删除”能无限占用存储。所以单家最多占 2 倍配额。
- **同步写入时打标记：** 记录被删除或编辑后不再提到某个文件，且家庭里没有其他未删除的记录提到它，就写 `unreferenced_at`。撤销（记录恢复）时清掉。
- **“提到”按文本算：** 记录 JSON 里出现这个 UUID 就算，不按 `media`、`files`、`avatar` 字段取。将来的版本可能在别的地方引用文件。多算只是晚点清理，少算就是删了用户的照片。
- **清理（`cli maintenance`，每天一次）：** 持有和同步相同的家庭行锁，以记录为准再核对一遍，确实没人用才删对象和 `media` 行。记录本身不动，仍是软删除。宽限期 `MEDIA_TRASH_DAYS`（默认 30 天）。清理后才恢复的记录，图片会显示不出来。
- **只清平台存储**，不碰用户自己的 Bucket。只删 `media` 表里有的对象，不列举 Bucket，所以 `backups/` 不受影响。
- 账号删除的 `pending_object_deletions` 是另一条分支做的，以后可以把这里的 `deleteObject` 合并进去。

**上传链接把大小签进去（`S3_BIND_UPLOAD_SIZE`）：** 否则拿到链接的人可以传任意大小，还能在 `complete` 校验后用同一个链接覆盖成大文件。`complete` 的 HEAD 校验仍然保留。

**下载：**`POST /v1/media/urls` 批量取签名链接，客户端按“文件 id + 变体”作为 expo-image 的缓存键，因为签名链接每次都会变。

## 桌面小工具（Android）

用 `react-native-android-widget`（配置在 `app.config.ts`，代码在 `apps/mobile/src/widgets/`）。没有自己写原生代码。

```
点击 → 系统广播 → WorkManager（持久化，App 被杀后还会跑）→ Headless JS（只执行 index.ts）
     → runWidgetAction → RecordStore.write（先写本地，进发件箱）→ 重画 → 尽力同步一轮
```

- **只有一个写入者。** 后台任务和界面在同一个进程的同一个 JS 运行环境里，共用 `getCoreServices()` 的那一份 `RecordStore`。不用原生代码直接写 SQLite：那样要有第二个数据库连接（系统 SQLite 和 expo-sqlite 自带的是两份库，同进程混用有损坏数据库的风险），校验和记录格式要在 Kotlin 里再写一遍，App 开着时内存里的数据也会过期。
- **幂等靠渲染时生成的 id。** 按钮的点击数据里带着新记录的 UUID，连点、任务重试都落在同一条记录上。撤销过的也算存在，不会复活。
- **判断逻辑都在 `packages/shared/src/domain/widget.ts`：** 能不能写、写什么、显示什么。未登录、没有家庭、只看回忆、没有宝宝时不写也不显示记录。
- **数据新到什么时候要如实显示。** 没有远程推送，家人的记录只在 App 同步时才到：App 在前台时、点击小工具之后、系统定时刷新时（约 30 分钟，厂商可能更久）。小工具上显示最后一次同步的时间。
- **显示的是位图，不能走字。** 只写绝对时间（`22:10 睡着`），不写“已睡 1 小时”。

## 应用内更新（Android 旁加载）

APK 不走应用商店，新版本由 App 自己下载，交给系统安装。配置和发布后的核对见 [DEPLOYMENT.md](DEPLOYMENT.md#应用内更新旁加载的-apk)。

```
release.yml ── scripts/publish-apk.sh ──> R2 releases/android/xiaodouya-<版本>-<编号>.apk
                                     └──> R2 releases/android/latest.json（最后写）
App ──GET /v1/app/update?platform=android&versionCode=N──> 服务端读清单，比 versionCode，签 15 分钟的链接
App ──下载到 cache/updates──> 核对大小和 sha256 ──> ACTION_VIEW（FileProvider content URI）──> 系统安装界面
```

- **清单最后写。** 发布脚本先传 APK，下载回来核对 sha256，再写 `latest.json`。传到一半时 App 看到的还是上一版。清单不会被换成更低的 versionCode（Android 不允许降级安装），也会先用 `aapt2` 核对 APK 里的版本号：清单写错的话，装完 App 还会一直提示更新。
- **契约在 shared（`appUpdate.ts`）**：清单和接口的 zod 定义、只按 versionCode 比较、`minSupportedVersionCode`（必须更新）、自动检查的间隔、同一版本只提示一次。App 收到的响应也过 zod，链接和哈希格式不对就当没查到。
- **服务端只签发布前缀下的对象**（`isReleaseKey`）：清单和家庭的文件在同一个 Bucket，清单被写坏也不能借它签出别人的照片。清单不存在是“没有更新”，读不了或格式不对是 503，不能说成“已经是最新”。要登录（链接是 Bucket 的流量），不要求加入家庭。只读默认存储（`S3_*`），没配的自建服务器没有更新。
- **不弹窗。** 半夜单手记录时不能被更新对话框挡住：每天第一次打开（`UpdateWatcher`，状态是 `ready` 才查）有新版本时用 Toast 提一句，同一个版本只提一次，必须更新的每次都提；设置里的「检查更新」一直在。自动检查失败什么都不说，也不算查过。
- **状态机（`lib/appUpdate.ts`）不依赖 React Native**，平台的事从 `appUpdateRuntime.ts` 注入，单例：关掉弹层不停下载，再打开接着看进度。下载用 `File.downloadFileAsync`（非 2xx 会抛错），可取消；失败后重试是从头下，链接剩不到 2 分钟就重新取一个。同一版本下好没装的，下次先核对再用，不重新下。
- **sha256 在原生算**（`modules/app-update`，流式读文件），不把几十 MB 读进 JS。这个模块还提供系统记录的 versionCode（不信构建配置）、“安装未知应用”的授权状态和设置页入口。
- **安装：** `expo-intent-launcher` 发 `ACTION_VIEW`，`application/vnd.android.package-archive`，用 expo-file-system 自己的 FileProvider 给一次性读取授权，文件不出 App 的缓存目录。安装界面开着时这个调用一直不返回，期间再点不再开一个。没有授权时不调起，先引导去设置。系统的“安装”确认不能跳过，签名不一致系统会拒绝。装上的版本和更旧的安装包下次启动时删掉。
- **Google Play 构建要关掉**（`EXPO_PUBLIC_SELF_UPDATE` 不是 `1`）：没有入口，`app.config.ts` 不加 `REQUEST_INSTALL_PACKAGES`，还把它放进 `blockedPermissions`，哪个依赖带进来都会被去掉。原生模块还在包里，但没有权限、也没人调用。
- **E2E：** `scripts/e2e.sh` 用 `e2e/helpers/fake-release.sh` 在单独的前缀（`releases-e2e/android/`）发布一个假版本，再把存储里的 APK 换成别的字节。流程 23 测检查、以后再说、下载后校验不通过不给安装。E2E 构建不自动检查，否则每条流程开头都多一个 Toast。

## 权限

权限在服务端判断，规则在 `packages/shared/src/schemas.ts`：

|                          | admin | caregiver | viewer |
| ------------------------ | ----- | --------- | ------ |
| 回忆、照片、信（读）     | ✓     | ✓         | ✓      |
| 记录、证件（读）         | ✓     | ✓         | ✗      |
| 写入、上传               | ✓     | ✓         | ✗      |
| 看存储用量               | ✓     | ✓         | ✗      |
| 邀请、成员管理、存储设置 | ✓     | ✗         | ✗      |

## 存储密钥

- Secret 用 `APP_SECRET` 通过 AES-256-GCM 加密存在 Postgres。
- 任何接口都不返回 Secret。
- 服务器不允许自定义存储时（`ALLOW_CUSTOM_STORAGE=false`，配了 `S3_*` 又没写这一项时的默认值），App 不显示 S3 表单，服务端也拒绝保存。已经在用自己存储的家庭不受影响：能读写，也能改配置，否则密钥过期就被锁死了。App 从公开的 `GET /v1/config` 知道服务器允许什么。
- 修改配置时可以不重填 Secret，但只有 Access Key 和地址都没变才行。否则管理员可以改掉地址，让服务器把旧 Secret 发到别处。
- 用户填写的地址要过 SSRF 检查（`assertEndpointAllowed`）。

## 已知限制

- **后台上传只有 Android，靠前台服务保活。** App 退到后台、锁屏、从最近任务划掉都继续传（见“后台上传”）。`force-stop`、系统或厂商杀进程后不能继续，下次打开接着传：大文件（分片）从缺的片开始，16 MB 以下的小文件从头重传。iOS 上只在 App 运行时传。
- 每个账号只属于一个家庭（`memberships_one_family`），一个家庭只有一个宝宝（`baby` 集合取最新一条）。
- iOS 没有测试过。
- 视频没有压缩。
- 存储地址的内网检查在连接前做，理论上还有 DNS 重绑定的窗口。管理员都是家人，风险可接受。
- 在 Supabase 上，手机断开后长轮询可能继续查到 25 秒时限才结束：在 edge-runtime 镜像里 `request.signal` 没有触发。只多几次很轻的查询，没有处理。
- 上传队列保存的是绝对路径。iOS 升级后容器路径可能变化，做 iOS 版时要改成相对路径。

## 登录失效和本地数据

| 情况                           | 本地数据                                               |
| ------------------------------ | ------------------------------------------------------ |
| 登录过期、被移出家庭、改了密码 | **保留**，回到登录页。同一个人回到同一个家庭后接着同步 |
| 换账号或换家庭后登录           | 清除                                                   |
| 主动退出、删除账号             | 清除，包括文件副本、缓存目录里的副本、图片缓存和已排好的本机提醒。有未上传内容时先警告 |

只有服务端返回 `unauthenticated` 才算登录失效，公共 Wi-Fi 或代理返回的 401 不算。

清除之后，还在路上的请求不能把数据写回来：`SyncEngine` 丢弃上一个会话的响应，`UploadQueue.reset` 之后失败的任务不再保存。

账号在一台手机上删除后，另一台手机只会收到 `unauthenticated`，分不清是过期还是删除，所以那台手机上的数据要等下次换账号登录才清除。

## 邮件和验证码

`Mailer` 和 `Notifier` 一样注入 `createApp`，`createMailer` 按配置选 Resend（HTTPS，Node 和 Edge 都能用）或 `log`，没配置时是 `null`。文字都在 `mailTemplates.ts`。参数见 [DEPLOYMENT.md](DEPLOYMENT.md#邮件和验证码)。

- **验证码（`emailCodes.ts`）：**每人每种用途一行（`email_codes`），发新的就覆盖旧的，用过就删。存的是带 `APP_SECRET` 的 HMAC：六位数字只有一百万种，不带密钥的哈希在数据库泄露时一下就能撞出来。次数检查和递增在同一条语句里，比较用 `timingSafeEqual`。
- **不泄露邮箱是否存在：**找回密码的接口限流只看来源和邮箱字符串，查账号、写库、发信都在响应之后（`background`）做，提交验证码时所有失败都是同一个响应。登录时邮箱不存在也算一遍 scrypt。**注册接口还是会返回 `email_taken`**，这个没有处理：要改就得让注册流程走邮件确认。
- **邮箱验证不是权限：**服务端不因此拒绝任何操作，线上的 v0.1.0 APK 不认识这一步。没配置邮件时 `emailVerified` 也是 `true`，App 只看这一个字段。

## 删除账号和导出

规则在 `packages/shared/src/account.ts` 的 `accountDeletionOutcome`，App 用它决定显示什么，服务端在事务里用它决定怎么删：

| 情况                         | 结果                                                     |
| ---------------------------- | -------------------------------------------------------- |
| 没有家庭                     | 只删账号                                                 |
| 唯一的管理员，还有别的家人   | 拒绝（409 `only_admin`），要先升别人为管理员或移出家人   |
| 最后一个成员                 | 家庭和全部数据一起删，文件进队列                         |
| 其他                         | 只删自己。记录和文件留给家庭，`created_by`、`uploaded_by` 置空；自己发出的未使用邀请随账号删除 |

事务里先锁家庭行再读成员，否则两个人同时删除时都以为对方还在。记录里的 `byName` 和正文是自由文本，不会改动。

文件走 `pending_object_deletions`（`objectDeletions.ts`）。队列带着存储配置的快照，因为配置随家庭级联删除了。处理时不开事务：先用一条语句把一批记录的下次重试时间推后（相当于租约），再连存储，成功后删记录。连接池可能只有 1 个连接，等对象存储时不能占着它。入口有三个：删除请求响应之后的后台任务，每天的 `cli maintenance`，手动的 `cli purge-objects`。定时任务可以没有 `APP_SECRET`：平台存储的文件不用解密；家庭自带存储的留在队列里，不认领、不计次数，也不算失败。

`GET /v1/family/export` 只含当前角色能读的集合和文件范围。文件只有元数据，没有 `object_key` 和下载地址；成员没有邮箱；已删除的记录和等待清理的文件不导出。一次查全家的数据，每人每小时 10 次，在 Edge Function 上数据量很大时可能碰到 CPU 限制（没有测过）。

## 分享一天

```
App ──POST /v1/shares──> 服务端（只存令牌的 SHA-256）──> 令牌只返回这一次
 │ <base>/#<令牌>：片段不会发给托管网页的服务器
 ▼
对方的浏览器 ── 静态页面（Cloudflare Worker 静态资源，Worker 没有代码）
     │ POST /v1/public/share {token}（令牌在请求体里，不进访问日志）
     ▼
服务端 ── 现查记录 ── 白名单 JSON + 1 小时的签名链接 ──> 页面直接从存储加载文件
```

**页面和接口分开：** Supabase Edge Function 在默认域名上会把 `text/html` 改写成 `text/plain`，所以函数只出 JSON。整个服务只有 `/v1/public/share` 开 CORS（`*`，不带凭据）。

**白名单在 `packages/shared/src/share.ts`：** `pickEventForShare`、`pickMomentForShare` 逐字段构造。`looseObject` 会保留未知字段，所以绝不能把 `record.data` 原样发出去。文件以 `media` 表为准：只发 `status='ready'`、`scope='memory'`、这个家庭的。记录是客户端写的，文件 id 可以写成证件的。一律签名，不用存储配置的公开地址：那种地址不会过期。

**照片发预览，不发原图（`publicRows`）：** `url` 优先是 `preview`，没有预览的旧照片才是原图；有预览时原图连签名都不签。预览和缩略图是从解码后的位图重新编码的，没有原图的 EXIF 和 GPS（`verify-uploads.mjs` 从存储读回来查，样例的原图带着虚构的 GPS 作对照）。视频和录音还是原文件，可能带位置信息，旧照片和做不出预览的照片也一样。

**响应里的文件链接一定带 object key。** S3 签名链接的路径就是 key，而 key 是 `families/<家庭 id>/memory/<文件 id>/<变体>`，主机名还有存储账号或 Bucket。所以拿到链接的人能看到家庭 id（一个 UUID，任何接口都不靠它授权）和存储地址。链接以外的字段都没有这些，测试是这样查的。要彻底去掉，得改对象路径并迁移旧文件，或者由函数代理文件（Edge Function 放不下大视频），这次都没有做。

**时区：** 打开页面的人可能在别的时区，服务端也不在分享者的时区。`shares.timezone` 存分享者手机的时区，日期和钟点用 `Intl` 按它算（`zonedClock`、`zonedCalendarDate`）。第几天和月龄由服务端算好再发，不下发出生时间。

**什么时候失效：** 过期、撤销（本人或管理员）、创建者被移出、降为只看回忆、删除账号。移出和降级时写 `revoked_at`，再加回来不复活；公开接口还核对创建者现在是能读记录的成员，防止以后新增的路径漏掉。撤销之后，已经发出去的签名链接最多还能用 1 小时，界面上写明了。

**分享页只连构建时的 API。** 登录页换成自己的服务器时，App 不显示入口（`canShare`）。

**限流：** 按来源（`RATE_PUBLIC_SHARE_PER_IP_15MIN`，取不到来源时跳过）和按令牌（`RATE_PUBLIC_SHARE_PER_TOKEN_HOUR`）。在查库之前计数，所以链接存不存在表现一样。

## 角色变化

同步响应里带当前角色，客户端保存上次的角色。升级后游标归零重新拉历史；降级后删除本地无权查看的集合。

## 多语言

目录在 `packages/shared/src/i18n`：`zh/` 是基准，`en/` 的类型来自它。没有运行时依赖，插值和单复数就是函数；日期和单复数不用 `Intl`，Hermes 上不完整。

- **当前语言是进程级状态。** App 只有一个用户，`AppProvider` 在渲染前调用 `setLocale`，语言变化时用 `key` 重新挂载界面（导航状态在容器里，不丢）。服务端不调用它：邮件和错误明确传语言，推送走默认的中文。
- **语言来源：** `Prefs.locale` 优先，否则跟随手机（`zh*` 中文，其他英文），E2E 构建没选过时中文。小工具的后台任务没有 `AppProvider`，自己读存的偏好。
- **地区和预置数据不进目录：** 疫苗名、备注写在地区文件里（`L(中文, 英文)`），`localized()` 把它们变成跟随语言的属性，新增地区只加一个文件。
- **记录是数据：** 内置疫苗写 `recordName`（中文原名），显示时按 id 换成当前语言；用户录入的原样显示。快捷按钮（药名、证件名、称呼、里程碑标题）只是替用户填字，存下来的就是当时的文字，之后不再翻译。
- **服务端错误：** `message` 不变（v0.1.0 直接显示），可选的 `params` 带参数或原因。App 在 `ApiFailure` 里换成当前语言，查不到才用 `message`。`check-i18n` 核对每个错误码都有英文。
- **邮件：** 收件人的 `Prefs.locale`，其次请求的 `Accept-Language`（新版 App 总是发），都没有时中文。

## 健康内容

规则和来源注释在 `packages/shared/src/health/index.ts`。

- 发烧阈值依据 NICE NG143 和 NHS。编写时 NICE 原文无法直接打开，阈值是通过二手摘要核对的。
- 低体温分级依据 WHO 新生儿保暖指南的二手引用，以及 NHS 孕产单位的家长手册。
- 疫苗表和来源在 `packages/shared/src/regions/` 各地区的文件里。新加坡的 2026-04-01 版 PDF 没能读到完整表格，标记为 `needs-review`。
- 奶粉营养的参考量在 `packages/shared/src/health/nutritionReferences.ts`，预置奶粉在 `formulaPresets.ts`，来源都写在代码旁边。

**这些内容都应该请医生或护士看一遍。**

## 奶粉和营养

**奶粉配置放在 `event` 集合，`type: 'formula'`，不是新集合。** 看过代码，新集合对线上版本不安全：

| 情况 | 新集合 | `event` 里的新类型（现在的做法） |
| ---- | ------ | -------------------------------- |
| v0.1.0 收到 | `collectionSchemas[集合]` 是 undefined，`rebuild` 抛错。记录已经落盘，下次启动在 `load()` 里再次抛错，App 打不开 | 校验不过，保留但不显示 |
| 新 App 连旧服务端 | `SyncChange.collection` 是枚举，整批同步 400，发件箱卡死 | 只有这一条被拒绝（`invalid`），标记为已处理，其他记录照常同步 |
| viewer | 要改权限表 | 和喂奶一样读不到，降级时一起清掉 |

也不放 `BabyData`：viewer 能读档案，而且档案是整条后写胜出，改奶粉会盖掉家人同时改的头像。

配置记录**没有 `at`**。v0.1.0 收到一小时内的新 `event` 会弹横幅，文字来自 `describeEvent`，遇到不认识的类型是 `undefined`；没有 `at` 时 `now - (at ?? 0)` 过不了一小时的判断。`EventData` 这个联合没有动，时间线、提示和导出都不用认识它，`RecordStore` 把它分到 `snapshot.formulas`。

**服务端要先于新版 App 部署。** 否则奶粉配置被旧服务端拒绝后标记为已处理，只留在这台手机上，部署后也不会重传，要改一次才会上传。喂奶记录不受影响，估算也不受影响：数值在记录的快照里。

**喂奶记录存快照。** 记录上有 `milkType`、`formulaId` 和 `formula`（名字 + 每 100 ml 的数值）。计算只读快照，不查奶粉配置，所以改配方、删奶粉、App 更新了预置都不会改写已经过去的日子。代价是后来补填或更正的数值只影响之后的喂奶。一条记录多 150 字节左右，可以接受。

**补记和修改。** 修改固定用记录上的快照，只改时间或奶量不会换成现在的数值，也不会给没标注的旧记录加上奶粉。补记没动过奶类型时跟着选的时间走（`feedDefaultsAt`）：比所有喂奶都晚就是下一次；更早就抄那之前最近标过的一条，连当时的快照一起；那之前没标过就不标，显示数据不足。默认值写在弹层那一行上，看得见，能改。

**旧版修改喂奶会丢这三个字段。** v0.1.0 的 `FeedSheet` 保存时新建对象，不展开原记录，`looseObject` 只保护读取。改过的记录回到“没标注”，显示数据不足，不会算错。新版从这一版开始展开原记录。

**判断规则**（`health/nutrition.ts`）：有任何一次喂奶算不进去就是数据不足并说明原因；今天只说“目前已摄入 xx%”；结论只给已结束、记录够完整的日子（至少 4 次、跨度至少 12 小时）；满 6 个月或当天有辅食，够的可以说达到，不够的不说低于；当天有吃药记录时钙、铁、维生素 D 同理；能量只显示摄入量，因为可靠的公式要性别；不判断超过上限。

新增品牌只在 `formulaPresets.ts` 加一条。某个地区读到了当地的推荐量，就在 `nutritionReferences.ts` 加一张表，把那个地区的 `nutrition` 指过去。

## 疫苗本的家庭配置

内置表是地区文件里的数据，永远不改。家庭的配置是一层覆盖：`planSchedule(地区, 出生时间, 配置, 记录)` 算出这个家庭实际的表，页面把它当成地区传给 `vaccineStatuses` 和 `otherVaccineRecords`，算状态、提醒、“其他接种记录”的逻辑只有一份。

**存在 `event` 集合，`type: 'vaccine-plan'`，一剂一条，没有 `at`。** 理由和奶粉配置一样：新集合会让 v0.1.0 启动崩溃、让旧服务端拒绝整批；放在 `event` 里旧版校验不过，保留但不显示；viewer 和喂奶一样读不到，也写不了。`RecordStore` 把它分到 `snapshot.vaccinePlans`，时间线、提示和导出都看不到它。

| 配置 | 字段 | 说明 |
| ---- | ---- | ---- |
| 隐藏一剂 | `vaccineId: 'sg:bcg'`、`hidden: true` | 恢复是写 `hidden: false`，改过的时间还留着 |
| 改一剂的时间 | `vaccineId: 'sg:bcg'`、`plannedAt` | 当地中午的时间戳，提前两周内算到期。`ageLabel` 还是表上的，恢复就回到原样 |
| 自己加的疫苗 | `vaccineId: 'custom:<记录 id>'`、`name`、`plannedAt` 或 `months`（都可以没有） | 打的时候接种记录也写这个 id，所以打过以后留在疫苗本上。移除是软删除，打过的记录回到“其他接种记录” |

**一剂一条而不是整份配置一条：** 整条后写胜出的话，两位家人同时改不同的剂次会互相覆盖。两台手机离线时给同一剂各建了一条，取 `updatedAt` 最新的那条。

**记录永远优先。** 隐藏只对还没打的剂次生效：打过的永远显示已接种，配置不能让接种记录消失或变成未接种。

**换地区：** 内置剂次的配置带地区前缀，换到别的地区时不生效，也不删除，换回来就恢复，疫苗本上有一句话说明还有几项没生效。自己加的疫苗不属于哪个地区，一直显示。其他地区没有内置表，疫苗本就是自己加的这些。

**App 不判断配置是否合理。** 不提示时间太早太晚，也不提示隐藏了常规剂次，这些是诊所的判断；状态文字只写 `计划 日期`，过了也不评价。配置页面都写着“以诊所安排和健康手册为准”。家里给“看情况”的剂次定了日期，那是家里的安排，可以提醒，这时不算 App 在建议打。

**服务端要先于新版 App 部署。** 否则配置被旧服务端拒绝后标记为已处理，只留在这台手机上，部署后也不会重传，要再改一次才会上传。

## 地区和单位

一个地区的全部差异都在 `packages/shared/src/regions/<id>.ts`：疫苗表、来源和版本、免责声明、证件建议、默认单位、纸张。页面只读这些字段，不判断具体是哪个国家。

| 概念 | 属于谁 | 存在哪里 | 缺失时 |
| ---- | ------ | -------- | ------ |
| 地区 | 家庭，只有管理员能改，服务端校验 | `BabyData.region` | 按新加坡，因为只可能来自 v0.1.0。不认识的值按 `OTHER` |
| 单位 | 个人 | `Prefs.units`，只存改过的项 | 跟随家庭的地区 |
| 时区 | 个人，手机启动时写入 | `Prefs.timezone` | 服务端按 `Asia/Singapore`，因为 v0.1.0 不上报 |

**存储永远是公制，**换算只发生在显示和输入。步进器在显示单位的网格上走，保存时显示值没变就保留原来的公制值（`metricToSave`），所以换单位不会让数据漂移。健康阈值只用摄氏度判断。

**接种记录换地区不丢。** `vaccineId` 带地区前缀（`sg:bcg`），没有前缀的当作 `sg:`，自定义疫苗是 `custom:<uuid>`。不在当前地区表里的记录显示在“其他接种记录”，不做跨地区对应，那是医生的判断。

**和旧版本兼容。** 新字段都是可选的。v0.1.0 不认识的字段会忽略并原样保存；旧服务端会丢掉 `Prefs.units`（单位退回地区默认），`BabyData.region` 能保留。推送按收件人的单位写，服务端部署新版后才生效。

### 新增一个国家

1. 读当地官方或权威机构的现行方案。读不到原文就用最好的二手来源，写 `reviewStatus: 'needs-review'`，注释里写明来源，并记到 PROGRESS（`AGENTS.md` 第 8 节）。
2. 复制 `regions/sg.ts` 为 `regions/<id>.ts`，`id` 用大写的 ISO 3166-1 代码，这样系统地区是这个国家的用户建档时会自动选中。疫苗表用 `defineSchedule` 声明，按月龄排序；只针对部分人的剂次写 `kind`，产品二选一的写 `choice`。名字用中文加常用英文缩写，免责声明要包含“以诊所安排和健康手册为准”。
3. 在 `regions/index.ts` 的 `regions` 和 `regionList` 里登记，`OTHER` 保持在最后。
4. 在 `packages/shared/test/regions.test.ts` 里把关键事实钉在读到的原文上。注册表的通用检查会自动覆盖新地区。

不用改页面，也不用迁移数据：选了这个地区的家庭在旧版本上显示为“其他地区”，记录不受影响。
