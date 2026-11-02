> **草稿，使用前必须由合格律师审核。** 本文件不是法律意见，由非律师起草，只列出需要核查的问题。它不表示小豆芽符合任何法律。
>
> **DRAFT. Must be reviewed by a qualified lawyer before use.** This is not legal advice. It was written by a non-lawyer and only lists questions to examine. It does not state that the app complies with any law.

# 合规核对清单（给运营者）

依据的代码是 `origin/main` 的 `8f78078`（2026-11-01）。代码变了，第 2 节的数据清单要跟着改，隐私政策和两个商店的表单也要跟着改。

相关文档：[隐私政策](privacy-policy.zh.md)、[用户协议](terms.zh.md)、[Google Play 资料](../store/google-play.md)、[App Store 资料](../store/app-store.md)。

## 1. 需要你先决定的事

后面的答案大多取决于这些决定，这里的问题律师也无法替你回答。

| # | 决定 | 为什么现在要定 |
|---|---|---|
| D1 | **运营者是谁：个人还是公司，在哪个国家** | Apple 5.1.1(ix) 说“需要敏感用户信息”的 App 应该（should）由法律实体提交，不是个人开发者。Google 说提供“Health apps, such as medical apps and human subjects research apps”必须用组织账号（需要 D-U-N-S），婴儿记录 App 算不算，页面没有说。按需要法律实体来准备最稳妥。运营者所在地也决定适用哪些法律和监管机构 |
| D2 | **首发地区** | 决定第 3 节哪些要做。中国大陆的工作量明显比其他地区大，建议单独决定 |
| D3 | **用户最低年龄** | 协议里是 `[最低年龄]`。建议 18 岁（或当地成年年龄），因为用户是在替孩子做决定。现在注册时没有任何年龄确认 |
| D4 | **远程推送开不开，推送里写什么** | 现在的推送正文会把“体温 38.5℃”“吃药 · 药名 剂量”这样的内容发给 Expo，再经 FCM/APNs 送达，可能显示在锁屏上。建议改成“家人有新记录”这类不含健康内容的文字，或者首发不开推送。**已决定（2026-11-01）：不做远程推送**，家人的记录在打开 App 时提示 |
| D5 | **删除账号时，家庭共享数据怎么办（F-93）** | 一个人写的记录也是全家的资料。Apple 明确说账号删除要包括分享给别人的用户内容。**代码现在的做法（F-93，待律师确认）：** 普通成员离开时，他写的记录和上传的文件留给家庭，作者置空；唯一的管理员、还有别的家人时被拦下，要先升别人为管理员或移出家人；最后一位成员删除时，家庭和全部内容一起删除 |
| D6 | **商店版是否保留“服务器地址”和“自带存储”** | 这两项让数据去到运营者控制不了的地方，隐私政策和商店表单都要多写一层例外，审核员也可能困惑。F-95 做完后建议从商店版隐藏 |
| D7 | **数据放在哪里** | 现在推荐的是 Supabase 新加坡 + R2 APAC。面向欧盟或中国时可能要换区域或换架构。R2 的 APAC 只是位置提示，不是保证；R2 另有保证留在欧盟的 `eu` 辖区 |

## 2. 数据清单（从代码得出）

“服务端”默认指 Supabase Postgres（表名见 `apps/server/src/db.ts`）。业务内容都存在 `records.data`（JSONB），字段见 `packages/shared/src/schemas.ts`。**这些字段都没有字段级加密。**

