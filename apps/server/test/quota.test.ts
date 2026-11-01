import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import type {
  AuthResponse,
  MediaUrlsResponse,
  MeResponse,
  PublicConfig,
  StorageUsage,
  SyncResponse,
  UploadUrlResponse,
} from '@xiaodouya/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { clientIpFrom } from '../src/client-ip';
import { type Config, loadConfig } from '../src/config';
import { connect, migrate, migrations, type Sql } from '../src/db';
import { ensureBucket } from '../src/dev-bucket';
import { runMaintenance } from '../src/maintenance';
import { activeStorage, checkUploadSizeBinding, headObject } from '../src/storage';

/** 配额、删除释放空间和防滥用。真实的 Postgres 和 S3 兼容服务，和 api.test.ts 一样由 pnpm dev:infra 提供。 */
function testEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const line of readFileSync(resolve(import.meta.dirname, '../.env.example'), 'utf8').split(
    '\n',
  )) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (match?.[1] && !env[match[1]]) env[match[1]] = match[2];
  }
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
let testUrl: string;
let config: Config;
let app: ReturnType<typeof createApp>;

const FILE = 300;
const bytes = Buffer.alloc(FILE, 7);

function useConfig(overrides: Partial<Config>) {
  app = createApp({ sql, config: { ...config, ...overrides } });
  return { ...config, ...overrides };
}

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

const errorCode = (r: { json: unknown }) => (r.json as { error?: { code?: string } }).error?.code;

async function newUser(headers?: Record<string, string>) {
  const email = `user-${randomUUID().slice(0, 12)}@example.test`;
  return api<AuthResponse>('POST', '/v1/auth/register', {
    headers,
    body: { email, password: 'correct horse', displayName: '虚构用户' },
  });
}

async function newFamily() {
  const owner = (await newUser()).json;
  const { json } = await api<MeResponse>('POST', '/v1/families', {
    token: owner.token,
    body: { name: '虚构一家', label: '爸爸' },
  });
  return { token: owner.token, familyId: json.family!.id };
}

async function join(ownerToken: string, role: 'caregiver' | 'viewer') {
  const user = (await newUser()).json;
  const invite = await api<{ code: string }>('POST', '/v1/invites', {
    token: ownerToken,
    body: { role, label: role === 'viewer' ? '外公' : '妈妈' },
  });
  await api('POST', '/v1/invites/accept', { token: user.token, body: { code: invite.json.code } });
  return user;
}

function requestUrl(token: string, overrides: Record<string, unknown> = {}) {
  return api<UploadUrlResponse>('POST', '/v1/media/upload-url', {
    token,
    body: {
      id: randomUUID(),
      scope: 'memory',
      variant: 'original',
      mime: 'image/jpeg',
      size: FILE,
      ...overrides,
    },
  });
}

const complete = (token: string, id: string, variant = 'original') =>
  api('POST', `/v1/media/${id}/complete`, { token, body: { variant } });

async function upload(token: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const id = (overrides.id as string) ?? randomUUID();
  const { json, status } = await requestUrl(token, { ...overrides, id });
  expect(status).toBe(200);
  const put = await fetch(json.url, { method: 'PUT', headers: json.headers, body: bytes });
  expect(put.status).toBe(200);
  expect((await complete(token, id, (overrides.variant as string) ?? 'original')).status).toBe(200);
  return id;
}

const usage = async (token: string) =>
  (await api<StorageUsage>('GET', '/v1/storage/usage', { token })).json;

const mediaRef = (id: string) => ({ id, kind: 'image', mime: 'image/jpeg', size: FILE });
const momentData = (media: string[]) => ({
  title: '虚构的一刻',
  text: '',
  at: 1_700_000_000_000,
  milestone: false,
  media: media.map(mediaRef),
});

let clock = Date.now();
const nextVersion = () => {
  clock += 1000;
  return clock;
};

function sync(token: string, changes: unknown[], cursor = 0) {
  return api<SyncResponse>('POST', '/v1/sync', { token, body: { cursor, changes } });
}

const writeMoment = (token: string, id: string, media: string[], deleted = false) =>
  sync(token, [
    { id, collection: 'moment', data: momentData(media), deleted, updatedAt: nextVersion() },
  ]);

const objectExists = async (familyId: string, id: string, variant = 'original') => {
  const storage = await activeStorage(sql, config, familyId);
  const head = await headObject(storage!, `families/${familyId}/memory/${id}/${variant}`);
  return head !== null;
};

const mediaRow = async (id: string) =>
  (await sql<{ status: string }[]>`SELECT status FROM media WHERE id = ${id}`)[0] ?? null;

const backdateTrash = (id: string, days: number) =>
  sql`UPDATE media SET unreferenced_at = now() - interval '1 day' * ${days} WHERE id = ${id}`;

beforeAll(async () => {
  config = loadConfig(testEnv());
  admin = connect(config.databaseUrl);
  testDatabase = `xiaodouya_test_${process.pid}_${Date.now()}_q`;
  await admin.unsafe(`CREATE DATABASE ${testDatabase}`);
  const url = new URL(config.databaseUrl);
  url.pathname = `/${testDatabase}`;
  testUrl = url.toString();
  sql = connect(testUrl, config.db);
  await migrate(sql);
  await ensureBucket(config);
});

beforeEach(() => {
  app = createApp({ sql, config });
});

afterAll(async () => {
  await sql.end();
  await admin.unsafe(`DROP DATABASE IF EXISTS ${testDatabase} WITH (FORCE)`);
  await admin.end();
});

describe('公开配置', () => {
  it('不用登录就能知道能不能自定义存储', async () => {
    useConfig({ allowCustomStorage: false });
    const closed = await api<PublicConfig>('GET', '/v1/config');
    expect(closed.status).toBe(200);
    expect(closed.json.allowCustomStorage).toBe(false);
    useConfig({ allowCustomStorage: true });
    expect((await api<PublicConfig>('GET', '/v1/config')).json.allowCustomStorage).toBe(true);
  });

  it('有托管存储时默认不开放自定义，自建没配存储时默认开放，也能显式指定', () => {
    const env = testEnv();
    delete env.ALLOW_CUSTOM_STORAGE;
    expect(loadConfig(env).allowCustomStorage).toBe(false);
    const noStorage = { ...env, S3_BUCKET: undefined };
    expect(loadConfig(noStorage).allowCustomStorage).toBe(true);
    expect(loadConfig({ ...env, ALLOW_CUSTOM_STORAGE: 'true' }).allowCustomStorage).toBe(true);
    expect(loadConfig({ ...noStorage, ALLOW_CUSTOM_STORAGE: 'false' }).allowCustomStorage).toBe(
      false,
    );
  });

  it('自定义关闭时不能保存存储配置，托管存储照常上传', async () => {
    useConfig({ allowCustomStorage: false });
    const { token } = await newFamily();
    const saved = await api('PUT', '/v1/storage', {
      token,
      body: {
        provider: 'other',
        endpoint: 'http://localhost:59000',
        bucket: 'x',
        accessKeyId: 'k',
        secretAccessKey: 's',
      },
    });
    expect(saved.status).toBe(403);
    await upload(token);
    expect((await usage(token)).total).toBe(FILE);
  });
});

