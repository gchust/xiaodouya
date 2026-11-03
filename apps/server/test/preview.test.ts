import { randomUUID } from 'node:crypto';
import type {
  MediaUrlsResponse,
  PublicShareResponse,
  StorageUsage,
  UploadUrlResponse,
} from '@xiaodouya/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { migrate, migrations } from '../src/db';
import { runMaintenance } from '../src/maintenance';
import { activeStorage, headObject } from '../src/storage';
import {
  type App,
  backgroundTasks,
  call,
  join,
  newFamily,
  OBJECT_BYTES,
  openTestDb,
  PASSWORD,
  type TestDb,
  upload,
} from './harness';

/** 照片预览（F-107）。真实的 Postgres 和 S3 兼容服务，所有内容都是虚构的。 */

let db: TestDb;
let app: App;
let bg: ReturnType<typeof backgroundTasks>;

const HOUR = 3_600_000;
const FROM = Date.UTC(2026, 5, 14, 16);
const TO = FROM + 24 * HOUR;
const units = { volume: 'ml', temperature: 'c', weight: 'kg', length: 'cm' };

beforeAll(async () => {
  db = await openTestDb('preview');
  bg = backgroundTasks();
  app = createApp({ sql: db.sql, config: db.config, background: bg.background });
});
afterAll(async () => {
  await db.close();
});

const urlOf = async (token: string, id: string, variant: string) => {
  const { json, status } = await call<MediaUrlsResponse>(app, 'POST', '/v1/media/urls', {
    token,
    body: { items: [{ id, variant }] },
  });
  expect(status).toBe(200);
  return json.urls[0]!;
};

const ref = (id: string, kind = 'image', mime = 'image/jpeg') => ({
  id,
  kind,
  mime,
  size: OBJECT_BYTES.length,
});

const writeMoment = async (
  token: string,
  media: unknown[],
  at = FROM + HOUR,
  id = randomUUID(),
) => {
  const { status } = await call(app, 'POST', '/v1/sync', {
    token,
    body: {
      cursor: 0,
      changes: [
        {
          id,
          collection: 'moment',
          data: { title: '虚构回忆', text: '', at, milestone: false, media },
          deleted: false,
          updatedAt: Date.now(),
        },
      ],
    },
  });
  expect(status).toBe(200);
  return id;
};

const deleteMoment = async (token: string, id: string, media: unknown[]) => {
  const { status } = await call(app, 'POST', '/v1/sync', {
    token,
    body: {
      cursor: 0,
      changes: [
        {
          id,
          collection: 'moment',
          data: { title: '虚构回忆', text: '', at: FROM + HOUR, milestone: false, media },
          deleted: true,
          updatedAt: Date.now() + 1000,
        },
      ],
    },
  });
  expect(status).toBe(200);
};

const openShare = async (token: string) => {
  const created = await call<{ token: string }>(app, 'POST', '/v1/shares', {
    token,
    body: {
      fromAt: FROM,
      toAt: TO,
      timezone: 'Asia/Singapore',
      units,
    },
  });
  expect(created.status).toBe(201);
  const opened = await call<PublicShareResponse>(app, 'POST', '/v1/public/share', {
    body: { token: created.json.token },
  });
  expect(opened.status).toBe(200);
  return opened;
};

const mediaRows = (id: string) =>
  db.sql<{ variant: string; status: string; object_key: string }[]>`
    SELECT variant, status, object_key FROM media WHERE id = ${id} ORDER BY variant`;

