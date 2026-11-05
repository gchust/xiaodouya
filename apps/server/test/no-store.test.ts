import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { type App, call, newFamily, openTestDb, PASSWORD, type TestDb } from './harness';

/**
 * F-135：Android 上 RN 的 fetch 走 OkHttp，自带 10 MB 的 `cache/http-cache`。没有 `no-store` 的
 * GET 响应原样写进去（`/v1/me` 里有邮箱、家庭名和成员），退出登录后还留在手机上。
 * 所以每个响应都要禁止缓存，出错的、没登录的也一样。
 */
let db: TestDb;
let app: App;

beforeAll(async () => {
  db = await openTestDb('nostore');
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await db.sql`DELETE FROM rate_limits`;
  app = createApp({ sql: db.sql, config: db.config });
});

const feed = () => ({
  id: randomUUID(),
  collection: 'event' as const,
  data: { type: 'feed', at: Date.now(), ml: 90, byName: '爸爸' },
  deleted: false,
  updatedAt: Date.now(),
});

describe('响应禁止缓存', () => {
  it('登录后读家庭数据的 GET 接口', async () => {
    const { admin } = await newFamily(app);
    const token = admin.token;
    const sync = await call(app, 'POST', '/v1/sync', {
      token,
      body: { cursor: 0, changes: [feed()] },
    });
    expect(sync.status).toBe(200);
    expect(sync.headers.get('cache-control')).toBe('no-store');

    for (const path of [
      '/v1/me',
      '/v1/sync/wait?cursor=0',
      '/v1/storage',
      '/v1/storage/usage',
      '/v1/shares',
      '/v1/family/export',
      '/v1/feedback',
    ]) {
      const response = await call(app, 'GET', path, { token });
      expect(response.status, path).toBe(200);
      expect(response.headers.get('cache-control'), path).toBe('no-store');
    }
  });

  it('登录和注册的响应里有令牌', async () => {
    const { admin } = await newFamily(app);
    const login = await call(app, 'POST', '/v1/auth/login', {
      body: { email: admin.email, password: PASSWORD },
    });
    expect(login.status).toBe(200);
    expect(login.headers.get('cache-control')).toBe('no-store');
  });

  it('不用登录的接口和出错的响应', async () => {
    const cases: [string, number][] = [
      ['/v1/config', 200],
      ['/healthz', 200],
      ['/v1/me', 401],
      ['/nope', 404],
    ];
    for (const [path, status] of cases) {
      const response = await call(app, 'GET', path);
      expect(response.status, path).toBe(status);
      expect(response.headers.get('cache-control'), path).toBe('no-store');
    }
    const expired = await call(app, 'GET', '/v1/me', { token: 'not-a-real-token' });
    expect(expired.status).toBe(401);
    expect(expired.headers.get('cache-control')).toBe('no-store');
  });
});
