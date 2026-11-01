# 端到端测试

```bash
pnpm dev:infra                 # Postgres + S3 兼容服务
pnpm android:build e2e         # 第一次约 20–40 分钟，之后增量很快
pnpm emulator                  # 无窗口模拟器
bash scripts/install-maestro.sh
pnpm e2e                       # 或 pnpm e2e e2e/flows/02_records.yaml
```

截图在 `.artifacts/e2e-*.png`，改 UI 后要逐张看。

## 用什么是真的，什么是模拟的

| 环节                           | 情况                                                     |
| ------------------------------ | -------------------------------------------------------- |
| 服务端、数据库、同步           | 真实                                                     |
| 预签名直传、S3 协议            | 真实（SeaweedFS，S3 兼容）                               |
| 上传后的校验                   | `verify-uploads.mjs` 直接查库并从 S3 读回对象            |
| 第二位家人                     | 脚本走真实接口                                           |
| 系统相册和相机                 | E2E 构建用内置样例代替，系统界面随版本变化，自动化不稳定 |
| Cloudflare R2、AWS S3 本身     | 没有测，需要真实账号                                     |
| 后台上传、推送到达、厂商杀后台 | 模拟器测不了，发版前要在真机上验证                       |
