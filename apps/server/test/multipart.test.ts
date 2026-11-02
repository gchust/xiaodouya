import { createHash, randomUUID } from 'node:crypto';
import {
  MULTIPART_PART_BYTES,
  type MultipartPartsResponse,
  type MultipartPartUrlsResponse,
  type MultipartStartResponse,
  multipartPartBytes,
  type StorageUsage,
  type UploadUrlResponse,
} from '@xiaodouya/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { runMaintenance } from '../src/maintenance';
import * as storageModule from '../src/storage';
import {
  abortMultipart,
  activeStorage,
  checkMultipartUpload,
  completeMultipart,
  headObject,
  listMultipartParts,
  type ResolvedStorage,
} from '../src/storage';
import {
  type App,
  backgroundTasks,
  call,
  join,
  newFamily,
  newUser,
  openTestDb,
  type TestDb,
  upload,
} from './harness';

/** 让测试能模拟存储对某个操作报错，其余都走真实的 SeaweedFS。 */
const failures = vi.hoisted(() => ({
  abort: null as Error | null,
  create: null as Error | null,
}));
vi.mock('../src/storage', async (original) => {
  const real = await original<typeof storageModule>();
  return {
    ...real,
    abortMultipart: (...args: Parameters<typeof real.abortMultipart>) =>
      failures.abort ? Promise.reject(failures.abort) : real.abortMultipart(...args),
    createMultipart: (...args: Parameters<typeof real.createMultipart>) =>
      failures.create ? Promise.reject(failures.create) : real.createMultipart(...args),
  };
});

let db: TestDb;
let app: App;
let bg: ReturnType<typeof backgroundTasks>;

const SIZE = MULTIPART_PART_BYTES * 2 + 1234;
const fileBytes = (size = SIZE) => {
  const data = Buffer.alloc(size);
  for (let i = 0; i < size; i += 4096) data[i] = i % 251;
  return data;
};
const FILE = fileBytes();

beforeAll(async () => {
  db = await openTestDb('multipart');
});
afterAll(async () => {
  await db.close();
});
beforeEach(() => {
  failures.abort = null;
  failures.create = null;
  bg = backgroundTasks();
  app = createApp({ sql: db.sql, config: db.config, background: bg.background });
});

const body = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  scope: 'memory',
  variant: 'original',
  mime: 'video/mp4',
  size: SIZE,
  ...overrides,
});

const start = (token: string, id = randomUUID(), overrides: Record<string, unknown> = {}) =>
  call<MultipartStartResponse>(app, 'POST', '/v1/media/multipart', {
    token,
    body: body(id, overrides),
  });

async function started(token: string, overrides: Record<string, unknown> = {}) {
  const id = randomUUID();
  const { status, json, text } = await start(token, id, overrides);
  if (status !== 200) throw new Error(`开始分片上传失败：${text}`);
  return { id, uploadId: json.uploadId, partSize: json.partSize };
}

const partUrls = (token: string, id: string, uploadId: string, partNumbers: number[]) =>
  call<MultipartPartUrlsResponse>(app, 'POST', `/v1/media/${id}/multipart/part-urls`, {
    token,
    body: { variant: 'original', uploadId, partNumbers },
  });

const parts = (token: string, id: string, uploadId: string) =>
  call<MultipartPartsResponse>(app, 'POST', `/v1/media/${id}/multipart/parts`, {
    token,
    body: { variant: 'original', uploadId },
  });

const complete = (token: string, id: string, uploadId: string) =>
  call(app, 'POST', `/v1/media/${id}/multipart/complete`, {
    token,
    body: { variant: 'original', uploadId },
  });

const cancel = (token: string, id: string) =>
  call(app, 'POST', `/v1/media/${id}/cancel`, { token });

function slice(partNumber: number, partSize: number, file: Buffer = FILE): Buffer {
  const offset = (partNumber - 1) * partSize;
  return file.subarray(offset, offset + multipartPartBytes(partNumber, file.length, partSize));
}

