/**
 * 服务器维护命令。这个项目没有邮件服务，忘记密码由部署者在服务器上重置：
 *   docker compose exec server node dist/cli.mjs reset-password user@example.com
 */
import { randomBytes } from 'node:crypto';
import { loadConfig } from './config';
import { hashPassword } from './crypto';
import { connect, migrate } from './db';

const [command, email] = process.argv.slice(2);

if (command !== 'reset-password' || !email) {
  console.error('用法：cli reset-password <邮箱>');
  process.exit(1);
}

const sql = connect(loadConfig().databaseUrl);
await migrate(sql);
const password = randomBytes(9).toString('base64url');
const hash = await hashPassword(password);
const [user] = await sql<{ id: string }[]>`
  UPDATE users SET password_hash = ${hash} WHERE email = ${email.trim().toLowerCase()} RETURNING id`;
if (!user) {
  console.error('找不到这个邮箱对应的账号');
  await sql.end();
  process.exit(1);
}
// 旧设备上的登录全部失效，防止遗失的手机继续访问。
await sql`DELETE FROM sessions WHERE user_id = ${user.id}`;
console.log(`新密码：${password}`);
await sql.end();