| 数据 | 具体字段 | 存放 | 目的 | 能看到的人和接收方 | 敏感 | 今天的保留情况 |
|---|---|---|---|---|---|---|
| 账号 | `email`、`display_name`、`prefs`（提醒、夜间安静、时区、单位、证件锁、仅 Wi-Fi 传视频）、`created_at` | `users` | 登录、设置 | 本人。其他成员的接口不返回邮箱 | 否 | 保留到用户在 App 内删除账号（F-93） |
| 密码 | `password_hash`（scrypt，N=2^15） | `users` | 登录 | 无人能还原密码 | 高 | 同上 |
| 登录令牌 | `token_hash`（SHA-256）、`expires_at` | `sessions`；明文令牌只在手机 SecureStore | 保持登录 | 无 | 高 | 365 天，常用时自动续期。退出或被移出时删除；过期的行没有清理任务 |
| 家庭和成员 | `families.name`、`memberships.role/label/last_seen_at` | `families`、`memberships` | 共享和权限 | 全部成员能看到称呼、角色、最后上线时间 | 否 | 随家庭保留。没有删除家庭的接口 |
| 邀请 | `code_hash`、`role`、`label`、`created_by`、`expires_at`、`used_by/at` | `invites` | 邀请家人 | 管理员 | 否 | 7 天失效，但行不删除（除非未使用时被撤销） |
| 宝宝档案 | `name`、`birthAt`、`birthWeightKg`、`birthLengthCm`、`hospital`、`bloodType`、`avatar` | `records`（`baby`） | 建档、计算月龄 | **全部成员，包括 `viewer`** | **高**（儿童、健康、出生信息） | 随家庭保留 |
| 日常记录 | 喂奶 `ml`、尿布 `kind`、睡眠 `at/endAt`、体温 `celsius`、用药 `name/dose`、洗澡、辅食 `food`、身高体重、疫苗 `vaccineId/name`；`note`、`byName` | `records`（`event`） | 记录、提示、估算 | admin、caregiver；有推送时见下 | **高**（儿童健康） | 随家庭保留。删除只是打标记，见注 1 |
| 回忆和信 | `title`、`text`、`at`、`milestone`、`media`、`byName` | `records`（`moment`、`letter`） | 回忆、成长册 | 全部成员 | 高（儿童） | 同上 |
| 证件 | `name`、`subtitle`、**`number`（证件号，明文）**、`issuedOn`、`expiresOn`、`files` | `records`（`document`） | 保存资料 | admin、caregiver | **高**（证件号、可能含健康和财务内容） | 同上 |
| 文件 | 照片、视频、录音、PDF、缩略图 | Cloudflare R2（`families/<id>/<scope>/<id>/<variant>`） | 保存和展示 | 回忆和头像：全部成员；证件：admin、caregiver。谁拿到未过期的签名链接都能打开 | **高** | **删除记录不会删除文件**，见注 2 |
| 文件元数据 | `mime`、`size`、`filename`（原文件名）、`uploaded_by`；`MediaRef` 里还有时长、宽高、录音波形 | `media`、`records` | 上传校验、展示 | 同上 | 中（文件名可能含个人信息） | 同上 |
| 文件内嵌信息 | 照片 EXIF 等，可能含拍摄地点 | 文件内部 | 不使用 | 同文件 | 中 | 代码没有去除原文件内嵌信息的步骤。`exif: false` 只是不把 EXIF 返回给 JS，见注 3 |
| 推送标识 | Expo push token、App 生成的随机 `device_id`、`user_id` | `push_tokens`；设备 ID 也在 SecureStore | 发推送 | Expo；令牌也指向 FCM/APNs | 中 | 退出时删除。被移出的成员的行不删除，但不会再发送 |
| 推送内容 | 记录者称呼 + `describeEvent` 文本或回忆标题（例：`体温 38.5℃`、`吃药 · 药名 剂量`） | 不落库，发给 `exp.host` | 通知家人 | **Expo、Google FCM 或 Apple APNs**；可能显示在锁屏 | **高** | 服务端不存。第三方的保留情况未查明。只有 `PUSH_ENABLED=true` 时发生 |
| 存储配置 | `provider`、`account_id`、`endpoint`、`bucket`、`access_key_id`、`secret_encrypted`（AES-256-GCM，这是唯一有应用层加密的字段） | `storage_configs` | 家庭自带存储 | 管理员能看到除 Secret 外的字段 | 高 | 停用后仍保留，用于读旧文件 |
| 限流计数 | 含 IP + 邮箱、邮箱或用户 ID 的键的 SHA-256；次数 | `rate_limits` | 防暴力登录 | 无 | 低 | 15 分钟窗口，下次检查时清除 |
| 服务端日志 | 方法、路径、状态码、错误信息。代码不记请求体、令牌和签名链接 | Supabase 日志 | 排错 | 运营者、Supabase | 低（路径可能含 ID） | 取决于 Supabase |
| 平台日志 | IP、请求元数据等，由平台记录 | Supabase、Cloudflare、Expo | 平台自身 | 这些服务商 | 中 | 取决于服务商，**未查明** |
| 数据库备份 | `public` 下全部表，`openssl` 加密 | R2 `backups/` | 灾难恢复 | 持有口令的运营者。GitHub Actions 方式下，加密前的数据流经过 GitHub 的 Runner | **高** | 每天一份，lifecycle 规则 30 天后删除（规则要手工配置）。**不含文件本身** |
| 手机本地 | `xiaodouya.db`（SQLite，**没有加密**）；`uploads/` 文件副本；图片缓存；SecureStore（令牌、服务器地址、账号信息、设备 ID） | 手机 | 离线使用 | 能进入手机的人 | **高** | 主动退出、删除账号或换账号时清除；**登录过期或被移出时保留**。账号在别的手机上删除后，这台手机只知道登录失效，数据要等下次换账号登录才清除 |
| 导出的成长册 | 回忆和信，每条最多 6 张图 | 用户选择的位置 | 分享 | 用户自己决定 | 高 | 不受运营者控制 |
| 导出的家庭数据 | 当前角色能读的全部记录（含证件号）和文件信息，不含文件本身和其他成员的邮箱 | 用户选择的位置 | 数据可携带（F-93） | 用户自己决定 | **高** | 手机缓存里留一份，退出或删除账号时清除；分享出去后不受运营者控制 |
| 分享一天（F-105） | 宝宝名字、第几天和月龄、日期、分享者时区、所选的记录和回忆（健康记录默认不含）、记录者称呼、原文件的 1 小时签名链接。库里存 `shares`：令牌的 SHA-256、范围、时区、选项、单位、到期和撤销时间、创建者 | 响应不落库；`shares` 表 | 用户主动分享给第三方 | **拿到链接的任何人**；经过 Cloudflare（网页）、Supabase（接口）、R2 或家庭自带存储（文件）。第三方的 IP 由这些服务商处理 | **高**（孩子的健康记录、照片；原文件可能带 EXIF 位置，见注 3；签名链接里有家庭 UUID 和存储地址） | 按选的 1、7、30 天到期，可撤销；撤销后已发出的文件链接最多还能用 1 小时；失效 30 天后 `cli maintenance` 删除这一行（`MAINTENANCE_ENABLED` 打开时）。**要律师看：** 把孩子的健康记录发给第三方算不算需要单独同意；页面上是否要声明；被分享的第三方是否算数据接收方。商店的数据安全表要补这一项 |
| 验证码 | HMAC（`APP_SECRET`）后的验证码、用途、有效期、尝试次数 | `email_codes` | 邮箱验证、找回密码 | 无 | 中 | 30 分钟内有效，用过或账号删除时删除；过期没用的行留到下次发新的 |
| 邮件（上线前开启） | 收件地址、验证码 | Resend（代码已支持，线上没有开启）| F-92 | 邮件服务商 | 中 | 取决于服务商，**未查明** |
| 待删除文件队列 | 文件路径；家庭自带存储时含存储配置和加密的 Secret | `pending_object_deletions` | 账号删除后清理存储 | 运营者 | 中 | 删除成功后移除。对方存储一直失败时会留到运营者处理 |