async function putParts(
  token: string,
  id: string,
  uploadId: string,
  partSize: number,
  numbers: number[],
) {
  const { json, status, text } = await partUrls(token, id, uploadId, numbers);
  if (status !== 200) throw new Error(`取分片链接失败：${text}`);
  for (const entry of json.urls) {
    const put = await fetch(entry.url, {
      method: 'PUT',
      body: new Uint8Array(slice(entry.partNumber, partSize)),
    });
    expect(put.status).toBe(200);
    await put.arrayBuffer();
  }
}

async function mediaRow(id: string, variant = 'original') {
  const [row] = await db.sql<
    {
      status: string;
      upload_id: string | null;
      object_key: string;
      family_id: string;
    }[]
  >`SELECT status, upload_id, object_key, family_id FROM media WHERE id = ${id} AND variant = ${variant}`;
  return row;
}

const storageFor = async (familyId: string): Promise<ResolvedStorage> => {
  const storage = await activeStorage(db.sql, db.config, familyId);
  if (!storage) throw new Error('没有存储');
  return storage;
};

/** NoSuchUpload 才算分片真的没了；别的错误（比如连不上）不能当成已清理。 */
async function uploadGone(storage: ResolvedStorage, key: string, uploadId: string) {
  try {
    await listMultipartParts(storage, key, uploadId);
    return false;
  } catch (error) {
    return storageModule.isNoSuchUpload(error);
  }
}

const usage = (token: string) => call<StorageUsage>(app, 'GET', '/v1/storage/usage', { token });

