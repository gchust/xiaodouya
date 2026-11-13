import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  AuthResponse,
  MediaUrlsResponse,
  MeResponse,
  StorageConfigView,
  StorageTestResult,
  StorageUsage,
  SyncResponse,
  UploadUrlResponse,
} from '@xiaodouya/shared';
import { CLIENT_LEVEL_HEADER, favoriteIdFor, MULTI_BABY_CLIENT_LEVEL } from '@xiaodouya/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { type Config, loadConfig } from '../src/config';
import { decryptSecret, encryptSecret, hashPassword, verifyPassword } from '../src/crypto';
import { connect, migrate, type Sql } from '../src/db';
import { ensureBucket } from '../src/dev-bucket';
import { isQuietHour, type PushMessage } from '../src/notifier';
import { assertEndpointAllowed, describeStorageError } from '../src/storage';

/** 集成测试：真实的 Postgres 和 S3 兼容服务（SeaweedFS），由 pnpm dev:infra 或 CI 提供。 */
function testEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  try {
    for (const line of readFileSync(resolve(import.meta.dirname, '../.env.example'), 'utf8').split(
      '\n',
    )) {
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
      if (match?.[1] && !env[match[1]]) env[match[1]] = match[2];
    }
  } catch {}
  env.S3_PUBLIC_ENDPOINT = 'http://localhost:59000';
  if (process.env.TEST_S3_ENDPOINT) {
    env.S3_ENDPOINT = process.env.TEST_S3_ENDPOINT;
    env.S3_PUBLIC_ENDPOINT = process.env.TEST_S3_ENDPOINT;
  }
  return env;
}

let sql: Sql;
let admin: Sql;
let testDatabase: string;
let config: Config;
let app: ReturnType<typeof createApp>;
let pushes: PushMessage[];

