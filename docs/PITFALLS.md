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
- **同一个事务里插入的行 `created_at` 都一样。** `now()` 是事务开始的时间，所以 `ORDER BY created_at, id` 对一次提交的几个反馈附件来说就是按随机 uuid 排，不是手机上的顺序（issue 里的“图片 1、图片 2”和用户加的顺序可能不同）。测试里要按内容找，不能按下标比；要保住顺序得另存序号。
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
- **放进 `event` 集合的配置，推送那边要明确排除。** 没有 `at` 时 `now - undefined` 是 NaN，刚好过不了“一小时内”的判断，看起来没问题；只要配置带上 `at`，家人就会收到正文是 `undefined` 的推送。要用 `isVaccinePlanData` 判断，不能靠缺字段碰巧过滤。打开 App 时的家人汇总（`summarizeRemote`）同样要过滤，它不限时间，配置会被提示成“记录了 undefined”。新代码读 `event` 集合时都要想到里面不全是记录。
- **`stop()` 不会取消已经发出的同步请求。** 退出登录清空本地之后响应才到的话，记录会被写回 SQLite，还会标记“同步过”，下一个登录的人就看到了上一个人的数据。按会话编号丢弃旧响应。上传队列同理，失败的任务不能再存回去。
- **`store.write` 必须校验。** `rebuild` 会跳过校验不过的记录，不校验的话它存得下、看不见、服务端也不收。改已有记录时更糟：原来的内容也跟着消失。一条回忆 105 张照片就走到过这里：弹层正常关闭，时间线是空的，文件还在后台上传。
- **不要把翻译后的文字写进记录。** 不填标题的信以前存成“无题”，英文下就会存成 “Untitled”，中文的家人看到的是英文。显示时才补的默认值就存空字符串（v0.1.0 也按空标题显示“无题”）。内置疫苗写 `recordName`（中文原名），显示时按 id 换语言，否则换一种语言记的剂次对不上名字。
- **按时间倒序翻页，游标不能是 JS 的 `Date`。** Postgres 的时间戳到微秒，`Date` 只到毫秒，同一毫秒里的几条会被漏掉或重复。「收到的反馈」的游标是 `floor(extract(epoch …) * 1000000)` 的微秒数加 id，`feedback-viewer.test.ts` 把三条改成同一个时间点来测。

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
- **S3 签名链接的路径就是 object key。** 我们的 key 带家庭 id，所以公开页面的文件链接里一定有家庭 id 和存储地址，这和“响应不含家庭 id”冲突。测试只能查链接以外的字段，并如实写进文档和隐私政策。要去掉得改对象路径或代理文件。
- **公开页面不能用存储配置的 `publicBaseUrl`。** App 的 `/media/urls` 对回忆走这个公开地址，它不会过期，撤销链接后还能一直打开。分享页一律签名。
- **`hasThumb: true` 不代表缩略图已经有了。** 缩略图是后来生成的，也可能做不出来。取缩略图的地方都要能退回原图，成长册以前就是直接跳过，照片会从册子里消失。
- **R2 的预签名文档只列了 GET、HEAD、PUT、DELETE，没提 UploadPart。** S3 兼容表把 UploadPart 列为支持，两页合起来没有说预签名的 UploadPart 一定能用。所以真实存储要跑 `cli check-multipart`，不通过就 `S3_MULTIPART_ENABLED=false`，App 退回单个 PUT。
- **完成分片之前要核对每片的大小，不能只看片数。** `S3_BIND_UPLOAD_SIZE=false` 时一片可以传任意大小，HEAD 只看合并后的总大小，错的片加上错的片可能正好相等。大小不对的片算没传，重传同一个片号会覆盖。
- **expo-file-system 上传的超时写死 60 秒，进度数的是写进 socket 的字节。** 模拟器的网络栈能缓存好几 MB，进度先冲到 8 MB，然后 OkHttp 等响应，慢网下 60 秒内发不完就超时重传。不能配置。这也是分片不能太大的原因之一。真实手机的缓存通常小得多，没有在真机上量过。
- **模拟器的 `network speed` 对到宿主机 S3 的流量不起作用。** 想慢下来要在宿主机上放一个限速的 TCP 转发，`S3_PUBLIC_ENDPOINT` 指向它（SigV4 看 Host 头，转发不改它）。
- **会一起看的几个状态不要隔着 await 改。** 任务从队列拿掉和“传完数加一”中间隔着写 SQLite，每秒一次的刷新正好落在中间时，界面看到任务没了、传完数是 0，就当成全取消了，不说“文件都上传好了”。CI 上慢才碰到，流程 14a 等满 60 秒失败。
- **取消上传时的响应可能晚于取消。** `finish` 和 catch 都要先确认任务还在队列里，否则取消后完成的响应会通知“传好了”，失败的响应会把任务写回数据库，重试时复活。
- **系统选择器给的照片可能还带着 GPS。** 模拟器（API 35）上用真实的系统照片选择器，App 没有 `ACCESS_MEDIA_LOCATION`，传上去的原图 EXIF 和 GPS 都还在。不能指望系统抹掉，发给外人的只能是重新编码过的文件。真机没有验证。
- **Android 重新编码的 JPEG 里也有 APP 段，但不是元数据。** Skia 会写一段 `ICC_PROFILE`（APP2）。查“有没有元数据”时要放过它，否则所有预览都被判成带元数据。
- **待删除队列对没传完的对象会多记一条延后的删除。** 预签名链接还有效，手机的上传可能晚到，所以 `pending` 的对象一小时后再删一次。任何会**复用同一个 object key** 的路径（反馈草稿被清掉后手机用同一个 id 重发）都要先撤掉队列里这个 key，否则新传上去的文件会被那条延后的删除删掉（`feedback.test.ts` 有用例，去掉撤销那一行就失败）。

## 健康内容

