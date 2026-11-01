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
- **“服务端说有更新但同步失败”的循环要有退避。** `/sync/wait` 在游标落后时立刻返回，没有退避就是死循环，会占满 JS 线程，整个 App 卡死。
- **宝宝档案的记录 id 用家庭 id。** 否则换手机的管理员在同步完成前再建一次档，新记录会覆盖全家的出生时间。同时要等第一次同步成功才显示建档页。
- **恢复旧备份会让家庭 seq 回退，手机的游标就超前了。** 服务端返回 `Math.max(upperBound, cursor)`，手机看不到家人新写的记录，也不报错，直到 seq 追上游标。协议还没有处理这种情况，目前只在部署文档里要求恢复后全家退出再登录。

- **从旧备份恢复后 seq 会倒退。** 手机游标比服务端还新时，如果不处理就会永远漏掉新记录。服务端发现这种情况要从头发送。

## 账号和登录

- **401 只代表要重新登录，不代表要清数据。** 本地可能有未同步的记录。只有换人或换家庭才清，主动退出才全清。
- **只认服务端返回的 `unauthenticated`。** 公共 Wi-Fi 的登录页和代理也可能返回 401。
- **处理 401 前要确认令牌还是发请求时那个。** 否则旧请求的响应晚到，会踢掉刚登录的新会话。

## 上传和存储

- **R2 预签名链接不能用于自定义域名。** 只能走 `<account>.r2.cloudflarestorage.com`。私有文件不要拼 CDN 域名。
- **SigV4 签名包含 Host。** 给手机的预签名链接必须用手机能访问的地址生成（`S3_PUBLIC_ENDPOINT`），不能用容器内部地址。
- **R2 的 APAC 只是位置提示。** 不保证数据在新加坡，界面和文档不要这样写。
- **一个文件传不上去不能挡住后面的文件。** 失败的先跳过，这一轮结束后再退避重试；存储持续报错要有次数上限。
- **退出登录的警告要同时算记录和上传队列。** 记录都同步了不代表视频也传了。
- **SeaweedFS 写入时会自动建 Bucket，R2 和 S3 不会。** “Bucket 不存在”在本地测不出来，要测错误翻译函数。
- **内网地址判断不能用字符串。** `::ffff:7f00:1` 就是 127.0.0.1，用 `net.BlockList`。
- **开发 SeaweedFS 的卷位用满后，写入新 Bucket 返回 500。** 它给每个 Bucket 单独分卷，`-volume.max=20` 用完就报 `No writable volume`，已有的 Bucket 不受影响。看起来像预签名出错，先看 S3 容器的日志。

## 健康内容

- **睡眠中的提示不能盖住“偏少”的提醒。** 先判断风险，再显示其他内容。忘记结束的睡眠也不能当真。
- **网页上的医学来源经常读不到。** NICE 和 MOH PDF 在这个环境下返回 403 或连接失败。读不到原文就在注释和 PROGRESS 里写明“二手来源，需复核”，不要写成已核实。

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
- **要让卡片不挡住下面的点击，整条路径都要处理。** 容器用 `box-none` 还不够：里面的普通 View 和 Text 仍会成为点击目标，点击不会穿透给下面的页面。不需要响应的部分要包在 `pointerEvents="none"` 里。

## Android 构建和模拟器

- **第一次 Gradle 构建要装 NDK，慢网下超过 1 小时。** 放后台跑，不要给短超时。之后的增量构建快得多，但 R8 这一步仍要几分钟。
- **Gradle 内存在 `scripts/android-build.sh` 里限制（`GRADLE_HEAP`、`GRADLE_WORKERS`）。** 本机内存紧张，不要让 Gradle 和模拟器同时高负载。
- **`adb input text` 批量注入会丢字符。** 它和输入法组字冲突，看起来像 App 的 Bug，其实不是。用 `scripts/adb-ui.py` 逐字输入。
- **键盘没开时按返回键会退出页面。** 用 `adb-ui.py hide`，它会先判断键盘状态。
- **本机不能直接下载运行 Maestro。** 权限系统会拦下外部代码。本地用 `adb-ui.py` 做探索性测试，Maestro 流程在 CI 上跑。
- **改 `build.gradle` 不能用跨块的正则。** 旧脚本在 release 排在 debug 前面时，会把正式密钥配给 debug，自己还正常退出。要先按花括号找到 release 块，只在块内替换，找不到就报错。

## 依赖和环境

