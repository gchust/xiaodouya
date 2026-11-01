import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import type { FamilyExport, MeResponse, UploadUrlResponse } from '@xiaodouya/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { decryptSecret } from '../src/crypto';
import { connect } from '../src/db';
import { processPendingDeletions } from '../src/objectDeletions';
import { headObject, type ResolvedStorage, storageById } from '../src/storage';
import {
  type App,
  backgroundTasks,
  call,
  join,
  newFamily,
  newUser,
  OBJECT_BYTES,
  openTestDb,
  PASSWORD,
  type TestDb,
  upload,
} from './harness';

let db: TestDb;
let bg: ReturnType<typeof backgroundTasks>;
let app: App;
let envStorage: ResolvedStorage;

beforeAll(async () => {
  db = await openTestDb('del');
  envStorage = (await storageById(db.sql, db.config, randomUUID(), null))!;
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await db.sql`DELETE FROM rate_limits`;
  await db.sql`DELETE FROM pending_object_deletions`;
  bg = backgroundTasks();
  app = createApp({ sql: db.sql, config: db.config, background: bg.background });
});
afterEach(() => {
  vi.restoreAllMocks();
});

const deleteAccount = (token: string, password = PASSWORD, target = app) =>
  call<{ ok?: boolean; error?: { code: string; message: string } }>(
    target,
    'POST',
    '/v1/me/delete',
    { token, body: { password } },
  );

const feedChange = () => ({
  id: randomUUID(),
  collection: 'event' as const,
  data: { type: 'feed', at: Date.now(), ml: 90, byName: '爸爸' },
  deleted: false,
  updatedAt: Date.now(),
});

const writeRecord = async (token: string, change: Record<string, unknown> = feedChange()) => {
  const response = await call(app, 'POST', '/v1/sync', {
    token,
    body: { cursor: 0, changes: [change] },
  });
  expect(response.status).toBe(200);
  return change.id as string;
};

const objectKeys = async (familyId: string) =>
  (
    await db.sql<
      { object_key: string }[]
    >`SELECT object_key FROM media WHERE family_id = ${familyId}`
  ).map((r) => r.object_key);

const exists = async (key: string, storage = envStorage) =>
  (await headObject(storage, key)) !== null;

const count = async (table: string, column: string, value: string) => {
  const [row] = await db.sql<{ count: string }[]>`
    SELECT count(*) FROM ${db.sql(table)} WHERE ${db.sql(column)} = ${value}`;
  return Number(row?.count);
};

const queueSize = async () => {
  const [row] = await db.sql<{ count: string }[]>`SELECT count(*) FROM pending_object_deletions`;
  return Number(row?.count);
};

const makeAllDue = () =>
  db.sql`UPDATE pending_object_deletions SET next_attempt_at = now() - interval '1 second'`;

const localS3 = () => ({
  provider: 'other' as const,
  endpoint: process.env.TEST_S3_ENDPOINT ?? 'http://localhost:59000',
  region: 'us-east-1',
  bucket: 'xiaodouya-dev',
  accessKeyId: 'devaccesskey',
  secretAccessKey: 'devsecretkey',
});

