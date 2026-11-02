# AGENTS.md — 小豆芽开发规范

这个项目**完全由 Code Agent 开发和维护**。这份文件是所有 Agent 的工作合同，先读完再动手。
与这里冲突的习惯一律以这里为准；规范本身过时了，就在同一个提交里改它。

## 1. 产品是什么

小豆芽（xiaodouya）是一个**面向各个国家公开发布**的宝宝成长 App：一家人一起记录喂奶、尿布、睡眠，保存照片、视频、录音和证件。

不要默认用户在某个国家或说某种语言。和国家有关的内容（疫苗表、单位、证件）放进地区配置，界面文字走多语言，新增国家不应该需要改页面代码。

三条产品底线，任何改动都不能破坏：

1. **半夜单手一两下就能记好。** 记录永远先写本地、立即成功，不等网络。
2. **不丢数据。** 离线写入、上传失败、App 被杀之后都要能恢复；撤销之外不做硬删除。例外只有两个：用户主动删除账号（输入密码确认后，账号和只属于这个账号的数据立即删除）；文件清理（所在记录删除满 30 天、且核对过没有其他记录在用，才由维护任务清理）。见 `docs/ARCHITECTURE.md`。
3. **美观好用是验收标准，不是加分项。** 视觉必须符合 `docs/design/SPEC.md`，UI 改动必须看过模拟器截图才算完成。

## 2. 仓库结构

```
apps/mobile/       Expo + React Native App（Expo Router，TypeScript）
apps/server/       Hono + Postgres 服务端（TypeScript），Node 和 Deno（Supabase Edge Function）共用
apps/share-web/    分享页：对方不用装 App 打开的静态网页，发布到 Cloudflare Worker 静态资源
packages/shared/   前后端共用：zod 契约、领域逻辑（喂奶估算、疫苗表、月龄计算）
e2e/               Maestro 端到端流程和测试辅助脚本
supabase/          Edge Function 入口和配置，代码由 scripts/build-edge.mjs 从 apps/server 打包
deploy/            生产 Docker Compose、Caddy、备份脚本
docs/              DEPLOYMENT.md、ARCHITECTURE.md、CAPACITY.md（容量和成本）、PROGRESS.md（功能进展）、PITFALLS.md（踩坑记录）、design/SPEC.md
.github/workflows/ CI
```

依赖方向：`mobile → shared ← server`，`share-web → shared`。`shared` 不能依赖 React Native 或 Node 专属 API。
**纯业务规则放 `shared` 并写单元测试**，不要埋在组件或路由里。

## 3. 常用命令

工具版本由 `.mise.toml` 固定（Node、Java）。在仓库根目录执行：

| 目的                                             | 命令                                           |
| ------------------------------------------------ | ---------------------------------------------- |
| 安装依赖                                         | `pnpm install`                                 |
| 启动开发依赖（Postgres + S3 兼容服务 SeaweedFS） | `pnpm dev:infra`                               |
| 启动服务端                                       | `pnpm dev:server`                              |
| 启动 App 的 Metro                                | `pnpm dev:mobile`                              |
| 全部静态检查 + 单元测试                          | `pnpm check`                                   |
| 服务端集成测试（需要 dev:infra）                 | `pnpm test:server`                             |
| 在 Deno 上跑 Edge Function 入口（需要 dev:infra 和 Deno） | `pnpm test:edge`                      |
| 编译 Android                                     | `pnpm android:build`（debug APK）              |
| 启动无窗口模拟器                                 | `pnpm emulator`                                |
| 端到端测试                                       | `pnpm e2e`                                     |
| 模拟器截图                                       | `pnpm screenshot <名字>`（存到 `.artifacts/`） |

本地端口（避开已有服务）：Postgres `55432`、S3 `59000`、服务端 `8787`。
模拟器里访问宿主机要用 `10.0.2.2`。

## 4. 完成的定义

没做完下面这些，不能说“完成”：

1. `pnpm check` 通过。
2. 改了服务端或同步逻辑：`pnpm test:server` 通过。
3. 改了 UI 或用户流程：在模拟器上实际跑过，**看过截图**，并和设计规范对照。
4. 新的用户流程或修过的流程级 Bug：补一条 Maestro 或集成测试。
5. 汇报时如实说明：跑了什么、结果如何、什么没测（例如只有真机才能验证的后台行为）。
6. 新的测试要先在修复前的代码上看到失败。
7. 更新了 `docs/PROGRESS.md`；踩了坑就更新 `docs/PITFALLS.md`（见第 11 节）。

测试失败就是失败。不要跳过、删除或放宽测试来变绿；确实是测试错了，要说明理由。

## 5. 代码规范

