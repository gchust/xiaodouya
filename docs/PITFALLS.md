# 踩坑记录

已经付出过代价的教训。动手前先扫一眼相关分类；踩了新坑，修完后必须追加到这里。

## 怎么写

只记不显而易见的结论，代码或工具报错已经说清楚的不用记。每条格式：

```
- **一句话结论。** 为什么，或者不这样做会怎样。怎么处理。
```

追加到对应分类的**末尾**，不要重排已有条目，这样并行开发时不容易冲突。结论失效了就直接删掉，不留过时的话。

## 同步和数据

- **同步接口必须先读家庭 seq，再查 `seq <= S` 的记录。** 反过来的话，两条语句之间提交的记录会被游标跳过，永远同步不到。这个窗口很小，压测复现不出来，靠 `api.test.ts` 里在语句之间强行插入写入的确定性测试把关。
- **补发服务端版本时要按可读集合过滤。** 否则 viewer 用猜到的 id 提交一次改动，就能读到证件。
- **被服务端拒绝的记录不能在本地标记删除。** 用户写的内容会悄悄消失。保留数据、标记为已处理，有权威版本时由服务端补发覆盖。
- **角色变化后游标已经越过当时读不到的记录。** 升级要归零重新拉取，降级要清掉本地无权查看的集合。
- **批量同步要按字节分批，不能只按条数。** 200 条长信就是 12 MB，超过 5 MB 的请求体上限后一直 413，退避重试也没用，后面的记录全被堵住。
- **`looseObject` 校验不挡多余字段。** 一条记录可以塞几 MB 垃圾原样入库，请求体上限挡不住，而数据库是最贵的资源。所以有单条上限和单家总量上限。
- **`hono/body-limit` 默认返回纯文本，不是约定的 JSON 错误。** 要传 `onError`，否则 App 拿不到错误码。
- **“服务端说有更新但同步失败”的循环要有退避。** `/sync/wait` 在游标落后时立刻返回，没有退避就是死循环，会占满 JS 线程，整个 App 卡死。
- **宝宝档案的记录 id 用家庭 id。** 否则换手机的管理员在同步完成前再建一次档，新记录会覆盖全家的出生时间。同时要等第一次同步成功才显示建档页。
- **恢复旧备份会让家庭 seq 回退，手机的游标就超前了。** 服务端返回 `Math.max(upperBound, cursor)`，手机看不到家人新写的记录，也不报错，直到 seq 追上游标。协议还没有处理这种情况，目前只在部署文档里要求恢复后全家退出再登录。

- **从旧备份恢复后 seq 会倒退。** 手机游标比服务端还新时，如果不处理就会永远漏掉新记录。服务端发现这种情况要从头发送。
- **Edge Function 上进程内存不能放共享状态。** isolate 随时被回收，也可能同时有多个。事件唤醒和内存限流都只在同一个 isolate 里生效，本地单进程的测试发现不了，要用两个 `createApp` 实例共享一个数据库来测。
- **长轮询要和开始等待时的 seq 比，不能和游标比。** 从旧备份恢复后游标比 seq 大，和游标比的话家人的新写入唤醒不了。
- **字段的缺失值要按写入它的旧版本理解，不能按“没选”理解。** 线上 v0.1.0 的档案没有 `region`，按“其他地区”处理会清空疫苗本，所以缺失是新加坡，只有不认识的值才是其他地区。时区同理：`defaultPrefs` 换成 UTC 后，没存过时区的旧账号会白天静音、半夜推送，服务端要保留 `Asia/Singapore`。
- **保存时不能无条件把显示值换算回公制。** 显示取整后再换算会改掉原值：家人记的 131ml 显示成 4.4oz，只改备注也会变成 130ml。显示值没变就保留原值（`metricToSave`）。
- **只有管理员能改的字段，不能靠拒绝整条记录来保护。** 档案是整条后写胜出，家人换头像时会带上旧地区，拒绝的话换头像会失败，放行的话会盖掉管理员刚改的地区。服务端替换这一个字段。
- **不能给同步加新集合。** v0.1.0 收到不认识的集合时 `collectionSchemas[集合]` 是 undefined，`rebuild` 抛错，而记录已经落盘，之后每次启动都崩。新 App 连旧服务端则整批 400，发件箱卡死。新业务数据放进 `event`、用新的 `type`，v0.1.0 校验不过会保留但不显示。见 ARCHITECTURE 的“奶粉和营养”。
- **`event` 里不是记录的新类型不能带 `at`。** v0.1.0 的横幅和服务端推送只看 `at` 是否在一小时内，文字来自 `describeEvent`，不认识的类型会显示“记录了 undefined”。
- **`looseObject` 只保护读取，不保护保存。** v0.1.0 和之前的 `FeedSheet` 保存时新建对象，未知字段照样丢。新加的字段要按“旧版改一下就没了”来设计，保存时要展开原记录。
- **修改记录不能重新构造对象。** 旧的喂奶修改只写认识的字段，新版本写入的未知字段保存一次就没了。修改要用 `mergeEdit` 放到最新版本上：只改用户动过的字段，弹层开着时家人改的内容也不会被盖掉。
- **`stop()` 不会取消已经发出的同步请求。** 退出登录清空本地之后响应才到的话，记录会被写回 SQLite，还会标记“同步过”，下一个登录的人就看到了上一个人的数据。按会话编号丢弃旧响应。上传队列同理，失败的任务不能再存回去。
- **`store.write` 必须校验。** `rebuild` 会跳过校验不过的记录，不校验的话它存得下、看不见、服务端也不收。改已有记录时更糟：原来的内容也跟着消失。一条回忆 105 张照片就走到过这里：弹层正常关闭，时间线是空的，文件还在后台上传。