describe('申请、完成和取链接', () => {
  it('预览能申请、完成、取到内容一样的链接', async () => {
    const { admin } = await newFamily(app);
    const id = await upload(app, admin.token, { variant: 'preview' });
    expect(await mediaRows(id)).toMatchObject([{ variant: 'preview', status: 'ready' }]);
    const { url, variant } = await urlOf(admin.token, id, 'preview');
    expect(variant).toBe('preview');
    const response = await fetch(url!);
    expect(Buffer.from(await response.arrayBuffer()).equals(OBJECT_BYTES)).toBe(true);
  });

  it('预览传好、原图没传完时，能取预览，原图的链接是空的', async () => {
    const { admin } = await newFamily(app);
    const id = await upload(app, admin.token, { variant: 'thumb' });
    await upload(app, admin.token, { id, variant: 'preview' });
    const started = await call(app, 'POST', '/v1/media/upload-url', {
      token: admin.token,
      body: { id, scope: 'memory', variant: 'original', mime: 'image/jpeg', size: 10 },
    });
    expect(started.status).toBe(200);
    expect((await urlOf(admin.token, id, 'preview')).url).toContain('X-Amz-Signature');
    expect((await urlOf(admin.token, id, 'original')).url).toBeNull();
  });

  it('没有预览的旧照片取预览是空的，不报错', async () => {
    const { admin } = await newFamily(app);
    const id = await upload(app, admin.token);
    expect((await urlOf(admin.token, id, 'preview')).url).toBeNull();
    expect((await urlOf(admin.token, id, 'original')).url).toContain('X-Amz-Signature');
  });

  it('预览只能是图片：视频不走这个变体，也不能拿它在分享页替换原文件', async () => {
    const { admin } = await newFamily(app);
    const refused = await call<{ error: { code: string } }>(app, 'POST', '/v1/media/upload-url', {
      token: admin.token,
      body: {
        id: randomUUID(),
        scope: 'memory',
        variant: 'preview',
        mime: 'video/mp4',
        size: 10,
      },
    });
    expect(refused.status).toBe(400);
    expect(refused.json.error.code).toBe('bad_type');
  });

  it('数据库约束放开了 preview，别的值还是进不去', async () => {
    const { family } = await newFamily(app);
    await expect(
      db.sql`INSERT INTO media (id, variant, family_id, scope, mime, size, object_key)
             VALUES (${randomUUID()}, 'bogus', ${family.id}, 'memory', 'image/jpeg', 1, 'k')`,
    ).rejects.toThrow(/media_variant_check/);
  });

  it('迁移追加在末尾，重复执行没有副作用', async () => {
    // 预览的迁移排在分片之后；之后的功能（比如反馈）还会继续往后追加。
    const preview = migrations.findIndex((m) => m.includes("'preview'"));
    expect(preview).toBeGreaterThan(migrations.findIndex((m) => m.includes('upload_part_size')));
    await migrate(db.sql);
  });
});

describe('权限和原图一样按 scope', () => {
  it('只看回忆的家人能读回忆的预览，读不到证件的预览，也不能上传', async () => {
    const { admin } = await newFamily(app);
    const grandma = await join(app, admin.token, 'viewer', '奶奶');
    const memory = await upload(app, admin.token, { variant: 'preview' });
    const document = await upload(app, admin.token, { variant: 'preview', scope: 'document' });
    expect((await urlOf(grandma.token, memory, 'preview')).url).toContain('X-Amz-Signature');
    expect((await urlOf(grandma.token, document, 'preview')).url).toBeNull();
    const refused = await call(app, 'POST', '/v1/media/upload-url', {
      token: grandma.token,
      body: {
        id: randomUUID(),
        scope: 'memory',
        variant: 'preview',
        mime: 'image/jpeg',
        size: 10,
      },
    });
    expect(refused.status).toBe(403);
  });

  it('别的家庭读不到', async () => {
    const { admin } = await newFamily(app);
    const other = await newFamily(app);
    const id = await upload(app, admin.token, { variant: 'preview' });
    expect((await urlOf(other.admin.token, id, 'preview')).url).toBeNull();
  });
});