- **`minio/minio` 镜像已无法公开拉取。** 本地和 CI 的 S3 用 `chrislusf/seaweedfs`。
- **pnpm 11 有发布冷却期，拒绝发布不足 24 小时的包。** 不要关闭它，把版本固定到更早的发布。改了版本还报错就删掉 `node_modules`，旧锁文件缓存在里面。
- **pnpm 11 用 `allowBuilds` 允许构建脚本。** 不是 `onlyBuiltDependencies`。
- **慢网下 `expo install` 会超时。** 从 `node_modules/expo/bundledNativeModules.json` 取版本写进 `package.json`，再用长超时运行 `pnpm install`。
- **Git worktree 里不能软链 `node_modules`。** `@xiaodouya/shared` 解析不到，每个 worktree 要自己 `pnpm install`。
- **`pkill -f 模式` 会匹配到自己所在的 shell。** 模式出现在命令行里就会把脚本自己杀掉，后面的清理步骤不会执行。
- **`nodeLinker: hoisted` 下 `pnpm install --filter` 不起过滤作用。** 服务端镜像曾因此下载全部 React Native（640 多个包），慢网下超时。Dockerfile 要加 `--node-linker=isolated`（104 个包），之后的 `pnpm run` 还要关掉 `verify-deps-before-run`，否则它会重新安装并报 Broken lockfile。

## CI

- **CI 不要用 `google_apis` 镜像。** Pixel Launcher 和 Google 服务在 CI 上太重，开机后会弹“isn't responding”挡住 App，现象是流程 01 失败、截图里 App 其实已经渲染。`hide_error_dialogs` 压不住这个弹窗。CI 改用 `target: default`。
- **`upload-artifact` 默认跳过隐藏目录。** 上传 `.artifacts` 要加 `include-hidden-files: true`，否则失败时什么现场都没有。
- **`setup-android` 默认安装已不存在的 `tools` 包。** 要写 `packages: platform-tools`。

## 部署

- **psql 遇到错误默认继续执行，最后还退出 0。** 把备份导入已有表的库，报了 48 个错，数据没恢复，看起来却成功了。必须加 `-v ON_ERROR_STOP=1 --single-transaction`。
- **不完整的备份可能是合法的 SQL。** 先删库再导入时，截断的备份不报错，提交后是一个空数据库。清空之前先检查结尾的 `dump complete` 标记，`deploy/restore.sh` 就是这样做的。
- **同时有 `image` 和 `build` 的服务，拉取被拒绝时 Compose 会自动改成本机构建。** 没有发布过镜像时“方式 A”其实在构建，还能成功，所以这样测不出镜像的问题。
- **在本机验证生产配置时，`ports` 会合并而不是覆盖。** 覆盖文件要写 `ports: !override [...]`，否则还是会占用 80 和 443。`COMPOSE_PROJECT_NAME` 优先于文件里的 `name:`，不改 `backup.sh` 也能指向测试环境。

## 测试方法

- **回归测试要先在修复前的代码上看它失败。** 没失败过的测试不能证明它抓得到问题。这个项目里压测没能复现游标竞态，看到失败才发现测试本身不够。
- **用 `uiautomator` 或 Maestro 点 Toast 里的按钮可能点空。** 取一次界面要好几秒，Toast 已经消失，点击会穿透到下面的内容。E2E 构建已把 Toast 放长到 8 秒。
- **“断言失败、截图里弹层还开着”不一定是时序问题。** 这里实际是 Toast 盖住了弹层底部的按钮，真实用户也会点空。第一反应是怪测试时，先用真实操作顺序复现一遍。
- **`takeScreenshot` 的文件在 Maestro 的调试目录里。** CI 产物路径是 `maestro/<流程>/takeScreenshot/.artifacts/`，失败现场在 `maestro/<流程>/screenshots/`。
- **测试整体没有输出时，先怀疑死循环。** 紧循环占满事件循环时，vitest 不会打印任何东西，只会超时。

## 并行开发

- **`.claude/worktrees/` 必须被忽略。** 否则 `git add -A` 会把子 Agent 的 worktree 当成嵌入仓库提交，Biome 也会因为嵌套配置报错。
- **服务端集成测试每次运行用独立的数据库。** 以前用 `TRUNCATE`，两个 Agent 同时跑会互相删数据。不要改回去。
- **模拟器只有一台。** `scripts/e2e.sh` 用文件锁排队，手动用 `adb-ui.py` 前先确认没有 E2E 在跑。
- **8787 端口已有服务时，`e2e.sh` 会直接复用它。** 那可能是别的分支的代码，脚本会打印警告。改了服务端就先停掉旧服务。
- **Biome 不要格式化 Markdown。** 它会重新对齐表格列宽，改一行就动到整张表，并行开发时 `PROGRESS.md` 必然冲突。已在 `biome.json` 里排除。