describe('完整的分片上传', () => {
  it('传完后是 ready，下载回来的内容一致', async () => {
    const { admin, family } = await newFamily(app);
    const { id, uploadId, partSize } = await started(admin.token);
    expect(partSize).toBe(MULTIPART_PART_BYTES);
    await putParts(admin.token, id, uploadId, partSize, [1, 2, 3]);

    const done = await complete(admin.token, id, uploadId);
    expect(done.status).toBe(200);
    const row = await mediaRow(id);
    expect(row?.status).toBe('ready');
    expect(row?.upload_id).toBeNull();

    const urls = await call<{ urls: { url: string | null }[] }>(app, 'POST', '/v1/media/urls', {
      token: admin.token,
      body: { items: [{ id, variant: 'original' }] },
    });
    const downloaded = await fetch(urls.json.urls[0]?.url ?? '');
    const hash = createHash('sha256')
      .update(Buffer.from(await downloaded.arrayBuffer()))
      .digest('hex');
    expect(hash).toBe(createHash('sha256').update(FILE).digest('hex'));

    const head = await headObject(await storageFor(family.id), row?.object_key ?? '');
    expect(head?.size).toBe(SIZE);
  });

  it('断点：传一半后查询、只补缺的片、完成', async () => {
    const { admin } = await newFamily(app);
    const { id, uploadId, partSize } = await started(admin.token);
    await putParts(admin.token, id, uploadId, partSize, [2]);

    const listed = await parts(admin.token, id, uploadId);
    expect(listed.status).toBe(200);
    expect(listed.json.complete).toBe(false);
    expect(listed.json.parts).toEqual([{ partNumber: 2, size: partSize }]);

    await putParts(admin.token, id, uploadId, partSize, [1, 3]);
    expect((await complete(admin.token, id, uploadId)).status).toBe(200);
    expect((await mediaRow(id))?.status).toBe('ready');
  });

  it('App 被杀后重新开始，拿回同一个 uploadId，已传的片还在', async () => {
    const { admin } = await newFamily(app);
    const { id, uploadId, partSize } = await started(admin.token);
    await putParts(admin.token, id, uploadId, partSize, [1]);

    const again = await start(admin.token, id);
    expect(again.status).toBe(200);
    expect(again.json.uploadId).toBe(uploadId);
    expect((await parts(admin.token, id, uploadId)).json.parts).toHaveLength(1);
  });

  it('文件大小变了就是新的上传，旧的分片要中止', async () => {
    const { admin, family } = await newFamily(app);
    const { id, uploadId } = await started(admin.token);
    const key = (await mediaRow(id))?.object_key ?? '';

    const changed = await start(admin.token, id, { size: SIZE + 1 });
    expect(changed.status).toBe(200);
    expect(changed.json.uploadId).not.toBe(uploadId);
    expect(await uploadGone(await storageFor(family.id), key, uploadId)).toBe(true);
  });

  it('未传完就完成要拒绝，缺的片补上后能完成', async () => {
    const { admin } = await newFamily(app);
    const { id, uploadId, partSize } = await started(admin.token);
    await putParts(admin.token, id, uploadId, partSize, [1, 2]);
    const early = await complete(admin.token, id, uploadId);
    expect(early.status).toBe(409);
    expect((early.json as { error: { code: string } }).error.code).toBe('parts_incomplete');
    expect((await mediaRow(id))?.status).toBe('pending');

    await putParts(admin.token, id, uploadId, partSize, [3]);
    expect((await complete(admin.token, id, uploadId)).status).toBe(200);
  });

  it('上次合并成功但没收到响应：查询说已完成，再调完成是幂等的', async () => {
    const { admin, family } = await newFamily(app);
    const { id, uploadId, partSize } = await started(admin.token);
    await putParts(admin.token, id, uploadId, partSize, [1, 2, 3]);
    const storage = await storageFor(family.id);
    const key = (await mediaRow(id))?.object_key ?? '';
    await completeMultipart(
      storage,
      key,
      uploadId,
      await listMultipartParts(storage, key, uploadId),
    );

    const listed = await parts(admin.token, id, uploadId);
    expect(listed.json.complete).toBe(true);
    expect((await complete(admin.token, id, uploadId)).status).toBe(200);
    expect((await mediaRow(id))?.status).toBe('ready');
    expect((await complete(admin.token, id, uploadId)).status).toBe(200);
    expect((await parts(admin.token, id, uploadId)).json.complete).toBe(true);
  });

  it('uploadId 在存储里没了：明确告诉客户端重新开始，再开始能拿到新的', async () => {
    const { admin, family } = await newFamily(app);
    const { id, uploadId } = await started(admin.token);
    const key = (await mediaRow(id))?.object_key ?? '';
    await abortMultipart(await storageFor(family.id), key, uploadId);

    const listed = await parts(admin.token, id, uploadId);
    expect(listed.status).toBe(404);
    expect((listed.json as unknown as { error: { code: string } }).error.code).toBe('upload_gone');

    const again = await start(admin.token, id);
    expect(again.status).toBe(200);
    expect(again.json.uploadId).not.toBe(uploadId);
  });
});

describe('大小限制', () => {
  it('分片链接绑定大小：传错的大小被存储拒绝', async () => {
    const { admin } = await newFamily(app);
    const { id, uploadId, partSize } = await started(admin.token);
    const { json } = await partUrls(admin.token, id, uploadId, [1]);
    const url = json.urls[0];
    expect(url?.size).toBe(partSize);
    const wrong = await fetch(url?.url ?? '', { method: 'PUT', body: Buffer.alloc(partSize + 1) });
    expect(wrong.status).toBeGreaterThanOrEqual(400);
    expect(wrong.status).toBeLessThan(500);
  });

  it('关掉绑定时大小不对的片也通不过完成，重传同一片后能完成', async () => {
    const lax = createApp({
      sql: db.sql,
      config: { ...db.config, bindUploadSize: false },
      background: bg.background,
    });
    app = lax;
    const { admin } = await newFamily(app);
    const { id, uploadId, partSize } = await started(admin.token);
    const { json } = await partUrls(admin.token, id, uploadId, [1, 2, 3]);
    for (const entry of json.urls) {
      const size = entry.partNumber === 3 ? entry.size + 7 : entry.size;
      const put = await fetch(entry.url, { method: 'PUT', body: Buffer.alloc(size) });
      expect(put.status).toBe(200);
    }
    const listed = await parts(admin.token, id, uploadId);
    expect(listed.json.parts.find((p) => p.partNumber === 3)?.size).toBe(1234 + 7);
    const bad = await complete(admin.token, id, uploadId);
    expect(bad.status).toBe(409);
    expect((await mediaRow(id))?.status).toBe('pending');

    await putParts(admin.token, id, uploadId, partSize, [3]);
    expect((await complete(admin.token, id, uploadId)).status).toBe(200);
  });

  it('超过上限的文件开不了分片上传，片号超范围也拿不到链接', async () => {
    const { admin } = await newFamily(app);
    const tooBig = await start(admin.token, randomUUID(), { size: 100 * 1024 * 1024 * 1024 });
    expect(tooBig.status).toBe(413);

    const { id, uploadId } = await started(admin.token);
    const beyond = await partUrls(admin.token, id, uploadId, [4]);
    expect(beyond.status).toBe(400);
    expect((beyond.json as unknown as { error: { code: string } }).error.code).toBe('bad_part');
  });
});

