import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  type AuthResponse,
  defaultPrefs,
  type MeResponse,
  type SyncResponse,
} from '@xiaodouya/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { type Config, loadConfig } from '../src/config';
import { verifyPassword } from '../src/crypto';
import { connect, migrate, type Sql } from '../src/db';
import type { PushMessage } from '../src/notifier';

/**
 * Edge Function 上每个 isolate 都是独立的进程内状态：这里用两个 createApp 实例模拟两个 isolate，
 * 它们只共享数据库。
 */
function testEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const line of readFileSync(resolve(import.meta.dirname, '../.env.example'), 'utf8').split(
    '\n',
  )) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (match?.[1] && !env[match[1]]) env[match[1]] = match[2];
  }
  return env;
}

let sql: Sql;
let admin: Sql;
let testDatabase: string;
let testUrl: string;
let config: Config;

type App = ReturnType<typeof createApp>;

async function call<T = unknown>(
  app: App,
  method: string,
  path: string,
  options: {
    token?: string;
    body?: unknown;
    headers?: Record<string, string>;
    signal?: AbortSignal;
  } = {},
): Promise<{ status: number; json: T }> {
  const response = await app.request(path, {
    method,
    signal: options.signal,
    headers: {
      'content-type': 'application/json',
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...options.headers,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { status: response.status, json: (await response.json()) as T };
}

async function newUser(app: App) {
  const email = `user-${randomUUID().slice(0, 8)}@example.test`;
  const { json } = await call<AuthResponse>(app, 'POST', '/v1/auth/register', {
    body: { email, password: 'correct horse', displayName: '虚构用户' },
  });
  return { ...json, email };
}

async function newFamily(app: App) {
  const owner = await newUser(app);
  await call<MeResponse>(app, 'POST', '/v1/families', {
    token: owner.token,
    body: { name: '虚构一家', label: '爸爸' },
  });
  const member = await newUser(app);
  const invite = await call<{ code: string }>(app, 'POST', '/v1/invites', {
    token: owner.token,
    body: { role: 'caregiver', label: '妈妈' },
  });
  await call(app, 'POST', '/v1/invites/accept', {
    token: member.token,
    body: { code: invite.json.code },
  });
  return { owner, member };
}

const feedChange = () => ({
  id: randomUUID(),
  collection: 'event' as const,
  data: { type: 'feed', at: Date.now(), ml: 90, byName: '爸爸' },
  deleted: false,
  updatedAt: Date.now(),
});

const write = (app: App, token: string) =>
  call<SyncResponse>(app, 'POST', '/v1/sync', {
    token,
    body: { cursor: 0, changes: [feedChange()] },
  });

beforeAll(async () => {
  config = loadConfig(testEnv());
  admin = connect(config.databaseUrl);
  testDatabase = `xiaodouya_test_${process.pid}_${Date.now()}_p`;
  await admin.unsafe(`CREATE DATABASE ${testDatabase}`);
  const url = new URL(config.databaseUrl);
  url.pathname = `/${testDatabase}`;
  testUrl = url.toString();
  sql = connect(testUrl, config.db);
  await migrate(sql);
});

afterAll(async () => {
  await sql.end();
  await admin.unsafe(`DROP DATABASE IF EXISTS ${testDatabase} WITH (FORCE)`);
  await admin.end();
});

describe('长轮询（跨实例）', () => {
  it('另一个实例写入后，等待中的客户端很快返回', async () => {
    const isolateA = createApp({ sql, config });
    const isolateB = createApp({ sql, config });
    const { owner, member } = await newFamily(isolateA);
    const { json } = await call<SyncResponse>(isolateA, 'POST', '/v1/sync', {
      token: member.token,
      body: { cursor: 0, changes: [] },
    });
    const started = Date.now();
    const waiting = call<{ changed: boolean }>(
      isolateA,
      'GET',
      `/v1/sync/wait?cursor=${json.cursor}`,
      { token: member.token },
    );
    await new Promise((r) => setTimeout(r, 100));
    await write(isolateB, owner.token);
    const result = await waiting;
    expect(result.json.changed).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('从旧备份恢复后游标超前，新的写入也能唤醒等待', async () => {
    const app = createApp({ sql, config });
    const { owner, member } = await newFamily(app);
    const started = Date.now();
    const waiting = call<{ changed: boolean }>(app, 'GET', '/v1/sync/wait?cursor=1000', {
      token: member.token,
    });
    await new Promise((r) => setTimeout(r, 100));
    await write(app, owner.token);
    expect((await waiting).json.changed).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('客户端断开后立刻停止等待', async () => {
    const app = createApp({ sql, config });
    const { member } = await newFamily(app);
    const { json } = await call<SyncResponse>(app, 'POST', '/v1/sync', {
      token: member.token,
      body: { cursor: 0, changes: [] },
    });
    const controller = new AbortController();
    const started = Date.now();
    const waiting = call<{ changed: boolean }>(app, 'GET', `/v1/sync/wait?cursor=${json.cursor}`, {
      token: member.token,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 100);
    expect((await waiting).json.changed).toBe(false);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('连接池只有 1 个连接时，等待不占住连接', async () => {
    const single = connect(testUrl, { ...config.db, poolMax: 1 });
    try {
      const app = createApp({ sql: single, config });
      const { owner, member } = await newFamily(app);
      const { json } = await call<SyncResponse>(app, 'POST', '/v1/sync', {
        token: member.token,
        body: { cursor: 0, changes: [] },
      });
      const waiting = call<{ changed: boolean }>(
        app,
        'GET',
        `/v1/sync/wait?cursor=${json.cursor}`,
        { token: member.token },
      );
      await new Promise((r) => setTimeout(r, 100));
      const writeStarted = Date.now();
      await write(app, owner.token);
      expect(Date.now() - writeStarted).toBeLessThan(1000);
      expect((await waiting).json.changed).toBe(true);
    } finally {
      await single.end();
    }
  });

  it('到达时限后返回 changed: false', async () => {
    const app = createApp({ sql, config, longPoll: { intervalMs: 50, timeoutMs: 300 } });
    const { member } = await newFamily(app);
    const { json } = await call<SyncResponse>(app, 'POST', '/v1/sync', {
      token: member.token,
      body: { cursor: 0, changes: [] },
    });
    const started = Date.now();
    const result = await call<{ changed: boolean }>(
      app,
      'GET',
      `/v1/sync/wait?cursor=${json.cursor}`,
      { token: member.token },
    );
    expect(result.json.changed).toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('后台任务', () => {
  it('响应之后的推送交给运行环境托管，不会被提前掐断', async () => {
    const tasks: Promise<unknown>[] = [];
    const pushes: PushMessage[] = [];
    const app = createApp({
      sql,
      config,
      notifier: { send: async (m) => void pushes.push(...m) },
      background: (task) => void tasks.push(task),
    });
    const { owner, member } = await newFamily(app);
    await call(app, 'POST', '/v1/me/push-token', {
      token: member.token,
      body: { deviceId: randomUUID(), token: 'ExponentPushToken[fictional]' },
    });
    // 默认开着夜间安静：不关的话，这条测试在新加坡时间 23:00 到 07:00 会失败。
    await call(app, 'PUT', '/v1/me/prefs', {
      token: member.token,
      body: { ...defaultPrefs, quietNight: false },
    });
    await write(app, owner.token);
    expect(tasks).toHaveLength(1);
    await Promise.all(tasks);
    expect(pushes).toHaveLength(1);
  });

  it('后台任务失败不影响响应，也不会变成未处理的拒绝', async () => {
    const tasks: Promise<unknown>[] = [];
    const app = createApp({
      sql,
      config,
      notifier: { send: () => Promise.reject(new Error('虚构的发送失败')) },
      background: (task) => void tasks.push(task),
    });
    const { owner, member } = await newFamily(app);
    await call(app, 'POST', '/v1/me/push-token', {
      token: member.token,
      body: { deviceId: randomUUID(), token: 'ExponentPushToken[fictional]' },
    });
    expect((await write(app, owner.token)).status).toBe(200);
    await expect(Promise.all(tasks)).resolves.toBeDefined();
  });
});

describe('限流（跨实例）', () => {
  const login = (app: App, email: string, headers: Record<string, string> = {}) =>
    call(app, 'POST', '/v1/auth/login', {
      body: { email, password: 'wrong-pass' },
      headers,
    });

  it('猜错的次数在实例之间累计', async () => {
    const isolateA = createApp({ sql, config });
    const isolateB = createApp({ sql, config });
    const user = await newUser(isolateA);
    let last = 0;
    for (let i = 0; i < 11; i++) {
      last = (await login(i % 2 === 0 ? isolateA : isolateB, user.email)).status;
    }
    expect(last).toBe(429);
  });

  it('换 X-Forwarded-For 绕不过同一个邮箱的总量限制', async () => {
    const app = createApp({ sql, config });
    const user = await newUser(app);
    const statuses: number[] = [];
    for (let i = 0; i < 51; i++) {
      statuses.push(
        (await login(app, user.email, { 'x-forwarded-for': `203.0.113.${i + 1}` })).status,
      );
    }
    expect(statuses.at(0)).toBe(401);
    expect(statuses.at(-1)).toBe(429);
  }, 60_000);

  it('限流表不保存明文邮箱', async () => {
    const app = createApp({ sql, config });
    const user = await newUser(app);
    await login(app, user.email);
    const rows = await sql<{ key_hash: string }[]>`SELECT key_hash FROM rate_limits`;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.key_hash.includes(user.email))).toBe(false);
  });

  it('过期的计数会被清掉，之后可以再试', async () => {
    const app = createApp({ sql, config });
    const user = await newUser(app);
    for (let i = 0; i < 11; i++) await login(app, user.email);
    expect((await login(app, user.email)).status).toBe(429);
    await sql`UPDATE rate_limits SET reset_at = now() - interval '1 second'`;
    expect((await login(app, user.email)).status).toBe(401);
  });
});

describe('Edge Function 的路径前缀', () => {
  it('路由和错误响应都带上前缀', async () => {
    const app = createApp({ sql, config, basePath: '/api' });
    expect((await app.request('/api/healthz')).status).toBe(200);
    const unauthenticated = await call<{ error: { code: string } }>(app, 'GET', '/api/v1/me');
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.json.error.code).toBe('unauthenticated');
    const missing = await call<{ error: { code: string } }>(app, 'GET', '/api/nope');
    expect(missing.status).toBe(404);
    expect(missing.json.error.code).toBe('not_found');
    expect((await app.request('/healthz')).status).toBe(404);
  });
});

describe('数据库配置', () => {
  it('默认值和 Docker 部署一致', () => {
    const env = { ...testEnv(), DB_POOL_MAX: undefined, DB_PREPARE: undefined, DB_SSL: undefined };
    expect(loadConfig(env).db).toEqual({ poolMax: 10, prepare: true, ssl: false });
  });
  it('可以按环境变量切换到事务模式连接池的配置', () => {
    const db = loadConfig({
      ...testEnv(),
      DB_POOL_MAX: '1',
      DB_PREPARE: 'false',
      DB_SSL: 'require',
    }).db;
    expect(db).toEqual({ poolMax: 1, prepare: false, ssl: 'require' });
  });
  it('没有配置 DB_SSL 时遵守连接串里的 sslmode', async () => {
    const fromUrl = connect(`${testUrl}?sslmode=require`, { ssl: false, poolMax: 1 });
    const fromOption = connect(testUrl, { ssl: 'require', prepare: false, poolMax: 1 });
    const plain = connect(testUrl, { ssl: false, poolMax: 1 });
    expect(fromUrl.options.ssl).toBe('require');
    expect(fromOption.options.ssl).toBe('require');
    expect(fromOption.options.prepare).toBe(false);
    expect(fromOption.options.max).toBe(1);
    expect(plain.options.ssl).toBe(false);
    await Promise.all([fromUrl.end(), fromOption.end(), plain.end()]);
  });
  it('拒绝无法识别的 SSL 取值，不能悄悄退回明文', () => {
    expect(() => loadConfig({ ...testEnv(), DB_SSL: 'yes-please' })).toThrow(/DB_SSL/);
  });
});

describe('迁移', () => {
  it('公开 schema 的每张表都开了 RLS，防止被 Supabase 的 Data API 读到', async () => {
    const open = await sql<{ relname: string }[]>`
      SELECT c.relname FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relrowsecurity`;
    expect(open.map((r) => r.relname)).toEqual([]);
  });

  it('命令行迁移只需要 DATABASE_URL，可以重复执行', async () => {
    const database = `${testDatabase}_cli`;
    await admin.unsafe(`CREATE DATABASE ${database}`);
    const url = new URL(config.databaseUrl);
    url.pathname = `/${database}`;
    const run = () =>
      promisify(execFile)(
        process.execPath,
        ['--import', 'tsx', resolve(import.meta.dirname, '../src/cli.ts'), 'migrate'],
        {
          cwd: resolve(import.meta.dirname, '..'),
          env: { PATH: process.env.PATH, DATABASE_URL: url.toString() },
        },
      );
    try {
      await run();
      await run();
      const check = connect(url.toString());
      const rows = await check<{ count: string }[]>`
        SELECT count(*) FROM schema_migrations`;
      const [users] = await check<{ exists: string | null }[]>`
        SELECT to_regclass('public.users')::text AS exists`;
      await check.end();
      expect(Number(rows[0]?.count)).toBeGreaterThan(0);
      expect(users?.exists).toBe('users');
    } finally {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    }
  }, 60_000);
});

describe('密码', () => {
  it('现有参数算出的哈希继续有效', async () => {
    // 固定的测试向量（虚构密码），Node 和 Deno 都必须算出同一个结果。
    const stored =
      'scrypt$32768$AAAAAAAAAAAAAAAAAAAAAA==$Y8MYoqnX4lWGWuAOv64MBPfBINQKVV0WkGusAfOtPo4=';
    expect(await verifyPassword('correct horse', stored)).toBe(true);
    expect(await verifyPassword('wrong', stored)).toBe(false);
  });
});