**没有收集的：** 代码里没有定位、通讯录、日历、HealthKit、Health Connect，也没有广告、分析、崩溃上报 SDK（在 `apps/mobile`、`apps/server`、`packages/shared` 里搜索过）。指纹和面容由系统处理，App 只拿到成功或失败。

**注：**

1. `store.remove` 只把记录标成 `deleted`，同步时带着完整的 `data` 发送（`syncEngine.ts`），服务端原样保存（`app.ts` 里 `change.deleted ? change.data : ...`）。所以**用户删除的记录内容仍然留在服务器上**。建议：同步时把已删除记录的 `data` 清空，只留墓碑。这不影响 AGENTS.md 的软删除同步规则，但要改代码，也要评估撤销功能。
2. 删除回忆或证件后，文件要等宽限期（默认 30 天）结束才由定时清理从平台存储删除，定时任务没打开时一直留着；家庭自带存储里的不清理。删除账号时走待删除队列（F-93），不等宽限期。
3. 是否保留 EXIF 取决于系统选择器和文件来源，没有在真机上验证过。`expo-document-picker` 选的文件是原样上传的。建议上传前去除元数据，这样隐私政策和商店表单都能写得更简单。
4. `viewer` 能读 `baby`，也就是能看到血型和出生医院。`docs/ARCHITECTURE.md` 的权限表没有列这一项。如果不是有意为之，应该把健康字段挪出去或者过滤。
5. 被移出的成员手机上已经同步的内容不会被清除（`ARCHITECTURE.md`“登录失效和本地数据”）。隐私政策已如实写明。如果想改变，需要改代码。
6. 删除账号时 `created_by/updated_by` 会被置空，但 `byName`、回忆文字里的姓名是自由文本，不会变。