describe('配额', () => {
  const withQuota = (bytes: number) => {
    app = createApp({
      sql: db.sql,
      config: { ...db.config, familyQuotaBytes: bytes },
      background: bg.background,
    });
  };

  it('开始时预留，别的文件要算上它', async () => {
    withQuota(SIZE + 100);
    const { admin } = await newFamily(app);
    await started(admin.token);
    const other = await start(admin.token);
    expect(other.status).toBe(413);
    const put = await call(app, 'POST', '/v1/media/upload-url', {
      token: admin.token,
      body: body(randomUUID(), { mime: 'image/jpeg', size: 200 }),
    });
    expect(put.status).toBe(413);
    expect((await usage(admin.token)).json.pending).toBe(SIZE);
  });

  it('并行开始不会一起超出', async () => {
    withQuota(SIZE + 100);
    const { admin } = await newFamily(app);
    const results = await Promise.all(Array.from({ length: 4 }, () => start(admin.token)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 413)).toHaveLength(3);
  });

  it('完成时复查：配额被调低后删掉文件并释放预留', async () => {
    const { admin, family } = await newFamily(app);
    const { id, uploadId, partSize } = await started(admin.token);
    await putParts(admin.token, id, uploadId, partSize, [1, 2, 3]);
    const key = (await mediaRow(id))?.object_key ?? '';

    withQuota(1000);
    const done = await complete(admin.token, id, uploadId);
    expect(done.status).toBe(413);
    expect(await mediaRow(id)).toBeUndefined();
    expect(await headObject(await storageFor(family.id), key)).toBeNull();
  });

  it('预留过期后继续传要重新过配额', async () => {
    withQuota(SIZE + 100);
    const { admin } = await newFamily(app);
    const { id, uploadId } = await started(admin.token);
    await db.sql`UPDATE media SET reserved_at = now() - interval '7 hours' WHERE id = ${id}`;
    // 预留过期后不算了，别的文件正好占了这部分空间。
    const taken = await call(app, 'POST', '/v1/media/upload-url', {
      token: admin.token,
      body: body(randomUUID(), { mime: 'image/jpeg', size: 200 }),
    });
    expect(taken.status).toBe(200);

    const refused = await partUrls(admin.token, id, uploadId, [1]);
    expect(refused.status).toBe(413);
  });

  it('取分片链接会刷新预留，慢网传很久也不算放弃', async () => {
    const { admin } = await newFamily(app);
    const { id, uploadId } = await started(admin.token);
    await db.sql`UPDATE media SET reserved_at = now() - interval '5 hours' WHERE id = ${id}`;
    expect((await partUrls(admin.token, id, uploadId, [1])).status).toBe(200);
    const [row] = await db.sql<{ fresh: boolean }[]>`
      SELECT reserved_at > now() - interval '1 minute' AS fresh FROM media WHERE id = ${id}`;
    expect(row?.fresh).toBe(true);
  });
});