describe('配额和清理', () => {
  it('预览算进配额：用量里有它，放不下时单独报配额错误', async () => {
    const { admin, family } = await newFamily(app);
    const usage = async () =>
      (await call<StorageUsage>(app, 'GET', '/v1/storage/usage', { token: admin.token })).json;
    const before = (await usage()).total;
    await upload(app, admin.token, { variant: 'preview' });
    expect((await usage()).total).toBe(before + OBJECT_BYTES.length);

    await db.sql`UPDATE families SET quota_mb = 1 WHERE id = ${family.id}`;
    const over = await call<{ error: { code: string } }>(app, 'POST', '/v1/media/upload-url', {
      token: admin.token,
      body: {
        id: randomUUID(),
        scope: 'memory',
        variant: 'preview',
        mime: 'image/jpeg',
        size: 2 * 1024 * 1024,
      },
    });
    expect(over.status).toBe(413);
    expect(over.json.error.code).toBe('quota_exceeded');
  });

  it('取消：没传完的预览连对象一起清掉，传好的变体不动', async () => {
    const { admin, family } = await newFamily(app);
    const id = await upload(app, admin.token, { variant: 'thumb' });
    const { json } = await call<UploadUrlResponse>(app, 'POST', '/v1/media/upload-url', {
      token: admin.token,
      body: { id, scope: 'memory', variant: 'preview', mime: 'image/jpeg', size: 16 },
    });
    await fetch(json.url, { method: 'PUT', headers: json.headers, body: Buffer.alloc(16) });
    const key = `families/${family.id}/memory/${id}/preview`;
    const storage = await activeStorage(db.sql, db.config, family.id);
    expect(await headObject(storage!, key)).not.toBeNull();

    const cancelled = await call(app, 'POST', `/v1/media/${id}/cancel`, { token: admin.token });
    expect(cancelled.status).toBe(200);
    await bg.flush();
    expect(await mediaRows(id)).toMatchObject([{ variant: 'thumb', status: 'ready' }]);
    expect(await headObject(storage!, key)).toBeNull();
  });

  it('放弃的预览上传：过期后对象和记录都清掉', async () => {
    const { admin, family } = await newFamily(app);
    const id = randomUUID();
    const { json } = await call<UploadUrlResponse>(app, 'POST', '/v1/media/upload-url', {
      token: admin.token,
      body: { id, scope: 'memory', variant: 'preview', mime: 'image/jpeg', size: 16 },
    });
    await fetch(json.url, { method: 'PUT', headers: json.headers, body: Buffer.alloc(16) });
    await db.sql`UPDATE media SET reserved_at = now() - interval '25 hours' WHERE id = ${id}`;
    const report = await runMaintenance(db.sql, db.config);
    expect(report.pendingRemoved).toBeGreaterThanOrEqual(1);
    expect(await mediaRows(id)).toEqual([]);
    const storage = await activeStorage(db.sql, db.config, family.id);
    expect(await headObject(storage!, `families/${family.id}/memory/${id}/preview`)).toBeNull();
  });

  it('删除回忆：过了宽限期三个变体一起清掉', async () => {
    const { admin, family } = await newFamily(app);
    const id = await upload(app, admin.token);
    await upload(app, admin.token, { id, variant: 'thumb' });
    await upload(app, admin.token, { id, variant: 'preview' });
    const moment = await writeMoment(admin.token, [ref(id)]);
    await deleteMoment(admin.token, moment, [ref(id)]);
    const marked = await db.sql<{ variant: string }[]>`
      SELECT variant FROM media WHERE id = ${id} AND unreferenced_at IS NOT NULL ORDER BY variant`;
    expect(marked.map((r) => r.variant)).toEqual(['original', 'preview', 'thumb']);

    await db.sql`UPDATE media SET unreferenced_at = now() - interval '1 day' * ${
      db.config.mediaTrashDays + 1
    } WHERE id = ${id}`;
    const report = await runMaintenance(db.sql, db.config);
    expect(report.trashPurged).toBeGreaterThanOrEqual(3);
    expect(await mediaRows(id)).toEqual([]);
    const storage = await activeStorage(db.sql, db.config, family.id);
    for (const variant of ['original', 'thumb', 'preview']) {
      expect(
        await headObject(storage!, `families/${family.id}/memory/${id}/${variant}`),
      ).toBeNull();
    }
  });

  it('删除账号：预览的对象和别的变体一起删', async () => {
    const { admin, family } = await newFamily(app);
    const id = await upload(app, admin.token);
    await upload(app, admin.token, { id, variant: 'preview' });
    const storage = await activeStorage(db.sql, db.config, family.id);
    const key = `families/${family.id}/memory/${id}/preview`;
    expect(await headObject(storage!, key)).not.toBeNull();

    const deleted = await call(app, 'POST', '/v1/me/delete', {
      token: admin.token,
      body: { password: PASSWORD },
    });
    expect(deleted.status).toBe(200);
    await bg.flush();
    expect(await mediaRows(id)).toEqual([]);
    expect(await headObject(storage!, key)).toBeNull();
  });
});

