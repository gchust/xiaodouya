/**
 * 服务器维护命令。这个项目没有邮件服务，忘记密码由部署者在服务器上重置：
 *   docker compose exec server node dist/cli.mjs reset-password user@example.com
 *
 * Edge Function 不会自己执行迁移，部署时在本机或 CI 上执行：
 *   DATABASE_URL=... pnpm --filter @xiaodouya/server cli migrate
 * 这些命令只需要数据库连接，不需要 APP_SECRET。
 *
 * 定时任务每天执行一次，清理放弃的上传和已删除的文件，见 docs/DEPLOYMENT.md：
 *   pnpm --filter @xiaodouya/server cli maintenance
 * 它只碰平台存储，所以要 S3_*，不需要 APP_SECRET（那是解密用户自己的存储密钥用的）。
 *
 * 上线前对真实存储确认一次，它支持把大小签进上传链接（不支持时所有上传都会失败）：
 *   pnpm --filter @xiaodouya/server cli check-upload-size
 */

import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { loadConfig, loadDbConfig } from './config';
import { hashPassword } from './crypto';
import { connect, migrate, type Sql } from './db';

async function resetPassword(sql: Sql, email: string): Promise<boolean> {
  await migrate(sql);
  const password = randomBytes(9).toString('base64url');
  const hash = await hashPassword(password);
  const [user] = await sql<{ id: string }[]>`
    UPDATE users SET password_hash = ${hash} WHERE email = ${email.trim().toLowerCase()} RETURNING id`;
  if (!user) {
    console.error('找不到这个邮箱对应的账号');
    return false;
  }
  // 旧设备上的登录全部失效，防止遗失的手机继续访问。
  await sql`DELETE FROM sessions WHERE user_id = ${user.id}`;
  console.log(`新密码：${password}`);
  return true;
}

const [command, email] = process.argv.slice(2);

if (
  command !== 'migrate' &&
  command !== 'maintenance' &&
  command !== 'check-upload-size' &&
  !(command === 'reset-password' && email)
) {
  console.error(
    '用法：cli migrate | cli maintenance | cli check-upload-size | cli reset-password <邮箱>',
  );
  process.exit(1);
}

/** 这两个命令不解密任何东西，不要为了通过校验把 APP_SECRET 复制到定时任务的环境里。 */
const storageConfig = () =>
  loadConfig({ APP_SECRET: Buffer.alloc(32).toString('base64'), ...process.env });

const { databaseUrl, db } = loadDbConfig();
const sql = connect(databaseUrl, db);
let ok = true;
try {
  if (command === 'migrate') {
    await migrate(sql);
    console.log('迁移已完成');
  } else if (command === 'maintenance') {
    // 动态引入：迁移和重置密码不需要加载 AWS SDK。
    const { runMaintenance } = await import('./maintenance');
    const report = await runMaintenance(sql, storageConfig());
    console.log(JSON.stringify(report));
    // 让定时任务看得出失败。记录还在，下次会重试。
    ok = report.failed === 0;
  } else if (command === 'check-upload-size') {
    const { checkUploadSizeBinding, storageById } = await import('./storage');
    const storage = await storageById(sql, storageConfig(), '', null);
    if (!storage) throw new Error('没有配置 S3_*');
    const result = await checkUploadSizeBinding(storage);
    console.log(
      `${result.ok ? '通过' : '不通过，请设置 S3_BIND_UPLOAD_SIZE=false'}：${result.message}`,
    );
    ok = result.ok;
  } else {
    ok = await resetPassword(sql, email!);
  }
} finally {
  await sql.end();
}
process.exit(ok ? 0 : 1);