## 账号和登录

- **401 只代表要重新登录，不代表要清数据。** 本地可能有未同步的记录。只有换人或换家庭才清，主动退出才全清。
- **只认服务端返回的 `unauthenticated`。** 公共 Wi-Fi 的登录页和代理也可能返回 401。
- **处理 401 前要确认令牌还是发请求时那个。** 否则旧请求的响应晚到，会踢掉刚登录的新会话。
- **`X-Forwarded-For` 的第一段不一定可信。** Caddy 会覆盖它，别的网关可能只是追加，换着填就能绕过按来源的限流。所以默认取最后一段（`CLIENT_IP_POSITION`），同一个邮箱还有一条不看来源的总量限制。
- **取不到来源时不能用同一个值当限流的键。** 比如都算 `local`，或者最后一段其实是网关的内网地址：一个人注册就挡住了全部用户。这种情况要跳过按来源的限制，由不看来源的总量限制兜底。公网地址的网关测不出来，所以部署后要照 `DEPLOYMENT.md` 从两个网络试一次。
- **线上有旧版 APK 时，服务端不能因为新步骤拒绝旧接口。** 邮箱验证原来在建家庭和接受邀请时返回 403，v0.1.0 没有验证页，用户就被锁在外面了。新步骤放在新版 App 里引导，服务端只增不拒。
- **响应内容一样不等于查不出邮箱是否存在。** 发信的 HTTP 调用和登录时的 scrypt 都能从响应时间看出来。查账号和发信放到响应之后，邮箱不存在时也算一遍哈希。
- **Supabase 不设置 `NODE_ENV`。** 靠它拦 `MAIL_PROVIDER=log` 的话，函数上验证码会进云端日志。`edge.ts` 把它写死成 `production`。

## 上传和存储