describe('权限', () => {
  it('viewer 每个接口都被拒绝', async () => {
    const { admin } = await newFamily(app);
    const viewer = await join(app, admin.token, 'viewer', '外公');
    expect((await start(viewer.token)).status).toBe(403);
    const { id, uploadId } = await started(admin.token);
    expect((await parts(viewer.token, id, uploadId)).status).toBe(403);
    expect((await partUrls(viewer.token, id, uploadId, [1])).status).toBe(403);
    expect((await complete(viewer.token, id, uploadId)).status).toBe(403);
    expect((await cancel(viewer.token, id)).status).toBe(403);
    expect((await mediaRow(id))?.status).toBe('pending');
  });

  it('别的家庭碰不到这个文件', async () => {
    const { admin } = await newFamily(app);
    const other = await newFamily(app);
    const { id, uploadId } = await started(admin.token);
    expect((await start(other.admin.token, id)).status).toBe(403);
    expect((await parts(other.admin.token, id, uploadId)).status).toBe(403);
    expect((await partUrls(other.admin.token, id, uploadId, [1])).status).toBe(403);
    expect((await complete(other.admin.token, id, uploadId)).status).toBe(403);
    expect((await cancel(other.admin.token, id)).status).toBe(403);
    expect((await mediaRow(id))?.status).toBe('pending');
  });

  it('caregiver 可以上传，没有家庭的账号不行', async () => {
    const { admin } = await newFamily(app);
    const carer = await join(app, admin.token, 'caregiver', '妈妈');
    expect((await start(carer.token)).status).toBe(200);
    const stranger = await newUser(app);
    expect((await start(stranger.token)).status).toBe(403);
  });
});

describe('取消', () => {
  it('分片和 pending 记录都没了，预留也释放', async () => {
    const { admin, family } = await newFamily(app);
    const { id, uploadId, partSize } = await started(admin.token);
    await putParts(admin.token, id, uploadId, partSize, [1]);
    const key = (await mediaRow(id))?.object_key ?? '';
    expect((await usage(admin.token)).json.pending).toBe(SIZE);

    expect((await cancel(admin.token, id)).status).toBe(200);
    expect(await mediaRow(id)).toBeUndefined();
    expect((await usage(admin.token)).json.pending).toBe(0);
    await bg.flush();
    expect(await uploadGone(await storageFor(family.id), key, uploadId)).toBe(true);
    expect((await parts(admin.token, id, uploadId)).status).toBe(404);
  });

  it('单个 PUT 的 pending 也能取消，已经传上去的对象要删掉', async () => {
    const { admin, family } = await newFamily(app);
    const id = randomUUID();
    const { json } = await call<UploadUrlResponse>(app, 'POST', '/v1/media/upload-url', {
      token: admin.token,
      body: body(id, { mime: 'image/jpeg', size: 16 }),
    });
    await fetch(json.url, { method: 'PUT', headers: json.headers, body: Buffer.alloc(16) });
    const key = (await mediaRow(id))?.object_key ?? '';

    expect((await cancel(admin.token, id)).status).toBe(200);
    await bg.flush();
    expect(await mediaRow(id)).toBeUndefined();
    expect(await headObject(await storageFor(family.id), key)).toBeNull();
  });

  it('已经传好的不碰：那条链路由记录引用决定，撤销还能用', async () => {
    const { admin } = await newFamily(app);
    const id = await upload(app, admin.token);
    expect((await cancel(admin.token, id)).status).toBe(200);
    await bg.flush();
    expect((await mediaRow(id))?.status).toBe('ready');
  });

  it('文件不存在时也算成功：离线取消可能晚到，也可能根本没开始过', async () => {
    const { admin } = await newFamily(app);
    expect((await cancel(admin.token, randomUUID())).status).toBe(200);
  });

  it('中止失败不影响取消，留在队列里下次再试', async () => {
    const { admin, family } = await newFamily(app);
    const { id, uploadId } = await started(admin.token);
    const key = (await mediaRow(id))?.object_key ?? '';
    failures.abort = Object.assign(new Error('虚构的存储错误'), {
      $metadata: { httpStatusCode: 500 },
    });
    expect((await cancel(admin.token, id)).status).toBe(200);
    expect(await mediaRow(id)).toBeUndefined();
    await bg.flush();
    expect(await uploadGone(await storageFor(family.id), key, uploadId)).toBe(false);

    failures.abort = null;
    await db.sql`UPDATE pending_object_deletions SET next_attempt_at = now() WHERE upload_id = ${uploadId}`;
    await runMaintenance(db.sql, db.config);
    expect(await uploadGone(await storageFor(family.id), key, uploadId)).toBe(true);
  });
});