- **睡眠中的提示不能盖住“偏少”的提醒。** 先判断风险，再显示其他内容。忘记结束的睡眠也不能当真。
- **网页上的医学来源经常读不到。** NICE 和 MOH PDF 在这个环境下返回 403 或连接失败。读不到原文就在注释和 PROGRESS 里写明“二手来源，需复核”，不要写成已核实。
- **中美的官方表有能读到的地址。** ndcpa.gov.cn、news.cn、moh.gov.sg 在这台机器上 TLS 被断开，cdc.gov 返回 403。但 chinacdc.cn 有国家免疫程序的 PDF，`aap.org/immunizationschedule` 跳转到可下载的 PDF，新华社的报道能从 web.archive.org 读。搜索摘要互相矛盾，不能当依据。
- **PDF 的免疫表要转成图片看。** `pdftotext` 排出来的列是错位的，AAP 表里跨几列的色块（比如乙肝第 3 剂的 6–18 个月）在文字里看不出范围。
- **奶粉标签要看清是哪种形态。** 同一个牌子粉和即饮液的数值不一样（Similac 360 的脂肪 5.6 和 5.4），Abbott 的页面把两种放在一起，抓取到的数字分不清是哪种。不能确认就只带名字。每 100 g 粉也不能拿“多少水加几勺”换算：水量不等于冲好的奶量，Enfamil 标签就写了每勺多出 6 ml。
- **NIH ODS 和 canada.ca 在这台机器上直连不了，Internet Archive 的副本能读。** ods.od.nih.gov 返回 403，canada.ca 连接时断时续。`curl https://web.archive.org/web/2025/<原地址>` 能拿到，WebFetch 不能访问 archive.org。中国营养学会 DRIs 2023 是出版物，WS/T 578 的 PDF（whcdc.org）TLS 被断开，存档里也没有。合生元官网的页面只有宣传图，图片 CDN 返回 403。
- **奶粉注册号的汇总站不是总局。** 搜索（尤其是 AI 搜索）会给出 nznewmilk.com.cn 这类站点，页面有完整的每 100 g 数值，标注“整理自总局公开信息”，但自己写明不是总局网站，也没有原图。总局的特殊食品信息查询平台（tsspxx.gsxt.gov.cn）在这台机器上返回 502 或连不上，核对不了。派星 1 段的数值是仓库所有者指定采用这个站后才加的（F-123），别的品牌不能照此默认可用。还要看清产品名：同一个牌子有“派星”“派星天护”“派星爱斯时光”几条线，注册号对的是哪一条、是不是“新版”（京东上的派星 1 段新版写着 6 重 HMO，汇总站给 YP20235061 列的成分里没有 HMO）都要对上。
- **°F 换成摄氏度要留两位小数。** 只留一位时 99.2°F 回来变成 99.1°F，步进器的值和存下来的对不上。100.4°F 也要正好等于 38℃，否则发烧提示不会出现，`units.test.ts` 把这个边界钉住了。
- **能补记之后，记录的时间不再说明它是什么时候记的。** “最早一条很久以前”曾被当成“已经记满一天”，第一天用的家庭补一条旧疫苗就被提示喂奶偏少；几个月前的喂奶也会被学成现在的间隔。判断数据够不够时要看最近的日常记录，不能只看最早或最多。
- **chinacdc.cn 的 PDF 不是一直能读。** 2026-11-02 再读返回 445，上次（F-90）能读。读不到就不重试、不绕过，只用文件里已有的缩写和通用名，写明待复核。AAP 的 PDF 这次能读，`pdftotext -layout` 能看到 Table 1 的术语。
- **翻译健康文案时用同一组输入比较两种语言的数字。** 把 “3 个月以下” 译错成 “under 6 months” 不会报错，`i18n-content.test.ts` 抽出句子里的数字比较才能发现。
- **chinacdc.cn 的 PDF 用 curl 返回 445 时，WebFetch 还能拿到。** WebFetch 读不出 PDF 正文，但会把原文件存进 tool-results，`pdftotext -layout` 就能看（2026-11-04 读了 2026 年版免疫程序和 2026—2027 流感指南）。已经失效的旧链接（2016 年的 EV71 指南返回 404）用 `curl https://web.archive.org/web/2020/<原地址>` 能读到。疫苗说明书没有找到能读的官方来源，宣传单之类的资料要写明待复核。

## React Native 和 Expo