- **R2 预签名链接不能用于自定义域名。** 只能走 `<account>.r2.cloudflarestorage.com`。私有文件不要拼 CDN 域名。
- **SigV4 签名包含 Host。** 给手机的预签名链接必须用手机能访问的地址生成（`S3_PUBLIC_ENDPOINT`），不能用容器内部地址。
- **R2 的 APAC 只是位置提示。** 不保证数据在新加坡，界面和文档不要这样写。
- **一个文件传不上去不能挡住后面的文件。** 失败的先跳过，这一轮结束后再退避重试；存储持续报错要有次数上限。
- **退出登录的警告要同时算记录和上传队列。** 记录都同步了不代表视频也传了。
- **SeaweedFS 写入时会自动建 Bucket，R2 和 S3 不会。** “Bucket 不存在”在本地测不出来，要测错误翻译函数。
- **内网地址判断不能用字符串。** `::ffff:7f00:1` 就是 127.0.0.1，用 `net.BlockList`。
- **Expo 会自动应用一批“老插件”，不写也生效。** 只是装上 `expo-media-library`，prebuild 就会声明 `READ_MEDIA_IMAGES`、`READ_MEDIA_VIDEO`、`READ_MEDIA_AUDIO`，上架 Google Play 要单独申报。必须在 `plugins` 里显式写 `granularPermissions: []`，库清单自带的 `READ_MEDIA_VISUAL_USER_SELECTED` 还要用 `blockedPermissions` 去掉。加原生依赖后要 prebuild 看一眼清单。
- **`saveToLibraryAsync` 靠文件名判断类型和扩展名。** 没有扩展名直接报错，所以上传队列里的 `<id>-original` 不能直接交给它。文件名有中文或 `+`、`,` 时，Android 的 `getFileExtensionFromUrl` 取不到扩展名，视频会被当成类型未知的图片，要先编码（见 `galleryUri`）。
- **expo-file-system 不能往 `createFile` 建好的 SAF 文档里 `copy`。** 不带 `overwrite` 报已存在，带了会先删掉文档再写，写不进去。只能 `copy` 到文件夹，用源文件的名字，重名时报 `Destination already exists`，要自己换名字再试。
- **`expo-intent-launcher` 拿不到 `ACTION_CREATE_DOCUMENT` 返回的地址。** 它返回的 `data` 是 `Intent.toString()`，不是 URI，所以“另存为”对话框走不通，只能用文件夹选择器。Android 11 起这个选择器不让选“下载”根目录和存储根目录，要在里面新建文件夹或选别的目录。
- **预签名 PUT 默认不限大小。** 只在 `complete` 时校验的话，拿到链接的人校验后还能用同一个链接覆盖成大文件，放弃 `complete` 也能占满存储。要把 `content-length` 签进去。R2 文档只提到签 `Content-Type`，所以上线前要用 `cli check-upload-size` 对真实存储跑一次。
- **媒体的 `created_at` 不能当作预留时间。** 上传重试时不会更新它，重试中的文件会被当成放弃、配额不算、对象被清理。要单独的 `reserved_at`，每次申请链接时刷新。
- **删除文件前要以记录为准再核对一遍，而且要持有同步用的那把锁。** 同一个文件可能被别的记录引用，同一批同步里也可能一删一引用。标记只是索引，不能当依据。
- **定时清理不要碰用户自己的 Bucket。** 那里的文件不花平台的钱，密钥也可能早就失效了，失败还会一直重试。唯一的例外是账号删除留下的队列：主人要求删除。这部分要真实的 `APP_SECRET`，没有时留在队列里，不算失败也不计次数。
- **定时任务的 `storageConfig()` 用的是假的 `APP_SECRET`。** 拿它解密家庭自带存储的快照一定失败，还会把重试次数白白耗掉。所以没有真实密钥时不认领这些记录。另外 GitHub 上没设置的 Secret 展开成空字符串，不能盖掉假值，否则配置校验失败，整个任务都跑不了。
- **已经上线后才加配额，要让超额的家庭什么都不丢。** 配额只拦新上传，不拦读、同步和删除，清理也不看配额。
- **开发 SeaweedFS 的卷位用满后，写入新 Bucket 返回 500。** 它给每个 Bucket 单独分卷，`-volume.max=20` 用完就报 `No writable volume`，已有的 Bucket 不受影响。看起来像预签名出错，先看 S3 容器的日志。
- **账号删了，预签名上传链接还有效。** 手机上的上传可能在删除之后才到达，文件就永远留在存储里了。没传完的文件要等链接过期后再删一次。
- **删除文件时存储配置已经没了。** `storage_configs` 随家庭级联删除，队列要带着配置的快照（Secret 仍是加密的）。删除也会连接用户填的地址，同样要过 SSRF 检查。
- **缓存目录里也有用户的文件。** 打开过的证件（`open-*`）、成长册、导出文件和系统选择器的副本都在 `Paths.cache`，只清 `uploads/` 和图片缓存的话，退出后还留在手机上。
- **选择器打开时进程被杀，选择结果找不回来。** `expo-modules-core` 只在 `onHostDestroy` 保存发起过的请求，进程被直接杀掉时没保存，新进程收到结果后 `dispatchResult` 对不上就丢弃。`getPendingResultAsync` 只对“Activity 被销毁、进程还在”有用。现象是点“添加”后 App 冷启动、选的图全没了，没有 `FATAL`，用户看到的就是闪退。要真正找回得改原生层，现在只提示用户再选一次。
- **不要把 `selectionLimit` 当上限用。** `parseResult` 里有 `it.take(selectionLimit)`：没有原生上限的回退选择器上，多选的图会被悄悄截掉。在 JS 里合并并提示数量（`mergePicked`）。传 0 表示不限，也是个坑。
- **保存时不要同步做缩略图。** `manipulate(uri)` 不带尺寸会整张解码，12 MP 要 48 MB，108 MP 要 430 MB，100 张要等两分钟，这期间记录还没写，被杀就什么都没有。文件挪进 App（同分区是 rename，瞬间完成）就写记录，缩略图放进持久化队列逐张做，并带 `maxWidth`、`maxHeight`。
- **图片在原生内存里，JS 的垃圾回收感觉不到。** `ImageManipulator` 的 context 和 image 用完要 `release()`。
- **`hasThumb: true` 不代表缩略图已经有了。** 缩略图是后来生成的，也可能做不出来。取缩略图的地方都要能退回原图，成长册以前就是直接跳过，照片会从册子里消失。

## 健康内容