describe('定时清理和账号删除', () => {
  it('放弃的分片上传：中止分片并删掉记录', async () => {
    const { admin, family } = await newFamily(app);
    const { id, uploadId, partSize } = await started(admin.token);
    await putParts(admin.token, id, uploadId, partSize, [1]);
    const key = (await mediaRow(id))?.object_key ?? '';
    await db.sql`UPDATE media SET reserved_at = now() - interval '25 hours' WHERE id = ${id}`;

    const report = await runMaintenance(db.sql, db.config);
    expect(report.pendingRemoved).toBeGreaterThanOrEqual(1);
    expect(report.failed).toBe(0);
    expect(await mediaRow(id)).toBeUndefined();
    expect(await uploadGone(await storageFor(family.id), key, uploadId)).toBe(true);
  });

  it('中止失败不能卡住清理：记录照删，分片转到待删除队列重试', async () => {
    const { admin, family } = await newFamily(app);
    const { id, uploadId } = await started(admin.token);
    const key = (await mediaRow(id))?.object_key ?? '';
    await db.sql`UPDATE media SET reserved_at = now() - interval '25 hours' WHERE id = ${id}`;
    failures.abort = Object.assign(new Error('虚构的存储错误'), {
      $metadata: { httpStatusCode: 500 },
    });

    await runMaintenance(db.sql, db.config);
    expect(await mediaRow(id)).toBeUndefined();
    const [queued] = await db.sql<{ count: string }[]>`
      SELECT count(*) FROM pending_object_deletions WHERE upload_id = ${uploadId}`;
    expect(Number(queued?.count)).toBeGreaterThan(0);

    failures.abort = null;
    await db.sql`UPDATE pending_object_deletions SET next_attempt_at = now() WHERE upload_id = ${uploadId}`;
    await runMaintenance(db.sql, db.config);
    expect(await uploadGone(await storageFor(family.id), key, uploadId)).toBe(true);
  });

  it('账号删除时未完成的分片也要中止', async () => {
    const { admin, family } = await newFamily(app);
    const { id, uploadId, partSize } = await started(admin.token);
    await putParts(admin.token, id, uploadId, partSize, [1]);
    const key = (await mediaRow(id))?.object_key ?? '';
    const storage = await storageFor(family.id);

    const deleted = await call(app, 'POST', '/v1/me/delete', {
      token: admin.token,
      body: { password: 'correct horse' },
    });
    expect(deleted.status).toBe(200);
    await bg.flush();
    expect(await uploadGone(storage, key, uploadId)).toBe(true);
    await db.sql`DELETE FROM pending_object_deletions WHERE upload_id = ${uploadId}`;
  });
});

