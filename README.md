# 小豆芽

一家人一起记录宝宝成长的 App。喂奶、尿布、睡眠一两下记好，照片、视频、录音和证件都放在一处，数据存在你们自己的服务器和对象存储里。

**这个项目完全由 Code Agent 开发**，规范见 [AGENTS.md](AGENTS.md)。

## 功能

- **今天**：离线也能记录喂奶、尿布、睡眠、体温、吃药、洗澡、身高体重、疫苗；估算下次喂奶时间；记错了可以撤销
- **回忆**：时间线、照片墙、里程碑、写给宝宝的信；支持照片、视频和录音
- **资料**：出生档案、证件夹（证件号打码、指纹解锁、10 分钟链接）、生长曲线、新加坡疫苗本
- **家人**：邀请码加入、三级权限、实时同步、喂奶提醒、夜间安静、导出成长册 PDF
- **存储**：Cloudflare R2、AWS S3 或任何 S3 兼容存储，App 内配置和测试

## 文档

- [部署文档](docs/DEPLOYMENT.md)：服务端、App 构建和分发、全部参数
- [架构](docs/ARCHITECTURE.md)：同步、上传、权限的设计，以及已知限制
- [设计规范](docs/design/SPEC.md)
- [功能进展](docs/PROGRESS.md)：每个功能的状态、验证方式和是否放行
- [踩坑记录](docs/PITFALLS.md)
- 法律和上架草稿（**未经律师审核，不能直接使用**）：[隐私政策](docs/legal/privacy-policy.zh.md)、[用户协议](docs/legal/terms.zh.md)、[合规清单](docs/legal/COMPLIANCE.md)、[Google Play](docs/store/google-play.md)、[App Store](docs/store/app-store.md)
- [端到端测试](e2e/README.md)

## 本地开发

```bash
mise install && pnpm install
cp apps/server/.env.example apps/server/.env
pnpm dev:infra     # Postgres + S3 兼容服务
pnpm dev:server    # 服务端
pnpm check         # 静态检查和单元测试
pnpm test:server   # 服务端集成测试
```

Android 相关命令见 [AGENTS.md](AGENTS.md) 第 3 节。

## 免责声明

App 里的健康提示和疫苗表仅供参考，不能替代医生的判断。宝宝不舒服时请及时就医。

## 许可

代码采用 MIT 许可。字体 Noto Serif SC 和 DM Mono 采用 SIL Open Font License，见 `apps/mobile/assets/fonts/`。