- **换行布局里，子元素全是绝对定位时，`aspectRatio` 算出的高度是 0。** 照片墙因此显示“1 项”却一片空白，也没有任何报错。给格子明确的宽和高。
- **截图存了就要打开看。** 照片墙这个 Bug 的截图一直在，是 E2E 失败后才发现的。
- **打开弹层时要收起 Toast。** Toast 显示在弹层之上，会盖住底部按钮。
- **`StyleSheet.absoluteFillObject` 在 RN 0.88 已移除。** 用 `absoluteFill` 或写明四个方向。
- **自定义 Tab 栏的类型从 `expo-router/js-tabs` 导入。** expo-router 58 自带 react-navigation，props 是 `emitter` 和 `navigateToTab`，不是 `navigation`。
- **不要在记录后直接请求系统权限。** 系统弹窗会盖住 Toast 和撤销，用户拒绝后下一次又会弹。用页面上的提示卡，由用户自己点开。
- **字体子集只有 GB2312 加一张名字用字表。** 表外的生僻字仍然回退到系统字体，和衬线标题放在一起字形不一样。要加字就改 `scripts/subset-fonts.py` 的 `NAME_CHARS` 再重新生成，并看 E2E 的 `e2e-05-rare-name` 截图。玥、喆已经在表里，这张截图现在看的是表内的字，不是回退。
- **expo-file-system 的 `copy`、`move`、`write` 是异步的，必须 await。** 同名的 `delete`、`create` 却是同步的，TypeScript 也不报错。漏写之后读到的大小是 0，所有上传都被服务端拒绝。只有在模拟器上真正跑才发现。
- **RN 的定时器在 App 暂停后不走，而 fetch 要靠它。** `JavaTimerManager` 在 `onHostPause` 后停掉，只有 Headless JS 任务在跑时例外；whatwg-fetch 收到响应后 `setTimeout(0)` 才 resolve，所以后台的 fetch 请求发得出去、响应也到了，Promise 却一直不结束，没有任何报错。后台要继续跑 JS 就要挂一个 Headless 任务。
- **Activity 销毁时 React 界面会卸载，JS 和进程还在。** `ReactDelegate.onHostDestroy` 调 `unloadApp`，所有 effect 的清理都会跑，再打开时重新挂载。放在 `useEffect` 或 `useState` 里的单例（队列、监听）会变成两份。要活得比界面长的放模块级。
- **`startForegroundService` 之后没进前台就 `stopService` 会崩。** 系统报 `did not then call startForeground`，小文件传得快就可能碰上。要等 `onStartCommand` 进了前台再停。
- **expo-image 默认按屏幕大小解码，放大看不到更多细节。** 不关掉 `allowDownscaling` 的话，“查看原图”点了也和预览一样糊。关掉要限制像素：Android 画超过 100 MB 的位图直接闪退（`Canvas: trying to draw too large bitmap`，这是读文档的结论，没有实际触发），2400 万像素是 96 MB。
- **Biome 的 `noReactNativeRawText` 认不出包了 Text 的组件。** 已关闭，不要重新打开。
- **弹层不能假设键盘有没有把窗口顶起来。** `softwareKeyboardLayoutMode: 'resize'` 在 edge-to-edge 下不一定缩小窗口，假设错了要么被键盘挡住，要么抬高两次。`overlays.tsx` 用量到的层高算差额（`keyboardLift`）。还没在设备上看过，改这里要在模拟器上打开喂奶弹层点备注确认。
- **`hitSlop` 只在父视图没有裁剪时才生效，后面的兄弟视图还会抢走重叠区域。** `overflow: hidden` 的卡片里，× 的热区要向卡片内部扩。紧贴滚动区的控件（回忆页子标签）用内边距加负外边距，再给头部 `zIndex`。
- **RN 的 `lineHeight` 按网页规则把差额平分到字的上下。** 衬线标题行高 31 时，g、y 的下伸部分会超出文字框 1dp 左右（按 `CustomLineHeightSpan` 源码推算，没有在设备上看过）。加 `paddingBottom` 和相同的负 `marginBottom`，布局不变，也不会被裁掉。
- **“文件都上传好了”的 Toast 会盖掉当前的 Toast，撤销按钮也跟着没了。** 小文件一两秒就传完，所以保存时带上传的操作，不要靠 Toast 里的撤销，也不要在 Maestro 里等这种操作自己的 Toast（头像流程因此失败过）。等“文件都上传好了”或按钮的变化。
- **要让卡片不挡住下面的点击，整条路径都要处理。** 容器用 `box-none` 还不够：里面的普通 View 和 Text 仍会成为点击目标，点击不会穿透给下面的页面。不需要响应的部分要包在 `pointerEvents="none"` 里。
- **系统回收进程后，从外部链接打开 App 时链接不在初始 Intent 里。** Activity 记录还在，重建时 `getIntent()` 是最初从桌面打开的那个，链接只通过 `onNewIntent` 送来：JS 已经在跑时发一次 `url` 事件，这时 expo-router 还没监听；JS 没跑时直接丢弃。App 只是停在首页，不报错。`with-latest-intent` 插件存下新 Intent，入口文件的 `linkInbox` 接住事件，`useWidgetLink` 都处理并去重。进程活着时测不出来，要先用 `am kill` 杀掉再点。
- **弹层刚挂载时马上打开会被清掉。** 挂载时那次“收起”动画的回调可能比 `open` 晚到 JS，把刚设置的内容清成 null，界面上什么都没有也不报错。`onHidden` 要先判断现在是不是真的收起。
- **语言定好之前求值的文字不会再变。** 模块顶层的常量（标签列表、选项表）在启动时算一次，用 `t()` 的话永远是默认语言。改成函数或属性（`get label()`），`check-i18n` 拦顶层调用。地区数据用 `localized()`，读的时候才取当前语言。
- **换语言时直接重新挂载界面。** 文字散在 `useMemo` 和被 memo 的组件里，靠 context 刷新总有漏的。`AppProvider` 里 `<Fragment key={locale}>` 最简单，导航状态在容器里不丢，打开的弹层会关掉。
- **`name` 不能换成英文。** iOS 的工程目录（`ios/app.xcworkspace`）是从它算的，非 ASCII 的名字才得到 `app`，改了会弄坏 `scripts/ios-build.sh`。Android 的默认 `app_name` 用 `withStringsXml` 覆盖，中文放 `locales`。
- **`locales` 只写带限定符的资源目录，默认的 `values/strings.xml` 不归它管。** 手机是法语时用默认资源，所以默认资源要写英文。小工具的 `label` 直接进清单，要写成 `@string/...` 才能本地化。
- **跟着文字收缩的 Text 可能把最后一个单词折到看不见的第二行。** 空状态的标题 “The first moment starts today” 在屏幕上只剩 “The first moment starts”，`uiautomator` 读到的文字是完整的，只有看截图才发现。量出来的宽度比实际画的窄一点时，高度还是一行。中文没遇到过。居中的文字用 `alignSelf: 'stretch'`。
- **`ListCard` 的 `Row` 放不下长的等宽值。** 反馈 ID（uuid）放在 `Row` 的右边，中文还放得下，英文标签 `Feedback ID` 更长，值折成两行、第二行被卡片裁掉一半（模拟器截图上才看出来）。长的、要复制的值单独一行放在卡片下面。

## Android 构建和模拟器

