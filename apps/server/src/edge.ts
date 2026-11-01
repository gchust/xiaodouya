/**
 * Supabase Edge Function 的入口逻辑，由 scripts/build-edge.mjs 打包进 supabase/functions/api/_bundle。
 * 这里不能引入 migrate：冷启动时不跑迁移，构建脚本会检查。
 */
import { createApp } from './app';
import { loadConfig } from './config';
import { connect } from './db';
import { expoNotifier, noopNotifier } from './notifier';

/** 函数名就是路径前缀：/functions/v1/api/v1/me 到函数里是 /api/v1/me。改函数名要一起改。 */
const FUNCTION_PATH = '/api';

/** 事务模式连接池要求的配置。放在这里是因为忘了配不会马上报错，要到线上偶发失败才发现。 */
const EDGE_DB_DEFAULTS = { DB_POOL_MAX: '1', DB_PREPARE: 'false', DB_SSL: 'require' };

const IDLE_TIMEOUT_SECONDS = 20;

export function createEdgeHandler(
  env: Record<string, string | undefined>,
  background: (task: Promise<void>) => void,
): (request: Request) => Response | Promise<Response> {
  const config = loadConfig({ ...EDGE_DB_DEFAULTS, ...env });
  const sql = connect(config.databaseUrl, { ...config.db, idleTimeout: IDLE_TIMEOUT_SECONDS });
  const app = createApp({
    sql,
    config,
    basePath: FUNCTION_PATH,
    background,
    notifier: config.pushEnabled ? expoNotifier(config.expoAccessToken) : noopNotifier,
  });
  return (request) => app.fetch(request);
}