describe('分享页', () => {
  const fullPhoto = async (token: string) => {
    const id = await upload(app, token);
    await upload(app, token, { id, variant: 'thumb' });
    await upload(app, token, { id, variant: 'preview' });
    return id;
  };

  it('有预览的照片给预览，原图的链接不出现在响应里', async () => {
    const { admin, family } = await newFamily(app);
    const id = await fullPhoto(admin.token);
    await writeMoment(admin.token, [ref(id)]);
    const { json, text } = await openShare(admin.token);
    const media = json.moments[0]!.media[0]!;
    expect(media.kind).toBe('image');
    expect(new URL(media.url!).pathname).toContain(`${family.id}/memory/${id}/preview`);
    expect(new URL(media.thumbUrl!).pathname).toContain(`${id}/thumb`);
    expect(text).not.toContain(`${id}/original`);
    const download = await fetch(media.url!);
    expect(Buffer.from(await download.arrayBuffer()).equals(OBJECT_BYTES)).toBe(true);
  });

  it('没有预览的旧照片回退原图', async () => {
    const { admin } = await newFamily(app);
    const id = await upload(app, admin.token);
    await upload(app, admin.token, { id, variant: 'thumb' });
    await writeMoment(admin.token, [ref(id)]);
    const { json } = await openShare(admin.token);
    expect(new URL(json.moments[0]!.media[0]!.url!).pathname).toContain(`${id}/original`);
  });

  it('预览传好、原图没传完时也能看，类型是照片', async () => {
    const { admin } = await newFamily(app);
    const id = await upload(app, admin.token, { variant: 'thumb' });
    await upload(app, admin.token, { id, variant: 'preview' });
    await writeMoment(admin.token, [ref(id)]);
    const { json } = await openShare(admin.token);
    const media = json.moments[0]!.media[0]!;
    expect(media.kind).toBe('image');
    expect(new URL(media.url!).pathname).toContain(`${id}/preview`);
  });

  it('视频不变：给原文件。写了预览行也一样', async () => {
    const { admin, family } = await newFamily(app);
    const video = await upload(app, admin.token, { mime: 'video/mp4' });
    await upload(app, admin.token, { id: video, variant: 'thumb' });
    await db.sql`INSERT INTO media (id, variant, family_id, scope, mime, size, object_key, status)
      VALUES (${video}, 'preview', ${family.id}, 'memory', 'image/jpeg', 1, ${`families/${family.id}/memory/${video}/preview`}, 'ready')`;
    await writeMoment(admin.token, [ref(video, 'video', 'video/mp4')]);
    const { json } = await openShare(admin.token);
    const media = json.moments[0]!.media[0]!;
    expect(media.kind).toBe('video');
    expect(new URL(media.url!).pathname).toContain(`${video}/original`);
  });

  it('不暴露多余字段，文件数也不多算', async () => {
    const { admin } = await newFamily(app);
    const id = await fullPhoto(admin.token);
    await writeMoment(admin.token, [ref(id)]);
    const { json, text } = await openShare(admin.token);
    expect(Object.keys(json.moments[0]!.media[0]!).sort()).toEqual([
      'id',
      'kind',
      'thumbUrl',
      'url',
    ]);
    expect(json.omittedMedia).toBe(0);
    // 只签要发出去的两条。
    expect(text.match(/X-Amz-Signature/g)?.length).toBe(2);
  });
});