- **睡眠中的提示不能盖住“偏少”的提醒。** 先判断风险，再显示其他内容。忘记结束的睡眠也不能当真。
- **网页上的医学来源经常读不到。** NICE 和 MOH PDF 在这个环境下返回 403 或连接失败。读不到原文就在注释和 PROGRESS 里写明“二手来源，需复核”，不要写成已核实。
- **中美的官方表有能读到的地址。** ndcpa.gov.cn、news.cn、moh.gov.sg 在这台机器上 TLS 被断开，cdc.gov 返回 403。但 chinacdc.cn 有国家免疫程序的 PDF，`aap.org/immunizationschedule` 跳转到可下载的 PDF，新华社的报道能从 web.archive.org 读。搜索摘要互相矛盾，不能当依据。
- **PDF 的免疫表要转成图片看。** `pdftotext` 排出来的列是错位的，AAP 表里跨几列的色块（比如乙肝第 3 剂的 6–18 个月）在文字里看不出范围。
- **奶粉标签要看清是哪种形态。** 同一个牌子粉和即饮液的数值不一样（Similac 360 的脂肪 5.6 和 5.4），Abbott 的页面把两种放在一起，抓取到的数字分不清是哪种。不能确认就只带名字。每 100 g 粉也不能拿“多少水加几勺”换算：水量不等于冲好的奶量，Enfamil 标签就写了每勺多出 6 ml。
- **NIH ODS 和 canada.ca 在这台机器上直连不了，Internet Archive 的副本能读。** ods.od.nih.gov 返回 403，canada.ca 连接时断时续。`curl https://web.archive.org/web/2025/<原地址>` 能拿到，WebFetch 不能访问 archive.org。中国营养学会 DRIs 2023 是出版物，WS/T 578 的 PDF（whcdc.org）TLS 被断开，存档里也没有。合生元官网的页面只有宣传图，图片 CDN 返回 403。
- **°F 换成摄氏度要留两位小数。** 只留一位时 99.2°F 回来变成 99.1°F，步进器的值和存下来的对不上。100.4°F 也要正好等于 38℃，否则发烧提示不会出现，`units.test.ts` 把这个边界钉住了。
- **能补记之后，记录的时间不再说明它是什么时候记的。** “最早一条很久以前”曾被当成“已经记满一天”，第一天用的家庭补一条旧疫苗就被提示喂奶偏少；几个月前的喂奶也会被学成现在的间隔。判断数据够不够时要看最近的日常记录，不能只看最早或最多。

## React Native 和 Expo

- **换行布局里，子元素全是绝对定位时，`aspectRatio` 算出的高度是 0。** 照片墙因此显示“1 项”却一片空白，也没有任何报错。给格子明确的宽和高。
- **截图存了就要打开看。** 照片墙这个 Bug 的截图一直在，是 E2E 失败后才发现的。
- **打开弹层时要收起 Toast。** Toast 显示在弹层之上，会盖住底部按钮。
- **`StyleSheet.absoluteFillObject` 在 RN 0.88 已移除。** 用 `absoluteFill` 或写明四个方向。
- **自定义 Tab 栏的类型从 `expo-router/js-tabs` 导入。** expo-router 58 自带 react-navigation，props 是 `emitter` 和 `navigateToTab`，不是 `navigation`。
- **不要在记录后直接请求系统权限。** 系统弹窗会盖住 Toast 和撤销，用户拒绝后下一次又会弹。用页面上的提示卡，由用户自己点开。
- **字体子集只有 GB2312 加一张名字用字表。** 表外的生僻字仍然回退到系统字体，和衬线标题放在一起字形不一样。要加字就改 `scripts/subset-fonts.py` 的 `NAME_CHARS` 再重新生成，并看 E2E 的 `e2e-05-rare-name` 截图。玥、喆已经在表里，这张截图现在看的是表内的字，不是回退。
- **expo-file-system 的 `copy`、`move`、`write` 是异步的，必须 await。** 同名的 `delete`、`create` 却是同步的，TypeScript 也不报错。漏写之后读到的大小是 0，所有上传都被服务端拒绝。只有在模拟器上真正跑才发现。
- **Biome 的 `noReactNativeRawText` 认不出包了 Text 的组件。** 已关闭，不要重新打开。
- **弹层不能假设键盘有没有把窗口顶起来。** `softwareKeyboardLayoutMode: 'resize'` 在 edge-to-edge 下不一定缩小窗口，假设错了要么被键盘挡住，要么抬高两次。`overlays.tsx` 用量到的层高算差额（`keyboardLift`）。还没在设备上看过，改这里要在模拟器上打开喂奶弹层点备注确认。
- **`hitSlop` 只在父视图没有裁剪时才生效，后面的兄弟视图还会抢走重叠区域。** `overflow: hidden` 的卡片里，× 的热区要向卡片内部扩。紧贴滚动区的控件（回忆页子标签）用内边距加负外边距，再给头部 `zIndex`。
- **RN 的 `lineHeight` 按网页规则把差额平分到字的上下。** 衬线标题行高 31 时，g、y 的下伸部分会超出文字框 1dp 左右（按 `CustomLineHeightSpan` 源码推算，没有在设备上看过）。加 `paddingBottom` 和相同的负 `marginBottom`，布局不变，也不会被裁掉。
- **“文件都上传好了”的 Toast 会盖掉当前的 Toast，撤销按钮也跟着没了。** 小文件一两秒就传完，所以保存时带上传的操作，不要靠 Toast 里的撤销，也不要在 Maestro 里等这种操作自己的 Toast（头像流程因此失败过）。等“文件都上传好了”或按钮的变化。
- **要让卡片不挡住下面的点击，整条路径都要处理。** 容器用 `box-none` 还不够：里面的普通 View 和 Text 仍会成为点击目标，点击不会穿透给下面的页面。不需要响应的部分要包在 `pointerEvents="none"` 里。
- **系统回收进程后，从外部链接打开 App 时链接不在初始 Intent 里。** Activity 记录还在，重建时 `getIntent()` 是最初从桌面打开的那个，链接只通过 `onNewIntent` 送来：JS 已经在跑时发一次 `url` 事件，这时 expo-router 还没监听；JS 没跑时直接丢弃。App 只是停在首页，不报错。`with-latest-intent` 插件存下新 Intent，入口文件的 `linkInbox` 接住事件，`useWidgetLink` 都处理并去重。进程活着时测不出来，要先用 `am kill` 杀掉再点。
- **弹层刚挂载时马上打开会被清掉。** 挂载时那次“收起”动画的回调可能比 `open` 晚到 JS，把刚设置的内容清成 null，界面上什么都没有也不报错。`onHidden` 要先判断现在是不是真的收起。