- **构建还没打完 JS 包时不要改源码，也不要切分支。** `android-build.sh` 打的是 worktree 里当时的文件，JS 包在 `createBundleReleaseJsAndAssets` 这一步（Gradle 开始后十几分钟）才读。2026-11-04 以为等到 `Done writing bundle output` 再还原文件就行，结果“改动前”的 APK 里已经有一半新代码，对照数据作废。也不要靠 grep JS 包里的函数名或中文判断代码在不在：Metro 压缩后名字换掉了、中文转成了 `\uXXXX`，grep 不到不说明没有。要改动前的对照包，没动原生代码时用 `expo export:embed` 在 `main` 的文件上打 JS 包，`hermesc` 编译后换进已有 APK 的 `assets/index.android.bundle`，`zipalign`、用 `apps/mobile/android/app/debug.keystore` 签名（和 Gradle 签的是同一个证书，`install -r` 不用卸载，桌面上的小工具也还在），几分钟一个包。
- **第一次 Gradle 构建要装 NDK，慢网下超过 1 小时。** 放后台跑，不要给短超时。之后的增量构建快得多，但 R8 这一步仍要几分钟。
- **Gradle 内存在 `scripts/android-build.sh` 里限制（`GRADLE_HEAP`、`GRADLE_WORKERS`）。** 本机内存紧张，不要让 Gradle 和模拟器同时高负载。
- **`adb input text` 批量注入会丢字符。** 它和输入法组字冲突，看起来像 App 的 Bug，其实不是。用 `scripts/adb-ui.py` 逐字输入。
- **键盘没开时按返回键会退出页面。** 用 `adb-ui.py hide`，它会先判断键盘状态。
- **本机不能直接下载运行 Maestro。** 权限系统会拦下外部代码。本地用 `adb-ui.py` 做探索性测试，Maestro 流程在 CI 上跑。
- **改 `build.gradle` 不能用跨块的正则。** 旧脚本在 release 排在 debug 前面时，会把正式密钥配给 debug，自己还正常退出。要先按花括号找到 release 块，只在块内替换，找不到就报错。
- **`uiautomator` 报 `null root node`，`adb-ui.py` 说“读不到界面结构”时，先看屏幕是不是灭了。** 截图一片黑，`dumpsys window` 的 `mCurrentFocus=null`。模拟器睡着了（`mWakefulness=Asleep`），不是 App 的问题。先 `adb shell input keyevent KEYCODE_WAKEUP`。
- **把小工具放到模拟器桌面：** 长按桌面空白处 → Widgets → 点小豆芽 → 点预览 → Add。`input swipe x y x y 2000` 能当长按，时间短了不行。
- **`am kill` 只杀得掉已经进入缓存状态的进程。** 刚跑完后台任务时它静默什么都不做，要等几秒再试并用 `pidof` 确认。不确认的话，“App 被杀”的测试其实是在进程活着时跑的。
- **HyperOS 的小部件列表里“找不到”小豆芽，其实在最下面。** 2026-11-03 在 Redmi K70 Ultra（HyperOS 3.0，Android 16）上查到：长按桌面 → 添加小部件，先显示的是“支持小部件应用”，只有按小米规范适配过的应用，搜索也只搜这些；普通 Android 小工具在列表最底下的“安卓小部件”里，按应用分组，小豆芽排在最后。排查时先 `adb shell dumpsys appwidget | grep <包名>` 看系统有没有登记，登记了就是桌面的问题，不要先怀疑配置。`widgetCategory` 带 `not_keyguard` 编译成 `9`（全手机只有我们一家不是 1、3、5、7），这台手机上照样能列出来。App 里“桌面小工具”页用 `requestPinWidget` 直接弹出添加窗口，绕开这个列表。
- **几个小工具的点击是同时跑的后台任务，不排队会画出新旧混在一起的画面。** 2026-11-03 在模拟器上 0.7 秒内连点喂奶、尿尿、醒了：睡眠小工具显示了“已记好 · 醒了”，却还是睡着时的夜蓝卡片和入睡时间，5 秒后才对。原因是一个任务读完数据还没画完，另一个任务已经写入并设好了“刚记好”。写入、读数据、重画现在都进 `widgets/queue.ts` 的同一个队列。
- **小工具点一下到画面变化，大部分时间花在系统拉起后台任务上，JS 帮不上。** 2026-11-04 模拟器（负载高）上 logcat 的时间线：点击入队后约 0.1 秒开始后台任务，再过约 0.5 秒 JS 才画出第一张；进程被杀时还要加上启动进程。负载低时，改之前松手后 0.7–1.1 秒出现“已记好”；JS 里先画“记录中…”是 0.6–0.8 秒，只早了约 0.3 秒。进程刚启动时没有缓存的数据，连“记录中…”也画不出来。按下时系统自带的变暗只在手指按着时有。要做到按下立刻有变化只能改原生（库里 `RNWidgetProvider.onReceive`）。
- **`react-native-android-widget` 每画一次就删掉上一张图片，桌面还在读的话小工具会整块变空白。** 桌面是异步套用更新的，负载高时要近 1 秒，logcat 里是桌面进程的 `ImageView: Unable to open content: content://….rnwidget.imageprovider/widget_41_….png` 和 `FileNotFoundException`，空白要等下一次重画才恢复。连着画两次（“记录中…”再“已记好”）时更容易碰上。`patches/react-native-android-widget.patch` 改成先写新图、再删掉除上一张以外的旧图。升级这个库时要检查补丁还用不用得上。
- **桌面上已经在主屏时按 Home 会翻回第一页。** 小工具放在第二页时，脚本里每次先按 Home 再点坐标，点的是第一页的空白处，录屏和计时全是空的。按 Home 之后要截图确认，或者不按。
- **`react-native-android-widget` 的配置插件不能设 `minResizeWidth`/`minResizeHeight`。** 小工具最小只能缩到 `minWidth`/`minHeight`（现在是 110dp），做不出 2×1 的窄版。要做得自己写配置插件改生成的 XML。
- **`apps/mobile/src/theme.ts` 引了 reanimated，vitest 里加载不了。** 小工具的颜色放在不依赖 React Native 的 `widgets/palette.ts`，节奏条的 SVG 也是纯函数（`widgets/dayline.ts`），这样能直接写单元测试。
- **不要给小工具里的文字容器 `flex: 1`。** react-native-android-widget 量出来的宽度偏大，旁边定宽的文字也会被挤出卡片。要截短就在 JS 里截（`shortBabyName`）。
- **`ImageWidget` 先把图拉伸到 `imageWidth`×`imageHeight` 再套 `resizeMode`。** 0.26.0 的原生代码是 `Bitmap.createScaledBitmap(bitmap, w, h, true)`，`cover` 救不回来，不是正方形的头像会被压扁；而且是整张解码，不会按尺寸采样。小工具的头像在存缓存时就裁成 128 px 的正方形（`widgets/avatarFile.ts` 的 `squareCrop`）。图片来源的类型只收 `require`、`http(s):`、`data:image`，原生其实也认 `file://`，这里用类型保证的 `data:` URI；`http` 不能用，签名链接会过期，后台任务也可能没网。
- **模拟器锁不会提醒你到期。** `flock ... sleep 900` 一到时间别的会话马上拿到锁，并且 `e2e.sh` 会卸载 App，桌面上的小工具随之消失。要跨多次命令用模拟器时，把整段写成脚本交给 `flock` 跑，不要自己估时间：这个 PR 走查时就有一次命令落在锁到期之后，差点盖掉别人刚装的 APK。
- **改写 JSX 文字时不要用 `node.getText()`。** TypeScript 的 `getText` 跳过前导空白，`{n} 项` 后面那段就变成 `项`，迁移后是 `共 100项`，单元测试不管这个，流程 03a 才发现。要用 `src.slice(node.pos, node.end)`，改完和原文比一遍。
- **`expo-intent-launcher` 的 `startActivityAsync` 要等打开的界面关掉才返回。** 系统安装界面开着时再调一次会抛 `ActivityAlreadyStartedException`，当成“打不开”就会在安装界面还在屏幕上时报错。应用内更新用一个标记挡住重复点击（`UpdateController.install`）。
- **更新已装的 App 时，系统确认按钮写的是“更新”（Update），不是“安装”。** 第一次写的提示是“再点一次安装”，在 API 35 上对不上。文案写成“更新或安装”。
- **`adb emu network speed` 限不住模拟器走 Wi-Fi 的下载。** 设成 `edge` 后 44 MB 还是几秒下完，看不到进度，也来不及点取消。要慢下来就在宿主机开一个限速的 TCP 转发，让服务端的 `S3_PUBLIC_ENDPOINT` 指向它：SigV4 签的是 Host，转发不改 Host 就能过签名。
- **界面一直在刷新时 `uiautomator dump` 会卡住。** 下载进度每次回调都重画，`scripts/adb-ui.py` 的 `ids`、`tap=` 等不到空闲就超时。这时用截图加坐标点。
- **在仓库外的目录里调 `apksigner` 会报 `mise ERROR No version is set for shim: java`。** mise 的 shim 按当前目录找 `.mise.toml`，scratchpad 里找不到。用 `env PATH=$(mise where java)/bin:/usr/bin:/bin apksigner …`，或者先回到仓库目录。

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
- **browser 映射下 AWS SDK 用 DOMParser 解析 XML，Deno 没有。** PUT、HEAD、GET 不解析响应体，所以一直没事；CreateMultipartUpload、ListParts 一调用就抛错，表现成“存储暂时没有响应”。`build-edge.mjs` 把 `xml-parser.browser` 换回纯 JS 的版本，并拦截产物里的 `new DOMParser`。Node 上的测试发现不了，要跑 `pnpm test:edge`。
- **`request.signal` 不一定会触发。** 普通 Deno 在客户端断开时会触发，但在 `edge-runtime` 镜像里经主服务转发到 Worker 时，断开后一直是 `aborted=false`，Supabase 线上是否一样还不知道。依赖它的逻辑必须另有时限。
- **Deno 在 `ssl: 'require'` 时也校验证书链。** postgres.js 传了 `rejectUnauthorized: false`，在 edge-runtime 里依然报 `invalid peer certificate`，随后表现成 `write CONNECT_TIMEOUT`，看起来像网络问题。本地连自签名的数据库要设 `SSL_CERT_FILE` 和 `DENO_TLS_CA_STORE=mozilla,system`，而且证书不能是 CA 证书。
- **本机的 DNS 会把外部域名解析成 `198.18.x.x`。** 这是代理的假 IP，属于 SSRF 检查拦截的范围。在这台机器上测“公网地址放行”会失败，不是代码的问题。
- **工作区新增一个包，服务端镜像的 `--frozen-lockfile` 就要多拷一个 `package.json`。** 锁文件校验要所有工作区的包，`deploy/server.Dockerfile` 里少一行镜像就构建不了，本地测试发现不了。
- **`import { z } from 'zod'` 会把所有语言的报错文字打进包里。** 分享页因此多了 250 KB。用 esbuild 插件把 `locales/index.js` 换成空模块。
- **zod 在定义 schema 时就试探 `new Function`，严格 CSP 下控制台会报错。** `z.config({ jitless: true })` 要放在单独的文件里，排在所有 import 最前面，放在入口文件的正文里已经晚了。
- **Chromium 的 `TMPDIR` 路径不能太长。** 放到 worktree 的 `.artifacts/tmp` 后报 `Socket path too long` 直接崩，换一个短路径。
- **`/tmp` 是共享配额。** 在里面下载大文件会让所有命令报 `EDQUOT`，输出也会丢。大文件放到 worktree 的 `.artifacts/`。
- **配额被别的项目占满时，命令其实跑了，只是拿不到输出。** Agent 的工具把输出写在 `/tmp` 下，所以这时每条命令都报 `EDQUOT`、看不到结果。把输出重定向到 `.artifacts/` 里的文件再读，`TMPDIR` 也指向那里。不要去删别人的目录。
- **`/tmp` 满了时，Gradle 的日志也写不进去，构建会半路停住。** 2026-11-04 构建日志停在第 32 行，看起来像卡死。本地构建用 `JAVA_TOOL_OPTIONS=-Djava.io.tmpdir=<worktree>/.artifacts/tmp`，日志写进 `.artifacts/`。不要为了这个全局改 `TMPDIR`：`e2e.sh` 的模拟器锁在 `${TMPDIR:-/tmp}` 下，换了目录就和别的 Agent 不是同一把锁。

