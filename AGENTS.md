# AGENTS.md — 小豆芽开发规范

这个项目**完全由 Code Agent 开发和维护**。这份文件是所有 Agent 的工作合同，先读完再动手。
与这里冲突的习惯一律以这里为准；规范本身过时了，就在同一个提交里改它。

## 1. 产品是什么

小豆芽（xiaodouya）是一个家庭共用的宝宝成长 App，一家人（主要在新加坡）一起记录喂奶、尿布、睡眠，
保存照片、视频、录音和证件。

三条产品底线，任何改动都不能破坏：

1. **半夜单手一两下就能记好。** 记录永远先写本地、立即成功，不等网络。
2. **不丢数据。** 离线写入、上传失败、App 被杀之后都要能恢复；撤销之外不做硬删除。
3. **美观好用是验收标准，不是加分项。** 视觉必须符合 `docs/design/SPEC.md`，UI 改动必须看过模拟器截图才算完成。

## 2. 仓库结构

```
apps/mobile/       Expo + React Native App（Expo Router，TypeScript）
apps/server/       Hono + Postgres 服务端（TypeScript，Node）
packages/shared/   前后端共用：zod 契约、领域逻辑（喂奶估算、疫苗表、月龄计算）
e2e/               Maestro 端到端流程和测试辅助脚本
deploy/            生产 Docker Compose、Caddy、备份脚本
docs/              DEPLOYMENT.md、ARCHITECTURE.md、PROGRESS.md（功能进展）、PITFALLS.md（踩坑记录）、design/SPEC.md
.github/workflows/ CI
```

依赖方向：`mobile → shared ← server`。`shared` 不能依赖 React Native 或 Node 专属 API。
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
- 用户可见文案全部是自然的中文，语气温和、简短，不用感叹号堆砌。称呼宝宝用“宝宝”或名字，不假定性别。
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
- 登录令牌只存在 `expo-secure-store`。

## 8. 健康内容

App 不是医疗器械，健康内容错了会伤人。

- 提示必须根据真实数据判断，**数据不足或低于常见范围时不能安慰说“吃够了”**。
- 涉及发烧、喂养等的规则放在 `packages/shared/src/health/`，写单元测试，并在代码旁注明来源。
- 疫苗表以新加坡卫生部 NCIS 为准，界面要注明“以诊所安排和健康手册为准”。
- 改健康内容时在 PR 里列出依据的来源。

## 9. Git 工作流

- `main` 保持可发布，功能在分支上开发，通过 PR 合并，CI 全绿才能合并。
- 提交信息用 Conventional Commits（`feat:`、`fix:`、`docs:`、`test:`、`ci:`、`chore:`），一个提交只做一件事。
- 提交前确认 `git status` 里没有 `.env`、`.artifacts/`、APK 或真实数据。

## 10. 并行开发

可能有多个 Agent 同时工作。

- 每个 Agent 用自己的分支和 git worktree，每个 worktree 单独 `pnpm install`。
- 开工前先看 [PROGRESS.md](docs/PROGRESS.md) 的“负责”列，别人在做的不要重复做，并在同一个 PR 里写上自己的分支。
- 用 `git fetch` 和 rebase 跟上 `main`，合并前必须基于最新的 `main` 重新跑检查。
- **数据库迁移只能追加到 `migrations` 数组末尾。** 两个 PR 都加了迁移时，后合并的要 rebase 并放到后面，不能调换已发布的顺序。
- 改 `packages/shared` 的数据结构前，先看有没有别的进行中的改动，它影响所有 Agent。
- 共享资源：开发用的 Postgres 和 S3 可以共用，测试已经隔离；模拟器只有一台，E2E 会排队；本地服务端端口用 `PORT` 区分。

## 11. 必须更新的文档

这两条属于“完成的定义”，不更新就不算完成：

- **踩坑后必须更新 [docs/PITFALLS.md](docs/PITFALLS.md)。** 踩坑记录都在那里，动手前先扫一眼相关分类。
- **完成功能或改变行为后必须更新 [docs/PROGRESS.md](docs/PROGRESS.md)。** 写明状态、验证方式和是否放行，只写已经发生的事实。

和代码放在同一个 PR 里。