## Android 构建和模拟器

- **第一次 Gradle 构建要装 NDK，慢网下超过 1 小时。** 放后台跑，不要给短超时。之后的增量构建快得多，但 R8 这一步仍要几分钟。
- **Gradle 内存在 `scripts/android-build.sh` 里限制（`GRADLE_HEAP`、`GRADLE_WORKERS`）。** 本机内存紧张，不要让 Gradle 和模拟器同时高负载。
- **`adb input text` 批量注入会丢字符。** 它和输入法组字冲突，看起来像 App 的 Bug，其实不是。用 `scripts/adb-ui.py` 逐字输入。
- **键盘没开时按返回键会退出页面。** 用 `adb-ui.py hide`，它会先判断键盘状态。
- **本机不能直接下载运行 Maestro。** 权限系统会拦下外部代码。本地用 `adb-ui.py` 做探索性测试，Maestro 流程在 CI 上跑。
- **改 `build.gradle` 不能用跨块的正则。** 旧脚本在 release 排在 debug 前面时，会把正式密钥配给 debug，自己还正常退出。要先按花括号找到 release 块，只在块内替换，找不到就报错。
- **把小工具放到模拟器桌面：** 长按桌面空白处 → Widgets → 点小豆芽 → 点预览 → Add。`input swipe x y x y 2000` 能当长按，时间短了不行。
- **`am kill` 只杀得掉已经进入缓存状态的进程。** 刚跑完后台任务时它静默什么都不做，要等几秒再试并用 `pidof` 确认。不确认的话，“App 被杀”的测试其实是在进程活着时跑的。
- **不要给小工具里的文字容器 `flex: 1`。** react-native-android-widget 量出来的宽度偏大，旁边定宽的文字也会被挤出卡片。要截短就在 JS 里截（`shortBabyName`）。
- **模拟器锁不会提醒你到期。** `flock ... sleep 900` 一到时间别的会话马上拿到锁，并且 `e2e.sh` 会卸载 App，桌面上的小工具随之消失。要跨多次命令用模拟器时，把整段写成脚本交给 `flock` 跑，不要自己估时间：这个 PR 走查时就有一次命令落在锁到期之后，差点盖掉别人刚装的 APK。

## 依赖和环境