## CI

- **`wrangler deploy --domain` 会默认关闭 `workers.dev`，即使部署前它能访问。** 这次首次绑定 `xdy.nfvd.net` 后，Wrangler 输出旧地址已禁用；在 `wrangler.toml` 明确设置 `workers_dev = true` 并重新部署，两个域名都恢复为 Worker 触发器。旧 APK 的链接仍指向 `workers.dev`，不能只看新域名是否能打开。
- **Wrangler 的本机 OAuth 能发布 Worker，不代表能创建 CI 用的长期令牌。** 这次本机凭 OAuth 成功发布 `xiaodouya-share`，但管理 Cloudflare API Token 的调用返回 403；需要在控制台创建限定到当前账号的 `Edit Cloudflare Workers` 令牌，并存入 GitHub Actions Secret。账号级令牌对 `/user/tokens/verify` 返回 401，不能用这个端点判断令牌失效；用目标账号的 Workers API 或带令牌的 `wrangler deployments list` 验证，再跑一次真实 CI 发布。
- **CI 模拟器的系统桌面可能卡住，弹“isn't responding”挡住 App。** 现象是流程 01 失败、截图里 App 其实已经渲染。Pixel Launcher 和 AOSP 的 Quickstep 都发生过，换镜像解决不了。`scripts/dismiss-anr.sh` 全程在后台清掉系统组件的 ANR；卡住的是我们自己的 App 时不处理，让测试失败。验证方法：`adb root` 后 `kill -STOP` 桌面进程，再点屏幕。
- **`upload-artifact` 默认跳过隐藏目录。** 上传 `.artifacts` 要加 `include-hidden-files: true`，否则失败时什么现场都没有。
- **`setup-android` 默认安装已不存在的 `tools` 包。** 要写 `packages: platform-tools`。
- **公开仓库的定时任务 60 天没有活动会被自动停用。** 备份流程放在定时任务上要留意这一点，Actions 的 `schedule` 也可能晚点或跳过。
- **GitHub 只遮盖完整的 Secret。** 连接串里的主机名和用户名是片段，`pg_dump` 报错时会打印出来，进入公开日志。`deploy/cloud-backup.sh` 在 Actions 里用 `::add-mask::` 单独登记。
- **CI 的 E2E 直接用 `apps/server/.env.example`。** 在里面打开 `MAIL_PROVIDER` 的话，每个流程都会多出邮箱验证这一步。保持注释。
- **`pull_request` 的 `paths-ignore` 看的是整个 PR 的差异，不是这次推送。** 含代码的 PR 只推一个文档提交，也会重跑全量 CI，还会取消正在跑的那一轮。所以 CI 编号要写进 PROGRESS 时，等要再推的时候一起带上，别为它单独推一次。
- **APK 的缓存键不能写 `restore-keys`，环境变量也不能手抄。** 相近的键就是旧代码，测到旧代码还显示全绿，比慢更糟。`apk-key.mjs` 执行一遍 `e2e-build-env.sh` 取实际生效的值，`apk-key.test.mjs` 扫描 App 读的 `process.env`，不在键里就失败。
- **Actions 缓存按分支隔离。** 键完全相同，别的 PR 也读不到：#34 存的 APK，#37 用同一个键查不到，又构建了一次（run 41468801018）。所以 PR 要复用别处的 APK，只能等 `main` 存过（读 `main` 的缓存这一条来自 GitHub 的文档，这个 PR 合并前没有实测过）。同一个 PR 第二次起能命中。
- **Actions 缓存总量到 10 GB 后最早用过的先被清掉。** 2026-11-02 已经有 10.5 GB，其中 Gradle 约 7 GB。被清只是多构建一次，不会测到旧代码。已关闭 PR 的缓存再也读不到，可以手动 `gh cache delete`。
- **整个 APK 每次构建都不一样，比较要看里面的内容。** 同一个键的两次构建（run 41460782478 和 41468801018）APK 的哈希不同，`assets/index.android.bundle` 和 `assets/app.config` 完全相同，所以 `compare-apk.sh` 比这两个文件。
- **汇总 job 要 `if: always()`，并且区分“跳过是对的”和“前面失败导致跳过”。** `CI 结果` 按 `changes` 的判断核对：要跑却是 `skipped` 算失败，否则 APK 没构建出来时 E2E 被跳过，结果还是绿的。
- **CI 模拟器偶尔和 adb 断开几秒，是模拟器那一侧关的连接。** adb server 记 `emulator-5554: connection terminated: read failed`，设备上 adbd 记 `write failed`，几秒后自己连回来。105 个 job 日志里 adb server 一次都没重启，logcat 里没有 OOM 和 App 崩溃，CPU steal 是 0，唯一记到现场的那次整机 CPU 只用了四成。分组以来约每 10 个分组 job 一次。排除过的：Maestro 进程反复启动（压测 681 次启动 0 次断开，重装和不重装驱动都一样）、`dismiss-anr.sh` 的轮询（只跑它的对照组 0 次），`adb track-devices` 在约 45 个带记录的 job 里也没看到被漏掉的断开。和两件事相关：开机后 50–112 秒（记到的 10 次里 6 次）；流程 03b 关飞行模式后 4–8 秒（3 次，每次都在 Wi-Fi 重新连上、默认网络切过去之后 1–2 秒，正是积压的 59 个上传开始传的时候，见 run 41574375290 第 5 次的 logcat）。流程 06、19 也关飞行模式，但没有积压的上传，没断过。样本太少，机制没有查到；Maestro 也有同样的报告（mobile-dev-inc/Maestro#3720）。所以不加等待、不改 `cores`，靠整组重跑兜住（见“测试方法”）。
- **系统镜像的下载偶尔拿到坏包。** 现象是 `Error on ZipFile unknown archive`，模拟器没起来 job 就失败了，什么现场也没有，1 分钟多一点结束（run 41465842346 的 `vaccine` 组）。四组各下载一次，碰上的机会多了，所以 `ci.yml` 先单独下载并只重试这一步。测试失败不重试。
- **`gh api .../actions/jobs/<id>/logs` 会拒绝输出日志。** 日志里有颜色转义，gh 报 `the response contains terminal escape sequences`，要加 `--allow-escape-sequences`，写进文件后再去掉转义。
- **开发服务的端口 55432、59000 在 Linux 的临时端口范围（32768–60999）里。** 新开的 Runner 上 docker 也可能报 `failed to bind host port for 0.0.0.0:59000 ... address already in use`：某个出站连接刚好用了这个本地端口（run 41572950825 的 `files` 组，模拟器还没启动就失败了）。`ci.yml` 一开始就用 `net.ipv4.ip_local_reserved_ports` 把它们留出来。本机的 `pnpm dev:infra` 理论上也会碰到，没遇到过。

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
- **改服务端配额默认值后，要核对线上的 Secret 和函数版本。** Supabase 的 Secret 会覆盖代码默认值，而没设 Secret 的项目仍运行旧函数时也会保留旧默认值。`supabase secrets list` 显示的是 SHA-256 摘要，不是明文；本项目 2026-11-03 原先没有 `FAMILY_QUOTA_MB`，设置为 `102400` 后核对了摘要，并部署新版函数。

