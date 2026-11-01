> **草稿，提交前必须由合格律师审核。** 这里的声明答案是对 Apple 的正式陈述，由非律师根据代码推导，不表示小豆芽符合任何法律或政策。
>
> **DRAFT. Must be reviewed by a qualified lawyer before use.** The declaration answers here are formal statements to Apple, derived from the code by a non-lawyer. They do not state that the app complies with any law or policy.

# App Store 上架资料（F-99）

依据代码 `8f78078`，政策页面于 2026-11-01 查阅。答案从 [COMPLIANCE.md 的数据清单](../legal/COMPLIANCE.md#2-数据清单从代码得出) 推导。

**iOS 从来没有运行过（F-77）。** 下面关于 iOS 的内容都来自读代码和 `node_modules`，没有构建，也没有在真机上验证过。

## 1. 现在还差什么

### 会挡住上架的

| # | 问题 | 现状 | 要做什么 | 依据 |
|---|---|---|---|---|
| 1 | **iOS 没跑过** | 仓库没有 `ios/`。`ARCHITECTURE.md` 说上传队列保存绝对路径，iOS 升级后可能失效。录音、相册、通知、证件夹解锁都没测 | 用 Mac 或云构建，走真机和 TestFlight；修路径问题 | 2.1：要在设备上测试过 |
| 2 | **提交者要是法律实体** | 没有开发者账号 | 需要敏感用户信息的 App “should be submitted by a legal entity”，不是个人开发者。**这款 App 处理儿童健康数据和证件，要假定适用。** 决定见 COMPLIANCE D1 | [5.1.1(ix)](https://developer.apple.com/app-store/review/guidelines/) |
| 3 | **没有删除账号** | F-93 未开始 | 必须能在 App 内发起。只能停用不够。除受监管行业外，不能要求打电话或发邮件。要告诉用户多久完成，完成后确认。Apple 明确说要包括分享给别人的用户内容，所以家庭共享的规则要定（COMPLIANCE D5） | [5.1.1(v)](https://developer.apple.com/app-store/review/guidelines/)；[账号删除说明](https://developer.apple.com/support/offering-account-deletion-in-your-app/) |
| 4 | **没有隐私政策入口** | App 里没有；政策是草稿 | App Store Connect 和 App 内都要有。政策要写明第三方提供同等保护、保留和删除规则、如何撤回同意。部分内容标着 `〔待落实〕` | [5.1.1(i)](https://developer.apple.com/app-store/review/guidelines/) |
| 5 | **没有同意流程** | 注册时没有 | 收集前要取得同意，并提供撤回方式 | [5.1.1(ii)](https://developer.apple.com/app-store/review/guidelines/)、[5.1.2(i)](https://developer.apple.com/app-store/review/guidelines/) |
| 6 | **Privacy manifest 没配置** | `app.config.ts` 没有 `ios.privacyManifests` | 见第 6 节。没有声明的 App 不会被 App Store Connect 接受 | [required reason API](https://developer.apple.com/tutorials/data/documentation/bundleresources/describing-use-of-required-reason-api.json) |
| 7 | **需要测试账号和在线后端** | 没有真实部署（F-79） | 提供测试账号，后端要开着。普通用户不配置 S3 也要能上传（F-95） | [2.1(a)](https://developer.apple.com/app-store/review/guidelines/) |

### 要核实的

| # | 问题 | 为什么 | 要做什么 |
|---|---|---|---|
| 8 | **iCloud 备份里的健康数据** | Apple 5.1.3(ii) 规定 App “may not store personal health information in iCloud”。SQLite 和 `uploads/` 放在 App 的文档目录，这个目录通常会进入设备的 iCloud 备份。这是不是 Apple 所说的“存在 iCloud”，页面没有细说 | 在真机上确认。把数据库和文件目录标记为不备份最稳妥，但换手机时本地未同步的内容会丢，要和“不丢数据”的产品底线一起考虑。Android 的自动备份规则只包含 SharedPreferences（`expo-secure-store` 带的规则，只读了规则文件，没有在设备上验证），不涉及这些文件 |
| 9 | **后台模式** | `expo-audio`、`expo-video` 的配置插件可能加 `UIBackgroundModes`。App 没有打开后台播放的设置 | 打包后看 `Info.plist`，去掉用不到的 |
| 10 | **权限说明文字只有中文** | `app.config.ts` 里的相机、相册、麦克风、Face ID 说明是写死的中文 | 随 F-91 做 `InfoPlist.strings` 本地化。相册走系统选择器，确认是否需要 `NSPhotoLibraryUsageDescription` |
| 11 | **录音指示** | 2.5.14 要求录制时有明确的视觉或声音提示 | 真机确认录音界面的状态足够清楚 |
| 12 | **健康内容** | 1.4.1 对可能提供不准确信息的医疗 App 审查更严，也要提醒用户问医生 | 不声称准确度。提示都指向医生。医护复核（F-100）。不要说 App 能测量任何东西 |
| 13 | **界面语言和地区** | 只有中文（F-91）；疫苗表只有新加坡、中国大陆、美国，且没有医护复核（F-90、F-100） | 同 Google Play。不要把英文资料放在中文界面上 |
| 14 | **出口合规** | App 用 HTTPS 和 `expo-crypto`、`expo-secure-store` | App Store Connect 上传时要回答加密问题，设 `ITSAppUsesNonExemptEncryption`。这一条没有打开官方页核对 |
| 15 | **公开用户内容** | 内容只在家庭内部，没有公开或陌生人分享 | 1.2 的 UGC 要求（过滤、举报、拉黑）应该不适用。在审核说明里写明。对外公布联系方式 |

### 账号和构建要求

- 用 Xcode 26 和 iOS 26 SDK 构建；最低目标 iOS 13（[Upcoming requirements](https://developer.apple.com/news/upcoming-requirements/)）。
- 面向欧盟要提供 [DSA trader 状态](https://developer.apple.com/news/upcoming-requirements/)，这会公开运营者的联系信息。
- 在 App Store Connect [回答年龄分级问题](https://developer.apple.com/news/upcoming-requirements/)。如实回答有医疗或健康内容。
- 面向中国大陆要填 ICP 备案号，否则显示 “ICP Filing Number Missing”（[说明](https://developer.apple.com/help/app-store-connect/reference/app-information/app-and-submission-statuses/)，只看到搜索摘录）。见 COMPLIANCE 3.4。

### 已经满足的

- **最小化权限：** 相册和文件用系统选择器，符合 [5.1.1(iii)](https://developer.apple.com/app-store/review/guidelines/) 的方向。
- **系统功能不是必需的：** 不开通知也能用（5.1.2(i)）。
- **登录：** 只有自己的账号系统，没有第三方登录，4.8 不要求加 Sign in with Apple。
- **没有广告和跟踪。**
- **不支持 iPad：** `supportsTablet: false`，不需要 iPad 截图。

## 2. 商店资料

**只写现有的功能，不写医疗声明。** 这些功能在 iOS 上都没有验证过。

字数限制（工具的一般了解，[官方页](https://developer.apple.com/help/app-store-connect/reference/app-information/required-localizable-and-editable-properties/)打开了但没有显示数字，请在 App Store Connect 里核对）：名称 30，副标题 30，关键词 100 字节，描述 4000。

### 中文

**名称：** 小豆芽：宝宝成长记录

**副标题：** 一家人一起记录宝宝的每一天

**关键词：** `宝宝,喂奶,尿布,睡眠,育儿,成长,记录,疫苗,家庭,相册`

**描述：**

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
· 证件夹：保存证件照片和 PDF，证件号默认打码，可以打开面容或指纹验证
· 体重图表和疫苗本（内置新加坡、中国大陆和美国的疫苗表，以诊所安排和健康手册为准）

家人
· 用邀请码邀请家人
· 三种角色：管理员、一起记录、只看回忆和照片
· 喂奶提醒，可以设置夜间安静

需要注册账号才能同步。你们的记录和文件保存在云端服务器上，隐私政策说明了存放位置和谁能访问。目前一个家庭只有一个宝宝档案。

重要提示
小豆芽不是医疗器械，不能诊断、治疗、治愈或预防任何疾病。App 内的提示、估算和疫苗表仅供参考，不能替代医疗建议。作出医疗决定前请咨询医生，紧急情况请立刻联系当地急救服务。
```

### English

只有英文界面上线后才用（F-91）。

**Name:** Xiaodouya: Baby Log & Memories

**Subtitle:** Family baby log and memories

**Keywords:** `baby,newborn,feeding,diaper,sleep,log,family,memories,growth,parenting`

**Description:**

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
- Document folder for document photos and PDFs. Document numbers are masked on screen by default, and you can turn on Face ID or fingerprint verification
- Weight chart and vaccine record (built-in schedules for Singapore, mainland China and the United States; follow your clinic's arrangements and health booklet)

Family
- Invite family members with a code
- Three roles: admin, caregiver, and view memories and photos only
- Feed reminders with a quiet-night setting

An account is needed to sync. Your records and files are stored on cloud servers. The privacy policy explains where and who can access them. Each family currently has one baby profile.

Important
Xiaodouya is not a medical device and does not diagnose, treat, cure, or prevent any medical condition. Hints, estimates and vaccine schedules in the app are for reference only and do not replace medical advice. Check with a doctor before making medical decisions, and contact local emergency services in an emergency.
```

**不要写：** “医生推荐”“安全”“符合 HIPAA/GDPR”“端到端加密”“永不丢失”“最好”“生长曲线”（现在只有体重柱状图）“支持各国疫苗表”。

**商标：** 没有做过商标检索，提交前要查。

### 审核说明（Review Notes）草稿

```text
Xiaodouya is a family baby-record app for parents and caregivers. It is not for children and has no public or stranger sharing: content is visible only to family members invited by the family's admin.

It is not a medical device. It records what parents enter, and its hints direct users to consult a doctor. It takes no measurements using device sensors.

Test account (admin): [测试账号邮箱] / [测试账号密码]
Test account (caregiver): [测试账号邮箱] / [测试账号密码]
All data in these accounts is fictional.

Account deletion: [App 内路径]
```

## 3. 分类

**推荐：主分类 Lifestyle，次分类 Health & Fitness。**

根据 [Apple 的分类页](https://developer.apple.com/app-store/categories/)：

- **Lifestyle** 的举例里明确有 “parenting”。
- **Health & Fitness** 的举例有 “pregnancy”，定义是健康生活，可以作为次分类，方便家长找到。
- **不选 Medical。** 它的举例确实有 “medical record-keeping” 和 “health tracking”，但主分类选它等于告诉审核员这是医疗 App，会招来 1.4.1 的更严审查，也和“不是医疗器械”的定位不一致。
- **不选 Kids。** 那是给 11 岁及以下儿童使用的 App，要遵守 1.3 的额外限制，比如不能向第三方发送个人信息。

这是判断，不是规则。Apple 说要选最能描述主要功能的分类，选错分类违反 2.3。可以看一下同类 App 的选择再定。

## 4. 截图清单

规格（[官方页](https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications)）：`.jpeg`、`.jpg` 或 `.png`，不能有透明通道，每种尺寸 1 到 10 张。官方页列出 iPhone with Dynamic Island (medium display) 为必需尺寸。大屏（16 Pro Max、17 Pro Max、18 Pro Max）可接受 1260×2736、1290×2796、1320×2868。不支持 iPad，不需要 iPad 截图。

**只用虚构数据**（AGENTS.md 第 7 节）。必须从 iOS 真实构建上截取，不能用 Android 截图。

- [ ] 今天：记录入口和时间线
- [ ] 记录喂奶的半屏面板
- [ ] 回忆：时间线或照片墙（用插画或授权素材，不用真实儿童照片）
- [ ] 写给宝宝的信或成长册 PDF
- [ ] 证件夹：证件号打码状态，明显虚构的号码
- [ ] 家人和三种角色
- [ ] 英文版一套（F-91 后）
- [ ] 不要突出体温提示，避免看起来像诊断工具

## 5. App Privacy 标签

定义来自[官方页](https://developer.apple.com/app-store/app-privacy-details/)：“collect” 指传出设备，并且你或第三方合作方能访问的时间长于实时处理请求所需。这里的数据都不符合“可选披露”的条件，因为它们是 App 的主要功能，不是偶尔才收集。

### 总体答案

| 问题 | 答案 | 理由 |
|---|---|---|
| 是否收集数据 | **是** | |
| 是否用于跟踪 | **否** | 没有广告 SDK，不和第三方数据关联，不给数据经纪商。`NSPrivacyTracking` 设为 false |
| 是否和身份关联 | **全部是** | 都和账号关联 |
| 用途 | **全部只选 App Functionality** | 不用于分析、广告、个性化。不要因为“以后可能”而多选，也不要因为方便而少选 |

### 数据类型

| Apple 分类 | 类型 | 收集 | 代码来源和理由 |
|---|---|---|---|
| Contact Info | Name | 是 | `display_name`、成员称呼、宝宝姓名 |
| Contact Info | Email Address | 是 | `users.email` |
| Health & Fitness | Health | 是 | 体温、用药、喂奶、尿布、睡眠、辅食、身高体重、疫苗、血型。Apple 的定义包括“any other user provided health or medical data” |
| Sensitive Info | Sensitive Info | **建议是，请律师确认** | Apple 的定义包括 “pregnancy or childbirth information”。出生体重、身长、出生医院、出生证明都可能算 |
| User Content | Photos or Videos | 是 | 回忆、头像、证件照片 |
| User Content | Audio Data | 是 | 录音 |
| User Content | Other User Content | 是 | 回忆文字、信、备注、证件文件 |
| Identifiers | User ID | 是 | 服务端 UUID |
| Identifiers | Device ID | 启用推送时 | 随机 `device_id` 和 Expo push token |
| Usage Data | Product Interaction | 建议是（保守） | `last_seen_at`，家人能看到 |
| Other Data | Other Data Types | 是 | 宝宝出生日期、证件号。其他分类都放不下。**证件号要在隐私政策和这里都写清楚** |

### 不收集

| 类型 | 理由 |
|---|---|
| Location | 没有定位权限和代码。**但原文件可能带 EXIF**，见 COMPLIANCE 第 2 节注 3。建议上传时去除 |
| Contacts、Browsing History、Search History | 没有 |
| Financial Info、Purchases | 没有支付。用户可能上传保险单和收据，这算自由上传的内容，已计入 Other User Content |
| Diagnostics | 没有崩溃和分析 SDK。提交前检查归档的隐私报告 |
| Surroundings、Body | 没有 |

### 第三方

Apple 说回答要涵盖集成了其代码的第三方合作方。App 内的第三方代码只有 Expo 和 React Native 的库。启用推送时，推送正文含健康内容，会经 Expo 和 APNs 发送，要在隐私政策里写明（已写）。5.1.2(i) 要求明确披露和第三方的共享并取得许可，这也是建议把通知改成不含健康内容的理由之一（COMPLIANCE D4）。

## 6. Privacy manifest

**现状：** `app.config.ts` 没有 `ios.privacyManifests`。

[Apple](https://developer.apple.com/tutorials/data/documentation/bundleresources/privacy-manifest-files.json) 要求 App 和第三方 SDK 记录收集的数据类型和使用的 required reason API。[Expo](https://docs.expo.dev/guides/apple-privacy/) 说 Apple 不能正确解析静态 CocoaPods 依赖里的所有 PrivacyInfo 文件，所以可能要手工加到 App 配置。Apple 的[列表](https://developer.apple.com/support/third-party-SDK-requirements/)上有 `hermes`，React Native 带它，也列了 Firebase 相关的 SDK。iOS 上的推送走 Expo 和 APNs，要确认没有引入 Firebase。

在已安装的依赖里找到的声明（只查了这几个包，`expo-secure-store`、`expo-sqlite` 没有找到）：

| 包 | API 类别 | 理由代码 |
|---|---|---|
| `react-native` | FileTimestamp | `C617.1` |
| `react-native` | UserDefaults | `CA92.1` |
| `expo-file-system` | FileTimestamp | `0A2A.1`、`3B52.1` |
| `expo-file-system` | DiskSpace | `E174.1`、`85F4.1` |
| `expo-notifications` | UserDefaults | `CA92.1` |
| `expo-device` | SystemBootTime | `35F9.1` |

**要做的（改 `app.config.ts`，不在这个文档任务的范围内）：**

```ts
ios: {
  privacyManifests: {
    NSPrivacyTracking: false,
    NSPrivacyAccessedAPITypes: [
      { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryFileTimestamp',
        NSPrivacyAccessedAPITypeReasons: ['C617.1', '0A2A.1', '3B52.1'] },
      { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryUserDefaults',
        NSPrivacyAccessedAPITypeReasons: ['CA92.1'] },
      { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryDiskSpace',
        NSPrivacyAccessedAPITypeReasons: ['E174.1', '85F4.1'] },
      { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategorySystemBootTime',
        NSPrivacyAccessedAPITypeReasons: ['35F9.1'] },
    ],
  },
},
```

这是从依赖里抄来的起点，没有验证过。理由代码必须和 App 的真实用法一致。构建后：

1. 在 Xcode 里归档，生成隐私报告，和这张表对照。
2. 上传到 TestFlight。[Expo](https://docs.expo.dev/guides/apple-privacy/) 说如果缺少理由，Apple 会在几分钟内发邮件。
3. 把第 5 节的数据类型也写进 `NSPrivacyCollectedDataTypes`，保持和 App Store Connect 的回答一致。

## 7. 官方来源

除特别说明外，都在 2026-11-01 打开过。内容经工具摘要，提交前请对照原文。

- [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)（页面很长，读了前 100000 字符，引用的条款都在其中）
- [App Privacy Details](https://developer.apple.com/app-store/app-privacy-details/)
- [Offering account deletion](https://developer.apple.com/support/offering-account-deletion-in-your-app/)
- [Privacy manifest files](https://developer.apple.com/tutorials/data/documentation/bundleresources/privacy-manifest-files.json)（普通网页版只取到标题，这里读的是数据接口）
- [Describing use of required reason API](https://developer.apple.com/tutorials/data/documentation/bundleresources/describing-use-of-required-reason-api.json)（理由代码的具体含义没有取到，要在官方页核对）
- [Third-party SDK requirements](https://developer.apple.com/support/third-party-SDK-requirements/)
- [Upcoming requirements](https://developer.apple.com/news/upcoming-requirements/)
- [App Store categories](https://developer.apple.com/app-store/categories/)
- [Screenshot specifications](https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications)
- [Required, localizable and editable properties](https://developer.apple.com/help/app-store-connect/reference/app-information/required-localizable-and-editable-properties/)（没有显示字数限制）
- [App and submission statuses](https://developer.apple.com/help/app-store-connect/reference/app-information/app-and-submission-statuses/)（只看到搜索摘录）
- [Expo: Apple privacy](https://docs.expo.dev/guides/apple-privacy/)