- **`minio/minio` 镜像已无法公开拉取。** 本地和 CI 的 S3 用 `chrislusf/seaweedfs`。
- **pnpm 11 有发布冷却期，拒绝发布不足 24 小时的包。** 不要关闭它，把版本固定到更早的发布。改了版本还报错就删掉 `node_modules`，旧锁文件缓存在里面。
- **pnpm 11 用 `allowBuilds` 允许构建脚本。** 不是 `onlyBuiltDependencies`。
- **慢网下 `expo install` 会超时。** 从 `node_modules/expo/bundledNativeModules.json` 取版本写进 `package.json`，再用长超时运行 `pnpm install`。
- **Git worktree 里不能软链 `node_modules`。** `@xiaodouya/shared` 解析不到，每个 worktree 要自己 `pnpm install`。
- **`pkill -f 模式` 会匹配到自己所在的 shell。** 模式出现在命令行里就会把脚本自己杀掉，后面的清理步骤不会执行。
- **`nodeLinker: hoisted` 下 `pnpm install --filter` 不起过滤作用。** 服务端镜像曾因此下载全部 React Native（640 多个包），慢网下超时。Dockerfile 要加 `--node-linker=isolated`（104 个包），之后的 `pnpm run` 还要关掉 `verify-deps-before-run`，否则它会重新安装并报 Broken lockfile。
- **Deno 不解析没有扩展名的相对导入。** 服务端和 `packages/shared` 都这样写，而 shared 还要给 Metro 用，所以 Edge Function 用 esbuild 打包（`scripts/build-edge.mjs`），不用 import map。
- **Edge 产物要用 `platform: browser`。** 这样 AWS SDK 走 fetch 和 WebCrypto，不会去读 `~/.aws/config`。postgres 写的是不带前缀的 `import net from 'net'`，要插件改成 `node:net`。打包后依赖算用户代码，旧版 Deno 不给用户代码提供 `Buffer`、`process` 全局变量，要在 banner 里补上。
- **`request.signal` 不一定会触发。** 普通 Deno 在客户端断开时会触发，但在 `edge-runtime` 镜像里经主服务转发到 Worker 时，断开后一直是 `aborted=false`，Supabase 线上是否一样还不知道。依赖它的逻辑必须另有时限。
- **Deno 在 `ssl: 'require'` 时也校验证书链。** postgres.js 传了 `rejectUnauthorized: false`，在 edge-runtime 里依然报 `invalid peer certificate`，随后表现成 `write CONNECT_TIMEOUT`，看起来像网络问题。本地连自签名的数据库要设 `SSL_CERT_FILE` 和 `DENO_TLS_CA_STORE=mozilla,system`，而且证书不能是 CA 证书。
- **本机的 DNS 会把外部域名解析成 `198.18.x.x`。** 这是代理的假 IP，属于 SSRF 检查拦截的范围。在这台机器上测“公网地址放行”会失败，不是代码的问题。
- **`/tmp` 是共享配额。** 在里面下载大文件会让所有命令报 `EDQUOT`，输出也会丢。大文件放到 worktree 的 `.artifacts/`。

## CI

- **CI 模拟器的系统桌面可能卡住，弹“isn't responding”挡住 App。** 现象是流程 01 失败、截图里 App 其实已经渲染。Pixel Launcher 和 AOSP 的 Quickstep 都发生过，换镜像解决不了。`scripts/dismiss-anr.sh` 全程在后台清掉系统组件的 ANR；卡住的是我们自己的 App 时不处理，让测试失败。验证方法：`adb root` 后 `kill -STOP` 桌面进程，再点屏幕。
- **`upload-artifact` 默认跳过隐藏目录。** 上传 `.artifacts` 要加 `include-hidden-files: true`，否则失败时什么现场都没有。
- **`setup-android` 默认安装已不存在的 `tools` 包。** 要写 `packages: platform-tools`。
- **公开仓库的定时任务 60 天没有活动会被自动停用。** 备份流程放在定时任务上要留意这一点，Actions 的 `schedule` 也可能晚点或跳过。
- **GitHub 只遮盖完整的 Secret。** 连接串里的主机名和用户名是片段，`pg_dump` 报错时会打印出来，进入公开日志。`deploy/cloud-backup.sh` 在 Actions 里用 `::add-mask::` 单独登记。
- **CI 的 E2E 直接用 `apps/server/.env.example`。** 在里面打开 `MAIL_PROVIDER` 的话，每个流程都会多出邮箱验证这一步。保持注释。
- **`pull_request` 的 `paths-ignore` 看的是整个 PR 的差异，不是这次推送。** 含代码的 PR 只推一个文档提交，也会重跑全量 CI，还会取消正在跑的那一轮。所以 CI 编号要写进 PROGRESS 时，等要再推的时候一起带上，别为它单独推一次。

## 部署