## 测试方法

- **回归测试要先在修复前的代码上看它失败。** 没失败过的测试不能证明它抓得到问题。这个项目里压测没能复现游标竞态，看到失败才发现测试本身不够。
- **用 `uiautomator` 或 Maestro 点 Toast 里的按钮可能点空。** 取一次界面要好几秒，Toast 已经消失，点击会穿透到下面的内容。E2E 构建已把 Toast 放长到 8 秒。
- **“断言失败、截图里弹层还开着”不一定是时序问题。** 这里实际是 Toast 盖住了弹层底部的按钮，真实用户也会点空。第一反应是怪测试时，先用真实操作顺序复现一遍。
- **`takeScreenshot` 的文件在 Maestro 的调试目录里。** CI 产物路径是 `maestro/<流程>/takeScreenshot/.artifacts/`，失败现场在 `maestro/<流程>/screenshots/`。
- **上传中 `uiautomator dump` 要等很久。** 进度条一直在动，实测 32 秒，界面已经变了。手动走查时用截图加坐标点击。
- **`uiautomator dump` 在界面一直有动画时会卡住。** 输入框光标闪烁、录音计时都会让它等不到空闲，`adb-ui.py` 看起来像挂了。这时用坐标点击和 `screencap`，或者先让输入框失去焦点。
- **E2E 构建走不到系统选择器，但不用为此重新编译。** 没动原生代码时，用 `expo export:embed` 打一个不带 `EXPO_PUBLIC_E2E` 的 JS 包，`hermesc` 编译后替换 CI APK 里的 `assets/index.android.bundle`，再 `zipalign`、`apksigner` 重新签名，几分钟就能走查真实的系统界面。
- **E2E 构建里同一个弹层点两次 `pick-media`，保存后只有一个文件。** 样例每次都写到同一个缓存路径，界面上有两个缩略图，保存时第一个把文件挪走，第二个就没了，时间线不显示 `共 2 项`（流程 14e 第一次在 CI 上这样失败）。要两个文件就先保存一个，再在修改里加一个，和流程 11a4 一样。
- **模拟器上全屏查看的快速滑动可能翻不过去。** `adb shell input swipe` 300 ms 的一次没翻页，600 ms 的在图片上和图片下方的黑底上都翻了（只试了这几次，原因没查）。Maestro 流程里翻页写明 `start`、`end` 和 `duration: 800`，再等页码变化。
- **测试整体没有输出时，先怀疑死循环。** 紧循环占满事件循环时，vitest 不会打印任何东西，只会超时。
- **测事务模式连接池要加反向对照。** 本地用 PgBouncer（`pool_mode=transaction`、`max_prepared_statements=0`）跑全部测试，再打开 `DB_PREPARE` 跑一次，要看到 `prepared statement does not exist`，才说明这个环境真的能发现问题。
- **底部标签页切走后不卸载，`useEffect` 只跑一次。** 家人页的用量因此一直是打开时的值，存储满了还写着“已用 0”。要在回到页面时刷新的数据用 `useFocusEffect`。
- **测试里有“现在几点”就可能只在某个时段失败。** 推送测试没关夜间安静，每天新加坡时间 23:00 到 07:00 必红，白天怎么跑都绿。
- **`while read` 循环里不能跑 `adb`、`maestro`。** 它们会读走循环的标准输入，后面的项被悄悄跳过。`pnpm e2e` 串行时因此只跑了第一组就报“全部通过”（run 的流程数 14，不是 37）。看到通过也要核对跑了多少条。
- **脚本里拿 `flock` 排队时，后台进程要关掉锁的文件描述符。** `e2e.sh` 启动的服务端继承了 fd 9，脚本退出后还活着，锁就一直不放，第二次调用卡到 CI 超时（串行模式 run 41468801018 跑了两小时才被取消）。启动时写 `9>&-`。
- **断开后不能只重跑那一条流程。** 流程不是幂等的：run 41551513433 里 03b 中途断开，重跑时第一次的同名回忆还在，“回忆已删除”的断言失败。`e2e.sh` 改成整组从头重跑一次（重装 App、新账号、新 `RUN_ID`，`verify-uploads.mjs` 只查新账号），只认这条流程的**第一个错误**是断开（`scripts/e2e-env-failure.mjs`）：断言失败之后才断开的，收尾时日志里也有 `device offline`，以前的 grep 会把它当断开重跑，掩盖断言失败。
- **Maestro 断开一次就不会自己重连。** 设备几秒后回来了，同一个 `maestro test` 进程后面的命令和流程全部失败（Maestro#3720，维护者说等 Maestro 3）。所以每条流程单独一个进程，判断断开前先等 `adb get-state` 连续几秒是 `device`，`adb wait-for-device` 一回来就返回，不够。
- **向上滚动后马上点按钮可能点空。** 列表还带着惯性，按钮一露出来就点，点下去时它已经滑走，弹层没打开，下一步才报“找不到元素”。这种失败时有时无（流程 11a；流程 19 滚到底点“退出登录”也这样，run 41775256799 和 41778765366 各失败一次，两个 PR 的下一轮 CI 都通过；流程 10a 点 `＋ 其他疫苗` 在 run 41822873334 也这样失败一次，截图里标题行已经滑出屏幕；流程 17a 最后向上滚回“地区”一行再点，在 run 41836513091 也是，截图里那一行只剩半截）。滚动后先 `waitForAnimationToEnd`，再确认一次目标还在。
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
- **`adb input swipe` 太快时查看器不一定翻页。** 150 ms 的滑动在 main 和新分支上都有丢，400 ms 的不丢。看模拟器走查的结果时先看滑动是不是真的到位，别把这当成翻页的 Bug。
- **响应之后才写库的内容，测试里要先 `bg.flush()` 再做下一步。** “重发次数有上限”曾偶发失败（期望 429，实际 200）：验证码在响应后才写，写入如果落在下一轮的 `skipCooldown` 和请求之间，这次请求就在冷却期里，不计数也返回 200。平时失败率低，多跑几次未必看得到；要在写入前等 30ms、`skipCooldown` 后等 100ms 才能稳定复现。
- **页面的日期和钟点要写明按谁的时区算。** shared 里的格式化函数都读运行环境的时区，服务端和对方的浏览器都不是分享者的时区。本机时区和分享者相同时什么都看不出来，走查要把浏览器设成另一个时区（`timezoneId`）。
- **`testID` 不能用翻译后的文字生成。** `self-妈妈`、`milestone-第一次抬头` 都是从文字来的，英文下就变了。固定用中文原文（`messagesFor('zh')` 或数据里的 `id`）。
- **脚本里 `process.exit` 会截断管道里还没写完的输出。** `check-i18n` 报几百条时，`| grep` 只收到前面一部分，看起来问题比实际少。用 `process.exitCode`。
- **E2E 流程的断言常常靠别的流程撑开的页面才成立。** 流程分组后才暴露出两个：页面短了，`scrollUntilVisible` 看到只露出一点的那一行就停，下面的状态还在屏幕外（16）；前面的记录没被挤出屏幕，“撤销后 `Feed 120ml` 不见了”看到的是流程 02a 的另一条 120ml（18a）。滚动要滚到断言的那一行，断言不见了的内容要在同组里独一无二。挪流程到别的组时要在 CI 上跑一遍，不能只看依赖表。
- **滚动区里只露一点的元素，Maestro 也算 100% 可见。** 系统给的坐标是裁剪后的：流程 16 失败时 `vaccine-row-bcg` 报的是 `[103,2081][979,2137]`（标签栏从 2140 开始），截图里只看得到文字的上半截，里面的状态还不在层级里。`visibility percentage 100%` 是对裁剪后的框算的，所以 `scrollUntilVisible` 不继续滚。页面上方的文案变长也会把下面的行挤到这种位置（F-126 的提示卡变长后，流程 24 的“等待发送”就在屏幕外），滚动时加 `centerElement: true`。
- **开关按钮只靠“写好后 500 ms 内不算”挡不住连点。** 睡眠按钮在机器负载很高时，Maestro 间隔 100 ms 的两下实际隔得更久，第二下落在 500 ms 之后，又记成了“睡了 0分钟”（同一个流程负载低时通过）。现在还比较按钮画出来时的状态：点的是“睡眠”而记录里已经在睡，就什么都不做。
- **连点测试里，后面几下会落在弹层收起之后的页面上。** E2E 构建里弹层收起没有动画，`tapOn` 带 `repeat` 时第一下保存、弹层马上消失，第二、三下点到下面的底部标签，流程 01a 第一次就这样停在了“资料”页，后面的流程也找不到今天页。连点之后先关掉可能打开的弹层，再点 `tab-today` 回来。
- **保存后的 Toast 会盖住列表最下面那一行。** 流程 02a 改完 90ml 马上点 130ml，那一行正好在 Toast 下面，点到的是 Toast，详情没打开，下一步找不到 `event-edit`（soak run 41565539665，日志里这次点击后没有“Something has changed”）。点靠近底部的行之前先等 `toast` 消失。
- **系统相册里的照片不随卸载消失。** 只查“有没有那张照片”的话，重跑或本地第二次跑时，上一次存的照片会让流程 14b 的检查直接通过。`e2e.sh` 比较这一次前后的张数。
- **开发用的 S3 是大家共用的，发布清单放在默认前缀会互相挡住。** 发布脚本不把清单覆盖成更低的 versionCode，E2E 的假版本（versionCode 2000000000、APK 被换过）要是写进默认的 `releases/android/`，之后谁在本机手动发布都会被拒，连到这个前缀的 App 也只会看到坏版本。`e2e.sh` 用 `releases-e2e/android/`，手动测试另起一个前缀（服务端和发布脚本都设 `APP_RELEASE_PREFIX`）。
- **不要断言“这是最后一条迁移”。** `preview.test.ts` 写过 `migrations.at(-1)` 包含 `'preview'`，下一个追加迁移的人就把它弄红了。要守护的是相对顺序，断言它排在谁之后。
- **只给测试用的服务端变量不用写进 `.env.example`。** `e2e.sh` 启动服务端时在进程环境里给（比如 `FEEDBACK_*` 指向假 GitHub）：`node --env-file` 遇到进程环境里已有的变量不覆盖，以进程环境为准。写进 `.env.example` 的话，集成测试和本地开发也全都带上了。
- **本机连着真机时，adb 和 Maestro 都要指定模拟器。** 无线调试的手机会自己连上（`adb devices` 里多一台），裸 `adb` 报 `more than one device`，Maestro 自己挑设备，`launchApp: clearState` 落到真机上会清掉家里正在用的数据。手动走查一律 `adb -s emulator-5554`、`maestro --device emulator-5554 test`，看 `maestro.log` 的 `Selected device` 确认。
- **换包走查的 APK 不要放在 `/tmp`。** 这台机器的 `/tmp` 是 tmpfs，Claude Code 的临时目录有配额，一个 E2E APK 就 46 MB，复制、去签名、对齐、重签各一份，几个 Agent 叠起来就满了：`zip -d` 写到一半失败，留下一个 31 MB 的坏 APK，之后连命令输出都写不进去（F-127 走查时遇到）。放到 worktree 的 `.artifacts/` 下（已忽略），用完删掉。
- **同一台模拟器上不能同时跑两个 `maestro test`。** 前一个还在跑流程 18 时又起了一个，新的那个每条流程几毫秒就失败，日志是 `DeviceServerDiedException ... during 'deviceInfo'`，看起来像模拟器坏了。自己手动跑之前先 `pgrep -f maestro.cli`，后台跑的命令要等它真的退出（等待脚本超时不等于 Maestro 结束了）。
- **机器忙时 `scrollUntilVisible` 30 秒滚不到疫苗本底部。** 几个 Agent 同时编译、跑模拟器时宿主机负载到 27，每次点击要 20 秒，流程 17a 滚到三十多行免疫规划表下面的自费疫苗卡片时超时，紧接着流程 18 启动 30 秒还停在开屏。滚到页面很下面的元素给 90 秒，失败时先看 `uptime`，别急着怀疑代码。
- **模拟器睡眠时 Maestro 的截图全黑，第一步就找不到元素。** 日志里 App 正常启动（`Running "main"`），看起来像 JS 包坏了。先 `adb shell input keyevent KEYCODE_WAKEUP`、`wm dismiss-keyguard`，`dumpsys power` 里 `mWakefulness=Awake` 再跑。
- **E2E 里要在服务端配置里写死的账号，邮箱只能是固定的。** `e2e.sh` 启动服务端时还没有 `RUN_ID`，`FEEDBACK_VIEWER_EMAILS` 只能写 `feedback-maintainer@example.test`。本地开发库跨次保留，上一次留下的同名账号还在别的家庭里，邀请会失败；`feedback-maintainer.js` 先登录、用密码正常删除这个账号，再注册、加入这次的家庭。

