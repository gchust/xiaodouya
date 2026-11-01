import { serve } from '@hono/node-server';
import { createApp } from './app';
import { loadConfig } from './config';
import { connect, migrate } from './db';
import { expoNotifier, noopNotifier } from './notifier';

const config = loadConfig();
const sql = connect(config.databaseUrl, config.db);
await migrate(sql);

if (!config.serverStorage) {
  console.warn('未配置默认存储（S3_*）。上传前需要管理员在 App 的「家人 → 存储」里设置。');
}

const app = createApp({
  sql,
  config,
  notifier: config.pushEnabled ? expoNotifier(config.expoAccessToken) : noopNotifier,
});

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`小豆芽服务端已启动：http://0.0.0.0:${info.port}`);
});

async function shutdown() {
  server.close();
  await sql.end({ timeout: 5 });
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