- **psql 遇到错误默认继续执行，最后还退出 0。** 把备份导入已有表的库，报了 48 个错，数据没恢复，看起来却成功了。必须加 `-v ON_ERROR_STOP=1 --single-transaction`。
- **不完整的备份可能是合法的 SQL。** 先删库再导入时，截断的备份不报错，提交后是一个空数据库。清空之前先检查结尾的 `dump complete` 标记，`deploy/restore.sh` 就是这样做的。
- **同时有 `image` 和 `build` 的服务，拉取被拒绝时 Compose 会自动改成本机构建。** 没有发布过镜像时“方式 A”其实在构建，还能成功，所以这样测不出镜像的问题。
- **在本机验证生产配置时，`ports` 会合并而不是覆盖。** 覆盖文件要写 `ports: !override [...]`，否则还是会占用 80 和 443。`COMPOSE_PROJECT_NAME` 优先于文件里的 `name:`，不改 `backup.sh` 也能指向测试环境。
- **Supabase 的 Data API 默认能读 `public` 里的表，而 anon key 是公开的。** 没有 RLS 的话，知道项目地址就能读密码哈希和存储密钥。部署时要关掉 Data API，迁移里也开了 RLS 并收回权限，两道都要。
- **Supabase 免费版的 Direct connection 只有 IPv6。** GitHub Actions 连不上。迁移和 `pg_dump` 走 Session pooler（5432），函数走 Transaction pooler（6543）。
- **Supabase Edge Function 默认就近执行，不保证跟数据库同区域。** 实际从本机代理请求新加坡项目时落在东京；加 `x-region: ap-southeast-1` 后响应头 `x-sb-edge-region` 才显示新加坡。APK 构建通过 `EXPO_PUBLIC_API_REGION` 固定区域。
- **Supabase CLI 默认用 Docker 打包函数，镜像仓库连接失败会阻止部署。** 实际从 ECR、GHCR、Docker Hub 拉取 Edge Runtime 都遇到 EOF；`supabase functions deploy api --use-api --no-verify-jwt` 在真实项目成功部署同一份已生成的 bundle。
- **事务模式连接池不能跑 `pg_dump`，也不能用命名预处理语句。** 后者报 `prepared statement "xxx" does not exist`，只在语句落到另一条服务端连接时才出现，是偶发的。
- **`pg_dump` 不能比服务器旧，导出的文件也不能恢复到比它旧的 Postgres。** 用 18 导出的备份恢复到 16 报 `unrecognized configuration parameter "transaction_timeout"`。脚本用 `BACKUP_PG_IMAGE` 指定版本，Supabase 升级大版本时要跟着改。
- **`pg_dump --schema=public` 的结果里有 `CREATE SCHEMA public`。** 恢复前只能 `DROP`，不能再 `CREATE`，否则报已存在。
- **`age` 的口令模式只能交互输入，不能从环境变量读。** 无人值守的备份用 `openssl enc -pbkdf2 -pass env:`。`openssl enc` 不支持 GCM，没有认证，损坏靠 gzip 校验和和 dump 结尾的标记发现。

## 测试方法

