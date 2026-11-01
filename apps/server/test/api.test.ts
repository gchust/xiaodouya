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
let config: Config;
let app: ReturnType<typeof createApp>;
let pushes: PushMessage[];

async function api<T = unknown>(
  method: string,
  path: string,
  options: { token?: string; body?: unknown } = {},
): Promise<{ status: number; json: T }> {
  const response = await app.request(path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
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

const sync = (token: string, cursor: number, changes: unknown[] = []) =>
  api<SyncResponse>('POST', '/v1/sync', { token, body: { cursor, changes } });

beforeAll(async () => {
  config = loadConfig(testEnv());
  sql = connect(config.databaseUrl);
  await migrate(sql);
  await ensureBucket(config);
  await sql`TRUNCATE users, families CASCADE`;
});

beforeEach(() => {
  pushes = [];
  app = createApp({ sql, config, notifier: { send: async (m) => void pushes.push(...m) } });
});

afterAll(async () => {
  await sql.end();
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

describe('推送', () => {
  async function familyWithToken(prefs: Record<string, unknown> = {}) {
    const { admin } = await newFamily();
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
    return { admin, mom };
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
    expect(json).toEqual({
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
