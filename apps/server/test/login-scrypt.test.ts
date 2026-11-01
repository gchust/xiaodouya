import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { type App, call, newUser, openTestDb, type TestDb, uniqueEmail } from './harness';

/**
 * 邮箱不存在时也要算一遍同样参数的 scrypt，否则响应时间就暴露了邮箱是否存在。
 * 这里数 scrypt 的调用，不量时间：量时间在机器繁忙时会偶发失败（两边都算了哈希也差过一倍）。
 */
const scrypt = vi.hoisted(() => ({ costs: [] as number[] }));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  const counted = (
    password: string,
    salt: Buffer,
    keylen: number,
    options: { N: number; r: number; p: number; maxmem: number },
    callback: (error: Error | null, key: Buffer) => void,
  ) => {
    scrypt.costs.push(options.N);
    actual.scrypt(password, salt, keylen, options, callback);
  };
  return { ...actual, scrypt: counted };
});

let db: TestDb;
let app: App;

beforeAll(async () => {
  db = await openTestDb('scrypt');
  app = createApp({ sql: db.sql, config: db.config });
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await db.sql`DELETE FROM rate_limits`;
});

const failedLogin = async (email: string) => {
  scrypt.costs.length = 0;
  const response = await call(app, 'POST', '/v1/auth/login', {
    body: { email, password: 'wrong-pass' },
  });
  expect(response.status).toBe(401);
  return [...scrypt.costs];
};

describe('登录时的密码哈希', () => {
  it('邮箱存在和不存在，算的次数和强度都一样', async () => {
    const user = await newUser(app);
    const existing = await failedLogin(user.email);
    const missing = await failedLogin(uniqueEmail());
    expect(existing).toHaveLength(1);
    expect(missing).toEqual(existing);
  });
});
