> **草稿，提交前必须由合格律师审核。** 这里的声明答案是对 Google 的正式陈述，由非律师根据代码推导，不表示小豆芽符合任何法律或政策。
>
> **DRAFT. Must be reviewed by a qualified lawyer before use.** The declaration answers here are formal statements to Google, derived from the code by a non-lawyer. They do not state that the app complies with any law or policy.

# Google Play 上架资料（F-98）

依据代码 `8f78078`，政策页面于 2026-11-01 查阅。答案从 [COMPLIANCE.md 的数据清单](../legal/COMPLIANCE.md#2-数据清单从代码得出) 推导。清单变了，这里也要改。

## 1. 现在还差什么

### 会挡住上架的

| # | 问题 | 现状 | 要做什么 | 依据 |
|---|---|---|---|---|
| 1 | **只能打 APK** | `release.yml` 和 `scripts/android-build.sh` 都只跑 `assembleRelease`，发布到 GitHub Releases | 加 `bundleRelease`，产出 AAB。把现在的 keystore 当上传密钥，启用 Play App Signing。APK 可以继续用于直接分发 | [新 App 自 2021-08 起必须用 AAB](https://developer.android.com/guide/app-bundle)；[Play App Signing 对新 App 是必需的](https://developer.android.com/guide/app-bundle/faq) |
| 2 | **没有删除账号** | F-93 未开始。服务端没有相关接口 | App 内入口，加上不用打开 App 就能提交的网页。删除要覆盖数据安全表里的全部数据，并要求服务商也删除 | [账号删除要求](https://support.google.com/googleplay/android-developer/answer/13327111) |
| 3 | **没有隐私政策入口** | App 里搜不到“隐私”“协议”；政策还是草稿，没有发布 | 律师审核后发布到公开网址（不能是 PDF，不能地理封锁），填入 Play Console，并在 App 内放链接 | [用户数据政策](https://support.google.com/googleplay/android-developer/answer/10144311)；[健康内容政策](https://support.google.com/googleplay/android-developer/answer/16679511?hl=en) |
| 4 | **账号类型可能不对** | 没有开发者账号。包名是 `com.gchust.xiaodouya` | 决定个人还是组织（COMPLIANCE D1）。Google 写明提供“Health apps, such as medical apps and human subjects research apps”必须用组织账号，需要 D-U-N-S。婴儿记录 App 算不算，页面没有说，**要问 Play 支持或律师**。个人账号（2023-11-13 后创建）还要 12 名测试者连续 14 天封闭测试 | [账号类型](https://support.google.com/googleplay/android-developer/answer/13634885)；[测试要求](https://support.google.com/googleplay/android-developer/answer/14151465) |
| 5 | **普通用户用不了上传** | 现在要管理员自己填 S3 密钥，或者服务器配置默认存储。没有配额（F-95、F-96、F-97） | 平台托管存储和配额。审核员和新用户不配置就要能用 | F-95；审核要能访问全部功能（见第 6 节） |
| 6 | **没有真实部署和正式包** | F-76 没打过正式包，F-79 没在真实 Supabase 跑过，所有功能的“真机”都是 ⬜ | 全部走通一遍 | PROGRESS |
| 7 | **注册时没有同意步骤** | 注册页只有邮箱、密码和名字 | 敏感数据的同意流程，由律师确认文案。Google 要求需要 prominent disclosure 的场景有肯定性操作 | [用户数据政策](https://support.google.com/googleplay/android-developer/answer/10144311) |

### 要在提交时处理的

| # | 问题 | 现状 | 要做什么 |
|---|---|---|---|
| 8 | **Foreground service 权限** | 生成的清单有 `FOREGROUND_SERVICE`、`FOREGROUND_SERVICE_MEDIA_PLAYBACK`，来自依赖的默认配置。App 代码里没有打开后台播放的设置 | 不需要的话用 `android.blockedPermissions` 去掉，并回归测试。留下就要在 App content 里[声明并提供视频](https://support.google.com/googleplay/android-developer/answer/13392821) |
| 9 | **多余的权限** | 清单有 `SYSTEM_ALERT_WINDOW`（模板带的）、`READ/WRITE_EXTERNAL_STORAGE`（`maxSdkVersion=32`）、`BIND_GET_INSTALL_REFERRER_SERVICE`（来自 `expo-application`，App 代码没有调用） | 逐个确认用不到后屏蔽。审核员会问为什么要悬浮窗权限 |
| 10 | **明文流量** | 看到的 `AndroidManifest` 是 E2E 构建的，`usesCleartextTraffic="true"`。`android-build.sh release` 会设 `ANDROID_ALLOW_HTTP=0` | 打出正式包后确认实际是 false。数据安全表里“传输加密”的答案取决于它 |
| 11 | **只有中文界面** | F-91 未开始。通知文字也写死中文 | 英文资料要等英文界面完成，否则只上传中文资料，或在描述里写明界面是中文 |
| 12 | **地区内容** | 疫苗表只有新加坡、中国大陆、美国（F-90），健康内容没有医护复核（F-11、F-37、F-100） | 上线地区的内容到位。不能说适用于各国 |
| 13 | **登录页的服务器地址** | 用户可以改服务器。App 内也能配置自己的 S3 | 决定商店版是否保留（COMPLIANCE D6） |

### 已经满足的

- **Target API：** 生成的清单是 `targetSdkVersion=36`、`minSdkVersion=24`，满足 [2026-08-31 起新 App 和更新要 API 36](https://developer.android.com/google/play/requirements/target-sdk) 的要求。这个数字来自 React Native 的默认值，每年 8 月前后都要重新查。
- **照片权限：** 用系统选择器，没有声明 `READ_MEDIA_IMAGES` 或 `READ_MEDIA_VIDEO`。
- **64 位：** 正式版默认 `arm64-v8a`。

### 还没确认的

- **16 KB 内存页：** [从 2027-02-01 起，不支持的更新不能发布](https://developer.android.com/guide/practices/page-sizes)。正式包要用 Android 的工具或 16 KB 模拟器检查一次，这里没有构建，所以没有验证。

## 2. 商店资料

**只写现有的功能，不写医疗声明。** 下面的文字描述的是 `8f78078` 已有的功能，它们都标着“待验证”，真机还没有验证过。提交前对照 PROGRESS 再读一遍，没有放行的功能要从描述里拿掉。

Google 要求非医疗器械的健康 App [在描述里明确声明](https://support.google.com/googleplay/android-developer/answer/16679511?hl=en)“not a medical device and does not diagnose, treat, cure, or prevent any medical condition”，并提醒用户咨询医护人员。两种语言的描述都放了。

字数限制：[名称 30，简短描述 80，完整描述 4000](https://support.google.com/googleplay/android-developer/answer/9859152?hl=en)，全角和半角一样算。

### 中文

**名称：** 小豆芽：宝宝成长记录

**简短描述：** 一家人一起记录喂奶、尿布和睡眠，把照片、录音和证件放在一处，离线也能用。

**完整描述：**

```text
小豆芽帮一家人一起记录宝宝的日常。半夜单手也能一两下记好，没有网络也能用，联网后自动同步给家人。

今天
· 记录喂奶、尿布、睡眠、体温、吃药、洗澡、身高体重和疫苗接种，宝宝满 6 个月后可以记录辅食
· 查看距离上次喂奶多久，以及根据你们的记录估算的下次喂奶时间
· 24 小时时间线和摘要，记错了可以修改或撤销

回忆
· 保存照片、视频和录音
· 时间线、照片墙和里程碑
· 写一封信给宝宝
· 导出成长册 PDF

资料
· 出生档案
· 证件夹：保存证件照片和 PDF，证件号默认打码，可以打开指纹或面容验证
· 体重图表和疫苗本（内置新加坡、中国大陆和美国的疫苗表，以诊所安排和健康手册为准）

家人
· 用邀请码邀请家人
· 三种角色：管理员、一起记录、只看回忆和照片
· 喂奶提醒，可以设置夜间安静

需要注册账号才能同步。你们的记录和文件保存在云端服务器上，隐私政策说明了存放位置和谁能访问。目前一个家庭只有一个宝宝档案。

重要提示
小豆芽不是医疗器械，不能诊断、治疗、治愈或预防任何疾病。App 内的提示、估算和疫苗表仅供参考，不能替代医疗建议。宝宝不舒服时请咨询医生或其他合格的医护人员，紧急情况请立刻联系当地急救服务。
```

**关键词（Play 没有关键词字段，只用于自然地写进描述。Google [提醒](https://support.google.com/googleplay/android-developer/answer/9859152?hl=en)关键词堆砌可能导致下架）：** 宝宝记录、喂奶记录、尿布、睡眠、育儿、成长相册、新生儿、家庭共享、疫苗记录

### English

只有英文界面上线后才用（F-91）。

**Name:** Xiaodouya: Baby Log & Memories

**Short description:** Log feeds, diapers and sleep as a family. Keep photos and documents together.

**Full description:**

```text
Xiaodouya helps a family record a baby's days together. One-handed logging takes a tap or two, even in the middle of the night. It works offline and syncs to your family when you're back online.

Today
- Log feeds, diapers, sleep, temperature, medicine, baths, height and weight, and vaccinations, plus solid food once your baby is 6 months old
- See how long it has been since the last feed, and an estimate of the next one based on your own records
- 24-hour timeline and summary. Made a mistake? Edit or undo it

Memories
- Keep photos, videos and voice recordings
- Timeline, photo wall and milestones
- Write letters to your baby
- Export a growth book PDF

Records
- Birth profile
- Document folder for document photos and PDFs. Document numbers are masked on screen by default, and you can turn on fingerprint or face verification
- Weight chart and vaccine record (built-in schedules for Singapore, mainland China and the United States; follow your clinic's arrangements and health booklet)

Family
- Invite family members with a code
- Three roles: admin, caregiver, and view memories and photos only
- Feed reminders with a quiet-night setting

An account is needed to sync. Your records and files are stored on cloud servers. The privacy policy explains where and who can access them. Each family currently has one baby profile.

Important
Xiaodouya is not a medical device and does not diagnose, treat, cure, or prevent any medical condition. Hints, estimates and vaccine schedules in the app are for reference only and do not replace medical advice. Consult a doctor or other qualified healthcare professional when your baby is unwell, and contact local emergency services in an emergency.
```

**Keywords (no keyword field on Play; use naturally in the description only):** baby log, feeding tracker, diaper, sleep, parenting, newborn, family sharing, baby photos, vaccine record

**不要写：** “医生推荐”“安全”“符合 HIPAA/GDPR”“端到端加密”“永不丢失”“第一”“最好”“生长曲线”（现在只有体重柱状图）“支持各国疫苗表”。

**商标：** “小豆芽”和 “Xiaodouya” 没有做过商标检索，提交前要查。

## 3. 分类

**推荐：Parenting（育儿）。** Google 的[分类页](https://support.google.com/googleplay/android-developer/answer/9859673)对 Parenting 的举例是 “Pregnancy, infant care and monitoring, childcare”，正好是这个 App 的主题。

- **不选 Medical：** 它的举例是临床参考、面向医护人员的工具和手册，不符合，也会招来更严格的审查和账号类型问题。
- **不选 Health and Fitness：** 举例偏个人健身和营养。可以考虑，但 Parenting 更准确。
- 分类不影响“健康 App 声明”，那个照样要填。

## 4. 截图清单

规格（[官方页](https://support.google.com/googleplay/android-developer/answer/9866151)）：图标 512×512 PNG；置顶大图 1024×500，无透明；手机截图至少 2 张，最多 8 张，建议至少 4 张竖屏 1080×1920 或更大，长边不超过短边 2 倍。文字说明不超过画面 20%，不要写“立即下载”，不要写排名和价格。

**只用虚构数据**（AGENTS.md 第 7 节）。不能出现真实的宝宝、证件或家人。用 `pnpm screenshot` 从真实界面截取，不做界面里没有的效果图。

- [ ] 今天：喂奶、尿布、睡眠的记录入口和时间线
- [ ] 记录喂奶的半屏面板，展示一两下就能记好
- [ ] 回忆：时间线或照片墙（用明显虚构的图片，比如插画或素材授权图，不用真实儿童照片）
- [ ] 写给宝宝的信或成长册 PDF
- [ ] 资料：证件夹，证件号打码状态，使用明显虚构的号码
- [ ] 家人：三种角色和邀请码
- [ ] 英文版一套（F-91 后）；如果上线地区的界面语言不同，也要一套
- [ ] 不要把体温提示当卖点。如果出现，要同时看得见“请联系医生”这类文字，避免看起来像诊断工具
- [ ] 不要用面向孩子的卡通风格宣传，[这可能被判定为面向儿童](https://support.google.com/googleplay/android-developer/answer/9867159)

## 5. 数据安全表

定义来自[官方页](https://support.google.com/googleplay/android-developer/answer/10787469)：“collect” 指数据被传出设备；“share” 指传给第三方，但**代表你处理数据的服务商**、用户主动发起的操作不算。只在设备上处理的不算收集。

### 总体问题

| 问题 | 建议答案 | 理由 |
|---|---|---|
| App 收集或分享用户数据吗？ | **是** | 记录和文件同步到服务器 |
| 传输时都加密吗？ | **是（要先核实）** | 正式版只允许 HTTPS（第 1 节 #10）；存储和 Expo 都是 HTTPS。自定义存储默认要求 https。没有验证过正式包，**核实前不能答** |
| 用户能请求删除数据吗？ | **今天是“否”，F-93 上线后改“是”** | 现在没有任何删除方式。同时要填账号删除网址 |
| 所有收集的数据都能删除吗？ | 取决于 F-93 | 备份要 30 天过期。这要在隐私政策里说明 |
| 独立安全审查 | **否** | 没做过 |
| Families 政策 | 不适用 | 不面向儿童 |

### 收集的数据类型

全部**不分享**，目的都是 **App functionality**，账号相关的加上 **Account management**。不用于广告、分析或个性化。

| 分类 | 类型 | 收集 | 必需/可选 | 代码来源和理由 |
|---|---|---|---|---|
| Personal info | Name | 是 | 必需 | `display_name`；宝宝姓名 `baby.name`；成员称呼 |
| Personal info | Email address | 是 | 必需 | `users.email` |
| Personal info | User IDs | 是 | 必需 | 服务端生成的 UUID |
| Personal info | Other info | 是 | 可选 | 宝宝出生时间（这一项建档时必需）、证件号、出生医院、血型 |
| Health and fitness | Health info | 是 | 可选 | 体温、用药、喂奶、尿布、睡眠、辅食、身高体重、疫苗、血型 |
| Photos and videos | Photos | 是 | 可选 | 回忆、头像、证件照片 |
| Photos and videos | Videos | 是 | 可选 | 回忆 |
| Audio files | Voice or sound recordings | 是 | 可选 | 回忆里的录音 |
| Files and docs | Files and docs | 是 | 可选 | 证件 PDF 和图片，含原文件名 |
| App activity | Other user-generated content | 是 | 可选 | 回忆文字、写给宝宝的信、备注 |
| App activity | App interactions | 是 | 必需 | `memberships.last_seen_at`，家人能看到。建议保守申报 |
| Device or other IDs | Device or other IDs | 启用推送时 | 可选 | Expo push token、随机 `device_id`。FCM SDK 还可能产生 Firebase 安装 ID。如果不启用推送，要确认构建里没有 `google-services.json` |

### 不收集的

| 分类 | 理由 |
|---|---|
| Location | 没有定位权限和代码。**但原文件里可能有 EXIF 位置**（COMPLIANCE 第 2 节注 3）。建议上传时去除，这样答案才干净；如果不去除，问律师是否要申报 |
| Financial info | 没有支付。用户可能自己上传保险单和收据，已经算在 Files and docs 里 |
| Messages | 没有聊天功能 |
| Contacts、Calendar | 没有权限和代码 |
| Web browsing | 没有 |
| App info and performance（Crash logs、Diagnostics） | App 里没有崩溃或分析 SDK。服务端日志只记路径和错误。提交前用 Play Console 的 SDK 报告核对一次 |

### “不分享”的理由和要确认的

- **Supabase、Cloudflare：** 服务商，代表运营者处理，按 Google 的定义不算分享。要签好 DPA。
- **Expo、FCM（启用推送时）：** 推送正文含健康内容。按服务商处理算不算分享，取决于 Expo 的条款，**要确认**。这也是建议把通知改成不含健康内容的理由之一（COMPLIANCE D4）。
- **家庭成员之间：** 用户自己邀请，属于用户主动发起。
- **成长册 PDF：** 用户自己选择分享，在设备上生成。

## 6. App content 里的其他声明

| 项目 | 建议答案 | 说明 |
|---|---|---|
| **Health apps 声明** | **不能选 “No health features”** | App 有体温记录和发烧提示、用药记录、喂养和睡眠记录。[官方分类](https://support.google.com/googleplay/android-developer/answer/14738291)里接近的有 Nutrition and Weight Management、Sleep Management（Health and fitness），以及 Medication and Treatment Management（Medical）。最后一项会把它归入 Medical 类，可能引出组织账号要求。**如实选择，拿不准就问 Play 支持或律师。** 不选 Medical Device、不选 Health subjects research |
| **Target audience** | **18 岁及以上** | 为家长设计。[官方页](https://support.google.com/googleplay/android-developer/answer/9867159)说按 App 设计面向的人群选择。选 18+ 后可以考虑打开 Restrict Minor Access。商店图片不能面向儿童 |
| Ads | 否 | 没有广告 SDK |
| App access | 提供测试账号 | 新建一个测试家庭，只放虚构数据，含管理员和一起记录的账号。不要用真实数据 |
| Content rating | 按问卷如实答 | 用户生成内容只在家庭内部，没有公开分享 |
| News、Government、Financial | 否 | |
| Foreground service | 见第 1 节 #8 | |
| Privacy policy URL | `[隐私政策网址]` | |
| Account deletion URL | `[账号删除网址]` | |
| Developer contact | `[联系邮箱]`、`[支持网址]` | |

## 7. 官方来源

全部在 2026-11-01 打开过。内容经工具摘要，提交前请对照原文。

- [Target API level](https://developer.android.com/google/play/requirements/target-sdk)
- [Target API level（Play Console 帮助）](https://support.google.com/googleplay/android-developer/answer/11926878)
- [Android App Bundle](https://developer.android.com/guide/app-bundle)、[FAQ](https://developer.android.com/guide/app-bundle/faq)
- [账号删除要求](https://support.google.com/googleplay/android-developer/answer/13327111)
- [健康内容和服务政策](https://support.google.com/googleplay/android-developer/answer/16679511?hl=en)
- [Health apps 声明](https://support.google.com/googleplay/android-developer/answer/14738291)
- [健康 App 分类](https://support.google.com/googleplay/android-developer/answer/13996367)
- [用户数据政策](https://support.google.com/googleplay/android-developer/answer/10144311)
- [数据安全表](https://support.google.com/googleplay/android-developer/answer/10787469)
- [账号类型](https://support.google.com/googleplay/android-developer/answer/13634885)
- [新个人账号的测试要求](https://support.google.com/googleplay/android-developer/answer/14151465)
- [Foreground service 声明](https://support.google.com/googleplay/android-developer/answer/13392821)
- [目标受众](https://support.google.com/googleplay/android-developer/answer/9867159)
- [分类](https://support.google.com/googleplay/android-developer/answer/9859673)
- [图形素材](https://support.google.com/googleplay/android-developer/answer/9866151)
- [文字素材限制](https://support.google.com/googleplay/android-developer/answer/9859152?hl=en)
- [Metadata 政策](https://support.google.com/googleplay/android-developer/answer/9898842)
- [16 KB 内存页](https://developer.android.com/guide/practices/page-sizes)
