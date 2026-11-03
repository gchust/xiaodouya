/**
 * 服务器维护命令。没有配置邮件时，忘记密码由部署者在服务器上重置：
 *   docker compose exec server node dist/cli.mjs reset-password user@example.com
 *
 * Edge Function 不会自己执行迁移，部署时在本机或 CI 上执行：
 *   DATABASE_URL=... pnpm --filter @xiaodouya/server cli migrate
 * 这两个命令只需要数据库连接，不需要 APP_SECRET。
 *
 * 定时任务每天执行一次，这是唯一要配置的定时任务，见 docs/DEPLOYMENT.md：
 *   pnpm --filter @xiaodouya/server cli maintenance
 * 它清理放弃的上传、已删除的文件和账号删除后留下的文件。要 S3_*。
 * APP_SECRET 可选：只有解密家庭自带存储的密钥才用到，没有时那部分留在队列里，平台存储照常处理。
 *
 * 只处理账号删除留下的文件，比如想马上清掉队列时：
 *   pnpm --filter @xiaodouya/server cli purge-objects
 *
 * 上线前对真实存储确认一次，它支持把大小签进上传链接（不支持时所有上传都会失败）：
 *   pnpm --filter @xiaodouya/server cli check-upload-size
 *
 * 再确认一次它支持分片上传（不通过时设置 S3_MULTIPART_ENABLED=false，App 退回单个 PUT）：
 *   pnpm --filter @xiaodouya/server cli check-multipart
 *
 * 用户反馈：不带 id 列出最近的反馈和状态；带 id 显示文字、诊断信息和附件的 10 分钟签名链接。
 * 附件不在公开的 issue 里，只能这样看。要 S3_*，不需要 APP_SECRET 和 GitHub 的配置。
 *   pnpm --filter @xiaodouya/server cli feedback [反馈 id]
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
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

if (
  command !== 'migrate' &&
  command !== 'maintenance' &&
  command !== 'purge-objects' &&
  command !== 'check-upload-size' &&
  command !== 'check-multipart' &&
  !(command === 'feedback' && (email === undefined || UUID.test(email))) &&
  !(command === 'reset-password' && email)
) {
  console.error(
    '用法：cli migrate | cli maintenance | cli purge-objects | cli check-upload-size | cli check-multipart | cli feedback [反馈 id] | cli reset-password <邮箱>',
  );
  process.exit(1);
}

/** 空字符串也算没有：GitHub 上没设置的 Secret 展开成空，不能因此校验失败。 */
const hasAppSecret = Boolean(process.env.APP_SECRET);

/**
 * 平台存储不解密任何东西，不要为了通过校验把 APP_SECRET 复制到定时任务的环境里。
 * 没有真实的 APP_SECRET 时这里是假的，解不开家庭自带存储的快照，要配合 hasAppSecret 判断。
 */
const storageConfig = () =>
  loadConfig({
    ...process.env,
    APP_SECRET: process.env.APP_SECRET || Buffer.alloc(32).toString('base64'),
  });

const reportWaiting = (waiting: number) => {
  if (waiting > 0) {
    console.log(`还有 ${waiting} 个文件在家庭自带的存储里，要设置 APP_SECRET 才能删除，已留在队列`);
  }
};

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
    const report = await runMaintenance(sql, storageConfig(), { customStorage: hasAppSecret });
    console.log(JSON.stringify(report));
    reportWaiting(report.deletionsWaitingForSecret);
    // 让定时任务看得出失败。记录还在，下次会重试。等 APP_SECRET 的不算失败。
    // 反馈建不了 issue 也算：多半是令牌过期了，要让部署者看得到。反馈本身留在队列里。
    ok = report.failed === 0 && report.deletionsFailed === 0 && report.feedbackFailed === 0;
  } else if (command === 'purge-objects') {
    const { processPendingDeletions } = await import('./objectDeletions');
    await migrate(sql);
    const result = await processPendingDeletions(sql, storageConfig(), {
      customStorage: hasAppSecret,
      maxMs: Number.POSITIVE_INFINITY,
    });
    console.log(
      `已删除 ${result.deleted} 个文件，失败 ${result.failed} 个，队列里还有 ${result.remaining} 个`,
    );
    reportWaiting(result.waitingForSecret);
    ok = result.failed === 0;
  } else if (command === 'check-upload-size') {
    const { checkUploadSizeBinding, storageById } = await import('./storage');
    const storage = await storageById(sql, storageConfig(), '', null);
    if (!storage) throw new Error('没有配置 S3_*');
    const result = await checkUploadSizeBinding(storage);
    console.log(
      `${result.ok ? '通过' : '不通过，请设置 S3_BIND_UPLOAD_SIZE=false'}：${result.message}`,
    );
    ok = result.ok;
  } else if (command === 'check-multipart') {
    const { checkMultipartUpload, storageById } = await import('./storage');
    const config = storageConfig();
    const storage = await storageById(sql, config, '', null);
    if (!storage) throw new Error('没有配置 S3_*');
    const result = await checkMultipartUpload(storage, config.bindUploadSize);
    console.log(
      result.ok ? result.message : `不通过，请设置 S3_MULTIPART_ENABLED=false：${result.message}`,
    );
    ok = result.ok;
  } else if (command === 'feedback') {
    const { feedbackDetails, recentFeedback } = await import('./feedback');
    if (email) {
      const details = await feedbackDetails(sql, storageConfig(), email);
      if (!details) {
        console.error('找不到这条反馈');
        ok = false;
      } else {
        // 链接 10 分钟内有效，不要转发，也不要贴进 issue。
        console.log(JSON.stringify(details, null, 2));
      }
    } else {
      for (const row of await recentFeedback(sql)) {
        console.log(
          [
            row.id,
            row.status,
            row.created_at.toISOString(),
            `附件 ${row.attachment_count}`,
            `尝试 ${row.attempts}`,
            row.issue_url ?? row.last_error ?? '',
          ].join('  '),
        );
      }
    }
  } else {
    ok = await resetPassword(sql, email!);
  }
} finally {
  await sql.end();
}
process.exit(ok ? 0 : 1);