describe('配额', () => {
  it('超过配额的上传返回单独的错误码，没超过的正常', async () => {
    useConfig({ familyQuotaBytes: FILE * 2 + 10 });
    const { token } = await newFamily();
    await upload(token);
    await upload(token);
    const over = await requestUrl(token);
    expect(over.status).toBe(413);
    expect(errorCode(over)).toBe('quota_exceeded');
  });

  it('并行申请不会超出配额：预留算进用量', async () => {
    useConfig({ familyQuotaBytes: FILE * 5 });
    const { token } = await newFamily();
    const results = await Promise.all(Array.from({ length: 20 }, () => requestUrl(token)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(5);
    expect(results.filter((r) => errorCode(r) === 'quota_exceeded')).toHaveLength(15);
  });

  it('连接池只有 1 个连接时，并行申请也不会死锁或超出', async () => {
    const single = connect(testUrl, { ...config.db, poolMax: 1, prepare: false });
    try {
      app = createApp({ sql: single, config: { ...config, familyQuotaBytes: FILE * 3 } });
      const { token } = await newFamily();
      const results = await Promise.all(Array.from({ length: 8 }, () => requestUrl(token)));
      expect(results.filter((r) => r.status === 200)).toHaveLength(3);
    } finally {
      await single.end();
    }
  });

  it('同一个文件重新申请链接不重复计算', async () => {
    useConfig({ familyQuotaBytes: FILE * 2 });
    const { token } = await newFamily();
    const id = randomUUID();
    for (let i = 0; i < 5; i++) expect((await requestUrl(token, { id })).status).toBe(200);
    expect((await requestUrl(token)).status).toBe(200);
    expect((await requestUrl(token)).status).toBe(413);
  });

  it('放弃的预留过一段时间后不再占用，重新申请会续期', async () => {
    useConfig({ familyQuotaBytes: FILE });
    const { token } = await newFamily();
    const id = randomUUID();
    expect((await requestUrl(token, { id })).status).toBe(200);
    expect((await requestUrl(token)).status).toBe(413);
    await sql`UPDATE media SET reserved_at = now() - interval '7 hours' WHERE id = ${id}`;
    const other = randomUUID();
    expect((await requestUrl(token, { id: other })).status).toBe(200);
    // 对方也放弃了，第一个文件重试：续期后又占住配额。
    await sql`UPDATE media SET reserved_at = now() - interval '7 hours' WHERE id = ${other}`;
    expect((await requestUrl(token, { id })).status).toBe(200);
    expect((await requestUrl(token)).status).toBe(413);
  });

  it('完成时再查一次：超了就删掉对象，之后腾出空间还能重传', async () => {
    useConfig({ familyQuotaBytes: FILE });
    const { token, familyId } = await newFamily();
    const first = randomUUID();
    const { json } = await requestUrl(token, { id: first });
    await fetch(json.url, { method: 'PUT', headers: json.headers, body: bytes });
    // 这个文件传得太久，预留过期后配额被另一个文件占了。
    await sql`UPDATE media SET reserved_at = now() - interval '7 hours' WHERE id = ${first}`;
    const blocker = await upload(token);
    const done = await complete(token, first);
    expect(done.status).toBe(413);
    expect(errorCode(done)).toBe('quota_exceeded');
    expect(await objectExists(familyId, first)).toBe(false);
    expect(await mediaRow(first)).toBeNull();
    // 删掉占空间的文件，同一个文件可以重新走完。
    const moment = randomUUID();
    await writeMoment(token, moment, [blocker]);
    await writeMoment(token, moment, [blocker], true);
    await upload(token, { id: first });
    expect((await usage(token)).total).toBe(FILE);
  });

  it('可以给单个家庭单独设定配额，0 表示不限', async () => {
    useConfig({ familyQuotaBytes: FILE });
    const { token, familyId } = await newFamily();
    await upload(token);
    expect((await requestUrl(token)).status).toBe(413);
    await sql`UPDATE families SET quota_mb = 1 WHERE id = ${familyId}`;
    expect((await requestUrl(token)).status).toBe(200);
    expect((await usage(token)).quota).toBe(1024 * 1024);
    await sql`UPDATE families SET quota_mb = 0 WHERE id = ${familyId}`;
    expect((await requestUrl(token, { size: 2 * 1024 * 1024 })).status).toBe(200);
    expect((await usage(token)).quota).toBeNull();
  });

  it('FAMILY_QUOTA_MB=0 不限；默认值是 5 GB', () => {
    const env = testEnv();
    expect(loadConfig(env).familyQuotaBytes).toBe(5120 * 1024 * 1024);
    expect(loadConfig({ ...env, FAMILY_QUOTA_MB: '0' }).familyQuotaBytes).toBeNull();
    expect(loadConfig({ ...env, FAMILY_QUOTA_MB: '100' }).familyQuotaBytes).toBe(100 * 1024 * 1024);
  });

  it('用自己存储的家庭不受平台配额限制', async () => {
    useConfig({ familyQuotaBytes: FILE });
    const { token } = await newFamily();
    await upload(token);
    expect((await requestUrl(token)).status).toBe(413);
    const saved = await api('PUT', '/v1/storage', {
      token,
      body: {
        provider: 'other',
        endpoint: process.env.TEST_S3_ENDPOINT ?? 'http://localhost:59000',
        region: 'us-east-1',
        bucket: 'xiaodouya-dev',
        accessKeyId: 'devaccesskey',
        secretAccessKey: 'devsecretkey',
      },
    });
    expect(saved.status).toBe(200);
    expect((await requestUrl(token)).status).toBe(200);
    expect((await usage(token)).quota).toBeNull();
  });

  it('管理员和一起记录的家人能看用量，只看回忆的不能', async () => {
    const { token } = await newFamily();
    const mom = await join(token, 'caregiver');
    const grandpa = await join(token, 'viewer');
    await upload(mom.token);
    const seen = await api<StorageUsage>('GET', '/v1/storage/usage', { token: mom.token });
    expect(seen.status).toBe(200);
    expect(seen.json.total).toBe(FILE);
    expect(seen.json.quota).toBe(config.familyQuotaBytes);
    expect(seen.json.quotaUsed).toBe(FILE);
    expect((await api('GET', '/v1/storage/usage', { token: grandpa.token })).status).toBe(403);
    expect((await api('GET', '/v1/storage', { token: mom.token })).status).toBe(403);
  });
});

describe('删除后释放空间', () => {
  it('删除回忆后马上不占配额，如实显示待清理，并且可以继续上传', async () => {
    useConfig({ familyQuotaBytes: FILE });
    const { token, familyId } = await newFamily();
    const media = await upload(token);
    const moment = randomUUID();
    await writeMoment(token, moment, [media]);
    expect((await requestUrl(token)).status).toBe(413);

    await writeMoment(token, moment, [media], true);
    const after = await usage(token);
    expect(after.total).toBe(0);
    expect(after.trash).toBe(FILE);
    expect(after.quotaUsed).toBe(0);
    expect(await objectExists(familyId, media)).toBe(true);
    expect((await requestUrl(token)).status).toBe(200);
  });

  it('撤销删除后文件恢复，配额也算回去', async () => {
    const { token, familyId } = await newFamily();
    const media = await upload(token);
    const moment = randomUUID();
    await writeMoment(token, moment, [media]);
    await writeMoment(token, moment, [media], true);
    expect((await usage(token)).trash).toBe(FILE);
    await writeMoment(token, moment, [media]);
    const after = await usage(token);
    expect(after.trash).toBe(0);
    expect(after.total).toBe(FILE);
    // 过了宽限期也不会被清理：标记已经清掉了。
    await runMaintenance(sql, config);
    expect(await objectExists(familyId, media)).toBe(true);
  });

  it('另一条记录还在用的文件不算待清理，也不会被删', async () => {
    const { token, familyId } = await newFamily();
    const shared = await upload(token);
    const first = randomUUID();
    const second = randomUUID();
    await writeMoment(token, first, [shared]);
    await writeMoment(token, second, [shared]);
    await writeMoment(token, first, [shared], true);
    expect((await usage(token)).trash).toBe(0);
    expect((await usage(token)).total).toBe(FILE);
    await runMaintenance(sql, config);
    expect(await objectExists(familyId, shared)).toBe(true);
    // 第二条也删了才算没人用。
    await writeMoment(token, second, [shared], true);
    expect((await usage(token)).trash).toBe(FILE);
  });

  it('同一批里一条删除、一条新引用同一个文件，文件保持可用', async () => {
    const { token } = await newFamily();
    const shared = await upload(token);
    const old = randomUUID();
    await writeMoment(token, old, [shared]);
    await sync(token, [
      {
        id: old,
        collection: 'moment',
        data: momentData([shared]),
        deleted: true,
        updatedAt: nextVersion(),
      },
      {
        id: randomUUID(),
        collection: 'moment',
        data: momentData([shared]),
        deleted: false,
        updatedAt: nextVersion(),
      },
    ]);
    expect((await usage(token)).trash).toBe(0);
  });

  it('修改回忆时移除文件后撤销，文件不再待清理，对象还在', async () => {
    const { token, familyId } = await newFamily();
    const keep = await upload(token);
    const removed = await upload(token);
    const moment = randomUUID();
    await writeMoment(token, moment, [keep, removed]);
    await writeMoment(token, moment, [keep]);
    expect((await usage(token)).trash).toBe(FILE);
    await writeMoment(token, moment, [keep, removed]);
    expect((await usage(token)).trash).toBe(0);
    const [row] = await sql<{ unreferenced_at: Date | null }[]>`
      SELECT unreferenced_at FROM media WHERE id = ${removed}`;
    expect(row?.unreferenced_at).toBeNull();
    expect(await objectExists(familyId, removed)).toBe(true);
  });

  it('编辑时去掉一张照片、换头像，被换下的文件进入待清理', async () => {
    const { token } = await newFamily();
    const keep = await upload(token);
    const drop = await upload(token);
    const moment = randomUUID();
    await writeMoment(token, moment, [keep, drop]);
    await writeMoment(token, moment, [keep]);
    expect((await usage(token)).trash).toBe(FILE);
    expect((await usage(token)).total).toBe(FILE);

    const oldAvatar = await upload(token, { scope: 'avatar' });
    const newAvatar = await upload(token, { scope: 'avatar' });
    const baby = (avatar: string) => ({
      name: '小虚构',
      birthAt: 1_700_000_000_000,
      avatar: mediaRef(avatar),
    });
    const babyId = randomUUID();
    await sync(token, [
      {
        id: babyId,
        collection: 'baby',
        data: baby(oldAvatar),
        deleted: false,
        updatedAt: nextVersion(),
      },
    ]);
    await sync(token, [
      {
        id: babyId,
        collection: 'baby',
        data: baby(newAvatar),
        deleted: false,
        updatedAt: nextVersion(),
      },
    ]);
    expect((await usage(token)).trash).toBe(FILE * 2);
  });

  it('删除证件同样释放空间', async () => {
    const { token } = await newFamily();
    const file = await upload(token, { scope: 'document', mime: 'application/pdf' });
    const document = { name: '虚构证件', files: [{ ...mediaRef(file), kind: 'pdf' }] };
    const id = randomUUID();
    await sync(token, [
      { id, collection: 'document', data: document, deleted: false, updatedAt: nextVersion() },
    ]);
    expect((await usage(token)).document).toBe(FILE);
    await sync(token, [
      { id, collection: 'document', data: document, deleted: true, updatedAt: nextVersion() },
    ]);
    const after = await usage(token);
    expect(after.document).toBe(0);
    expect(after.trash).toBe(FILE);
  });

  it('被拒绝的旧版本改动不影响文件状态', async () => {
    const { token } = await newFamily();
    const media = await upload(token);
    const moment = randomUUID();
    const version = nextVersion();
    await sync(token, [
      {
        id: moment,
        collection: 'moment',
        data: momentData([media]),
        deleted: false,
        updatedAt: version,
      },
    ]);
    await sync(token, [
      {
        id: moment,
        collection: 'moment',
        data: momentData([media]),
        deleted: true,
        updatedAt: version - 1,
      },
    ]);
    expect((await usage(token)).trash).toBe(0);
  });

  it('反复上传再删除绕不过配额：待清理超过配额的部分要算进去', async () => {
    useConfig({ familyQuotaBytes: FILE });
    const { token } = await newFamily();
    const churn = async () => {
      const media = await upload(token);
      const moment = randomUUID();
      await writeMoment(token, moment, [media]);
      await writeMoment(token, moment, [media], true);
    };
    await churn(); // 待清理 1 份，刚好等于配额，不算。
    await churn(); // 待清理 2 份，多出来的 1 份算进用量。
    const blocked = await requestUrl(token);
    expect(blocked.status).toBe(413);
    expect((await usage(token)).quotaUsed).toBe(FILE);
  });
});

describe('维护任务', () => {
  it('宽限期内不删，过了宽限期连文件带记录一起删，用量随之减少', async () => {
    const { token, familyId } = await newFamily();
    const media = await upload(token);
    await upload(token, { id: media, variant: 'thumb' });
    const moment = randomUUID();
    await writeMoment(token, moment, [media]);
    await writeMoment(token, moment, [media], true);

    await backdateTrash(media, config.mediaTrashDays - 1);
    expect((await runMaintenance(sql, config)).trashPurged).toBe(0);
    expect(await objectExists(familyId, media)).toBe(true);

    await backdateTrash(media, config.mediaTrashDays + 1);
    expect((await runMaintenance(sql, config)).trashPurged).toBe(2);
    expect(await objectExists(familyId, media)).toBe(false);
    expect(await objectExists(familyId, media, 'thumb')).toBe(false);
    expect(await mediaRow(media)).toBeNull();
    expect((await usage(token)).trash).toBe(0);
    // 记录本身还是软删除，不动。
    const [record] = await sql<
      { deleted: boolean }[]
    >`SELECT deleted FROM records WHERE id = ${moment}`;
    expect(record?.deleted).toBe(true);
  });

  it('清理前再核对一遍：标记是错的也不能删还有记录在用的文件', async () => {
    const { token, familyId } = await newFamily();
    const media = await upload(token);
    await writeMoment(token, randomUUID(), [media]);
    await backdateTrash(media, config.mediaTrashDays + 1);
    const report = await runMaintenance(sql, config);
    expect(report.trashPurged).toBe(0);
    expect(report.rescued).toBe(1);
    expect(await objectExists(familyId, media)).toBe(true);
    const [row] = await sql<{ unreferenced_at: Date | null }[]>`
      SELECT unreferenced_at FROM media WHERE id = ${media}`;
    expect(row?.unreferenced_at).toBeNull();
  });

  it('别的家庭写了同样的 id 不算引用，也不能保住或删掉这个家庭的文件', async () => {
    const a = await newFamily();
    const b = await newFamily();
    const media = await upload(a.token);
    const moment = randomUUID();
    await writeMoment(a.token, moment, [media]);
    await writeMoment(b.token, randomUUID(), [media]);
    await writeMoment(a.token, moment, [media], true);
    expect((await usage(a.token)).trash).toBe(FILE);
    await backdateTrash(media, config.mediaTrashDays + 1);
    expect((await runMaintenance(sql, config)).trashPurged).toBe(1);
    expect(await objectExists(a.familyId, media)).toBe(false);
  });

  it('传完却一直没有记录引用的文件，很久以后也会清掉；新的和有引用的不动', async () => {
    const { token, familyId } = await newFamily();
    const orphan = await upload(token);
    const fresh = await upload(token);
    const attached = await upload(token);
    await writeMoment(token, randomUUID(), [attached]);
    await sql`UPDATE media SET created_at = now() - interval '40 days' WHERE id IN (${orphan}, ${attached})`;
    const report = await runMaintenance(sql, config);
    expect(report.unattachedPurged).toBe(1);
    expect(await objectExists(familyId, orphan)).toBe(false);
    expect(await objectExists(familyId, fresh)).toBe(true);
    expect(await objectExists(familyId, attached)).toBe(true);
  });

  it('放弃的上传：对象和记录都清掉，刚申请的不动', async () => {
    const { token, familyId } = await newFamily();
    const abandoned = randomUUID();
    const { json } = await requestUrl(token, { id: abandoned });
    await fetch(json.url, { method: 'PUT', headers: json.headers, body: bytes });
    const recent = randomUUID();
    await requestUrl(token, { id: recent });
    await sql`UPDATE media SET reserved_at = now() - interval '25 hours' WHERE id = ${abandoned}`;
    const report = await runMaintenance(sql, config);
    expect(report.pendingRemoved).toBe(1);
    expect(await objectExists(familyId, abandoned)).toBe(false);
    expect(await mediaRow(abandoned)).toBeNull();
    expect((await mediaRow(recent))?.status).toBe('pending');
  });

  it('存储删除失败时保留记录下次再试，并报告失败', async () => {
    const { token } = await newFamily();
    const media = await upload(token);
    const moment = randomUUID();
    await writeMoment(token, moment, [media]);
    await writeMoment(token, moment, [media], true);
    await backdateTrash(media, config.mediaTrashDays + 1);
    const broken = {
      ...config,
      serverStorage: { ...config.serverStorage!, secretAccessKey: 'wrong' },
    };
    const report = await runMaintenance(sql, broken);
    expect(report.failed).toBe(1);
    expect(report.trashPurged).toBe(0);
    expect((await mediaRow(media))?.status).toBe('ready');
    expect((await runMaintenance(sql, config)).trashPurged).toBe(1);
  });

  it('清理过期的限流计数', async () => {
    await sql`INSERT INTO rate_limits (key_hash, count, reset_at)
              VALUES (${`old-${randomUUID()}`}, 1, now() - interval '1 hour')`;
    expect((await runMaintenance(sql, config)).rateLimitsRemoved).toBeGreaterThan(0);
  });

  it('连接池只有 1 个连接时也能跑完', async () => {
    const single = connect(testUrl, { ...config.db, poolMax: 1, prepare: false });
    try {
      const { token, familyId } = await newFamily();
      const media = await upload(token);
      const moment = randomUUID();
      await writeMoment(token, moment, [media]);
      await writeMoment(token, moment, [media], true);
      await backdateTrash(media, config.mediaTrashDays + 1);
      expect((await runMaintenance(single, config)).trashPurged).toBe(1);
      expect(await objectExists(familyId, media)).toBe(false);
    } finally {
      await single.end();
    }
  });

  it('命令行入口可以被定时任务调用', async () => {
    const env = testEnv();
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ['--import', 'tsx', resolve(import.meta.dirname, '../src/cli.ts'), 'maintenance'],
      {
        cwd: resolve(import.meta.dirname, '..'),
        env: {
          PATH: process.env.PATH,
          DATABASE_URL: testUrl,
          S3_ENDPOINT: env.S3_ENDPOINT,
          S3_REGION: env.S3_REGION,
          S3_BUCKET: env.S3_BUCKET,
          S3_ACCESS_KEY_ID: env.S3_ACCESS_KEY_ID,
          S3_SECRET_ACCESS_KEY: env.S3_SECRET_ACCESS_KEY,
          S3_FORCE_PATH_STYLE: 'true',
        },
      },
    );
    // 不需要 APP_SECRET：不用把它复制到定时任务的环境里。
    expect(JSON.parse(stdout)).toMatchObject({ failed: 0 });
  }, 60_000);
});

describe('防滥用：来源地址', () => {
  const xff = { header: 'x-forwarded-for', position: 'last' } as const;
  const read = (headers: Record<string, string>) => (name: string) => headers[name];

  it('默认取 X-Forwarded-For 最后一段：客户端只能在前面加内容', () => {
    expect(clientIpFrom(read({ 'x-forwarded-for': 'spoofed, 203.0.113.9' }), xff)).toBe(
      '203.0.113.9',
    );
    expect(clientIpFrom(read({ 'x-forwarded-for': '203.0.113.9' }), xff)).toBe('203.0.113.9');
  });
  it('可以换成别的头和位置', () => {
    expect(
      clientIpFrom(read({ 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-for': '198.51.100.1' }), {
        header: 'cf-connecting-ip',
        position: 'last',
      }),
    ).toBe('203.0.113.9');
    expect(
      clientIpFrom(read({ 'x-forwarded-for': '203.0.113.9, 198.51.100.1' }), {
        header: 'x-forwarded-for',
        position: 'first',
      }),
    ).toBe('203.0.113.9');
  });
  it('取不到、不是地址、内网地址都算未知，不能让所有人挤进同一个计数', () => {
    expect(clientIpFrom(read({}), xff)).toBeNull();
    expect(clientIpFrom(read({ 'x-forwarded-for': 'not-an-ip' }), xff)).toBeNull();
    expect(clientIpFrom(read({ 'x-forwarded-for': '10.0.0.5' }), xff)).toBeNull();
  });
  it('IPv6 按 /64 归并：同一个家庭宽带能换很多地址', () => {
    const a = clientIpFrom(read({ 'x-forwarded-for': '2001:db8:1:2:aaaa::1' }), xff);
    const b = clientIpFrom(read({ 'x-forwarded-for': '2001:db8:1:2:bbbb::2' }), xff);
    const other = clientIpFrom(read({ 'x-forwarded-for': '2001:db8:1:3::1' }), xff);
    expect(a).toBe(b);
    expect(a).not.toBe(other);
  });
  it('配置项默认值', () => {
    expect(loadConfig(testEnv()).clientIp).toEqual(xff);
    expect(
      loadConfig({
        ...testEnv(),
        CLIENT_IP_HEADER: 'CF-Connecting-IP',
        CLIENT_IP_POSITION: 'first',
      }).clientIp,
    ).toEqual({ header: 'cf-connecting-ip', position: 'first' });
  });
});

describe('防滥用：注册', () => {
  const limited = (overrides = {}) =>
    useConfig({
      limits: { ...config.limits, registerPerIpHour: 3, registerGlobalHour: 0, ...overrides },
    });
  const ip = (value: string) => ({ 'x-forwarded-for': value });

  it('同一个来源注册太多被拒绝，别的来源不受影响', async () => {
    limited();
    const addr = '203.0.113.10';
    for (let i = 0; i < 3; i++) expect((await newUser(ip(addr))).status).toBe(201);
    const blocked = await newUser(ip(addr));
    expect(blocked.status).toBe(429);
    expect(errorCode(blocked)).toBe('too_many_attempts');
    expect((await newUser(ip('203.0.113.11'))).status).toBe(201);
  });
  it('在前面伪造一段 X-Forwarded-For 绕不过去', async () => {
    limited();
    const addr = '203.0.113.20';
    for (let i = 0; i < 3; i++) {
      expect((await newUser(ip(`198.51.100.${i}, ${addr}`))).status).toBe(201);
    }
    expect((await newUser(ip(`198.51.100.99, ${addr}`))).status).toBe(429);
  });
  it('一家人在同一个 Wi-Fi 下注册不会被挡（默认限额）', async () => {
    const addr = '203.0.113.30';
    for (let i = 0; i < 6; i++) expect((await newUser(ip(addr))).status).toBe(201);
  });
  it('拿不到来源时不按来源限制，只受总量限制', async () => {
    useConfig({
      limits: { ...config.limits, registerPerIpHour: 1, registerGlobalHour: 0 },
    });
    for (let i = 0; i < 3; i++) expect((await newUser()).status).toBe(201);
  });
  it('换来源绕不过总量限制', async () => {
    // 这张计数是全局的，用干净的数据库才不受别的测试影响。
    await sql`DELETE FROM rate_limits`;
    useConfig({ limits: { ...config.limits, registerPerIpHour: 0, registerGlobalHour: 3 } });
    for (let i = 0; i < 3; i++) expect((await newUser(ip(`203.0.113.${40 + i}`))).status).toBe(201);
    expect((await newUser(ip('203.0.113.50'))).status).toBe(429);
    await sql`DELETE FROM rate_limits`;
  });
  it('登录限流用同一套来源判断：伪造前缀绕不过按来源的限制', async () => {
    const user = (await newUser()).json;
    const login = (spoof: number) =>
      api('POST', '/v1/auth/login', {
        headers: ip(`198.51.100.${spoof}, 203.0.113.60`),
        body: { email: user.user.email, password: 'wrong-pass' },
      });
    let last = 0;
    for (let i = 0; i < 11; i++) last = (await login(i)).status;
    expect(last).toBe(429);
  });
});

describe('防滥用：请求频率', () => {
  it('一次传 100 张照片（原图加缩略图 200 个文件）不会被限流（默认限额）', async () => {
    const { token } = await newFamily();
    const results = await Promise.all(
      Array.from({ length: 200 }, (_, i) =>
        requestUrl(token, { variant: i % 2 ? 'thumb' : 'original' }),
      ),
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('申请上传链接过于频繁时限流，换个人不受影响', async () => {
    useConfig({ limits: { ...config.limits, uploadUrlPerWindow: 5 } });
    const { token } = await newFamily();
    const mom = await join(token, 'caregiver');
    for (let i = 0; i < 5; i++) expect((await requestUrl(token)).status).toBe(200);
    const blocked = await requestUrl(token);
    expect(blocked.status).toBe(429);
    expect(errorCode(blocked)).toBe('rate_limited');
    expect((await requestUrl(mom.token)).status).toBe(200);
  });

  it('离线一周后补传 2000 条再拉取，不会被限流（默认限额）', async () => {
    const { token } = await newFamily();
    const at = Date.now();
    for (let batch = 0; batch < 10; batch++) {
      const changes = Array.from({ length: 200 }, (_, i) => ({
        id: randomUUID(),
        collection: 'event',
        data: { type: 'feed', at: at + batch * 1000 + i, ml: 90 },
        deleted: false,
        updatedAt: at + batch,
      }));
      const r = await sync(token, changes);
      expect(r.status).toBe(200);
      expect(r.json.rejected).toEqual([]);
    }
    let cursor = 0;
    let rounds = 0;
    for (;;) {
      const r = await sync(token, [], cursor);
      expect(r.status).toBe(200);
      cursor = r.json.cursor;
      rounds += 1;
      if (!r.json.hasMore) break;
    }
    expect(rounds).toBeGreaterThan(1);
    // SyncEngine 一轮最多 50 次请求，连着跑几轮也要放行。
    for (let i = 0; i < 150; i++) expect((await sync(token, [], cursor)).status).toBe(200);
  }, 60_000);

  it('同步过于频繁时限流，过了窗口恢复，换个人不受影响', async () => {
    useConfig({ limits: { ...config.limits, syncPerWindow: 5 } });
    const { token, familyId } = await newFamily();
    const mom = await join(token, 'caregiver');
    for (let i = 0; i < 5; i++) expect((await sync(token, [])).status).toBe(200);
    const blocked = await sync(token, []);
    expect(blocked.status).toBe(429);
    expect(errorCode(blocked)).toBe('rate_limited');
    expect((await sync(mom.token, [])).status).toBe(200);
    await sql`UPDATE memberships SET sync_window_at = now() - interval '1 hour' WHERE family_id = ${familyId}`;
    expect((await sync(token, [])).status).toBe(200);
  });

  it('同步限流不增加写入：不往 rate_limits 写，只复用更新 last_seen_at 的那一行', async () => {
    const { token } = await newFamily();
    const before = await sql<{ count: string }[]>`SELECT count(*) FROM rate_limits`;
    for (let i = 0; i < 20; i++) await sync(token, []);
    const after = await sql<{ count: string }[]>`SELECT count(*) FROM rate_limits`;
    expect(after[0]?.count).toBe(before[0]?.count);
  });

  it('限流也跨实例生效', async () => {
    const tight = { ...config, limits: { ...config.limits, syncPerWindow: 3 } };
    const a = createApp({ sql, config: tight });
    const b = createApp({ sql, config: tight });
    const { token } = await newFamily();
    const post = (instance: typeof a) =>
      instance.request('/v1/sync', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ cursor: 0, changes: [] }),
      });
    expect((await post(a)).status).toBe(200);
    expect((await post(b)).status).toBe(200);
    expect((await post(a)).status).toBe(200);
    expect((await post(b)).status).toBe(429);
  });
});

describe('防滥用：文件和记录大小', () => {
  it('按类型限制单个文件大小，错误里写明上限', async () => {
    const mb = 1024 * 1024;
    useConfig({
      maxFileBytes: { image: mb, video: 8 * mb, audio: 2 * mb, document: 3 * mb },
    });
    const { token } = await newFamily();
    const cases: [Record<string, unknown>, number][] = [
      [{ mime: 'image/jpeg', size: mb }, 200],
      [{ mime: 'image/jpeg', size: mb + 1 }, 413],
      [{ mime: 'video/mp4', size: 8 * mb }, 200],
      [{ mime: 'video/mp4', size: 8 * mb + 1 }, 413],
      [{ mime: 'audio/m4a', size: 2 * mb }, 200],
      [{ mime: 'audio/m4a', size: 2 * mb + 1 }, 413],
      [{ scope: 'document', mime: 'application/pdf', size: 3 * mb }, 200],
      [{ scope: 'document', mime: 'application/pdf', size: 3 * mb + 1 }, 413],
      // 证件拍照是图片，按证件算，不按图片算。
      [{ scope: 'document', mime: 'image/jpeg', size: 3 * mb }, 200],
    ];
    for (const [overrides, expected] of cases) {
      const r = await requestUrl(token, overrides);
      expect([overrides, r.status]).toEqual([overrides, expected]);
      if (expected === 413) expect(errorCode(r)).toBe('too_large');
    }
  });

  it('MAX_UPLOAD_MB 仍然是总上限', async () => {
    useConfig({
      maxUploadBytes: 1000,
      maxFileBytes: { image: 5000, video: 5000, audio: 5000, document: 5000 },
    });
    const { token } = await newFamily();
    expect((await requestUrl(token, { size: 1001 })).status).toBe(413);
  });

  it('预签名链接绑定声明的大小：传比声明大的文件直接被存储拒绝', async () => {
    const { token } = await newFamily();
    const { json } = await requestUrl(token, { size: 10 });
    const big = await fetch(json.url, {
      method: 'PUT',
      headers: json.headers,
      body: Buffer.alloc(11, 1),
    });
    expect(big.status).toBe(403);
    const exact = await fetch(json.url, {
      method: 'PUT',
      headers: json.headers,
      body: Buffer.alloc(10, 1),
    });
    expect(exact.status).toBe(200);
  });

  it('单条记录太大被拒绝，同批其他记录照常写入', async () => {
    const { token } = await newFamily();
    const good = randomUUID();
    const bad = randomUUID();
    const r = await sync(token, [
      {
        id: bad,
        collection: 'moment',
        data: { ...momentData([]), junk: 'x'.repeat(600 * 1024) },
        deleted: false,
        updatedAt: nextVersion(),
      },
      {
        id: good,
        collection: 'moment',
        data: momentData([]),
        deleted: false,
        updatedAt: nextVersion(),
      },
    ]);
    expect(r.status).toBe(200);
    expect(r.json.rejected).toEqual([{ id: bad, reason: 'too_large' }]);
    expect(r.json.records.some((x) => x.id === good)).toBe(true);
    expect(r.json.records.some((x) => x.id === bad)).toBe(false);
  });

  it('App 能产生的最大的记录（2 万字加 100 个带波形的文件）放得下', async () => {
    const { token } = await newFamily();
    const peaks = Array.from({ length: 64 }, () => 0.123456789);
    const media = Array.from({ length: 100 }, () => ({
      ...mediaRef(randomUUID()),
      name: '名'.repeat(200),
      mime: 'm'.repeat(200),
      peaks,
      durationMs: 1000,
      width: 4000,
      height: 3000,
      hasThumb: true,
    }));
    const id = randomUUID();
    const r = await sync(token, [
      {
        id,
        collection: 'moment',
        data: { ...momentData([]), title: '题'.repeat(200), text: '字'.repeat(20_000), media },
        deleted: false,
        updatedAt: nextVersion(),
      },
    ]);
    expect(r.status).toBe(200);
    expect(r.json.rejected).toEqual([]);
  });

  it('家庭的记录总量到上限后拒绝变大的写入，不变大的修改和删除不受影响', async () => {
    useConfig({ familyRecordsBytes: 2000 });
    const { token } = await newFamily();
    const keep = randomUUID();
    const first = await writeMoment(token, keep, []);
    expect(first.json.rejected).toEqual([]);
    const big = (id: string) => ({
      id,
      collection: 'moment',
      data: { ...momentData([]), text: 'x'.repeat(3000) },
      deleted: false,
      updatedAt: nextVersion(),
    });
    const over = await sync(token, [big(randomUUID())]);
    expect(over.json.rejected).toEqual([]);
    const blockedId = randomUUID();
    const blocked = await sync(token, [big(blockedId)]);
    expect(blocked.json.rejected).toEqual([{ id: blockedId, reason: 'family_data_full' }]);
    const removed = await writeMoment(token, keep, [], true);
    expect(removed.json.rejected).toEqual([]);
  });

  it('非管理员保存档案时地区被换回来，大小和引用都按真正入库的内容算', async () => {
    const { token, familyId } = await newFamily();
    const mom = await join(token, 'caregiver');
    const oldAvatar = await upload(token, { scope: 'avatar' });
    const newAvatar = await upload(token, { scope: 'avatar' });
    const id = randomUUID();
    const baby = (avatar: string, region?: string) => ({
      name: '小虚构',
      birthAt: 1_700_000_000_000,
      avatar: mediaRef(avatar),
      ...(region ? { region } : {}),
    });
    const write = (who: string, data: unknown) =>
      sync(who, [{ id, collection: 'baby', data, deleted: false, updatedAt: nextVersion() }]);
    await write(token, baby(oldAvatar, 'SG'));

    // 旧版 App 不认识地区，发来的内容没有这个字段，入库时要补上，所以比发来的大。
    expect((await write(mom.token, baby(newAvatar))).json.rejected).toEqual([]);
    const [stored] = await sql<{ data: { region?: string } }[]>`
      SELECT data FROM records WHERE id = ${id}`;
    expect(stored?.data.region).toBe('SG');
    const [family] = await sql<{ record_bytes: string }[]>`
      SELECT record_bytes FROM families WHERE id = ${familyId}`;
    expect(Number(family?.record_bytes)).toBe(Buffer.byteLength(JSON.stringify(stored?.data)));

    const after = await usage(token);
    expect(after.trash).toBe(FILE);
    expect(after.total).toBe(FILE);
  });

  it('请求体上限仍然拦得住超大的同步请求', async () => {
    const { token } = await newFamily();
    const r = await sync(token, [
      {
        id: randomUUID(),
        collection: 'moment',
        data: { ...momentData([]), junk: 'x'.repeat(6 * 1024 * 1024) },
        deleted: false,
        updatedAt: nextVersion(),
      },
    ]);
    expect(r.status).toBe(413);
  });
});

describe('已上线的家庭和 v0.1.0 APK', () => {
  const ownStorage = () => ({
    provider: 'other' as const,
    endpoint: process.env.TEST_S3_ENDPOINT ?? 'http://localhost:59000',
    region: 'us-east-1',
    bucket: 'xiaodouya-dev',
    accessKeyId: 'devaccesskey',
    secretAccessKey: 'devsecretkey',
  });
  const urlOf = async (token: string, id: string) =>
    (
      await api<MediaUrlsResponse>('POST', '/v1/media/urls', {
        token,
        body: { items: [{ id, variant: 'original' }] },
      })
    ).json.urls[0]!.url;

  it('已经超过默认配额的家庭什么都不丢：能看、能同步、能删，只是传不了新文件', async () => {
    const { token, familyId } = await newFamily();
    const old = [await upload(token), await upload(token), await upload(token)];
    const moment = randomUUID();
    await writeMoment(token, moment, old);

    useConfig({ familyQuotaBytes: FILE * 2 });
    const seen = await usage(token);
    expect(seen.quotaUsed).toBe(FILE * 3);
    expect(seen.total).toBe(FILE * 3);
    for (const id of old) expect((await fetch((await urlOf(token, id))!)).status).toBe(200);
    expect((await writeMoment(token, randomUUID(), [])).json.rejected).toEqual([]);
    expect((await sync(token, [])).json.records.some((r) => r.id === moment)).toBe(true);
    expect((await requestUrl(token)).status).toBe(413);

    // 清理任务不因为超额删任何东西。
    const report = await runMaintenance(sql, { ...config, familyQuotaBytes: FILE * 2 });
    expect(report.trashPurged + report.unattachedPurged).toBe(0);
    for (const id of old) expect(await objectExists(familyId, id)).toBe(true);

    // 删到配额以内就又能传了。
    await writeMoment(token, moment, [old[0]!]);
    expect((await usage(token)).quotaUsed).toBe(FILE);
    expect((await requestUrl(token)).status).toBe(200);
  });

  it('配额错误是 4xx，带可以直接显示的文字：v0.1.0 把它显示给用户并停止重试', async () => {
    useConfig({ familyQuotaBytes: FILE - 1 });
    const { token } = await newFamily();
    const over = await requestUrl(token);
    expect(over.status).toBeGreaterThanOrEqual(400);
    expect(over.status).toBeLessThan(500);
    // v0.1.0 把 401、403、408、429 当成可恢复或别的含义，其余 4xx 才永久失败并显示 message。
    expect([401, 403, 408, 429]).not.toContain(over.status);
    const { message } = (over.json as unknown as { error: { message: string } }).error;
    expect(message).toContain('存储空间已满');
    expect(message).toContain('重试');
    expect(message.length).toBeLessThanOrEqual(40);
  });

  it('服务器关闭自定义后，已经用自己存储的家庭照常读写，还能换密钥', async () => {
    const { token, familyId } = await newFamily();
    expect((await api('PUT', '/v1/storage', { token, body: ownStorage() })).status).toBe(200);
    const before = await upload(token);

    useConfig({ allowCustomStorage: false, familyQuotaBytes: 1 });
    expect((await fetch((await urlOf(token, before))!)).status).toBe(200);
    const after = await upload(token);
    expect((await fetch((await urlOf(token, after))!)).status).toBe(200);
    const [row] = await sql<{ storage_config_id: string | null }[]>`
      SELECT storage_config_id FROM media WHERE id = ${after}`;
    expect(row?.storage_config_id).not.toBeNull();
    expect((await usage(token)).quota).toBeNull();
    expect((await api<{ source: string }>('GET', '/v1/storage', { token })).json.source).toBe(
      'family',
    );
    // 密钥过期时不能把他们锁死。
    expect((await api('PUT', '/v1/storage', { token, body: ownStorage() })).status).toBe(200);
    expect(await objectExists(familyId, after)).toBe(true);
  });

  it('服务器关闭自定义后，没用过自己存储的家庭不能开始用', async () => {
    useConfig({ allowCustomStorage: false });
    const { token } = await newFamily();
    const test = await api('POST', '/v1/storage/test', { token, body: ownStorage() });
    expect(test.status).toBe(403);
    expect(errorCode(test)).toBe('custom_storage_disabled');
    const saved = await api('PUT', '/v1/storage', { token, body: ownStorage() });
    expect(saved.status).toBe(403);
    // v0.1.0 还有这个表单，它把这句话显示在按钮下面。
    expect((saved.json as { error: { message: string } }).error.message).toContain('自定义存储');
  });

  it('清理任务不碰用户自己的存储：那是他们的 Bucket，密钥也可能早过期了', async () => {
    const { token, familyId } = await newFamily();
    await api('PUT', '/v1/storage', { token, body: ownStorage() });
    const deleted = await upload(token);
    const orphan = await upload(token);
    const abandoned = randomUUID();
    const { json } = await requestUrl(token, { id: abandoned });
    await fetch(json.url, { method: 'PUT', headers: json.headers, body: bytes });
    const moment = randomUUID();
    await writeMoment(token, moment, [deleted]);
    await writeMoment(token, moment, [deleted], true);
    await backdateTrash(deleted, config.mediaTrashDays + 1);
    await sql`UPDATE media SET created_at = now() - interval '40 days' WHERE id = ${orphan}`;
    await sql`UPDATE media SET reserved_at = now() - interval '25 hours' WHERE id = ${abandoned}`;

    await runMaintenance(sql, config);
    for (const id of [deleted, orphan, abandoned]) {
      expect(await mediaRow(id)).not.toBeNull();
      expect(await objectExists(familyId, id)).toBe(true);
    }
    // 对象还在他们的 Bucket 里，用量也要如实算上。
    expect((await usage(token)).total).toBe(FILE * 2);
  });

  it('Edge Function 的路径前缀下也能读公开配置', async () => {
    const edge = createApp({ sql, config, basePath: '/api' });
    expect((await edge.request('/api/v1/config')).status).toBe(200);
  });

  it('可以关掉大小绑定，也能检查存储支不支持', async () => {
    const storage = (await activeStorage(sql, config, randomUUID()))!;
    expect(await checkUploadSizeBinding(storage)).toMatchObject({ ok: true });
    expect(loadConfig(testEnv()).bindUploadSize).toBe(true);
    useConfig({ bindUploadSize: false });
    const { token } = await newFamily();
    const { json } = await requestUrl(token, { size: 10 });
    expect(json.url).not.toContain('content-length');
    const put = await fetch(json.url, {
      method: 'PUT',
      headers: json.headers,
      body: Buffer.alloc(11, 1),
    });
    expect(put.status).toBe(200);
    // 关掉之后，complete 的 HEAD 校验还是最终依据。
    const id = new URL(json.url).pathname.split('/').at(-2)!;
    expect((await complete(token, id)).status).toBe(409);
  });
});

describe('升级已有的数据', () => {
  it('迁移时：已删除记录的文件进入待清理，还在用的标记为有引用，记录总量补算', async () => {
    const database = `${testDatabase}_up`;
    await admin.unsafe(`CREATE DATABASE ${database}`);
    const url = new URL(config.databaseUrl);
    url.pathname = `/${database}`;
    const old = connect(url.toString(), config.db);
    try {
      // 停在这次改动之前的版本（前 3 条迁移），写入旧数据后再升级。
      await old`CREATE TABLE schema_migrations (version INT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
      for (const [index, statement] of migrations.slice(0, 3).entries()) {
        await old.unsafe(statement);
        await old`INSERT INTO schema_migrations (version) VALUES (${index})`;
      }
      const family = randomUUID();
      const [live, deleted, shared, unattached] = [
        randomUUID(),
        randomUUID(),
        randomUUID(),
        randomUUID(),
      ];
      await old`INSERT INTO families (id, name, seq) VALUES (${family}, '虚构一家', 3)`;
      for (const id of [live, deleted, shared, unattached]) {
        await old`INSERT INTO media (id, variant, family_id, scope, mime, size, object_key, status)
                  VALUES (${id}, 'original', ${family}, 'memory', 'image/jpeg', 10, ${`k/${id}`}, 'ready')`;
      }
      const record = (seq: number, media: string[], isDeleted: boolean) =>
        old`INSERT INTO records (id, family_id, collection, data, deleted, updated_at_client, seq)
            VALUES (${randomUUID()}, ${family}, 'moment', ${old.json(momentData(media))}, ${isDeleted}, 1, ${seq})`;
      await record(1, [live, shared], false);
      await record(2, [deleted, shared], true);
      await migrate(old);

      const rows = await old<{ id: string; attached: boolean; unreferenced_at: Date | null }[]>`
        SELECT id, attached, unreferenced_at FROM media`;
      const state = (id: string) => rows.find((r) => r.id === id);
      expect(state(live)).toMatchObject({ attached: true, unreferenced_at: null });
      expect(state(shared)).toMatchObject({ attached: true, unreferenced_at: null });
      expect(state(deleted)?.unreferenced_at).toBeInstanceOf(Date);
      expect(state(unattached)).toMatchObject({ attached: false, unreferenced_at: null });
      const [totals] = await old<{ record_bytes: string; quota_mb: string | null }[]>`
        SELECT record_bytes, quota_mb FROM families WHERE id = ${family}`;
      expect(Number(totals?.record_bytes)).toBeGreaterThan(0);
      expect(totals?.quota_mb).toBeNull();
    } finally {
      await old.end();
      await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    }
  });
});

describe('下载链接不受影响', () => {
  it('待清理期间文件还能打开，撤销后不用重新上传', async () => {
    const { token } = await newFamily();
    const media = await upload(token);
    const moment = randomUUID();
    await writeMoment(token, moment, [media]);
    await writeMoment(token, moment, [media], true);
    const { json } = await api<MediaUrlsResponse>('POST', '/v1/media/urls', {
      token,
      body: { items: [{ id: media, variant: 'original' }] },
    });
    expect((await fetch(json.urls[0]!.url!)).status).toBe(200);
  });
});