## 并行开发

- **`.claude/worktrees/` 必须被忽略。** 否则 `git add -A` 会把子 Agent 的 worktree 当成嵌入仓库提交，Biome 也会因为嵌套配置报错。
- **服务端集成测试每次运行用独立的数据库。** 以前用 `TRUNCATE`，两个 Agent 同时跑会互相删数据。不要改回去。
- **模拟器只有一台。** `scripts/e2e.sh` 用文件锁排队，手动用 `adb-ui.py` 前先确认没有 E2E 在跑。
- **本地开发库是共用的，别的端口起的服务端也会处理别人留下的队列。** F-126 走查时 8817 上的服务端顺手把别的 Agent 流程 24 留下的排队反馈补发到了自己的假 GitHub（反馈的补发是全库的）。核对假 GitHub 收到的内容时按这次的 `RUN_ID` 找，不要按条数或编号。
- **8787 端口已有服务时，`e2e.sh` 会直接复用它。** 那可能是别的分支的代码，脚本会打印警告。改了服务端就先停掉旧服务。
- **Biome 不要格式化 Markdown。** 它会重新对齐表格列宽，改一行就动到整张表，并行开发时 `PROGRESS.md` 必然冲突。已在 `biome.json` 里排除。
- **`/tmp` 是按用户限额的内存盘，几个会话共用。** 写满后连命令输出都会丢。大文件（测试图片、APK）放 worktree 的 `.artifacts`。
- **子 Agent 的 scratchpad 和主会话是同一个目录。** 目录名里是会话 id，不是 Agent 自己的。`/tmp` 配额满时不要清 `scratchpad/*`：里面有别的 Agent 和主会话的文件。自己的临时文件放 worktree 的 `.artifacts/`。
- **`flock` 排队不等于拿到锁。** 后台挂着 `flock ... sleep` 时要确认它下面已经有 `sleep` 子进程，别的会话可能抢在前面。长任务要算好时间，不要跑到锁到期之后；收尾的命令直接用 `flock` 包住。
- **杀掉 `flock` 进程不会释放模拟器锁。** `flock 锁文件 sleep 3600` 里的 `sleep` 继承了锁的文件描述符，只杀 `flock` 锁还在，别人一直排队。要杀 `sleep`（或整个进程组），再用 `stat -c %i 锁文件` 得到 inode，`grep :<inode> /proc/locks` 确认已经放掉。