describe('删除账号的规则', () => {
  it('密码错误不删，不算登录失效，App 不会被踢出去', async () => {
    const { admin, family } = await newFamily(app);
    const response = await deleteAccount(admin.token, 'wrong-pass');
    expect(response.status).toBe(403);
    expect(response.json.error?.code).toBe('wrong_password');
    expect((await call(app, 'GET', '/v1/me', { token: admin.token })).status).toBe(200);
    expect(await count('families', 'id', family.id)).toBe(1);
  });

  it('猜密码有次数限制，令牌被偷了也不能无限试', async () => {
    const user = await newUser(app);
    let last = 0;
    for (let i = 0; i < 11; i++) last = (await deleteAccount(user.token, 'wrong-pass')).status;
    expect(last).toBe(429);
  });

  it('没有登录不能删', async () => {
    const response = await call(app, 'POST', '/v1/me/delete', { body: { password: PASSWORD } });
    expect(response.status).toBe(401);
  });

  it('还没有家庭：只删账号', async () => {
    const user = await newUser(app);
    expect((await deleteAccount(user.token)).status).toBe(200);
    expect(await count('users', 'id', user.user.id)).toBe(0);
    expect((await call(app, 'GET', '/v1/me', { token: user.token })).status).toBe(401);
    const again = await call(app, 'POST', '/v1/auth/login', {
      body: { email: user.email, password: PASSWORD },
    });
    expect(again.status).toBe(401);
  });

  it('家庭里唯一的管理员、还有别的家人时拒绝，什么都不删', async () => {
    const { admin, family } = await newFamily(app);
    const mom = await join(app, admin.token, 'caregiver', '妈妈');
    const key = await writeRecord(admin.token);
    const response = await deleteAccount(admin.token);
    expect(response.status).toBe(409);
    expect(response.json.error?.code).toBe('only_admin');
    expect(response.json.error?.message).toMatch(/管理员/);
    expect(await count('users', 'id', admin.user.id)).toBe(1);
    expect(await count('memberships', 'family_id', family.id)).toBe(2);
    expect(await count('records', 'id', key)).toBe(1);
    expect((await call(app, 'GET', '/v1/me', { token: admin.token })).status).toBe(200);
    expect((await call(app, 'GET', '/v1/me', { token: mom.token })).status).toBe(200);
  });

  it('把别人升为管理员之后就可以删了，家庭和数据都留下', async () => {
    const { admin, family } = await newFamily(app);
    const mom = await join(app, admin.token, 'caregiver', '妈妈');
    await call(app, 'PATCH', `/v1/family/members/${mom.user.id}`, {
      token: admin.token,
      body: { role: 'admin' },
    });
    expect((await deleteAccount(admin.token)).status).toBe(200);
    expect(await count('families', 'id', family.id)).toBe(1);
    const me = await call<MeResponse>(app, 'GET', '/v1/me', { token: mom.token });
    expect(me.json.members.map((m) => m.userId)).toEqual([mom.user.id]);
  });

  it('把家人都移出之后，就是最后一个人，家庭一起删除', async () => {
    const { admin, family } = await newFamily(app);
    const mom = await join(app, admin.token, 'caregiver', '妈妈');
    await call(app, 'DELETE', `/v1/family/members/${mom.user.id}`, { token: admin.token });
    expect((await deleteAccount(admin.token)).status).toBe(200);
    expect(await count('families', 'id', family.id)).toBe(0);
    // 被移出的家人只是没有家庭了，账号还在。
    expect(await count('users', 'id', mom.user.id)).toBe(1);
  });

  it('普通成员：只删自己的账号、成员关系、登录和推送，记录留给家庭', async () => {
    const { admin, family } = await newFamily(app);
    const mom = await join(app, admin.token, 'caregiver', '妈妈');
    await call(app, 'POST', '/v1/me/push-token', {
      token: mom.token,
      body: { deviceId: randomUUID(), token: 'ExponentPushToken[fictional]' },
    });
    const recordId = await writeRecord(mom.token);
    const mediaId = await upload(app, mom.token);
    const keys = await objectKeys(family.id);

    expect((await deleteAccount(mom.token)).status).toBe(200);
    await bg.flush();

    expect(await count('users', 'id', mom.user.id)).toBe(0);
    expect(await count('memberships', 'user_id', mom.user.id)).toBe(0);
    expect(await count('sessions', 'user_id', mom.user.id)).toBe(0);
    expect(await count('push_tokens', 'user_id', mom.user.id)).toBe(0);
    expect((await call(app, 'GET', '/v1/me', { token: mom.token })).status).toBe(401);

    const [record] = await db.sql<{ created_by: string | null; updated_by: string | null }[]>`
      SELECT created_by, updated_by FROM records WHERE id = ${recordId}`;
    expect(record).toEqual({ created_by: null, updated_by: null });
    const [media] = await db.sql<{ uploaded_by: string | null }[]>`
      SELECT uploaded_by FROM media WHERE id = ${mediaId}`;
    expect(media?.uploaded_by).toBeNull();

    // 家庭的文件不动。
    expect(await queueSize()).toBe(0);
    expect(await exists(keys[0]!)).toBe(true);
    const synced = await call<{ records: { id: string; createdBy: string | null }[] }>(
      app,
      'POST',
      '/v1/sync',
      { token: admin.token, body: { cursor: 0, changes: [] } },
    );
    expect(synced.json.records.find((r) => r.id === recordId)?.createdBy).toBeNull();
  });

  it('删除后这个邮箱可以重新注册，是一个全新的账号', async () => {
    const user = await newUser(app);
    await deleteAccount(user.token);
    const again = await call(app, 'POST', '/v1/auth/register', {
      body: { email: user.email, password: PASSWORD, displayName: '虚构用户' },
    });
    expect(again.status).toBe(201);
  });

  it('最后一个成员：家庭、记录、文件记录、邀请、存储配置全部删除', async () => {
    const { admin, family } = await newFamily(app);
    await call(app, 'POST', '/v1/invites', {
      token: admin.token,
      body: { role: 'caregiver', label: '妈妈' },
    });
    await writeRecord(admin.token);
    await upload(app, admin.token);
    await upload(app, admin.token, { variant: 'thumb' });
    await upload(app, admin.token, { scope: 'document', mime: 'application/pdf' });
    const keys = await objectKeys(family.id);
    expect(keys).toHaveLength(3);
    for (const key of keys) expect(await exists(key)).toBe(true);

    expect((await deleteAccount(admin.token)).status).toBe(200);
    await bg.flush();

    for (const table of ['records', 'media', 'invites', 'memberships', 'storage_configs']) {
      expect(await count(table, 'family_id', family.id)).toBe(0);
    }
    expect(await count('families', 'id', family.id)).toBe(0);
    expect(await count('users', 'id', admin.user.id)).toBe(0);
    for (const key of keys) expect(await exists(key)).toBe(false);
    expect(await queueSize()).toBe(0);
  });

  it('家庭自己配置的存储：配置和文件记录一起删，文件也能从那份存储里删掉', async () => {
    const { admin, family } = await newFamily(app);
    const saved = await call(app, 'PUT', '/v1/storage', { token: admin.token, body: localS3() });
    expect(saved.status).toBe(200);
    await upload(app, admin.token);
    const keys = await objectKeys(family.id);
    const [row] = await db.sql<{ storage_config_id: string | null }[]>`
      SELECT storage_config_id FROM media WHERE family_id = ${family.id}`;
    expect(row?.storage_config_id).not.toBeNull();

    expect((await deleteAccount(admin.token)).status).toBe(200);
    await bg.flush();

    expect(await count('storage_configs', 'family_id', family.id)).toBe(0);
    expect(await exists(keys[0]!)).toBe(false);
    expect(await queueSize()).toBe(0);
  });

  /**
   * 让两个删除请求确定地重叠：别的连接锁住成员行，两个事务读完成员后都会卡在级联删除上，
   * 放开后才继续。不这样做的话窗口太小，去掉家庭行锁后这些测试照样通过，证明不了什么。
   * 连接池只有 1 个连接时请求本来就是串行的，等不到两个都卡住，超时后照常继续。
   */
  async function deleteBothOverlapping(familyId: string, tokens: [string, string]) {
    // 两个连接：一个拿着锁，一个查有没有卡住。只有一个的话查询永远等不到连接。
    const holder = connect(db.url, { poolMax: 2 });
    try {
      let release = () => {};
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let locked = () => {};
      const isLocked = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const holding = holder.begin(async (tx) => {
        await tx`SELECT 1 FROM memberships WHERE family_id = ${familyId} FOR UPDATE`;
        locked();
        await released;
      });
      await isLocked;
      const requests = Promise.all(tokens.map((token) => deleteAccount(token)));
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const [row] = await holder<{ count: string }[]>`
          SELECT count(*) FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'`;
        if (Number(row?.count) >= 2) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      release();
      await holding;
      return await requests;
    } finally {
      await holder.end();
    }
  }

  it('两位管理员同时删除：不会留下没有成员的家庭和永远删不掉的文件', async () => {
    const { admin, family } = await newFamily(app);
    const other = await join(app, admin.token, 'admin', '妈妈');
    await upload(app, admin.token);
    const keys = await objectKeys(family.id);
    const results = await deleteBothOverlapping(family.id, [admin.token, other.token]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    await bg.flush();
    expect(await count('families', 'id', family.id)).toBe(0);
    expect(await exists(keys[0]!)).toBe(false);
  });

  it('两位管理员和一位家人，同时删除只能走一个，不会留下没有管理员的家庭', async () => {
    const { admin, family } = await newFamily(app);
    const other = await join(app, admin.token, 'admin', '妈妈');
    await join(app, admin.token, 'caregiver', '奶奶');
    const results = await deleteBothOverlapping(family.id, [admin.token, other.token]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const admins = await db.sql`
      SELECT 1 FROM memberships WHERE family_id = ${family.id} AND role = 'admin'`;
    expect(admins).toHaveLength(1);
  });
});

describe('待删除文件的队列', () => {
  it('存储暂时不可用：账号照样删除，记录留在队列，恢复后能补删', async () => {
    const { admin, family } = await newFamily(app);
    await upload(app, admin.token);
    const keys = await objectKeys(family.id);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = createApp({
      sql: db.sql,
      config: { ...db.config, serverStorage: null },
      background: bg.background,
    });
    expect((await deleteAccount(admin.token, PASSWORD, broken)).status).toBe(200);
    await bg.flush();

    expect(await count('users', 'id', admin.user.id)).toBe(0);
    expect(await exists(keys[0]!)).toBe(true);
    const [row] = await db.sql<
      { attempts: number; last_error: string | null; waits: boolean }[]
    >`SELECT attempts, last_error, next_attempt_at > now() AS waits FROM pending_object_deletions`;
    expect(row?.attempts).toBe(1);
    expect(row?.last_error).toBeTruthy();
    expect(row?.waits).toBe(true);

    // 退避期内不重试，退避结束后才重试。
    expect((await processPendingDeletions(db.sql, db.config)).deleted).toBe(0);
    await makeAllDue();
    const result = await processPendingDeletions(db.sql, db.config);
    expect(result).toMatchObject({ deleted: 1, failed: 0, remaining: 0 });
    expect(await exists(keys[0]!)).toBe(false);
  });

  it('家庭的存储配置删掉之后，队列还带着（加密的）凭据，密钥不是明文', async () => {
    const { admin, family } = await newFamily(app);
    await call(app, 'PUT', '/v1/storage', { token: admin.token, body: localS3() });
    await upload(app, admin.token);
    const keys = await objectKeys(family.id);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // 让第一次处理什么都做不了：APP_SECRET 不对就解不开，模拟函数在处理前被回收。
    const wrongKey = Buffer.alloc(32, 1);
    const stalled = createApp({
      sql: db.sql,
      config: { ...db.config, appSecret: wrongKey },
      background: bg.background,
    });
    expect((await deleteAccount(admin.token, PASSWORD, stalled)).status).toBe(200);
    await bg.flush();
    expect(await count('storage_configs', 'family_id', family.id)).toBe(0);

    const [row] = await db.sql<{ storage: { secret_encrypted: string } }[]>`
      SELECT storage FROM pending_object_deletions`;
    expect(JSON.stringify(row?.storage)).not.toContain('devsecretkey');
    expect(decryptSecret(row!.storage.secret_encrypted, db.config.appSecret)).toBe('devsecretkey');

    await makeAllDue();
    expect((await processPendingDeletions(db.sql, db.config)).deleted).toBe(1);
    expect(await exists(keys[0]!)).toBe(false);
  });

  describe('用本地假存储', () => {
    let server: Server;
    let hits: string[];
    let respond: (res: import('node:http').ServerResponse) => void;
    let endpoint: string;

    beforeAll(async () => {
      server = createServer((req, res) => {
        hits.push(req.method ?? '');
        respond(res);
      });
      await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
      endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterAll(async () => {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    });
    beforeEach(() => {
      hits = [];
      respond = (res) => {
        res.statusCode = 204;
        res.end();
      };
    });

    const enqueue = (key: string) =>
      db.sql`INSERT INTO pending_object_deletions (id, object_key, storage)
        VALUES (${randomUUID()}, ${key}, ${db.sql.json({
          id: randomUUID(),
          provider: 'other',
          account_id: null,
          endpoint,
          region: 'us-east-1',
          bucket: 'fictional',
          access_key_id: 'fictional',
          secret_encrypted: encrypted(),
          public_base_url: null,
        })})`;
    const encrypted = () => {
      const { encryptSecret } = cryptoModule;
      return encryptSecret('fictional-secret', db.config.appSecret);
    };

    it('地址指向内网时不连接：删除也要过 SSRF 检查', async () => {
      await enqueue('families/x/memory/y/original');
      const locked = { ...db.config, allowPrivateEndpoints: false };
      const result = await processPendingDeletions(db.sql, locked);
      expect(hits).toEqual([]);
      expect(result).toMatchObject({ deleted: 0, failed: 1, remaining: 1 });
    });

    it('对方说文件或 Bucket 不存在，就算删掉了，不会一直重试', async () => {
      respond = (res) => {
        res.statusCode = 404;
        res.setHeader('content-type', 'application/xml');
        res.end('<Error><Code>NoSuchBucket</Code></Error>');
      };
      await enqueue('families/x/memory/y/original');
      const result = await processPendingDeletions(db.sql, db.config);
      expect(result).toMatchObject({ deleted: 1, failed: 0, remaining: 0 });
    });

    it('存储报错时留在队列，下次退避后再试', async () => {
      respond = (res) => {
        res.statusCode = 403;
        res.setHeader('content-type', 'application/xml');
        res.end('<Error><Code>AccessDenied</Code></Error>');
      };
      await enqueue('families/x/memory/y/original');
      const result = await processPendingDeletions(db.sql, db.config);
      expect(result).toMatchObject({ deleted: 0, failed: 1, remaining: 1 });
      const [row] = await db.sql<{ last_error: string }[]>`
        SELECT last_error FROM pending_object_deletions`;
      expect(row?.last_error).toContain('密钥');
      expect(row?.last_error).not.toContain('fictional-secret');
    });

    it('存储一直不响应也不会卡住整批', async () => {
      respond = () => {};
      await enqueue('families/x/memory/hang/original');
      const started = Date.now();
      const result = await processPendingDeletions(db.sql, db.config, { objectTimeoutMs: 200 });
      expect(Date.now() - started).toBeLessThan(5000);
      expect(result).toMatchObject({ deleted: 0, failed: 1, remaining: 1 });
    });

    it('按批处理：到时限就停，没做完的留给下一次', async () => {
      for (let i = 0; i < 5; i++) await enqueue(`families/x/memory/${i}/original`);
      const first = await processPendingDeletions(db.sql, db.config, { batchSize: 2, maxMs: 0 });
      expect(first).toMatchObject({ deleted: 2, remaining: 3 });
      const rest = await processPendingDeletions(db.sql, db.config, { batchSize: 2 });
      expect(rest).toMatchObject({ deleted: 3, remaining: 0 });
    });

    it('两个进程同时处理，同一个文件不会被处理两次', async () => {
      for (let i = 0; i < 10; i++) await enqueue(`families/x/memory/c${i}/original`);
      const [a, b] = await Promise.all([
        processPendingDeletions(db.sql, db.config, { batchSize: 3 }),
        processPendingDeletions(db.sql, db.config, { batchSize: 3 }),
      ]);
      expect((a?.deleted ?? 0) + (b?.deleted ?? 0)).toBe(10);
      expect(hits).toHaveLength(10);
    });

    it('退避时间有上限，重试很多次也不会溢出报错', async () => {
      await enqueue('families/x/memory/z/original');
      await db.sql`UPDATE pending_object_deletions SET attempts = 100000`;
      respond = (res) => {
        res.statusCode = 403;
        res.end();
      };
      const result = await processPendingDeletions(db.sql, db.config);
      expect(result.failed).toBe(1);
      const [row] = await db.sql<{ hours: number }[]>`
        SELECT extract(epoch FROM next_attempt_at - now()) / 3600 AS hours
        FROM pending_object_deletions`;
      expect(Number(row?.hours)).toBeLessThan(25);
    });
  });

  it('还没传完的文件：预签名链接在删除之后还有效，晚些时候要再删一次', async () => {
    const { admin, family } = await newFamily(app);
    const id = randomUUID();
    const { json } = await call<UploadUrlResponse>(app, 'POST', '/v1/media/upload-url', {
      token: admin.token,
      body: { id, scope: 'memory', variant: 'original', mime: 'image/jpeg', size: 26 },
    });
    const [key] = await objectKeys(family.id);
    expect((await deleteAccount(admin.token)).status).toBe(200);
    await bg.flush();

    // 手机上的上传在账号删除之后才到达。
    const put = await fetch(json.url, { method: 'PUT', headers: json.headers, body: OBJECT_BYTES });
    expect(put.status).toBe(200);
    expect(await exists(key!)).toBe(true);

    expect((await processPendingDeletions(db.sql, db.config)).deleted).toBe(0);
    expect(await queueSize()).toBe(1);
    await makeAllDue();
    expect((await processPendingDeletions(db.sql, db.config)).deleted).toBe(1);
    expect(await exists(key!)).toBe(false);
  });

  it('命令行 purge-objects 能处理队列', async () => {
    const { admin, family } = await newFamily(app);
    await upload(app, admin.token);
    const [key] = await objectKeys(family.id);
    await db.sql`INSERT INTO pending_object_deletions (id, object_key, storage)
      VALUES (${randomUUID()}, ${key!}, NULL)`;
    const s = db.config.serverStorage!;
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ['--import', 'tsx', resolve(import.meta.dirname, '../src/cli.ts'), 'purge-objects'],
      {
        cwd: resolve(import.meta.dirname, '..'),
        env: {
          PATH: process.env.PATH,
          DATABASE_URL: db.url,
          APP_SECRET: db.config.appSecret.toString('base64'),
          S3_ENDPOINT: s.endpoint,
          S3_REGION: s.region,
          S3_BUCKET: s.bucket,
          S3_ACCESS_KEY_ID: s.accessKeyId,
          S3_SECRET_ACCESS_KEY: s.secretAccessKey,
          S3_FORCE_PATH_STYLE: 'true',
        },
      },
    );
    expect(stdout).toContain('已删除 1 个');
    expect(await exists(key!)).toBe(false);
    expect(await queueSize()).toBe(0);
  }, 60_000);
});

describe('导出家庭数据', () => {
  const exportFamily = (token: string) =>
    call<FamilyExport & { error?: { code: string } }>(app, 'GET', '/v1/family/export', { token });

  const documentChange = () => ({
    id: randomUUID(),
    collection: 'document' as const,
    data: { name: '虚构证件', number: 'FICTIONAL-123', files: [] },
    deleted: false,
    updatedAt: Date.now(),
  });
  const momentChange = () => ({
    id: randomUUID(),
    collection: 'moment' as const,
    data: { title: '虚构回忆', text: '', at: Date.now(), milestone: false, media: [] },
    deleted: false,
    updatedAt: Date.now(),
  });

  it('管理员：下载文件，包含全部记录和文件信息', async () => {
    const { admin, family } = await newFamily(app);
    const event = await writeRecord(admin.token);
    const doc = await writeRecord(admin.token, documentChange());
    const memoryId = await upload(app, admin.token, { filename: 'first-smile.jpg' });
    const response = await exportFamily(admin.token);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toMatch(/^attachment; filename="[^"]+"/);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const data = response.json;
    expect(data.format).toBe('xiaodouya-export');
    expect(data.version).toBe(1);
    expect(data.family).toEqual({ id: family.id, name: family.name });
    expect(data.account.email).toBe(admin.email);
    expect(data.records.map((r) => r.id).sort()).toEqual([event, doc].sort());
    expect(data.media).toHaveLength(1);
    expect(data.media[0]).toMatchObject({
      id: memoryId,
      variant: 'original',
      scope: 'memory',
      mime: 'image/jpeg',
      filename: 'first-smile.jpg',
    });
  });

  it('一起记录的家人：和管理员一样读全部', async () => {
    const { admin } = await newFamily(app);
    const mom = await join(app, admin.token, 'caregiver', '妈妈');
    const doc = await writeRecord(admin.token, documentChange());
    const { json, status } = await exportFamily(mom.token);
    expect(status).toBe(200);
    expect(json.records.map((r) => r.id)).toContain(doc);
  });

  it('只看回忆的家人：读不到记录、证件和证件文件', async () => {
    const { admin } = await newFamily(app);
    const viewer = await join(app, admin.token, 'viewer', '外公');
    await writeRecord(admin.token);
    await writeRecord(admin.token, documentChange());
    const moment = await writeRecord(admin.token, momentChange());
    const memoryId = await upload(app, admin.token);
    await upload(app, admin.token, { scope: 'document', mime: 'application/pdf' });
    const { json, text, status } = await exportFamily(viewer.token);
    expect(status).toBe(200);
    expect(json.records.map((r) => r.id)).toEqual([moment]);
    expect(json.media.map((m) => m.id)).toEqual([memoryId]);
    expect(text).not.toContain('FICTIONAL-123');
  });

  it('不含已删除的记录、还没传完的文件和别的家庭的数据', async () => {
    const { admin } = await newFamily(app);
    const other = await newFamily(app);
    const foreign = await writeRecord(other.admin.token);
    const gone = feedChange();
    await writeRecord(admin.token, gone);
    await writeRecord(admin.token, { ...gone, deleted: true, updatedAt: Date.now() + 1000 });
    await call(app, 'POST', '/v1/media/upload-url', {
      token: admin.token,
      body: { id: randomUUID(), scope: 'memory', variant: 'original', mime: 'image/jpeg', size: 1 },
    });
    const { json, text } = await exportFamily(admin.token);
    expect(json.records).toEqual([]);
    expect(json.media).toEqual([]);
    expect(text).not.toContain(foreign);
  });

  it('密钥、哈希、令牌、别人的邮箱和内部地址一律不出现', async () => {
    const { admin } = await newFamily(app);
    const mom = await join(app, admin.token, 'caregiver', '妈妈');
    await call(app, 'PUT', '/v1/storage', { token: admin.token, body: localS3() });
    await call(app, 'POST', '/v1/me/push-token', {
      token: admin.token,
      body: { deviceId: randomUUID(), token: 'ExponentPushToken[fictional]' },
    });
    const invite = await call<{ code: string }>(app, 'POST', '/v1/invites', {
      token: admin.token,
      body: { role: 'viewer', label: '外公' },
    });
    await upload(app, admin.token);
    const { text } = await exportFamily(admin.token);
    for (const secret of [
      'scrypt$',
      'password',
      'secret',
      'devsecretkey',
      'devaccesskey',
      'object_key',
      'objectKey',
      'families/',
      admin.token,
      invite.json.code,
      'ExponentPushToken',
      mom.email,
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  it('还没有家庭不能导出，没登录也不能', async () => {
    const user = await newUser(app);
    expect((await exportFamily(user.token)).status).toBe(403);
    expect((await call(app, 'GET', '/v1/family/export')).status).toBe(401);
  });

  it('频率有限制：一次要查全家的数据', async () => {
    const { admin } = await newFamily(app);
    let last = 0;
    for (let i = 0; i < 11; i++) last = (await exportFamily(admin.token)).status;
    expect(last).toBe(429);
  });
});

const cryptoModule = await import('../src/crypto');