## 3. 各地区要核查什么

**来源状态：**

- **已打开**：用 WebFetch 打开过页面（内容经工具摘要，引用前请对照原文）。
- **仅搜索摘录**：页面打不开，只看到搜索工具返回的摘录，没有读过原文。
- **无法打开**：打开失败。错误写在第 5 节。

凡是“未核对原文”的内容，都来自起草者的一般了解，只作为律师的线索，不能当作依据。

### 3.1 欧盟 GDPR（面向欧盟时）

| | |
|---|---|
| **要问的问题** | 运营者不在欧盟时是否因“向欧盟的人提供服务”而适用（第 3 条）；宝宝健康记录能否基于明示同意处理（第 9 条）；家长替孩子提供数据时，谁同意、同意什么（第 8 条针对孩子自己同意的信息社会服务，这里是家长在用，要问律师怎么适用）；是否需要 DPIA（第 35 条）和欧盟代表（第 27 条）；向新加坡和美国传输用什么机制（第五章）。家庭成员自己使用可能属于“家庭活动”豁免，但运营者不在豁免之内 |
| **App 今天** | 把健康数据存在新加坡区域。Supabase 的资料说向新加坡和美国的传输依赖 SCC（已打开）。注册时没有任何同意步骤。没有自助的访问、删除、可携带功能。成长册 PDF 只含回忆和信 |
| **缺什么** | 敏感数据的单独明示同意界面；隐私政策上线和 App 内入口；F-93 删除、完整导出；与 Supabase、Cloudflare、Expo、邮件服务商的 DPA；SCC 和传输影响评估；DPIA；处理活动记录；72 小时内的泄露通知流程（第 33 条，未核对原文）；可能需要的欧盟代表 |
| **要律师** | **是：** 合法性基础、第 8 条如何适用、是否需要代表和 DPO、传输机制、各成员国对健康数据的附加规定 |
| **来源** | [GDPR, EUR-Lex](https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng)：无法打开。仅搜索摘录看到第 3、8 条，**第 9 条原文没有取到**。[EDPB 第 3 条指南](https://www.edpb.europa.eu/system/files/documents/files/file1/edpb_guidelines_3_2018_territorial_scope_after_public_consultation_en_1.pdf)：仅搜索摘录 |

### 3.2 英国 UK GDPR 和 Children's code（面向英国时）

| | |
|---|---|
| **要问的问题** | 同 3.1，另外：英国的传输机制（IDTA 或 Addendum）；英国代表；Data (Use and Access) Act 2025 带来的变化（没有查到，交给律师）。**Children's code：** 测试是孩子“更可能会使用”这项服务，而不只是针对孩子。小豆芽面向成人，孩子只是被记录的对象，商店资料也不应吸引孩子，所以可能不在范围内，但这要写成书面评估。ICO 还把揭示儿童健康信息列为高风险活动，通常要做 DPIA |
| **App 今天** | 同 3.1。没有年龄确认 |
| **缺什么** | 同 3.1；Children's code 适用性的书面评估；UK 传输文件 |
| **要律师** | **是** |
| **来源** | [ICO Children's code 适用范围](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/childrens-information/childrens-code-guidance-and-resources/age-appropriate-design-a-code-of-practice-for-online-services/services-covered-by-this-code/)：HTTP 503，无法打开，仅搜索摘录。[ICO 特殊类别数据](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/lawful-basis/special-category-data/what-is-special-category-data/)、[ICO 国际传输](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/international-transfers/international-transfers-a-guide/)：HTTP 503，无法打开，也没有摘录。[UK GDPR 第 9 条](https://www.legislation.gov.uk/eur/2016/679/article/9)：无法打开 |

### 3.3 新加坡 PDPA

| | |
|---|---|
| **要问的问题** | 在新加坡有用户或运营者时适用。同意和通知义务怎么做；PDPC 儿童指南的 13 岁线：13 至 17 岁通常可自行同意，未满 13 岁要父母或监护人同意。这里是家长提供孩子的数据，要确认按“代表孩子”处理的条件；传输限制（第 26 条）；保留限制（第 25 条，法律没有固定年限，要运营者自己定）；泄露通知（第 26A 至 26E 条，摘录显示评估后 72 小时内通知 PDPC） |
| **App 今天** | 数据计划放在新加坡（Supabase），但 R2 的 APAC 位置不保证留在新加坡，Expo 可能在美国处理。没有保留期限，没有同意界面 |
| **缺什么** | 同意和通知界面；书面的保留期限；Data Protection Officer 的指定和公开联系方式（未核对原文）；对境外服务商的尽职调查和合同；泄露处理流程 |
| **要律师** | **建议：** 代表孩子同意的依据、保留期限、新加坡身份证号（NRIC）类证件号码的处理（PDPC 另有针对 NRIC 的指南，未核对原文，App 证件夹可能存这类号码） |
| **来源** | [PDPA, SSO](https://sso.agc.gov.sg/Act/PDPA2012)：无法打开。[PDPC 儿童数据指南](https://www.pdpc.gov.sg/-/media/files/pdpc/pdf-files/advisory-guidelines/advisory-guidelines-on-the-pdpa-for-children's-personal-data-in-the-digital-environment_mar24.pdf)：无法打开，仅搜索摘录。[PDPC 关键概念指南](https://www.pdpc.gov.sg/-/media/files/pdpc/pdf-files/advisory-guidelines/ag-on-key-concepts/advisory-guidelines-on-key-concepts-in-the-pdpa-17-may-2022.pdf)、[泄露管理指南](https://www.pdpc.gov.sg/-/media/Files/PDPC/PDF-Files/Other-Guides/Data-Breach-Management/Introduction-to-Managing-Data-Breaches-2-0.pdf)：仅搜索摘录 |

### 3.4 中国 PIPL、儿童规定、App 备案（面向中国大陆时）

**工作量最大。** 先决定 D2：可以暂不在中国大陆上架，也要问律师，这样做能否避开境外适用。

| | |
|---|---|
| **要问的问题** | ① 境外运营者是否因向境内自然人提供服务而适用（第 3 条，未核对原文），是否要设境内代表（第 53 条，未核对原文）。② **敏感个人信息：** 第 28 条把不满十四周岁未成年人的个人信息列为敏感个人信息，医疗健康也是。这意味着这款 App 的核心数据基本都落在这一类。需要单独同意（第 29 条，未核对原文）和影响评估（第 55 条，未核对原文）。③ **第 31 条：** 处理不满十四周岁未成年人信息要取得父母或其他监护人同意，并制定专门的处理规则。④ **《儿童个人信息网络保护规定》：** 第 2 条儿童指不满十四周岁；第 8 条要有专门的儿童个人信息保护规则和用户协议，并指定专人负责；第 9 条要显著、清晰地告知监护人并取得同意，告知事项实质变化时要再次同意。⑤ 《未成年人网络保护条例》：没有取到原文，交给律师。⑥ **出境：** 《促进和规范数据跨境流动规定》第 7、8 条的门槛（摘录）：当年累计出境敏感个人信息不满 1 万人要标准合同或认证，1 万人以上要安全评估。第 5 条有合同履行等例外，能否适用要问律师。存放在新加坡本身就是出境。⑦ **App 备案：** 工信部信管〔2023〕105 号通知要求在境内提供互联网信息服务的 App 主办者备案，在 App 内显著展示备案号，分发平台不得为未备案 App 提供服务 |
| **App 今天** | 没有监护人同意界面，没有儿童个人信息专门规则，没有备案，服务器不在境内。FCM 在大陆通常不可用（未核实），推送可能不工作。Google Play 在大陆不可用，安卓要走国内应用商店，各商店还有自己的要求（未核实） |
| **缺什么** | 上面全部；App Store 的 ICP 备案号字段（Apple 文档确认部分 App 需要，且未提供时显示“ICP Filing Number Missing”，已在搜索中看到）；可能需要的境内主体和服务器 |
| **要律师** | **必须：** 这一节全部。隐私政策草稿第 13 节不能直接当作专门规则使用 |
| **来源** | [PIPL，全国人大](http://www.npc.gov.cn/npc/c2/c30834/202108/t20210820_313088.html)：无法打开，仅搜索摘录（第 28、31 条）。[儿童个人信息网络保护规定，网信办](https://www.cac.gov.cn/2019-08/23/c_1124913903.htm)：无法打开，仅搜索摘录（第 2、8、9 条）。[促进和规范数据跨境流动规定，中国政府网](https://www.gov.cn/gongbao/2024/issue_11366/202405/content_6954192.html)：仅搜索摘录。[App 备案通知，工信部](https://www.miit.gov.cn/zwgk/zcwj/wjfb/tz/art/2023/art_920db564162e4312916a01bed6540ad8.html)：无法打开，仅搜索摘录。[Apple ICP 说明](https://developer.apple.com/help/app-store-connect/reference/app-information/app-and-submission-statuses/)：仅搜索摘录 |

### 3.5 美国 COPPA

| | |
|---|---|
| **要问的问题** | COPPA 针对“面向 13 岁以下儿童”的服务和实际知道在收集 13 岁以下儿童信息的运营者。FTC FAQ F.4 写道它“does not cover information collected from adults that may pertain to children”。小豆芽的用户是家长，所以**可能不适用**，但要确认：App 或商店资料是否会被认定为面向儿童；有没有未满 13 岁的孩子自己注册；如果孩子长大后自己用账号怎么办 |
| **App 今天** | 没有年龄确认。注册只要邮箱和密码。没有广告。面向家长的文案，但视觉风格可能偏柔和 |
| **缺什么** | 协议里写明面向成人（已写，待你定 `[最低年龄]`）；中性年龄确认（要不要做，问律师）；发现孩子账号时的处理流程；商店资料不面向儿童（已按此起草）。FAQ 提到规则在 2025-04-22 修订过，要看新规 |
| **要律师** | **是：** 确认不适用的结论，写成书面意见 |
| **来源** | [FTC COPPA FAQ](https://www.ftc.gov/business-guidance/resources/complying-coppa-frequently-asked-questions)：已打开（只读了前 100000 字符）。[16 CFR 312, eCFR](https://www.ecfr.gov/current/title-16/chapter-I/subchapter-C/part-312)：被重定向到人工验证页，没有继续，未读 |

### 3.6 美国各州健康数据法：华盛顿 My Health My Data Act 等

| | |
|---|---|
| **要问的问题** | 只要向华盛顿州消费者提供服务就算 regulated entity，不是看运营者在哪。Consumer health data 的定义很宽。Consumer 是华盛顿居民或健康数据在华盛顿收集的自然人，孩子和家长的关系法条没有直接写，要问律师。有私人诉权（AG FAQ 摘录：违反即违反消费者保护法） |
| **App 今天** | 收集宝宝和可能关于家人的健康信息，没有美国地区限制的设置 |
| **缺什么** | RCW 19.373.020：单独的 Consumer Health Data Privacy Policy，**从网站首页显著链接**（AG FAQ 摘录说要独立链接，不能夹杂其他内容）。这意味着运营者要有网站。19.373.030：收集和分享要各自同意，接受一般条款不算同意，除非是提供所请求服务所必需。19.373.040：删除请求要在 45 天内处理（可延长一次 45 天），备份最长 6 个月，并通知接收过数据的处理者。F-93 的设计要满足这些。其他州（比如内华达 SB 370）没有查，交给律师 |
| **要律师** | **是：** 是否要做地理限制；推送发给 Expo 算不算需要单独同意的“分享” |
| **来源** | [RCW 19.373](https://app.leg.wa.gov/RCW/default.aspx?cite=19.373&full=true)：已打开（读了前 100000 字符）。[WA AG 页面](https://www.atg.wa.gov/protecting-washingtonians-personal-health-data-and-privacy)：HTTP 403，无法打开。[WA AG FAQ](https://www.atg.wa.gov/HB1071-FAQ)：仅搜索摘录 |

### 3.7 美国 FTC Health Breach Notification Rule

| | |
|---|---|
| **要问的问题** | 任务清单之外加上的一项。规则针对个人健康记录（PHR）供应商，PHR 是“有技术能力从多个来源获取”可识别健康信息的电子记录。FTC 的例子包括用户手动输入加其他来源的 App。小豆芽现在只有家人手动录入，要问律师：多名家人录入算不算多来源，HIPAA 不适用的健康 App 是否可能落在这里 |
| **App 今天** | 没有泄露响应流程 |
| **缺什么** | 泄露响应流程；FTC 页面写明未经授权的披露也算违规，而且要在发现后 60 天内通知 |
| **要律师** | **是** |
| **来源** | [FTC HBNR 指引](https://www.ftc.gov/business-guidance/resources/complying-ftcs-health-breach-notification-rule-0)：已打开 |

### 3.8 美国 HIPAA

| | |
|---|---|
| **要问的问题** | HIPAA 约束 covered entity（医疗机构、健康计划、清算所）和它们的 business associate。HHS 的情景文件（摘录）说，开发者直接面向消费者、不受医疗机构委托时，通常不是 business associate。小豆芽**很可能不适用** |
| **App 今天** | 直接面向家庭。没有和诊所、医院、保险公司对接，也没有代表它们处理数据 |
| **缺什么** | 不需要做什么，但不要写“符合 HIPAA”。将来如果和诊所、医院或保险公司合作，要重新评估 |
| **要律师** | 确认一次即可；重要的是 3.6 和 3.7 |
| **来源** | [HHS Health App Use Scenarios](https://www.hhs.gov/sites/default/files/ocr-health-app-developer-scenarios-2-2016.pdf)：仅搜索摘录（2016 年）。[HHS access right, health apps](https://www.hhs.gov/hipaa/for-professionals/privacy/guidance/access-right-health-apps-apis/index.html)、[HHS covered entities](https://www.hhs.gov/hipaa/for-professionals/covered-entities/index.html)：HTTP 403，无法打开 |

### 3.9 医疗器械监管（任务清单之外加上的一项）

| | |
|---|---|
| **要问的问题** | App 对外说“不是医疗器械”，但这句话不决定法律上的分类。体温提示会按月龄和温度给出“请尽快就医”，这是否让它被认定为医疗软件？风险在 `packages/shared/src/health/index.ts` 的规则，以及未来可能增加的功能 |
| **App 今天** | 提示保守，只建议联系医生，不给诊断或用药剂量。规则来源写在代码旁，部分是二手资料。**内容没有经过医护复核**（F-11、F-37、F-100） |
| **缺什么** | 各地区医护复核；律师或法规顾问对分类的意见（FDA、欧盟 MDR、新加坡 HSA、中国 NMPA）；不加入诊断、用药建议类功能之前都要先评估 |
| **要律师** | **是**（法规顾问） |
| **来源** | [FDA 移动医疗应用指南](https://www.fda.gov/regulatory-information/search-fda-guidance-documents/policy-device-software-functions-and-mobile-medical-applications)：已打开概览页，未读全文。其他地区未查 |

## 4. 动作清单

按上线前的顺序排列。

**必须改代码（不在这个文档任务的范围内）：**

- [ ] 注册流程加入隐私政策和用户协议的链接，以及儿童和健康数据的单独明示同意（Apple 5.1.2、Google 用户数据政策、GDPR 第 9 条、PIPL 第 29 和 31 条、RCW 19.373.030 都涉及）。现在 App 里完全没有隐私或协议的入口
- [ ] App 内有常驻的隐私政策入口（Apple 5.1.1(i)、Google 用户数据政策都要求）
- [ ] F-93：App 内删除账号已实现，还没在设备上验证。最后一位成员删除时，R2 文件、软删除的记录内容、`push_tokens`、`sessions`、`invites` 都会清掉。普通成员离开时家庭的记录和文件留下，他自己软删除过的内容也留下，是否符合要求要律师确认。不打开 App 就能提交的删除网页还没有做，上线前要做
- [ ] F-92：自助找回密码已实现，上线前要开通邮件服务（Resend、已验证的发件域名）。没开时还是由运营者在服务器上重置
- [ ] 完整数据导出：JSON 已实现，含当前角色能读的记录和文件信息，**不含照片、视频、录音和证件文件本身**。是否够满足可携带权要律师确认
- [ ] 已删除记录清空内容（第 2 节注 1）；删除记录时清理文件（注 2）
- [ ] 上传前去除 EXIF 等元数据（注 3）
- [ ] 决定 `viewer` 能否看到血型和出生医院（注 4）
- [x] 推送内容去掉健康细节（D4）：不做远程推送，`PUSH_ENABLED` 保持关闭
- [x] 去掉 `prefs.timezone` 写死的问题：App 启动后写入手机的时区（F-90）。没存过时区的旧账号在服务端仍按 `Asia/Singapore`，因为 v0.1.0 不上报时区
- [ ] 确认 iOS 的 iCloud 设备备份是否包含 SQLite 和 `uploads/`，Apple 5.1.3(ii) 不允许把个人健康信息存在 iCloud（详见 [App Store 资料](../store/app-store.md)）

**必须由运营者完成（不写代码）：**

- [ ] D1 至 D7 的决定
- [ ] 找律师审核隐私政策、用户协议和这份清单，按上线地区补全
- [ ] 公开可访问的网站：隐私政策网址（不能是 PDF，不能地理封锁）、账号删除网址、支持网址；如面向美国，还有单独的 Consumer Health Data Privacy Policy
- [ ] 和 Supabase、Cloudflare、Expo（如用推送）、邮件服务商签 DPA 或确认条款。GitHub Actions 用于备份时，加密前的数据要经过它，**建议改到自己控制的机器上跑备份**
- [ ] 查明各服务商的日志和推送内容保留期，补进隐私政策
- [ ] 写内部制度：谁能访问生产数据库，什么情况下访问，怎样留痕。隐私政策里这条现在是 `〔待落实〕`
- [ ] 写泄露响应流程：判断、时限（GDPR、PDPA、FTC 规则各不相同）、通知模板
- [ ] 请医护复核健康内容（F-100）
- [ ] 确认备份真的配置了（F-79：还没有在真实 Supabase 上跑过）；演练恢复；lifecycle 规则确实是 30 天

## 5. 打不开的来源

2026-11-01 尝试。这些站点用 WebFetch 打开时失败。

| 站点 | 错误 |
|---|---|
| eur-lex.europa.eu、commission.europa.eu、edpb.europa.eu | `Socket is closed` |
| legislation.gov.uk | `Socket is closed` |
| ico.org.uk | HTTP 503 |
| sso.agc.gov.sg、pdpc.gov.sg | `Socket is closed` |
| npc.gov.cn、cac.gov.cn、miit.gov.cn、gov.cn、stats.gov.cn、hunan.gov.cn | `Socket is closed` |
| hhs.gov、atg.wa.gov | HTTP 403 |
| ecfr.gov | 重定向到人工验证页 `unblock.federalregister.gov`，没有继续 |

律师审核时请直接读这些原文。第 3 节里标“未核对原文”和“仅搜索摘录”的内容，都要在依赖前核对一遍。