- TypeScript `strict`，不用 `any`；外部输入（请求体、同步数据、存储内容）一律先过 zod。
- 前后端的请求和数据结构只在 `packages/shared` 定义一次。
- 优先用平台和现有依赖；加新依赖要说明理由，App 依赖用 `npx expo install` 保证版本匹配。
- 注释只写“为什么”，不写代码已经表达的“做了什么”。
- 用户可见文案走 `packages/shared/src/i18n` 的目录，中文和英文都要写：`zh/` 是基准，`en/` 用类型保证不缺键，缺了编译不过。代码里写 `t().模块.键`，不能写在模块顶层（语言还没定），`apps/mobile` 里不能有中文字符串字面量（`scripts/check-i18n.mjs`，接在 `pnpm test` 里）。
- 文案自然、温和、简短，不用感叹号堆砌。称呼宝宝用“宝宝”或名字，不假定性别；英文用 your baby、they，不用 he/she。
- 记录里存的是数据不是界面文字：用户录入的内容原样显示，不翻译；内置疫苗名写进记录的永远是 `recordName`（中文原名），显示时再按 id 换语言。
- 服务端的错误 `message` 一直是中文（v0.1.0 直接显示它），新版 App 按 `code` 查 `i18n/apiErrors.ts`。服务端同时服务不同语言的人，绝不能调用 `setLocale`，要用 `messagesFor` 或明确传语言。
- 所有可点击元素要有 `accessibilityLabel` 和稳定的 `testID`（Maestro 依赖它）。

## 6. 数据与同步规则

- 主键由客户端生成 UUID，写入幂等。
- 所有业务数据走 `records` 集合同步（见 `docs/ARCHITECTURE.md`）。冲突按 `updatedAt` 后写胜出。
- 删除是软删除（`deleted: true`），要能同步给其他设备。
- 服务端按家庭串行分配 `seq`，客户端用游标增量拉取；不要改成按时间戳拉取，那样会漏数据。
- 改数据结构要向后兼容：新字段可选；旧版 App 仍在用的字段不能删。服务端迁移只增不改。

## 7. 安全与隐私（硬性要求）

这是**公开仓库**，而数据是别人家的孩子。

- 绝不提交真实的宝宝信息、照片、证件、密钥或 `.env`。测试数据只用明显虚构的内容。
- 存储的 Secret 只存在服务端并加密保存，**永远不下发给 App**；App 只拿短时效的签名链接。
- 权限在服务端校验，App 里的隐藏按钮不算权限。`viewer` 只能读回忆和照片，不能读记录和证件。
- 证件文件的签名链接有效期不超过 10 分钟，日志里不能出现签名链接、证件号或令牌。
- 数据库备份不能进入 Actions 产物或日志，上传前必须加密。
- 登录令牌只存在 `expo-secure-store`。

## 8. 健康内容

App 不是医疗器械，健康内容错了会伤人。

- 提示必须根据真实数据判断，**数据不足或低于常见范围时不能安慰说“吃够了”**。
- 涉及发烧、喂养等的规则放在 `packages/shared/src/health/`，写单元测试，并在代码旁注明来源。
- 两种语言的健康提示意思必须完全一致：阈值、月龄和紧迫程度都不能变，`i18n-content.test.ts` 用同一组输入比较两种语言。改文案时两边一起改。
- 每个地区的疫苗表以当地官方或权威机构的现行方案为准，代码旁写明来源和版本，界面要注明“以诊所安排和健康手册为准”。
- 读不到官方原文的地区，不要凭二手资料当成已核实；在 PROGRESS 里标明待复核。
- 改健康内容时在 PR 里列出依据的来源。

## 9. Git 工作流

- `main` 保持可发布，功能在分支上开发，通过 PR 合并，CI 全绿才能合并。
- `pull_request` 的 `paths-ignore`（`ci.yml`）看的是整个 PR 的差异：只有全是 `docs/` 和 Markdown 的 PR 才不跑 CI，含代码的 PR 只推文档也会重跑全量 CI。
- 不要在 CI 运行中推送同一分支，除非已知这轮会失败：新推送会取消正在跑的 Android 流程（约 30 分钟）。
- 提交信息用 Conventional Commits（`feat:`、`fix:`、`docs:`、`test:`、`ci:`、`chore:`），一个提交只做一件事。
- 提交前确认 `git status` 里没有 `.env`、`.artifacts/`、APK 或真实数据。

## 10. 并行开发

可能有多个 Agent 同时工作。

- 每个 Agent 用自己的分支和 git worktree，每个 worktree 单独 `pnpm install`。
- 开工前先看 [PROGRESS.md](docs/PROGRESS.md) 的“负责”列，别人在做的不要重复做，并在同一个 PR 里写上自己的分支。
- 用 `git fetch` 和 rebase 跟上 `main`，合并前必须基于最新的 `main` 重新跑检查。
- **数据库迁移只能追加到 `migrations` 数组末尾。** 两个 PR 都加了迁移时，后合并的要 rebase 并放到后面，不能调换已发布的顺序。新表要开 RLS，否则 `portable.test.ts` 不通过。
- 改 `packages/shared` 的数据结构前，先看有没有别的进行中的改动，它影响所有 Agent。
- 共享资源：开发用的 Postgres 和 S3 可以共用，测试已经隔离；模拟器只有一台，E2E 会排队；本地服务端端口用 `PORT` 区分。

## 11. 必须更新的文档

这两条属于“完成的定义”，不更新就不算完成：

- **踩坑后必须更新 [docs/PITFALLS.md](docs/PITFALLS.md)。** 踩坑记录都在那里，动手前先扫一眼相关分类。
- **完成功能或改变行为后必须更新 [docs/PROGRESS.md](docs/PROGRESS.md)。** 写明状态、验证方式和是否放行，只写已经发生的事实。

和代码放在同一个 PR 里。