describe('兼容', () => {
  it('旧版 PUT 不受影响', async () => {
    const { admin } = await newFamily(app);
    const id = await upload(app, admin.token);
    const row = await mediaRow(id);
    expect(row?.status).toBe('ready');
    expect(row?.upload_id).toBeNull();
  });

  it('退回 PUT 时清掉分片状态并中止已有分片，之后走旧的完成接口', async () => {
    const { admin, family } = await newFamily(app);
    const { id, uploadId } = await started(admin.token);
    const key = (await mediaRow(id))?.object_key ?? '';
    const data = Buffer.alloc(32, 3);
    const { json, status } = await call<UploadUrlResponse>(app, 'POST', '/v1/media/upload-url', {
      token: admin.token,
      body: body(id, { size: data.length }),
    });
    expect(status).toBe(200);
    expect((await mediaRow(id))?.upload_id).toBeNull();
    expect(await uploadGone(await storageFor(family.id), key, uploadId)).toBe(true);
    await fetch(json.url, { method: 'PUT', headers: json.headers, body: data });
    const done = await call(app, 'POST', `/v1/media/${id}/complete`, {
      token: admin.token,
      body: { variant: 'original' },
    });
    expect(done.status).toBe(200);
  });

  it('关掉分片上传时返回固定错误码，客户端据此退回 PUT', async () => {
    app = createApp({
      sql: db.sql,
      config: { ...db.config, multipartEnabled: false },
      background: bg.background,
    });
    const { admin } = await newFamily(app);
    const res = await start(admin.token);
    expect(res.status).toBe(501);
    expect((res.json as unknown as { error: { code: string } }).error.code).toBe(
      'multipart_unsupported',
    );
  });

  it('存储不支持分片（返回 4xx 或 501）时同样退回；5xx 是暂时的，可以重试', async () => {
    const { admin } = await newFamily(app);
    failures.create = Object.assign(new Error('NotImplemented'), {
      $metadata: { httpStatusCode: 501 },
    });
    const unsupported = await start(admin.token);
    expect(unsupported.status).toBe(501);

    failures.create = Object.assign(new Error('虚构的存储错误'), {
      $metadata: { httpStatusCode: 503 },
    });
    const transient = await start(admin.token);
    expect(transient.status).toBe(503);
    expect((transient.json as unknown as { error: { code: string } }).error.code).toBe(
      'storage_unavailable',
    );
  });
});

describe('自带存储', () => {
  const localS3 = () => ({
    provider: 'other',
    endpoint: process.env.TEST_S3_ENDPOINT ?? 'http://localhost:59000',
    region: 'us-east-1',
    bucket: 'xiaodouya-dev',
    accessKeyId: 'devaccesskey',
    secretAccessKey: 'devsecretkey',
  });

  it('自带存储能分片上传，不算平台配额', async () => {
    app = createApp({
      sql: db.sql,
      config: {
        ...db.config,
        allowCustomStorage: true,
        allowPrivateEndpoints: true,
        familyQuotaBytes: 1000,
      },
      background: bg.background,
    });
    const { admin } = await newFamily(app);
    const saved = await call(app, 'PUT', '/v1/storage', { token: admin.token, body: localS3() });
    expect(saved.status).toBe(200);
    const { id, uploadId, partSize } = await started(admin.token);
    await putParts(admin.token, id, uploadId, partSize, [1, 2, 3]);
    expect((await complete(admin.token, id, uploadId)).status).toBe(200);
    expect((await mediaRow(id))?.status).toBe('ready');
  });

  it('存储地址变成内网时不连接', async () => {
    const allow = {
      ...db.config,
      allowCustomStorage: true,
      allowPrivateEndpoints: true,
    };
    app = createApp({ sql: db.sql, config: allow, background: bg.background });
    const { admin } = await newFamily(app);
    await call(app, 'PUT', '/v1/storage', { token: admin.token, body: localS3() });
    const { id, uploadId } = await started(admin.token);

    app = createApp({
      sql: db.sql,
      config: { ...allow, allowPrivateEndpoints: false },
      background: bg.background,
    });
    expect((await start(admin.token)).status).toBe(503);
    expect((await parts(admin.token, id, uploadId)).status).toBe(503);
    expect((await complete(admin.token, id, uploadId)).status).toBe(503);
  });
});

describe('cli check-multipart', () => {
  it('在 SeaweedFS 上完整跑通并清理干净', async () => {
    const storage = storageModule.storageFromSnapshot(null, db.config);
    if (!storage) throw new Error('没有配置存储');
    const result = await checkMultipartUpload(storage);
    expect(result.message).toContain('通过');
    expect(result.ok).toBe(true);
  }, 60_000);
});
