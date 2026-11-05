import { randomUUID } from 'node:crypto';
import type { MediaUrlsResponse, PublicShareResponse } from '@xiaodouya/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import {
  type App,
  call,
  join,
  newFamily,
  OBJECT_BYTES,
  openTestDb,
  type TestDb,
  upload,
} from './harness';

/**
 * 证件的缩略图（F-131）：资料页的卡片显示它，权限和链接有效期必须和证件原件一样。
 * 真实的 Postgres 和 S3 兼容服务，所有内容都是虚构的。
 */

let db: TestDb;
let app: App;

beforeAll(async () => {
  db = await openTestDb('document_thumb');
  app = createApp({ sql: db.sql, config: db.config });
});
afterAll(async () => {
  await db.close();
});

const urlOf = async (token: string, id: string, variant: 'thumb' | 'original') => {
  const { json, status } = await call<MediaUrlsResponse>(app, 'POST', '/v1/media/urls', {
    token,
    body: { items: [{ id, variant }] },
  });
  expect(status).toBe(200);
  return json.urls[0]!;
};

/** 一张证件照：原件和缩略图，和 App 上传的一样。 */
const documentPhoto = async (token: string) => {
  const id = await upload(app, token, { scope: 'document' });
  await upload(app, token, { id, scope: 'document', variant: 'thumb' });
  return id;
};

const expectShortSigned = (entry: MediaUrlsResponse['urls'][number]) => {
  expect(entry.url).toContain('X-Amz-Signature');
  expect(entry.expiresIn).toBeGreaterThan(0);
  expect(entry.expiresIn).toBeLessThanOrEqual(600);
  expect(Number(new URL(entry.url!).searchParams.get('X-Amz-Expires'))).toBeLessThanOrEqual(600);
};

describe('证件缩略图的链接', () => {
  it('管理员和一起记录的家人拿到 10 分钟以内的签名链接，内容就是传上去的那份', async () => {
    const { admin } = await newFamily(app);
    const mom = await join(app, admin.token, 'caregiver', '妈妈');
    const id = await documentPhoto(admin.token);
    for (const token of [admin.token, mom.token]) {
      const entry = await urlOf(token, id, 'thumb');
      expectShortSigned(entry);
      const response = await fetch(entry.url!);
      expect(Buffer.from(await response.arrayBuffer()).equals(OBJECT_BYTES)).toBe(true);
    }
  });

  it('只看回忆的家人拿不到证件的缩略图，也拿不到原件', async () => {
    const { admin } = await newFamily(app);
    const grandpa = await join(app, admin.token, 'viewer', '外公');
    const id = await documentPhoto(admin.token);
    expect(await urlOf(grandpa.token, id, 'thumb')).toEqual({
      id,
      variant: 'thumb',
      url: null,
      expiresIn: 0,
    });
    expect((await urlOf(grandpa.token, id, 'original')).url).toBeNull();
  });

  it('别的家庭拿不到', async () => {
    const { admin } = await newFamily(app);
    const other = await newFamily(app);
    const id = await documentPhoto(admin.token);
    expect((await urlOf(other.admin.token, id, 'thumb')).url).toBeNull();
  });

  it('自带存储配了公开 CDN 时，证件缩略图也不走公开地址', async () => {
    const { admin } = await newFamily(app);
    const saved = await call(app, 'PUT', '/v1/storage', {
      token: admin.token,
      body: {
        provider: 'other',
        endpoint: process.env.TEST_S3_ENDPOINT ?? 'http://localhost:59000',
        region: 'us-east-1',
        bucket: 'xiaodouya-dev',
        accessKeyId: 'devaccesskey',
        secretAccessKey: 'devsecretkey',
        publicBaseUrl: 'https://cdn.fictional.test',
      },
    });
    expect(saved.status).toBe(200);
    const id = await documentPhoto(admin.token);
    const entry = await urlOf(admin.token, id, 'thumb');
    expect(entry.url).not.toContain('cdn.fictional.test');
    expectShortSigned(entry);
  });

  it('回忆里写上证件缩略图的 id，分享页也带不出去', async () => {
    const { admin, family } = await newFamily(app);
    const id = await documentPhoto(admin.token);
    const at = Date.UTC(2026, 5, 15, 2);
    const synced = await call(app, 'POST', '/v1/sync', {
      token: admin.token,
      body: {
        cursor: 0,
        changes: [
          {
            id: family.id,
            collection: 'baby',
            data: { name: '测试豆', birthAt: Date.UTC(2026, 5, 1) },
            deleted: false,
            updatedAt: Date.now(),
          },
          {
            id: randomUUID(),
            collection: 'moment',
            data: {
              title: '虚构回忆',
              text: '',
              at,
              milestone: false,
              media: [{ id, kind: 'image', mime: 'image/jpeg', size: 1, hasThumb: true }],
            },
            deleted: false,
            updatedAt: Date.now(),
          },
        ],
      },
    });
    expect(synced.status).toBe(200);
    const created = await call<{ token: string }>(app, 'POST', '/v1/shares', {
      token: admin.token,
      body: {
        fromAt: at - 3_600_000,
        toAt: at + 3_600_000,
        timezone: 'Asia/Singapore',
        units: { volume: 'ml', temperature: 'c', weight: 'kg', length: 'cm' },
      },
    });
    expect(created.status).toBe(201);
    const opened = await call<PublicShareResponse>(app, 'POST', '/v1/public/share', {
      body: { token: created.json.token },
    });
    expect(opened.status).toBe(200);
    expect(opened.text).not.toContain(id);
    expect(opened.json.moments.flatMap((m) => m.media)).toEqual([]);
  });
});