- **回归测试要先在修复前的代码上看它失败。** 没失败过的测试不能证明它抓得到问题。这个项目里压测没能复现游标竞态，看到失败才发现测试本身不够。
- **用 `uiautomator` 或 Maestro 点 Toast 里的按钮可能点空。** 取一次界面要好几秒，Toast 已经消失，点击会穿透到下面的内容。E2E 构建已把 Toast 放长到 8 秒。
- **“断言失败、截图里弹层还开着”不一定是时序问题。** 这里实际是 Toast 盖住了弹层底部的按钮，真实用户也会点空。第一反应是怪测试时，先用真实操作顺序复现一遍。
- **`takeScreenshot` 的文件在 Maestro 的调试目录里。** CI 产物路径是 `maestro/<流程>/takeScreenshot/.artifacts/`，失败现场在 `maestro/<流程>/screenshots/`。
- **`uiautomator dump` 在界面一直有动画时会卡住。** 输入框光标闪烁、录音计时都会让它等不到空闲，`adb-ui.py` 看起来像挂了。这时用坐标点击和 `screencap`，或者先让输入框失去焦点。
- **E2E 构建走不到系统选择器，但不用为此重新编译。** 没动原生代码时，用 `expo export:embed` 打一个不带 `EXPO_PUBLIC_E2E` 的 JS 包，`hermesc` 编译后替换 CI APK 里的 `assets/index.android.bundle`，再 `zipalign`、`apksigner` 重新签名，几分钟就能走查真实的系统界面。
- **测试整体没有输出时，先怀疑死循环。** 紧循环占满事件循环时，vitest 不会打印任何东西，只会超时。
- **测事务模式连接池要加反向对照。** 本地用 PgBouncer（`pool_mode=transaction`、`max_prepared_statements=0`）跑全部测试，再打开 `DB_PREPARE` 跑一次，要看到 `prepared statement does not exist`，才说明这个环境真的能发现问题。
- **底部标签页切走后不卸载，`useEffect` 只跑一次。** 家人页的用量因此一直是打开时的值，存储满了还写着“已用 0”。要在回到页面时刷新的数据用 `useFocusEffect`。
- **测试里有“现在几点”就可能只在某个时段失败。** 推送测试没关夜间安静，每天新加坡时间 23:00 到 07:00 必红，白天怎么跑都绿。
- **`scrollUntilVisible` 一看到目标就停。** 滚到区块标题后再断言下面的内容，长列表时内容还在屏幕外。要断言哪一行就滚到哪一行。
- **本地连续构建后先释放内存。** Gradle 和 Kotlin 守护进程留在后台占几 G，模拟器会因此反复弹 System UI 无响应。先 `./gradlew --stop` 再启动模拟器；这时强杀 systemui 只会让它循环卡住。
- **E2E 的语言和地区不要依赖默认猜测。** CI 模拟器是 en-US，建档默认会猜成美国，后面所有 `喂奶 130ml` 都会变成盎司。流程 01 要明确选新加坡，改地区的流程结束时要换回来。
- **不要等“文件都上传好了”。** 它是 Toast，文件传得快时已经被下一个 Toast 换掉了，流程 11a 因此等满 60 秒后失败。等 `upload-card` 消失：上传失败时卡片还在，一样能发现问题。
- **不要用响应时间断言“两条路径耗时一样”。** 登录时邮箱是否存在的测试量过时间，机器繁忙时两边都算了 scrypt 也差了将近一倍，偶发失败。改成数 scrypt 的调用次数和参数（`login-scrypt.test.ts`）。
- **同时发两个请求不等于真的并发。** 删除账号的测试用 `Promise.all`，去掉家庭行锁照样通过：scrypt 耗时不同，两个事务根本没有重叠。要用另一个连接拿住锁，查 `pg_stat_activity` 确认两边都卡住了再放开（`deletion.test.ts`）。拿锁的连接池至少 2 个连接，否则查询等不到连接，整个测试超时。
- **`am kill` 杀不掉系统选择器下面的 App。** 选择器是半透明弹层，App 还是可见状态（`vis+1 TOP`），命令没有效果也不报错，“不保留活动”同样碰不到它。要先按 Home 让 App 进入后台（`cch`），或者 `adb root` 后 `kill -9`。每次都要对比前后的 pid，否则会把没生效的测试当成通过。
- **API 35 上 `legacy: true` 走不到全屏选择器。** `ACTION_GET_CONTENT` 被系统接管，打开的还是同一个 PhotoPicker，上限也还是 100。Android 12 及以下的 DocumentsUI 回退在这台模拟器上测不了。
- **长时间等待之后，`extendedWaitUntil notVisible` 可能不等够超时就失败。** 流程 03a 等完上传再等 Toast 消失，超时写的 15 秒，1.4 秒就报错；同一条命令紧跟在点击后面时能正常等。这时距上次交互已经约 28 秒，原因没有查证。先看失败现场的 App 是否正常，再看这一步是否真的需要。
- **单元测试绿了，原生行为不一定对。** 找回选择结果的重试逻辑测试全绿，模拟器上一跑就发现原生层根本不给结果。涉及系统界面和进程生死的修复，要看到模拟器上真的生效。
- **响应之后才写库的内容，测试里要先 `bg.flush()` 再做下一步。** “重发次数有上限”曾偶发失败（期望 429，实际 200）：验证码在响应后才写，写入如果落在下一轮的 `skipCooldown` 和请求之间，这次请求就在冷却期里，不计数也返回 200。平时失败率低，多跑几次未必看得到；要在写入前等 30ms、`skipCooldown` 后等 100ms 才能稳定复现。

## 并行开发

- **`.claude/worktrees/` 必须被忽略。** 否则 `git add -A` 会把子 Agent 的 worktree 当成嵌入仓库提交，Biome 也会因为嵌套配置报错。
- **服务端集成测试每次运行用独立的数据库。** 以前用 `TRUNCATE`，两个 Agent 同时跑会互相删数据。不要改回去。
- **模拟器只有一台。** `scripts/e2e.sh` 用文件锁排队，手动用 `adb-ui.py` 前先确认没有 E2E 在跑。
- **8787 端口已有服务时，`e2e.sh` 会直接复用它。** 那可能是别的分支的代码，脚本会打印警告。改了服务端就先停掉旧服务。
- **Biome 不要格式化 Markdown。** 它会重新对齐表格列宽，改一行就动到整张表，并行开发时 `PROGRESS.md` 必然冲突。已在 `biome.json` 里排除。
- **`/tmp` 是按用户限额的内存盘，几个会话共用。** 写满后连命令输出都会丢。大文件（测试图片、APK）放 worktree 的 `.artifacts`。
- **`flock` 排队不等于拿到锁。** 后台挂着 `flock ... sleep` 时要确认它下面已经有 `sleep` 子进程，别的会话可能抢在前面。长任务要算好时间，不要跑到锁到期之后；收尾的命令直接用 `flock` 包住。