async function api<T = unknown>(
  method: string,
  path: string,
  options: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; json: T }> {
  const response = await app.request(path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...options.headers,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { status: response.status, json: (await response.json()) as T };
}

let counter = 0;
async function newUser(displayName = '测试用户') {
  counter += 1;
  const email = `user${counter}-${randomUUID().slice(0, 6)}@example.test`;
  const { json } = await api<AuthResponse>('POST', '/v1/auth/register', {
    body: { email, password: 'correct horse', displayName },
  });
  return { ...json, email };
}

async function newFamily() {
  const admin = await newUser('爸爸');
  const { json } = await api<MeResponse>('POST', '/v1/families', {
    token: admin.token,
    body: { name: '虚构一家', label: '爸爸' },
  });
  return { admin, family: json.family! };
}

async function join(adminToken: string, role: 'admin' | 'caregiver' | 'viewer', label: string) {
  const user = await newUser(label);
  const invite = await api<{ code: string }>('POST', '/v1/invites', {
    token: adminToken,
    body: { role, label },
  });
  const accepted = await api('POST', '/v1/invites/accept', {
    token: user.token,
    body: { code: invite.json.code },
  });
  expect(accepted.status).toBe(200);
  return user;
}

const feedChange = (
  overrides: Partial<{ id: string; updatedAt: number; ml: number; deleted: boolean }> = {},
) => ({
  id: overrides.id ?? randomUUID(),
  collection: 'event' as const,
  data: { type: 'feed', at: Date.now(), ml: overrides.ml ?? 90, byName: '爸爸' },
  deleted: overrides.deleted ?? false,
  updatedAt: overrides.updatedAt ?? Date.now(),
});

const babyChange = (
  id: string,
  data: Record<string, unknown>,
  updatedAt = Date.now(),
): {
  id: string;
  collection: 'baby';
  data: Record<string, unknown>;
  deleted: boolean;
  updatedAt: number;
} => ({
  id,
  collection: 'baby',
  data: { name: '虚构宝宝', birthAt: 1_000, ...data },
  deleted: false,
  updatedAt,
});

const sync = (token: string, cursor: number, changes: unknown[] = []) =>
  api<SyncResponse>('POST', '/v1/sync', { token, body: { cursor, changes } });

/** 按宝宝过滤的新版 App：家里有第二个宝宝后，不带这个头的旧版同步不了（issue #106）。 */
const syncMultiBaby = (token: string, cursor: number, changes: unknown[] = []) =>
  api<SyncResponse>('POST', '/v1/sync', {
    token,
    headers: { [CLIENT_LEVEL_HEADER]: String(MULTI_BABY_CLIENT_LEVEL) },
    body: { cursor, changes },
  });

beforeAll(async () => {
  config = loadConfig(testEnv());
  // 每次运行用独立的数据库：多个 Agent 可能同时跑这组测试，共用一个库会互相删数据。
  admin = connect(config.databaseUrl);
  testDatabase = `xiaodouya_test_${process.pid}_${Date.now()}`;
  await admin.unsafe(`CREATE DATABASE ${testDatabase}`);
  const url = new URL(config.databaseUrl);
  url.pathname = `/${testDatabase}`;
  sql = connect(url.toString(), config.db);
  await migrate(sql);
  await ensureBucket(config);
});

beforeEach(() => {
  pushes = [];
  app = createApp({ sql, config, notifier: { send: async (m) => void pushes.push(...m) } });
});

afterAll(async () => {
  await sql.end();
  await admin.unsafe(`DROP DATABASE IF EXISTS ${testDatabase} WITH (FORCE)`);
  await admin.end();
});

describe('账号', () => {
  it('注册、登录、读取自己的信息', async () => {
    const user = await newUser('妈妈');
    const login = await api<AuthResponse>('POST', '/v1/auth/login', {
      body: { email: user.email, password: 'correct horse' },
    });
    expect(login.status).toBe(200);
    const me = await api<MeResponse>('GET', '/v1/me', { token: login.json.token });
    expect(me.json.user.displayName).toBe('妈妈');
    expect(me.json.family).toBeNull();
  });
  it('密码错误和未登录都被拒绝', async () => {
    const user = await newUser();
    const bad = await api('POST', '/v1/auth/login', {
      body: { email: user.email, password: 'wrong-pass' },
    });
    expect(bad.status).toBe(401);
    expect((await api('GET', '/v1/me')).status).toBe(401);
    expect((await api('GET', '/v1/me', { token: 'not-a-token' })).status).toBe(401);
  });
  it('邮箱不能重复，大小写不敏感', async () => {
    const user = await newUser();
    const again = await api('POST', '/v1/auth/register', {
      body: { email: user.email.toUpperCase(), password: 'correct horse', displayName: 'x' },
    });
    expect(again.status).toBe(409);
  });
  it('多次猜错密码后限流', async () => {
    const user = await newUser();
    let last = 0;
    for (let i = 0; i < 11; i++) {
      last = (
        await api('POST', '/v1/auth/login', { body: { email: user.email, password: 'wrong-pass' } })
      ).status;
    }
    expect(last).toBe(429);
  });
  it('退出后令牌失效', async () => {
    const user = await newUser();
    await api('POST', '/v1/auth/logout', { token: user.token });
    expect((await api('GET', '/v1/me', { token: user.token })).status).toBe(401);
  });
  it('关闭注册后只有持邀请码才能注册', async () => {
    const { admin } = await newFamily();
    const invite = await api<{ code: string }>('POST', '/v1/invites', {
      token: admin.token,
      body: { role: 'caregiver', label: '妈妈' },
    });
    app = createApp({ sql, config: { ...config, allowSignup: false } });
    const base = { password: 'correct horse', displayName: '妈妈' };
    expect(
      (
        await api('POST', '/v1/auth/register', {
          body: { ...base, email: `a${randomUUID()}@example.test` },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await api('POST', '/v1/auth/register', {
          body: { ...base, email: `b${randomUUID()}@example.test`, inviteCode: invite.json.code },
        })
      ).status,
    ).toBe(201);
  });
});

describe('家庭和邀请', () => {
  it('邀请码只能用一次', async () => {
    const { admin } = await newFamily();
    const { json } = await api<{ code: string }>('POST', '/v1/invites', {
      token: admin.token,
      body: { role: 'caregiver', label: '妈妈' },
    });
    const first = await newUser();
    const second = await newUser();
    expect(
      (await api('POST', '/v1/invites/accept', { token: first.token, body: { code: json.code } }))
        .status,
    ).toBe(200);
    expect(
      (await api('POST', '/v1/invites/accept', { token: second.token, body: { code: json.code } }))
        .status,
    ).toBe(404);
  });
  it('邀请码输入时可以小写或带空格', async () => {
    const { admin } = await newFamily();
    const { json } = await api<{ code: string }>('POST', '/v1/invites', {
      token: admin.token,
      body: { role: 'caregiver', label: '妈妈' },
    });
    const user = await newUser();
    const code = `${json.code.slice(0, 4).toLowerCase()} ${json.code.slice(4)}`;
    expect(
      (await api('POST', '/v1/invites/accept', { token: user.token, body: { code } })).status,
    ).toBe(200);
  });
  it('只有管理员能发邀请', async () => {
    const { admin } = await newFamily();
    const member = await join(admin.token, 'caregiver', '妈妈');
    const r = await api('POST', '/v1/invites', {
      token: member.token,
      body: { role: 'viewer', label: '奶奶' },
    });
    expect(r.status).toBe(403);
  });
  it('不能移除或降级最后一位管理员', async () => {
    const { admin } = await newFamily();
    expect(
      (await api('DELETE', `/v1/family/members/${admin.user.id}`, { token: admin.token })).status,
    ).toBe(409);
    expect(
      (
        await api('PATCH', `/v1/family/members/${admin.user.id}`, {
          token: admin.token,
          body: { role: 'viewer' },
        })
      ).status,
    ).toBe(409);
  });
  it('被移除的成员立刻失去访问权限', async () => {
    const { admin } = await newFamily();
    const member = await join(admin.token, 'caregiver', '妈妈');
    await api('DELETE', `/v1/family/members/${member.user.id}`, { token: admin.token });
    expect((await sync(member.token, 0)).status).toBe(401);
  });
});

describe('同步', () => {
  it('一方写入，另一方能拉到', async () => {
    const { admin } = await newFamily();
    const mom = await join(admin.token, 'caregiver', '妈妈');
    const change = feedChange();
    const pushed = await sync(admin.token, 0, [change]);
    expect(pushed.status).toBe(200);
    const pulled = await sync(mom.token, 0);
    expect(pulled.json.records.map((r) => r.id)).toEqual([change.id]);
    expect(pulled.json.cursor).toBeGreaterThan(0);
    const next = await sync(mom.token, pulled.json.cursor);
    expect(next.json.records).toEqual([]);
  });
  it('重复提交是幂等的（离线重试不会产生重复记录）', async () => {
    const { admin } = await newFamily();
    const change = feedChange();
    await sync(admin.token, 0, [change]);
    await sync(admin.token, 0, [change]);
    const all = await sync(admin.token, 0);
    expect(all.json.records.filter((r) => r.id === change.id)).toHaveLength(1);
  });
  it('后写胜出，旧版本不能覆盖新版本，并且把新版本补发给客户端', async () => {
    const { admin } = await newFamily();
    const id = randomUUID();
    await sync(admin.token, 0, [feedChange({ id, updatedAt: 2000, ml: 120 })]);
    const { json: first } = await sync(admin.token, 0);
    const stale = await sync(admin.token, first.cursor, [
      feedChange({ id, updatedAt: 1000, ml: 60 }),
    ]);
    const returned = stale.json.records.find((r) => r.id === id);
    expect((returned!.data as { ml: number }).ml).toBe(120);
    const all = await sync(admin.token, 0);
    expect((all.json.records.find((r) => r.id === id)!.data as { ml: number }).ml).toBe(120);
  });
  it('删除能同步给其他人', async () => {
    const { admin } = await newFamily();
    const mom = await join(admin.token, 'caregiver', '妈妈');
    const id = randomUUID();
    await sync(admin.token, 0, [feedChange({ id, updatedAt: 1000 })]);
    const { json } = await sync(mom.token, 0);
    await sync(admin.token, 0, [feedChange({ id, updatedAt: 2000, deleted: true })]);
    const after = await sync(mom.token, json.cursor);
    expect(after.json.records[0]).toMatchObject({ id, deleted: true });
  });
  it('非法数据被拒绝，且不影响同批的合法数据', async () => {
    const { admin } = await newFamily();
    const good = feedChange();
    const badId = randomUUID();
    const r = await sync(admin.token, 0, [
      { id: badId, collection: 'event', data: { type: 'feed' }, deleted: false, updatedAt: 1 },
      good,
    ]);
    expect(r.json.rejected).toEqual([{ id: badId, reason: 'invalid' }]);
    expect(r.json.records.map((x) => x.id)).toContain(good.id);
  });
  it('不能用相同 id 覆盖别的家庭的记录', async () => {
    const a = await newFamily();
    const b = await newFamily();
    const id = randomUUID();
    await sync(a.admin.token, 0, [feedChange({ id, updatedAt: 1000, ml: 90 })]);
    const attack = await sync(b.admin.token, 0, [feedChange({ id, updatedAt: 9000, ml: 1 })]);
    expect(attack.json.rejected[0]?.reason).toBe('forbidden');
    const original = await sync(a.admin.token, 0);
    expect((original.json.records[0]!.data as { ml: number }).ml).toBe(90);
  });
  it('家庭之间数据隔离', async () => {
    const a = await newFamily();
    const b = await newFamily();
    await sync(a.admin.token, 0, [feedChange()]);
    expect((await sync(b.admin.token, 0)).json.records).toEqual([]);
  });
  it('viewer 读不到记录和证件，也不能写入', async () => {
    const { admin } = await newFamily();
    const grandma = await join(admin.token, 'viewer', '奶奶');
    const momentId = randomUUID();
    await sync(admin.token, 0, [
      feedChange(),
      {
        id: randomUUID(),
        collection: 'document',
        data: { name: '虚构证件', number: 'T0000000X', files: [] },
        deleted: false,
        updatedAt: 1,
      },
      {
        id: momentId,
        collection: 'moment',
        data: { title: '第一次笑', text: '', at: 1, milestone: true, media: [] },
        deleted: false,
        updatedAt: 1,
      },
    ]);
    const view = await sync(grandma.token, 0);
    expect(view.json.records.map((r) => r.id)).toEqual([momentId]);
    const write = await sync(grandma.token, 0, [feedChange()]);
    expect(write.json.rejected[0]?.reason).toBe('forbidden');
  });
  it('回忆的封面能同步给家人，格式不对只丢这一项，viewer 能看到但改不了', async () => {
    const { admin } = await newFamily();
    const mom = await join(admin.token, 'caregiver', '妈妈');
    const grandma = await join(admin.token, 'viewer', '奶奶');
    const photo = (id: string) => ({ id, kind: 'image', mime: 'image/jpeg', size: 1 });
    const first = randomUUID();
    const second = randomUUID();
    const id = randomUUID();
    const moment = (coverMediaId: unknown, updatedAt: number) => ({
      id,
      collection: 'moment' as const,
      data: {
        title: '虚构的一刻',
        text: '',
        at: 1,
        milestone: false,
        media: [photo(first), photo(second)],
        coverMediaId,
      },
      deleted: false,
      updatedAt,
    });
    const coverOf = async (token: string) =>
      (
        (await sync(token, 0)).json.records.find((r) => r.id === id)?.data as {
          coverMediaId?: unknown;
        }
      )?.coverMediaId;

    expect((await sync(admin.token, 0, [moment(second, 1000)])).json.rejected).toEqual([]);
    expect(await coverOf(mom.token)).toBe(second);
    expect(await coverOf(grandma.token)).toBe(second);

    // 一起记录的家人能改封面，和改这条回忆的其他内容一样。
    expect((await sync(mom.token, 0, [moment(first, 2000)])).json.rejected).toEqual([]);
    expect(await coverOf(admin.token)).toBe(first);

    const forbidden = await sync(grandma.token, 0, [moment(second, 3000)]);
    expect(forbidden.json.rejected[0]?.reason).toBe('forbidden');
    expect(await coverOf(admin.token)).toBe(first);

    // 坏数据不能让整条回忆被拒，也不能原样存下来再同步给别的设备。
    const junk = await sync(admin.token, 0, [moment('not-a-uuid', 4000)]);
    expect(junk.json.rejected).toEqual([]);
    expect(await coverOf(mom.token)).toBeUndefined();
  });
  it('记录的 babyId 和档案的 createdAt 能同步，格式不对只丢这一项（issue #106）', async () => {
    const { admin, family } = await newFamily();
    const mom = await join(admin.token, 'caregiver', '妈妈');
    const second = randomUUID();
    const change = (id: string, collection: string, data: Record<string, unknown>) => ({
      id,
      collection,
      data,
      deleted: false,
      updatedAt: 1000,
    });
    const scoped: [string, Record<string, unknown>][] = [
      ['event', { type: 'feed', at: 1, ml: 90 }],
      ['event', { type: 'vaccine-plan', vaccineId: 'sg:bcg', hidden: true }],
      ['event', { type: 'money', flow: 'in', amountMinor: 100, currency: 'SGD', happenedAt: 1 }],
      ['moment', { title: '', text: '', at: 1, milestone: false, media: [] }],
      ['letter', { title: '', text: '虚构的信', at: 1 }],
      ['document', { name: '虚构证件', files: [] }],
    ];
    const good = scoped.map(([collection, data]) =>
      change(randomUUID(), collection, { ...data, babyId: second }),
    );
    const bad = scoped.map(([collection, data]) =>
      change(randomUUID(), collection, { ...data, babyId: 'not-a-uuid' }),
    );
    const result = await sync(admin.token, 0, [babyChange(family.id, {}, 1000), ...good, ...bad]);
    expect(result.json.rejected).toEqual([]);
    // 以后的版本加的第二个宝宝。家人保存档案时服务端会换掉地区，createdAt 不能跟着丢。
    // 有了第二个宝宝，旧版就同步不了了，所以这里是新版 App。
    expect(
      (await syncMultiBaby(mom.token, 0, [babyChange(second, { createdAt: 5000 }, 2000)])).json
        .rejected,
    ).toEqual([]);

    const { json } = await syncMultiBaby(mom.token, 0);
    const dataOf = (id: string) =>
      json.records.find((r) => r.id === id)?.data as Record<string, unknown> | undefined;
    for (const { id } of good) expect(dataOf(id)?.babyId).toBe(second);
    for (const { id } of bad) {
      expect(dataOf(id)).toBeDefined();
      expect(dataOf(id)).not.toHaveProperty('babyId');
    }
    expect(dataOf(second)?.createdAt).toBe(5000);
    expect(dataOf(family.id)).not.toHaveProperty('createdAt');
  });

  it('奶粉配置和喂奶上的奶粉字段能同步，viewer 读不到也不能写', async () => {
    const { admin } = await newFamily();
    const mom = await join(admin.token, 'caregiver', '妈妈');
    const grandma = await join(admin.token, 'viewer', '奶奶');
    const formulaId = randomUUID();
    const formula = {
      id: formulaId,
      collection: 'event' as const,
      data: { type: 'formula', name: '虚构奶粉', basis: 'per100ml', values: { proteinG: 1.4 } },
      deleted: false,
      updatedAt: Date.now(),
    };
    const fed = feedChange();
    const feedData = {
      ...fed.data,
      milkType: 'formula',
      formulaId,
      formula: { name: '虚构奶粉', per100ml: { proteinG: 1.4 } },
    };
    const write = await sync(admin.token, 0, [formula, { ...fed, data: feedData }]);
    expect(write.json.rejected).toEqual([]);

    const seen = await sync(mom.token, 0);
    expect(seen.json.records.find((r) => r.id === formulaId)?.data).toEqual(formula.data);
    expect(seen.json.records.find((r) => r.id === fed.id)?.data).toEqual(feedData);

    const view = await sync(grandma.token, 0);
    expect(view.json.records).toEqual([]);
    const forbidden = await sync(grandma.token, 0, [{ ...formula, id: randomUUID() }]);
    expect(forbidden.json.rejected[0]?.reason).toBe('forbidden');
    // 猜到 id 提交改动，也不能把奶粉配置补发出来。
    const guessed = await sync(grandma.token, 0, [{ ...formula, updatedAt: 1 }]);
    expect(guessed.json.records).toEqual([]);
  });

  it('小金库的记录能同步，修改后写胜出，删除是软删除；viewer 读不到也不能写', async () => {
    const { admin } = await newFamily();
    const mom = await join(admin.token, 'caregiver', '妈妈');
    const grandma = await join(admin.token, 'viewer', '奶奶');
    const id = randomUUID();
    const data = {
      type: 'money',
      flow: 'in',
      amountMinor: 60_000,
      currency: 'CNY',
      happenedAt: 1000,
      from: '虚构的爷爷',
      category: 'lunar-new-year',
      byName: '爸爸',
    };
    const change = { id, collection: 'event' as const, data, deleted: false, updatedAt: 1000 };
    expect((await sync(admin.token, 0, [change])).json.rejected).toEqual([]);
    // 同一条再提交一次（离线重试）不会多出一条
    expect((await sync(admin.token, 0, [change])).json.rejected).toEqual([]);
    const seen = await sync(mom.token, 0);
    expect(seen.json.records.filter((r) => r.id === id)).toHaveLength(1);
    expect(seen.json.records.find((r) => r.id === id)?.data).toEqual(data);

    // 一起记录的家人改了金额，后写胜出；旧版本的改动被拒，服务端补发新版本
    const edited = { ...data, amountMinor: 80_000, future: 'kept' };
    expect(
      (await sync(mom.token, 0, [{ ...change, data: edited, updatedAt: 2000 }])).json.rejected,
    ).toEqual([]);
    const stale = await sync(admin.token, 0, [{ ...change, updatedAt: 1500 }]);
    expect(stale.json.records.find((r) => r.id === id)?.data).toEqual(edited);

    const view = await sync(grandma.token, 0);
    expect(view.json.records).toEqual([]);
    const forbidden = await sync(grandma.token, 0, [{ ...change, id: randomUUID() }]);
    expect(forbidden.json.rejected[0]?.reason).toBe('forbidden');
    // 猜到 id 提交改动，也不能把小金库补发出来
    const guessed = await sync(grandma.token, 0, [{ ...change, updatedAt: 1 }]);
    expect(guessed.json.records).toEqual([]);

    await sync(admin.token, 0, [{ ...change, data: edited, deleted: true, updatedAt: 3000 }]);
    const after = await sync(mom.token, 0);
    expect(after.json.records.find((r) => r.id === id)?.deleted).toBe(true);
  });

  it('育儿资料、收藏和收藏夹能同步，后写胜出，软删除；viewer 读不到也不能写', async () => {
    const { admin } = await newFamily();
    const mom = await join(admin.token, 'caregiver', '妈妈');
    const grandma = await join(admin.token, 'viewer', '奶奶');
    const resourceId = randomUUID();
    const folderId = randomUUID();
    const favoriteId = favoriteIdFor(resourceId);
    const resource = {
      type: 'resource',
      url: 'https://b23.tv/AbC1234',
      title: '虚构的睡眠视频',
      addedAt: 1000,
      byName: '爸爸',
    };
    const folder = { type: 'favorite-folder', name: '睡眠', createdAt: 1000 };
    const favorite = {
      type: 'favorite',
      target: 'resource',
      targetId: resourceId,
      addedAt: 1000,
      folders: [folderId],
    };
    const changes = [
      {
        id: resourceId,
        collection: 'event' as const,
        data: resource,
        deleted: false,
        updatedAt: 1000,
      },
      { id: folderId, collection: 'event' as const, data: folder, deleted: false, updatedAt: 1000 },
      {
        id: favoriteId,
        collection: 'event' as const,
        data: favorite,
        deleted: false,
        updatedAt: 1000,
      },
    ];
    expect((await sync(admin.token, 0, changes)).json.rejected).toEqual([]);
    // 离线重试不会多出来
    expect((await sync(admin.token, 0, changes)).json.rejected).toEqual([]);
    const seen = await sync(mom.token, 0);
    for (const change of changes) {
      expect(seen.json.records.filter((r) => r.id === change.id)).toHaveLength(1);
      expect(seen.json.records.find((r) => r.id === change.id)?.data).toEqual(change.data);
    }

    // 妈妈在另一台手机上也收藏了同一条：id 一样，是同一条记录，后写胜出
    const momFavorite = { ...favorite, folders: [], addedAt: 2000, future: 'kept' };
    expect(
      (
        await sync(mom.token, 0, [
          { ...changes[2], id: favoriteIdFor(resourceId), data: momFavorite, updatedAt: 2000 },
        ])
      ).json.rejected,
    ).toEqual([]);
    const stale = await sync(admin.token, 0, [{ ...changes[2], updatedAt: 1500 }]);
    expect(stale.json.records.find((r) => r.id === favoriteId)?.data).toEqual(momFavorite);

    const view = await sync(grandma.token, 0);
    expect(view.json.records).toEqual([]);
    const forbidden = await sync(grandma.token, 0, [{ ...changes[0], id: randomUUID() }]);
    expect(forbidden.json.rejected[0]?.reason).toBe('forbidden');
    // 猜到 id 提交改动，也拿不到资料
    const guessed = await sync(grandma.token, 0, [{ ...changes[0], updatedAt: 1 }]);
    expect(guessed.json.records).toEqual([]);

    await sync(admin.token, 0, [{ ...changes[0], deleted: true, updatedAt: 3000 }]);
    const after = await sync(mom.token, 0);
    expect(after.json.records.find((r) => r.id === resourceId)?.deleted).toBe(true);
    // 资料删了，收藏不跟着删：撤销删除后收藏原样回来
    expect(after.json.records.find((r) => r.id === favoriteId)?.deleted).toBe(false);
  });

  it('育儿资料的链接只收网页链接，格式不对整条被拒', async () => {
    const { admin } = await newFamily();
    const bad = ['javascript:alert(1)', 'intent://x#Intent;end', 'file:///etc/passwd', ''].map(
      (url) => ({
        id: randomUUID(),
        collection: 'event' as const,
        data: { type: 'resource', url, title: '虚构', addedAt: 1000 },
        deleted: false,
        updatedAt: 1000,
      }),
    );
    const result = await sync(admin.token, 0, bad);
    expect(result.json.rejected.map((r) => r.reason)).toEqual([
      'invalid',
      'invalid',
      'invalid',
      'invalid',
    ]);
  });

  it('小金库的金额只收整数最小单位，格式不对整条被拒', async () => {
    const { admin } = await newFamily();
    const base = { type: 'money', flow: 'in', currency: 'CNY', happenedAt: 1000 };
    const bad = [12.5, 0, -1].map((amountMinor) => ({
      id: randomUUID(),
      collection: 'event' as const,
      data: { ...base, amountMinor },
      deleted: false,
      updatedAt: 1000,
    }));
    const result = await sync(admin.token, 0, bad);
    expect(result.json.rejected.map((r) => r.reason)).toEqual(['invalid', 'invalid', 'invalid']);
  });

  it('删除奶粉是软删除，能同步给其他设备', async () => {
    const { admin } = await newFamily();
    const id = randomUUID();
    const data = { type: 'formula', name: '虚构奶粉', basis: 'per100ml', values: {} };
    await sync(admin.token, 0, [
      { id, collection: 'event', data, deleted: false, updatedAt: 1000 },
    ]);
    await sync(admin.token, 0, [{ id, collection: 'event', data, deleted: true, updatedAt: 2000 }]);
    const after = await sync(admin.token, 0);
    expect(after.json.records.find((r) => r.id === id)?.deleted).toBe(true);
  });

  it('viewer 不能修改已有的回忆和信，原内容不变', async () => {
    const { admin } = await newFamily();
    const grandma = await join(admin.token, 'viewer', '奶奶');
    const momentId = randomUUID();
    const letterId = randomUUID();
    const moment = { title: '第一次笑', text: '', at: 1, milestone: true, media: [] };
    const letter = { title: '百天快乐', text: '虚构的内容', at: 1 };
    await sync(admin.token, 0, [
      { id: momentId, collection: 'moment', data: moment, deleted: false, updatedAt: 1 },
      { id: letterId, collection: 'letter', data: letter, deleted: false, updatedAt: 1 },
    ]);
    const write = await sync(grandma.token, 0, [
      {
        id: momentId,
        collection: 'moment',
        data: { ...moment, title: '外公改的' },
        deleted: false,
        updatedAt: 2,
      },
      {
        id: letterId,
        collection: 'letter',
        data: { ...letter, title: '外公改的' },
        deleted: false,
        updatedAt: 2,
      },
    ]);
    expect(write.json.rejected.map((r) => r.reason)).toEqual(['forbidden', 'forbidden']);
    // 被拒绝的手机拿回服务端的版本，不留下自己改的内容。
    expect(write.json.records.find((r) => r.id === momentId)?.data).toMatchObject(moment);
    const all = await sync(admin.token, 0);
    expect(all.json.records.find((r) => r.id === momentId)?.data).toMatchObject(moment);
    expect(all.json.records.find((r) => r.id === letterId)?.data).toMatchObject(letter);
  });
  it('修改记录时，时间可以改到以前，未知字段和记录人原样保存', async () => {
    const { admin } = await newFamily();
    const mom = await join(admin.token, 'caregiver', '妈妈');
    const id = randomUUID();
    const data = { type: 'feed', at: 5000, ml: 90, byName: '爸爸', milkKind: 'formula' };
    await sync(admin.token, 0, [{ id, collection: 'event', data, deleted: false, updatedAt: 1 }]);
    const edited = { ...data, at: 1000, ml: 100 };
    const result = await sync(mom.token, 0, [
      { id, collection: 'event', data: edited, deleted: false, updatedAt: 2 },
    ]);
    expect(result.json.rejected).toEqual([]);
    const all = await sync(admin.token, 0);
    const record = all.json.records.find((r) => r.id === id);
    expect(record?.data).toEqual(edited);
    expect(record?.updatedAt).toBe(2);
  });
  it('修改回忆时新加的文件引用，未知字段不丢', async () => {
    const { admin } = await newFamily();
    const id = randomUUID();
    const media = {
      id: randomUUID(),
      kind: 'image',
      mime: 'image/png',
      size: 1,
      futureField: 'keep',
    };
    const moment = { title: '虚构的一刻', text: '', at: 1, milestone: false, media: [] };
    await sync(admin.token, 0, [
      { id, collection: 'moment', data: moment, deleted: false, updatedAt: 1 },
    ]);
    await sync(admin.token, 0, [
      {
        id,
        collection: 'moment',
        data: { ...moment, media: [media] },
        deleted: false,
        updatedAt: 2,
      },
    ]);
    const all = await sync(admin.token, 0);
    expect(all.json.records.find((r) => r.id === id)?.data).toMatchObject({ media: [media] });
  });
  it('疫苗本的配置能同步，一起记录的家人能改，viewer 读不到也不能写', async () => {
    const { admin } = await newFamily();
    const mom = await join(admin.token, 'caregiver', '妈妈');
    const grandma = await join(admin.token, 'viewer', '奶奶');
    const hide = {
      id: randomUUID(),
      collection: 'event' as const,
      data: { type: 'vaccine-plan', vaccineId: 'sg:bcg', hidden: true },
      deleted: false,
      updatedAt: Date.now(),
    };
    const added = {
      id: randomUUID(),
      collection: 'event' as const,
      data: {
        type: 'vaccine-plan',
        vaccineId: `custom:${randomUUID()}`,
        name: '虚构疫苗',
        months: 6,
      },
      deleted: false,
      updatedAt: Date.now(),
    };
    const write = await sync(admin.token, 0, [hide]);
    expect(write.json.rejected).toEqual([]);
    const byCaregiver = await sync(mom.token, 0, [added]);
    expect(byCaregiver.json.rejected).toEqual([]);

    const seen = await sync(mom.token, 0);
    expect(seen.json.records.find((r) => r.id === hide.id)?.data).toEqual(hide.data);
    expect(seen.json.records.find((r) => r.id === added.id)?.data).toEqual(added.data);

    const view = await sync(grandma.token, 0);
    expect(view.json.records).toEqual([]);
    const forbidden = await sync(grandma.token, 0, [{ ...hide, id: randomUUID() }]);
    expect(forbidden.json.rejected[0]?.reason).toBe('forbidden');
    // 猜到 id 提交改动，既不能改掉配置，也不能把它补发出来。
    const guessed = await sync(grandma.token, 0, [
      { ...hide, data: { ...hide.data, hidden: false }, updatedAt: Date.now() + 60_000 },
    ]);
    expect(guessed.json.rejected[0]?.reason).toBe('forbidden');
    expect(guessed.json.records).toEqual([]);
    const after = await sync(admin.token, 0);
    expect(after.json.records.find((r) => r.id === hide.id)?.data).toEqual(hide.data);
  });

  it('疫苗本的配置后写胜出，自己加的移除后是软删除', async () => {
    const { admin } = await newFamily();
    const id = randomUUID();
    const data = { type: 'vaccine-plan', vaccineId: `custom:${id}`, name: '虚构疫苗' };
    await sync(admin.token, 0, [
      { id, collection: 'event', data, deleted: false, updatedAt: 2000 },
    ]);
    await sync(admin.token, 0, [
      {
        id,
        collection: 'event',
        data: { ...data, name: '更早的改动' },
        deleted: false,
        updatedAt: 1000,
      },
    ]);
    await sync(admin.token, 0, [{ id, collection: 'event', data, deleted: true, updatedAt: 3000 }]);
    const after = await sync(admin.token, 0);
    const record = after.json.records.find((r) => r.id === id);
    expect(record?.deleted).toBe(true);
    expect(record?.data).toEqual(data);
  });

  it('viewer 能读宝宝档案，但不能换头像', async () => {
    const { admin, family } = await newFamily();
    const grandma = await join(admin.token, 'viewer', '奶奶');
    const avatar = (id: string) => ({ id, kind: 'image', mime: 'image/jpeg', size: 1 });
    const mine = randomUUID();
    await sync(admin.token, 0, [babyChange(family.id, { avatar: avatar(mine) }, 1000)]);
    const write = await sync(grandma.token, 0, [
      babyChange(family.id, { avatar: avatar(randomUUID()) }, 2000),
    ]);
    expect(write.json.rejected).toEqual([{ id: family.id, reason: 'forbidden' }]);
    const stored = write.json.records.find((r) => r.id === family.id);
    expect((stored!.data as { avatar: { id: string } }).avatar.id).toBe(mine);
  });
  it('大量记录分页拉取，不遗漏', async () => {
    const { admin } = await newFamily();
    const ids = new Set<string>();
    for (let batch = 0; batch < 3; batch++) {
      const changes = Array.from({ length: 300 }, () => feedChange());
      for (const c of changes) ids.add(c.id);
      await sync(admin.token, 0, changes);
    }
    const seen = new Set<string>();
    let cursor = 0;
    for (let guard = 0; guard < 10; guard++) {
      const { json } = await sync(admin.token, cursor);
      for (const r of json.records) seen.add(r.id);
      cursor = json.cursor;
      if (!json.hasMore) break;
    }
    expect(seen.size).toBe(ids.size);
  });
  it('并发写入时 seq 不重复', async () => {
    const { admin } = await newFamily();
    await Promise.all(Array.from({ length: 10 }, () => sync(admin.token, 0, [feedChange()])));
    const { json } = await sync(admin.token, 0);
    const seqs = json.records.map((r) => r.seq);
    expect(new Set(seqs).size).toBe(10);
    expect(Math.max(...seqs)).toBe(10);
  });
  it('长轮询在有新记录时立刻返回', async () => {
    const { admin } = await newFamily();
    const mom = await join(admin.token, 'caregiver', '妈妈');
    const { json } = await sync(mom.token, 0);
    const started = Date.now();
    const waiting = api<{ changed: boolean }>('GET', `/v1/sync/wait?cursor=${json.cursor}`, {
      token: mom.token,
    });
    await new Promise((r) => setTimeout(r, 100));
    await sync(admin.token, 0, [feedChange()]);
    const result = await waiting;
    expect(result.json.changed).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe('审查发现的同步问题（回归）', () => {
  it('写入和拉取并发时，读者不会漏掉任何记录', async () => {
    const { admin } = await newFamily();
    const mom = await join(admin.token, 'caregiver', '妈妈');
    const written = new Set<string>();
    let writing = true;
    const writers = Array.from({ length: 4 }, async () => {
      for (let i = 0; i < 40; i++) {
        const change = feedChange();
        await sync(admin.token, 0, [change]);
        written.add(change.id);
      }
    });
    const done = Promise.all(writers).then(() => {
      writing = false;
    });
    const seen = new Set<string>();
    let cursor = 0;
    while (writing) {
      const { json } = await sync(mom.token, cursor);
      for (const r of json.records) seen.add(r.id);
      cursor = json.cursor;
    }
    await done;
    for (let guard = 0; guard < 20; guard++) {
      const { json } = await sync(mom.token, cursor);
      for (const r of json.records) seen.add(r.id);
      cursor = json.cursor;
      if (!json.hasMore && json.records.length === 0) break;
    }
    expect([...written].filter((id) => !seen.has(id))).toEqual([]);
  });
  it('分页查询和读 seq 之间有写入提交时，不会被游标跳过', async () => {
    const { admin } = await newFamily();
    const mom = await join(admin.token, 'caregiver', '妈妈');
    const before = feedChange();
    await sync(admin.token, 0, [before]);

    // 在“读家庭 seq”的语句前后各插入一次写入，覆盖两种语句顺序下的竞争窗口。
    const writer = createApp({ sql, config });
    const raw = sql;
    const injected: string[] = [];
    let armed = true;
    const inject = async () => {
      const change = feedChange();
      injected.push(change.id);
      const response = await writer.request('/v1/sync', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${admin.token}` },
        body: JSON.stringify({ cursor: 0, changes: [change] }),
      });
      expect(response.status).toBe(200);
    };
    const racing = new Proxy(raw, {
      apply(target, thisArg, args: unknown[]) {
        const text = Array.isArray(args[0]) ? (args[0] as string[]).join('?') : '';
        if (armed && text.includes('SELECT seq FROM families') && !text.includes('FOR UPDATE')) {
          armed = false;
          return (async () => {
            await inject();
            const result = await Reflect.apply(target, thisArg, args);
            await inject();
            return result;
          })();
        }
        return Reflect.apply(target, thisArg, args);
      },
    });
    app = createApp({ sql: racing as Sql, config });

    const seen = new Set<string>();
    let cursor = 0;
    for (let i = 0; i < 4; i++) {
      const { json } = await sync(mom.token, cursor);
      for (const r of json.records) seen.add(r.id);
      cursor = json.cursor;
    }
    expect(injected).toHaveLength(2);
    expect([before.id, ...injected].filter((id) => !seen.has(id))).toEqual([]);
  });
  it('从备份恢复后，手机的游标超前也能重新拿到记录，且不漏新记录', async () => {
    const { admin } = await newFamily();
    const mom = await join(admin.token, 'caregiver', '妈妈');
    const kept = feedChange();
    await sync(admin.token, 0, [kept]);
    const fresh = feedChange();
    // 手机的游标来自恢复之前，比现在的 seq 大。
    await sync(admin.token, 0, [fresh]);
    const { json } = await sync(mom.token, 999_999);
    expect(json.records.map((r) => r.id)).toEqual(expect.arrayContaining([kept.id, fresh.id]));
    expect(json.cursor).toBeLessThan(999_999);
    const next = await sync(mom.token, json.cursor);
    expect(next.json.records).toEqual([]);
  });
  it('响应里带当前角色，客户端才能发现权限变化', async () => {
    const { admin } = await newFamily();
    expect((await sync(admin.token, 0)).json.role).toBe('admin');
  });
  it('没有写权限时返回服务端当前版本，让客户端收敛而不是丢数据', async () => {
    const { admin } = await newFamily();
    const member = await join(admin.token, 'caregiver', '妈妈');
    const id = randomUUID();
    const moment = (title: string, updatedAt: number) => ({
      id,
      collection: 'moment' as const,
      data: { title, text: '', at: 1, milestone: false, media: [] },
      deleted: false,
      updatedAt,
    });
    await sync(member.token, 0, [moment('原来的', 1000)]);
    await api('PATCH', `/v1/family/members/${member.user.id}`, {
      token: admin.token,
      body: { role: 'viewer' },
    });
    const { json } = await sync(member.token, 999_999, [moment('离线改的', 2000)]);
    expect(json.rejected[0]?.reason).toBe('forbidden');
    expect((json.records.find((r) => r.id === id)!.data as { title: string }).title).toBe('原来的');
  });
  it('补发服务端版本时不能泄露 viewer 读不到的集合', async () => {
    const { admin } = await newFamily();
    const grandma = await join(admin.token, 'viewer', '奶奶');
    const secret = randomUUID();
    await sync(admin.token, 0, [
      {
        id: secret,
        collection: 'document',
        data: { name: '虚构证件', number: 'T0000000X', files: [] },
        deleted: false,
        updatedAt: 1,
      },
    ]);
    const probe = await sync(grandma.token, 999_999, [
      {
        id: secret,
        collection: 'document',
        data: { name: '探测', files: [] },
        deleted: false,
        updatedAt: 2,
      },
    ]);
    expect(probe.json.records.map((r) => r.id)).not.toContain(secret);
  });
  it('登录会话在使用时自动延长，常用的手机不会到期被踢', async () => {
    const user = await newUser();
    await sql`UPDATE sessions SET expires_at = now() + interval '10 days' WHERE user_id = ${user.user.id}`;
    await api('GET', '/v1/me', { token: user.token });
    const [row] = await sql<{ days: number }[]>`
      SELECT EXTRACT(DAY FROM expires_at - now())::int AS days FROM sessions WHERE user_id = ${user.user.id}`;
    expect(row?.days).toBeGreaterThan(300);
  });
});

describe('家庭的地区只有管理员能改', () => {
  const stored = async (token: string, id: string) => {
    const { json } = await sync(token, 0);
    return json.records.find((r) => r.id === id)?.data as Record<string, unknown>;
  };
  it('管理员可以设置和修改', async () => {
    const { admin, family } = await newFamily();
    await sync(admin.token, 0, [babyChange(family.id, { region: 'SG' }, 1000)]);
    expect((await stored(admin.token, family.id)).region).toBe('SG');
    await sync(admin.token, 0, [babyChange(family.id, { region: 'US' }, 2000)]);
    expect((await stored(admin.token, family.id)).region).toBe('US');
  });
  it('其他家人写入时不能改地区，其余修改照常生效', async () => {
    const { admin, family } = await newFamily();
    const mom = await join(admin.token, 'caregiver', '妈妈');
    await sync(admin.token, 0, [babyChange(family.id, { region: 'SG' }, 1000)]);
    const result = await sync(mom.token, 0, [
      babyChange(family.id, { region: 'US', name: '改名' }, 2000),
    ]);
    expect(result.json.rejected).toEqual([]);
    const data = await stored(admin.token, family.id);
    expect(data.region).toBe('SG');
    expect(data.name).toBe('改名');
  });
  it('其他家人拿着旧版本保存，不能把地区改回去或抹掉', async () => {
    const { admin, family } = await newFamily();
    const mom = await join(admin.token, 'caregiver', '妈妈');
    await sync(admin.token, 0, [babyChange(family.id, { region: 'US' }, 1000)]);
    await sync(mom.token, 0, [babyChange(family.id, { name: '换头像' }, 2000)]);
    expect((await stored(admin.token, family.id)).region).toBe('US');
  });
  it('其他家人也不能用另一条记录绕过', async () => {
    const { admin, family } = await newFamily();
    const mom = await join(admin.token, 'caregiver', '妈妈');
    await sync(admin.token, 0, [babyChange(family.id, { region: 'SG' }, 1000)]);
    // 后加的档案要带 createdAt，有两份档案起只有新版 App 能同步（issue #106）。
    const other = randomUUID();
    await syncMultiBaby(mom.token, 0, [babyChange(other, { region: 'US', createdAt: 5000 }, 2000)]);
    const { json } = await syncMultiBaby(admin.token, 0);
    const data = json.records.find((r) => r.id === other)?.data as Record<string, unknown>;
    expect(data.region).toBe('SG');
  });
  it('没有地区的旧档案，其他家人保存后仍然没有地区', async () => {
    const { admin, family } = await newFamily();
    const mom = await join(admin.token, 'caregiver', '妈妈');
    await sync(admin.token, 0, [babyChange(family.id, {}, 1000)]);
    await sync(mom.token, 0, [babyChange(family.id, { region: 'US' }, 2000)]);
    expect((await stored(admin.token, family.id)).region).toBeUndefined();
  });
  it('新版本写入的未知地区能保存，不被拒绝', async () => {
    const { admin, family } = await newFamily();
    const result = await sync(admin.token, 0, [babyChange(family.id, { region: 'JP' }, 1000)]);
    expect(result.json.rejected).toEqual([]);
    expect((await stored(admin.token, family.id)).region).toBe('JP');
  });
});

describe('推送', () => {
  async function familyWithToken(prefs: Record<string, unknown> = {}) {
    const { admin, family } = await newFamily();
    const mom = await join(admin.token, 'caregiver', '妈妈');
    await api('POST', '/v1/me/push-token', {
      token: mom.token,
      body: { token: 'ExponentPushToken[mom]', deviceId: randomUUID() },
    });
    await api('PUT', '/v1/me/prefs', {
      token: mom.token,
      body: {
        feedReminder: true,
        familyNotify: true,
        quietNight: false,
        timezone: 'Asia/Singapore',
        documentLock: false,
        videoWifiOnly: true,
        ...prefs,
      },
    });
    return { admin, mom, family };
  }
  const flush = () => new Promise((r) => setTimeout(r, 100));

  it('记录后通知其他家人，不通知自己', async () => {
    const { admin } = await familyWithToken();
    await sync(admin.token, 0, [feedChange({ ml: 90 })]);
    await flush();
    expect(pushes).toEqual([
      { token: 'ExponentPushToken[mom]', title: '爸爸 刚刚记录了', body: '喂奶 90ml' },
    ]);
  });
  it('按收件人自己选的单位写推送内容', async () => {
    const { admin } = await familyWithToken({ units: { volume: 'oz' } });
    await sync(admin.token, 0, [feedChange({ ml: 90 })]);
    await flush();
    expect(pushes.map((p) => p.body)).toEqual(['喂奶 3oz']);
  });
  it('收件人没选单位时跟随家庭的地区', async () => {
    const { admin, family } = await familyWithToken();
    await sync(admin.token, 0, [babyChange(family.id, { region: 'US' })]);
    await flush();
    pushes = [];
    await sync(admin.token, 0, [
      {
        id: randomUUID(),
        collection: 'event',
        data: { type: 'temp', at: Date.now(), celsius: 38 },
        deleted: false,
        updatedAt: Date.now(),
      },
    ]);
    await flush();
    expect(pushes.map((p) => p.body)).toEqual(['体温 100.4°F']);
  });
  it('收件人明确选了公制时，美国家庭也用公制', async () => {
    const { admin, family } = await familyWithToken({ units: { volume: 'ml' } });
    await sync(admin.token, 0, [babyChange(family.id, { region: 'US' })]);
    await flush();
    pushes = [];
    await sync(admin.token, 0, [feedChange({ ml: 90 })]);
    await flush();
    expect(pushes.map((p) => p.body)).toEqual(['喂奶 90ml']);
  });
  it('v0.1.0 没存过时区的账号，夜间安静仍按新加坡判断', async () => {
    const { admin } = await newFamily();
    const { json } = await api<MeResponse>('GET', '/v1/me', { token: admin.token });
    expect(json.prefs.timezone).toBe('Asia/Singapore');
  });
  it('v0.1.0 发来的完整偏好（没有 units）能保存，不会弄丢已选的单位以外的设置', async () => {
    const { admin } = await newFamily();
    const body = {
      feedReminder: false,
      familyNotify: true,
      quietNight: true,
      timezone: 'Asia/Singapore',
      documentLock: false,
      videoWifiOnly: true,
    };
    const saved = await api('PUT', '/v1/me/prefs', { token: admin.token, body });
    expect(saved.status).toBe(200);
    const { json } = await api<MeResponse>('GET', '/v1/me', { token: admin.token });
    expect(json.prefs).toMatchObject(body);
    expect(json.prefs.units).toBeUndefined();
  });
  it('v0.1.0 建的档案没有地区，推送还是公制', async () => {
    const { admin, family } = await familyWithToken();
    await sync(admin.token, 0, [babyChange(family.id, {})]);
    await flush();
    pushes = [];
    await sync(admin.token, 0, [feedChange({ ml: 90 })]);
    await flush();
    expect(pushes.map((p) => p.body)).toEqual(['喂奶 90ml']);
  });
  it('不认识的单位不会让收件人的其他设置失效', async () => {
    const { admin } = await familyWithToken({
      familyNotify: false,
      units: { volume: 'cup' },
    });
    await sync(admin.token, 0, [feedChange()]);
    await flush();
    expect(pushes).toEqual([]);
  });
  it('关闭通知后不再推送', async () => {
    const { admin } = await familyWithToken({ familyNotify: false });
    await sync(admin.token, 0, [feedChange()]);
    await flush();
    expect(pushes).toEqual([]);
  });
  it('补记很久以前的记录不打扰家人', async () => {
    const { admin } = await familyWithToken();
    const old = feedChange();
    old.data.at = Date.now() - 5 * 3_600_000;
    await sync(admin.token, 0, [old]);
    await flush();
    expect(pushes).toEqual([]);
  });
  it('配置奶粉不是一条记录，不打扰家人', async () => {
    const { admin } = await familyWithToken();
    await sync(admin.token, 0, [
      {
        id: randomUUID(),
        collection: 'event',
        data: { type: 'formula', name: '虚构奶粉', basis: 'per100ml', values: {} },
        deleted: false,
        updatedAt: Date.now(),
      },
    ]);
    await flush();
    expect(pushes).toEqual([]);
  });
  it('带奶粉字段的喂奶，通知文字和以前一样', async () => {
    const { admin } = await familyWithToken();
    const fed = feedChange();
    await sync(admin.token, 0, [
      {
        ...fed,
        data: {
          ...fed.data,
          milkType: 'formula',
          formulaId: randomUUID(),
          formula: { name: '虚构奶粉', per100ml: {} },
        },
      },
    ]);
    await flush();
    expect(pushes[0]?.body).toBe('喂奶 90ml');
  });
  it('配置疫苗本不是一条记录，不打扰家人', async () => {
    const { admin } = await familyWithToken();
    await sync(admin.token, 0, [
      {
        id: randomUUID(),
        collection: 'event',
        data: { type: 'vaccine-plan', vaccineId: 'sg:bcg', hidden: true },
        deleted: false,
        updatedAt: Date.now(),
      },
      {
        id: randomUUID(),
        collection: 'event',
        // 就算以后的版本给配置带上了时间，也不能当成一条新记录通知。
        data: { type: 'vaccine-plan', vaccineId: 'sg:hepb-1', hidden: true, at: Date.now() },
        deleted: false,
        updatedAt: Date.now(),
      },
    ]);
    await flush();
    expect(pushes).toEqual([]);
  });
  it('记小金库不是一条照护记录，不打扰家人，哪怕带着 at', async () => {
    const { admin } = await familyWithToken();
    const money = { type: 'money', flow: 'in', amountMinor: 100, currency: 'SGD' };
    await sync(admin.token, 0, [
      {
        id: randomUUID(),
        collection: 'event',
        data: { ...money, happenedAt: Date.now() },
        deleted: false,
        updatedAt: Date.now(),
      },
      {
        id: randomUUID(),
        collection: 'event',
        data: { ...money, happenedAt: Date.now(), at: Date.now() },
        deleted: false,
        updatedAt: Date.now(),
      },
    ]);
    await flush();
    expect(pushes).toEqual([]);
  });
  it('存资料、收藏、建收藏夹都不打扰家人，哪怕带着 at', async () => {
    const { admin } = await familyWithToken();
    const now = Date.now();
    const targetId = randomUUID();
    const items = [
      { type: 'resource', url: 'https://youtu.be/x', title: '虚构', addedAt: now },
      { type: 'favorite', target: 'resource', targetId, addedAt: now },
      { type: 'favorite-folder', name: '辅食', createdAt: now },
    ];
    await sync(
      admin.token,
      0,
      items.flatMap((data) => [
        { id: randomUUID(), collection: 'event', data, deleted: false, updatedAt: now },
        {
          id: randomUUID(),
          collection: 'event',
          data: { ...data, at: now },
          deleted: false,
          updatedAt: now,
        },
      ]),
    );
    await flush();
    expect(pushes).toEqual([]);
  });
  it('viewer 不会收到喂奶通知', async () => {
    const { admin } = await newFamily();
    const grandma = await join(admin.token, 'viewer', '奶奶');
    await api('POST', '/v1/me/push-token', {
      token: grandma.token,
      body: { token: 'ExponentPushToken[g]', deviceId: randomUUID() },
    });
    await sync(admin.token, 0, [feedChange()]);
    await flush();
    expect(pushes).toEqual([]);
  });
  it('夜间安静判断按用户时区', () => {
    const utc = (h: number) => Date.UTC(2026, 0, 15, h);
    expect(isQuietHour(utc(16), 'Asia/Singapore')).toBe(true); // 新加坡 00:00
    expect(isQuietHour(utc(4), 'Asia/Singapore')).toBe(false); // 新加坡 12:00
    expect(isQuietHour(utc(15), 'Asia/Singapore')).toBe(true); // 新加坡 23:00
    expect(isQuietHour(utc(23), 'Asia/Singapore')).toBe(false); // 新加坡 07:00
  });
});

describe('文件上传（真实 S3 协议）', () => {
  const bytes = Buffer.from('fake image content 🌱'.repeat(100));

  async function uploadUrl(token: string, overrides: Record<string, unknown> = {}) {
    const id = randomUUID();
    const body = {
      id,
      scope: 'memory',
      variant: 'original',
      mime: 'image/jpeg',
      size: bytes.length,
      ...overrides,
    };
    const response = await api<UploadUrlResponse>('POST', '/v1/media/upload-url', { token, body });
    return { id: body.id as string, ...response };
  }

  async function uploadAll(token: string, overrides: Record<string, unknown> = {}) {
    const { id, json } = await uploadUrl(token, overrides);
    const put = await fetch(json.url, { method: 'PUT', headers: json.headers, body: bytes });
    expect(put.status).toBe(200);
    const variant = (overrides.variant as string) ?? 'original';
    const done = await api('POST', `/v1/media/${id}/complete`, { token, body: { variant } });
    expect(done.status).toBe(200);
    return id;
  }

  async function urlFor(token: string, id: string, variant: 'original' | 'thumb' = 'original') {
    const { json } = await api<MediaUrlsResponse>('POST', '/v1/media/urls', {
      token,
      body: { items: [{ id, variant }] },
    });
    return json.urls[0]!;
  }

  it('预签名直传、完成校验、下载，内容完全一致', async () => {
    const { admin } = await newFamily();
    const id = await uploadAll(admin.token);
    const { url } = await urlFor(admin.token, id);
    const downloaded = await fetch(url!);
    expect(downloaded.status).toBe(200);
    expect(Buffer.from(await downloaded.arrayBuffer()).equals(bytes)).toBe(true);
  });
  it('原图和缩略图分别存储', async () => {
    const { admin } = await newFamily();
    const id = await uploadAll(admin.token);
    await uploadAll(admin.token, { id, variant: 'thumb' });
    expect((await urlFor(admin.token, id, 'thumb')).url).toContain('/thumb');
    expect((await urlFor(admin.token, id, 'original')).url).toContain('/original');
  });
  it('还没上传完不能标记完成，也拿不到下载链接', async () => {
    const { admin } = await newFamily();
    const { id } = await uploadUrl(admin.token);
    const r = await api('POST', `/v1/media/${id}/complete`, {
      token: admin.token,
      body: { variant: 'original' },
    });
    expect(r.status).toBe(409);
    expect((await urlFor(admin.token, id)).url).toBeNull();
  });
  it('实际大小和声明不符时拒绝并删除，防止绕过大小限制', async () => {
    const { admin } = await newFamily();
    const { id, json } = await uploadUrl(admin.token, { size: 10 });
    await fetch(json.url, { method: 'PUT', headers: json.headers, body: bytes });
    const r = await api('POST', `/v1/media/${id}/complete`, {
      token: admin.token,
      body: { variant: 'original' },
    });
    expect(r.status).toBe(409);
    const key = (
      await sql<{ object_key: string }[]>`SELECT object_key FROM media WHERE id = ${id}`
    )[0]!.object_key;
    expect(key).toContain(id);
    const after = await uploadUrl(admin.token, { id, size: bytes.length });
    expect(after.status).toBe(200);
  });
  it('拒绝不在白名单的类型和超大文件', async () => {
    const { admin } = await newFamily();
    expect((await uploadUrl(admin.token, { mime: 'text/html' })).status).toBe(400);
    expect(
      (await uploadUrl(admin.token, { mime: 'application/pdf', scope: 'memory' })).status,
    ).toBe(400);
    expect((await uploadUrl(admin.token, { size: config.maxUploadBytes + 1 })).status).toBe(413);
  });
  it('viewer 能看回忆，不能看证件，也不能上传', async () => {
    const { admin } = await newFamily();
    const grandma = await join(admin.token, 'viewer', '奶奶');
    const memory = await uploadAll(admin.token);
    const doc = await uploadAll(admin.token, { scope: 'document', mime: 'application/pdf' });
    expect((await urlFor(grandma.token, memory)).url).toBeTruthy();
    expect((await urlFor(grandma.token, doc)).url).toBeNull();
    expect((await uploadUrl(grandma.token)).status).toBe(403);
  });
  it('其他家庭拿不到链接，也不能复用文件 id', async () => {
    const a = await newFamily();
    const b = await newFamily();
    const id = await uploadAll(a.admin.token);
    expect((await urlFor(b.admin.token, id)).url).toBeNull();
    expect((await uploadUrl(b.admin.token, { id })).status).toBe(403);
    expect(
      (
        await api('POST', `/v1/media/${id}/complete`, {
          token: b.admin.token,
          body: { variant: 'original' },
        })
      ).status,
    ).toBe(404);
  });
  it('证件链接最多 10 分钟有效，回忆链接更长', async () => {
    const { admin } = await newFamily();
    const memory = await uploadAll(admin.token);
    const doc = await uploadAll(admin.token, { scope: 'document', mime: 'application/pdf' });
    expect((await urlFor(admin.token, doc)).expiresIn).toBeLessThanOrEqual(600);
    expect((await urlFor(admin.token, doc)).url).toContain('X-Amz-Expires=600');
    expect((await urlFor(admin.token, memory)).expiresIn).toBeGreaterThan(600);
  });
  it('用量按类别统计，只算已完成的文件', async () => {
    const { admin } = await newFamily();
    await uploadAll(admin.token);
    await uploadAll(admin.token, { mime: 'video/mp4' });
    await uploadAll(admin.token, { scope: 'document', mime: 'application/pdf' });
    await uploadUrl(admin.token);
    const { json } = await api<StorageUsage>('GET', '/v1/storage/usage', { token: admin.token });
    expect(json).toMatchObject({
      image: bytes.length,
      video: bytes.length,
      audio: 0,
      document: bytes.length,
      total: bytes.length * 3,
    });
  });
  it('没有配置任何存储时给出明确提示', async () => {
    const { admin } = await newFamily();
    app = createApp({ sql, config: { ...config, serverStorage: null } });
    const r = await uploadUrl(admin.token);
    expect(r.status).toBe(503);
  });
});

describe('存储设置', () => {
  const localS3 = () => ({
    provider: 'other' as const,
    endpoint: process.env.TEST_S3_ENDPOINT ?? 'http://localhost:59000',
    region: 'us-east-1',
    bucket: 'xiaodouya-dev',
    accessKeyId: 'devaccesskey',
    secretAccessKey: 'devsecretkey',
  });

  it('测试连接真实地读写，错误的密钥和 Bucket 不会通过', async () => {
    const { admin } = await newFamily();
    const test = (body: unknown) =>
      api<StorageTestResult>('POST', '/v1/storage/test', { token: admin.token, body });
    expect((await test(localS3())).json.ok).toBe(true);
    const badKey = await test({ ...localS3(), secretAccessKey: 'wrong' });
    expect(badKey.json.ok).toBe(false);
    expect(badKey.json.message).toContain('密钥');
  });
  it('存储错误翻译成用户能看懂的提示', () => {
    // SeaweedFS 写入时会自动建 Bucket，真实的 R2 和 S3 不会，所以这里直接验证错误翻译。
    expect(describeStorageError({ name: 'NoSuchBucket' })).toContain('Bucket');
    expect(describeStorageError({ $metadata: { httpStatusCode: 404 } })).toContain('Bucket');
    expect(describeStorageError({ name: 'SignatureDoesNotMatch' })).toContain('密钥');
    expect(describeStorageError({ $metadata: { httpStatusCode: 403 } })).toContain('密钥');
    expect(describeStorageError({ code: 'ENOTFOUND' })).toContain('连接不上');
    expect(describeStorageError(new Error('boom'))).toContain('连接失败');
  });
  it('保存后 Secret 加密落库，且永远不会返回给 App', async () => {
    const { admin, family } = await newFamily();
    const saved = await api<StorageConfigView>('PUT', '/v1/storage', {
      token: admin.token,
      body: localS3(),
    });
    expect(saved.status).toBe(200);
    expect(JSON.stringify(saved.json)).not.toContain('devsecretkey');
    const read = await api<StorageConfigView>('GET', '/v1/storage', { token: admin.token });
    expect(read.json.hasSecret).toBe(true);
    expect(JSON.stringify(read.json)).not.toContain('devsecretkey');
    const [row] = await sql<{ secret_encrypted: string }[]>`
      SELECT secret_encrypted FROM storage_configs WHERE family_id = ${family.id}`;
    expect(row?.secret_encrypted).not.toContain('devsecretkey');
    expect(decryptSecret(row!.secret_encrypted, config.appSecret)).toBe('devsecretkey');
  });
  it('错误的配置不能保存', async () => {
    const { admin } = await newFamily();
    const r = await api('PUT', '/v1/storage', {
      token: admin.token,
      body: { ...localS3(), secretAccessKey: 'wrong' },
    });
    expect(r.status).toBe(400);
    expect(
      (await api<StorageConfigView>('GET', '/v1/storage', { token: admin.token })).json.source,
    ).toBe('server');
  });
  it('只有管理员能看和改存储', async () => {
    const { admin } = await newFamily();
    const mom = await join(admin.token, 'caregiver', '妈妈');
    expect((await api('GET', '/v1/storage', { token: mom.token })).status).toBe(403);
    expect((await api('PUT', '/v1/storage', { token: mom.token, body: localS3() })).status).toBe(
      403,
    );
    expect(
      (await api('POST', '/v1/storage/test', { token: mom.token, body: localS3() })).status,
    ).toBe(403);
  });
  it('修改配置时可以不重填 Secret，但改了地址必须重填，防止把 Secret 发给别处', async () => {
    const { admin } = await newFamily();
    await api('PUT', '/v1/storage', { token: admin.token, body: localS3() });
    const { secretAccessKey: _omit, ...withoutSecret } = localS3();
    expect(
      (await api('PUT', '/v1/storage', { token: admin.token, body: withoutSecret })).status,
    ).toBe(200);
    const moved = await api('POST', '/v1/storage/test', {
      token: admin.token,
      body: { ...withoutSecret, endpoint: 'http://localhost:1' },
    });
    expect(moved.status).toBe(400);
  });
  it('换存储后，旧文件还能从原来的位置读取', async () => {
    const { admin } = await newFamily();
    await api('PUT', '/v1/storage', { token: admin.token, body: localS3() });
    const id = randomUUID();
    const bytes = Buffer.from('old file');
    const { json } = await api<UploadUrlResponse>('POST', '/v1/media/upload-url', {
      token: admin.token,
      body: { id, scope: 'memory', variant: 'original', mime: 'image/png', size: bytes.length },
    });
    await fetch(json.url, { method: 'PUT', headers: json.headers, body: bytes });
    await api('POST', `/v1/media/${id}/complete`, {
      token: admin.token,
      body: { variant: 'original' },
    });
    await api('PUT', '/v1/storage', {
      token: admin.token,
      body: { ...localS3(), region: 'us-east-1' },
    });
    const urls = await api<MediaUrlsResponse>('POST', '/v1/media/urls', {
      token: admin.token,
      body: { items: [{ id, variant: 'original' }] },
    });
    expect((await fetch(urls.json.urls[0]!.url!)).status).toBe(200);
  });
  it('默认禁止内网地址（SSRF 防护），可通过配置放开', async () => {
    const strict = { ...config, allowPrivateEndpoints: false };
    for (const endpoint of [
      'https://127.0.0.1',
      'https://10.1.2.3',
      'https://192.168.1.1',
      'https://169.254.169.254',
      'https://[::1]',
      'https://[::ffff:127.0.0.1]',
      'https://[::ffff:10.0.0.1]',
      'https://[::7f00:1]',
      'https://[64:ff9b::7f00:1]',
      'https://[fe80::1]',
      'https://[fd00::1]',
      'http://example.com',
    ]) {
      await expect(assertEndpointAllowed(endpoint, strict)).rejects.toThrow();
    }
    await expect(assertEndpointAllowed('http://127.0.0.1:9000', config)).resolves.toBeUndefined();
  });
  it('R2 的 Account ID 只允许安全字符', async () => {
    const { admin } = await newFamily();
    const r = await api('POST', '/v1/storage/test', {
      token: admin.token,
      body: {
        provider: 'r2',
        accountId: 'evil.example.com/x',
        bucket: 'b',
        accessKeyId: 'k',
        secretAccessKey: 's',
      },
    });
    expect(r.status).toBe(400);
  });
});

describe('密码和加密工具', () => {
  it('密码哈希可验证，错误密码不通过', async () => {
    const hash = await hashPassword('correct horse');
    expect(hash).not.toContain('correct');
    expect(await verifyPassword('correct horse', hash)).toBe(true);
    expect(await verifyPassword('wrong', hash)).toBe(false);
  });
  it('密文被篡改或换密钥后无法解密', () => {
    const key = Buffer.alloc(32, 1);
    const cipher = encryptSecret('secret', key);
    expect(decryptSecret(cipher, key)).toBe('secret');
    expect(() => decryptSecret(cipher, Buffer.alloc(32, 2))).toThrow();
    const parts = cipher.split('.');
    parts[3] = Buffer.from('tampered').toString('base64');
    expect(() => decryptSecret(parts.join('.'), key)).toThrow();
  });
});
