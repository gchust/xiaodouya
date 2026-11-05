import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { MediaUrlsResponse } from '@xiaodouya/shared';
import jpeg from 'jpeg-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { jpegDimensions, type ShrinkOptions, shrinkDocumentThumbs } from '../src/documentThumbs';
import {
  deleteObject,
  platformStorage,
  putObjectBytes,
  type ResolvedStorage,
  readObjectBytes,
} from '../src/storage';
import { type App, call, join, newFamily, openTestDb, type TestDb, upload } from './harness';

/**
 * 旧证件缩略图的回填（F-134）：`cli shrink-document-thumbs` 把宽 720 的证件缩略图缩到长边 256。
 * 真实的 Postgres 和 S3 兼容服务，图片都是程序画的渐变和条纹，没有真实内容。
 */

let db: TestDb;
let app: App;
let storage: ResolvedStorage;

beforeAll(async () => {
  db = await openTestDb('shrink_doc_thumbs');
  app = createApp({ sql: db.sql, config: db.config });
  const platform = platformStorage(db.config);
  if (!platform) throw new Error('测试环境没有 S3');
  storage = platform;
});
afterAll(async () => {
  await db.close();
});

const FICTIONAL = 'XIAODOUYA FICTIONAL DOCUMENT';

/** 画一张虚构的“证件”：渐变底色加细条纹，条纹是为了让缩小前后的内容真的不一样。 */
function fakeJpeg(width: number, height: number, quality = 90): Buffer {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const stripe = (x >> 2) % 2 === 0 ? 40 : 0;
      data[i] = (x * 255) / width;
      data[i + 1] = (y * 255) / height;
      data[i + 2] = 160 + stripe;
      data[i + 3] = 255;
    }
  }
  return jpeg.encode({ data, width, height }, quality).data;
}

/** 在 SOI 后面塞一段 EXIF（只有 Orientation 和一段明显虚构的描述），像手机直接写出的 JPEG。 */
function withExif(bytes: Buffer, orientation: number): Buffer {
  const description = Buffer.from(`${FICTIONAL}\0`, 'ascii');
  // TIFF 头（小端）+ 一个 IFD：两项，没有下一个 IFD，描述放在 IFD 后面。
  const ifdStart = 8;
  const entries = 2;
  const valuesAt = ifdStart + 2 + entries * 12 + 4;
  const tiff = Buffer.alloc(valuesAt + description.length);
  tiff.write('II*\0', 0, 'latin1');
  tiff.writeUInt32LE(ifdStart, 4);
  tiff.writeUInt16LE(entries, ifdStart);
  let at = ifdStart + 2;
  tiff.writeUInt16LE(0x010e, at);
  tiff.writeUInt16LE(2, at + 2);
  tiff.writeUInt32LE(description.length, at + 4);
  tiff.writeUInt32LE(valuesAt, at + 8);
  at += 12;
  tiff.writeUInt16LE(0x0112, at);
  tiff.writeUInt16LE(3, at + 2);
  tiff.writeUInt32LE(1, at + 4);
  tiff.writeUInt16LE(orientation, at + 8);
  description.copy(tiff, valuesAt);
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const header = Buffer.from([0xff, 0xe1, 0, 0]);
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([bytes.subarray(0, 2), header, payload, bytes.subarray(2)]);
}

/** SOS 之前的段标记。APP0 是 JFIF，其余 APP 段（EXIF、XMP 等）都可能带元数据。 */
function appMarkers(bytes: Uint8Array): number[] {
  const found: number[] = [];
  let i = 2;
  while (i + 4 <= bytes.length && bytes[i] === 0xff) {
    const marker = bytes[i + 1]!;
    if (marker === 0xda) break;
    if (marker >= 0xe0 && marker <= 0xef) found.push(marker);
    i += 2 + ((bytes[i + 2]! << 8) | bytes[i + 3]!);
  }
  return found;
}

interface MediaRow {
  size: string;
  mime: string;
  object_key: string;
}

const rowOf = async (id: string, variant: string) => {
  const [row] = await db.sql<MediaRow[]>`
    SELECT size, mime, object_key FROM media WHERE id = ${id} AND variant = ${variant}`;
  return row;
};

const bytesOf = async (id: string, variant: string, s: ResolvedStorage = storage) => {
  const row = await rowOf(id, variant);
  if (!row) throw new Error(`没有 ${variant}`);
  const bytes = await readObjectBytes(s, row.object_key, 50 * 1024 * 1024);
  if (bytes === null || bytes === 'tooLarge') throw new Error('读不到对象');
  return Buffer.from(bytes);
};

/** 一张证件照，和旧版 App 传的一样：原图加一张宽 720 的缩略图。 */
const documentPhoto = async (
  token: string,
  thumb: Buffer = fakeJpeg(720, 480),
  original: Buffer = fakeJpeg(1200, 800),
) => {
  const id = await upload(app, token, { scope: 'document' }, original);
  await upload(app, token, { id, scope: 'document', variant: 'thumb' }, thumb);
  return id;
};

const run = (familyId: string, options: ShrinkOptions = {}) =>
  shrinkDocumentThumbs(db.sql, db.config, { customStorage: true, ...options, familyId });

describe('jpegDimensions', () => {
  it('从文件头读出宽高，不是 JPEG 时是 null', () => {
    expect(jpegDimensions(fakeJpeg(720, 480))).toEqual({ width: 720, height: 480 });
    expect(jpegDimensions(withExif(fakeJpeg(30, 20), 1))).toEqual({ width: 30, height: 20 });
    expect(jpegDimensions(Buffer.from('%PDF-1.4 fictional'))).toBeNull();
  });
});

describe('cli shrink-document-thumbs', () => {
  it('把 720 的证件缩略图缩到长边 256，写回同一个对象，记录的大小跟着改，原图不动', async () => {
    const { admin, family } = await newFamily(app);
    const original = fakeJpeg(1200, 800);
    const landscape = await documentPhoto(admin.token, fakeJpeg(720, 480), original);
    const portrait = await documentPhoto(admin.token, fakeJpeg(720, 960));
    const keyBefore = (await rowOf(landscape, 'thumb'))!.object_key;
    const sizeBefore = Number((await rowOf(landscape, 'thumb'))!.size);

    const report = await run(family.id);
    expect(report).toMatchObject({ dryRun: false, examined: 2, shrunk: 2, failed: 0 });

    const thumb = await bytesOf(landscape, 'thumb');
    expect(jpegDimensions(thumb)).toEqual({ width: 256, height: 171 });
    expect(jpegDimensions(await bytesOf(portrait, 'thumb'))).toEqual({ width: 192, height: 256 });
    const row = await rowOf(landscape, 'thumb');
    expect(row).toEqual({ size: String(thumb.length), mime: 'image/jpeg', object_key: keyBefore });
    expect(thumb.length).toBeLessThan(sizeBefore);
    expect(report.bytesAfter).toBeLessThan(report.bytesBefore);
    expect((await bytesOf(landscape, 'original')).equals(original)).toBe(true);
  });

  it('去掉缩略图里的 EXIF；方向不是 1 的不缩（像素没转正，缩了会倒过来）', async () => {
    const { admin, family } = await newFamily(app);
    const plain = await documentPhoto(admin.token, withExif(fakeJpeg(720, 480), 1));
    const rotated = withExif(fakeJpeg(720, 480), 6);
    const sideways = await documentPhoto(admin.token, rotated);

    const report = await run(family.id);
    expect(report).toMatchObject({ examined: 2, shrunk: 1, unsupported: 1, failed: 0 });
    const thumb = await bytesOf(plain, 'thumb');
    expect(appMarkers(thumb).filter((m) => m !== 0xe0)).toEqual([]);
    expect(thumb.includes(FICTIONAL)).toBe(false);
    expect((await bytesOf(sideways, 'thumb')).equals(rotated)).toBe(true);
  });

  it('已经不超过 256 的跳过，一个字节都不改；再跑一次什么都不做', async () => {
    const { admin, family } = await newFamily(app);
    const small = fakeJpeg(256, 180);
    const tiny = fakeJpeg(64, 64);
    const a = await documentPhoto(admin.token, small);
    const b = await documentPhoto(admin.token, tiny);
    const c = await documentPhoto(admin.token, fakeJpeg(720, 480));

    expect(await run(family.id)).toMatchObject({ examined: 3, shrunk: 1, alreadySmall: 2 });
    expect((await bytesOf(a, 'thumb')).equals(small)).toBe(true);
    expect((await bytesOf(b, 'thumb')).equals(tiny)).toBe(true);
    const once = await bytesOf(c, 'thumb');

    expect(await run(family.id)).toMatchObject({
      examined: 3,
      shrunk: 0,
      alreadySmall: 3,
      repaired: 0,
    });
    expect((await bytesOf(c, 'thumb')).equals(once)).toBe(true);
  });

  it('只有 PDF 的证件：不做缩略图，原件不动', async () => {
    const { admin, family } = await newFamily(app);
    const pdf = Buffer.from('%PDF-1.4\n% fictional document\n%%EOF\n');
    const id = await upload(app, admin.token, { scope: 'document', mime: 'application/pdf' }, pdf);

    expect(await run(family.id)).toMatchObject({ examined: 0, shrunk: 0 });
    expect(await rowOf(id, 'thumb')).toBeUndefined();
    expect((await bytesOf(id, 'original')).equals(pdf)).toBe(true);
  });

  it('回忆和头像的缩略图不动', async () => {
    const { admin, family } = await newFamily(app);
    const memoryThumb = fakeJpeg(720, 480);
    const avatarThumb = fakeJpeg(720, 720);
    const memory = await upload(app, admin.token, { scope: 'memory' }, fakeJpeg(1200, 800));
    await upload(app, admin.token, { id: memory, variant: 'thumb' }, memoryThumb);
    const avatar = await upload(app, admin.token, { scope: 'avatar' }, fakeJpeg(800, 800));
    await upload(app, admin.token, { id: avatar, scope: 'avatar', variant: 'thumb' }, avatarThumb);

    expect(await run(family.id)).toMatchObject({ examined: 0, shrunk: 0 });
    expect((await bytesOf(memory, 'thumb')).equals(memoryThumb)).toBe(true);
    expect((await bytesOf(avatar, 'thumb')).equals(avatarThumb)).toBe(true);
    expect(await rowOf(memory, 'thumb')).toMatchObject({ size: String(memoryThumb.length) });
  });

  it('--dry-run 只统计，不写存储也不改记录', async () => {
    const { admin, family } = await newFamily(app);
    const thumb = fakeJpeg(720, 480);
    const id = await documentPhoto(admin.token, thumb);

    const report = await run(family.id, { dryRun: true });
    expect(report).toMatchObject({ dryRun: true, examined: 1, shrunk: 1, failed: 0 });
    expect(report.bytesBefore).toBe(thumb.length);
    expect(report.bytesAfter).toBeGreaterThan(0);
    expect((await bytesOf(id, 'thumb')).equals(thumb)).toBe(true);
    expect(await rowOf(id, 'thumb')).toMatchObject({ size: String(thumb.length) });
  });

  it('--limit 分几次跑，和一次跑完的结果一样', async () => {
    const source = [fakeJpeg(720, 480), fakeJpeg(720, 960), fakeJpeg(720, 540)];
    const once = await newFamily(app);
    const onceIds: string[] = [];
    for (const thumb of source) onceIds.push(await documentPhoto(once.admin.token, thumb));
    expect(await run(once.family.id)).toMatchObject({ shrunk: 3 });

    const staged = await newFamily(app);
    const stagedIds: string[] = [];
    for (const thumb of source) stagedIds.push(await documentPhoto(staged.admin.token, thumb));
    expect(await run(staged.family.id, { limit: 1 })).toMatchObject({ shrunk: 1 });
    expect(await run(staged.family.id, { limit: 1 })).toMatchObject({ shrunk: 1, alreadySmall: 1 });
    expect(await run(staged.family.id)).toMatchObject({ shrunk: 1, alreadySmall: 2 });

    for (const [index, id] of stagedIds.entries()) {
      const expected = await bytesOf(onceIds[index]!, 'thumb');
      expect((await bytesOf(id, 'thumb')).equals(expected)).toBe(true);
      expect(await rowOf(id, 'thumb')).toMatchObject({ size: String(expected.length) });
    }
  });

  it('上次写完对象、没来得及改记录就断了：重跑时补上记录的大小，不再缩一次', async () => {
    const reference = await newFamily(app);
    const refId = await documentPhoto(reference.admin.token);
    await run(reference.family.id);
    const shrunk = await bytesOf(refId, 'thumb');

    const { admin, family } = await newFamily(app);
    const id = await documentPhoto(admin.token);
    const before = await rowOf(id, 'thumb');
    // 模拟中断：对象已经是新的，media 行还是旧的大小。
    await putObjectBytes(storage, before!.object_key, shrunk, 'image/jpeg');

    expect(await run(family.id, { dryRun: true })).toMatchObject({ repaired: 1, shrunk: 0 });
    expect(await rowOf(id, 'thumb')).toEqual(before);
    expect(await run(family.id)).toMatchObject({ repaired: 1, shrunk: 0, failed: 0 });
    expect(await rowOf(id, 'thumb')).toMatchObject({ size: String(shrunk.length) });
    expect((await bytesOf(id, 'thumb')).equals(shrunk)).toBe(true);
    expect(await run(family.id)).toMatchObject({ repaired: 0, alreadySmall: 1 });
  });

  it('一张出问题不挡别的：对象不见了、不是 JPEG 的计数跳过，其余照常缩小', async () => {
    const { admin, family } = await newFamily(app);
    const gone = await documentPhoto(admin.token);
    await deleteObject(storage, (await rowOf(gone, 'thumb'))!.object_key);
    const notJpeg = Buffer.from('xiaodouya-fictional-not-a-jpeg');
    const odd = await documentPhoto(admin.token, notJpeg);
    const fine = await documentPhoto(admin.token);

    const report = await run(family.id);
    expect(report).toMatchObject({ examined: 3, missing: 1, unsupported: 1, shrunk: 1 });
    expect(report.failed).toBe(0);
    expect((await bytesOf(odd, 'thumb')).equals(notJpeg)).toBe(true);
    expect(jpegDimensions(await bytesOf(fine, 'thumb'))).toEqual({ width: 256, height: 171 });
    expect(await rowOf(gone, 'thumb')).toBeDefined();
  });

  it('家庭自带的存储：没有 APP_SECRET 时跳过并计数，有了才缩；连不上的算失败', async () => {
    const { admin, family } = await newFamily(app);
    const saved = await call(app, 'PUT', '/v1/storage', {
      token: admin.token,
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
    const thumb = fakeJpeg(720, 480);
    const id = await documentPhoto(admin.token, thumb);
    const [row] = await db.sql<{ storage_config_id: string | null }[]>`
      SELECT storage_config_id FROM media WHERE id = ${id} AND variant = 'thumb'`;
    expect(row?.storage_config_id).not.toBeNull();

    const waiting = await run(family.id, { customStorage: false });
    expect(waiting).toMatchObject({ examined: 0, waitingForSecret: 1, shrunk: 0, failed: 0 });
    expect((await bytesOf(id, 'thumb')).equals(thumb)).toBe(true);

    const done = await run(family.id, { customStorage: true });
    expect(done).toMatchObject({ examined: 1, waitingForSecret: 0, shrunk: 1, failed: 0 });
    expect(jpegDimensions(await bytesOf(id, 'thumb'))).toEqual({ width: 256, height: 171 });

    // 对方的存储连不上：算失败（退出码非 0），记录和对象都不动。
    const other = await documentPhoto(admin.token, thumb);
    await db.sql`UPDATE storage_configs SET endpoint = 'http://127.0.0.1:9' WHERE family_id = ${family.id}`;
    const broken = await run(family.id, { customStorage: true });
    expect(broken.failed).toBe(2);
    expect(Object.keys(broken.failures).join()).not.toMatch(/127\.0\.0\.1|families\//);
    await db.sql`UPDATE storage_configs SET endpoint = ${process.env.TEST_S3_ENDPOINT ?? 'http://localhost:59000'} WHERE family_id = ${family.id}`;
    expect(await rowOf(other, 'thumb')).toMatchObject({ size: String(thumb.length) });
    expect(await run(family.id)).toMatchObject({ shrunk: 1, alreadySmall: 1, failed: 0 });
  });

  it('自带存储写的时候不回应：超时算失败，放开家庭锁，记录不动', async () => {
    const s3 = new URL(process.env.TEST_S3_ENDPOINT ?? 'http://localhost:59000');
    // 读照常转给 SeaweedFS（原样带着 Host 头，签名对得上），写就一直挂着不回。
    const hung: Server = createServer((incoming, outgoing) => {
      if (incoming.method === 'PUT') return;
      const forward = request(
        {
          host: s3.hostname,
          port: s3.port,
          method: incoming.method,
          path: incoming.url,
          headers: incoming.headers,
        },
        (answer) => {
          outgoing.writeHead(answer.statusCode ?? 502, answer.headers);
          answer.pipe(outgoing);
        },
      );
      incoming.pipe(forward);
    });
    await new Promise<void>((resolve) => hung.listen(0, '127.0.0.1', resolve));
    try {
      const { admin, family } = await newFamily(app);
      const saved = await call(app, 'PUT', '/v1/storage', {
        token: admin.token,
        body: {
          provider: 'other',
          endpoint: s3.origin,
          region: 'us-east-1',
          bucket: 'xiaodouya-dev',
          accessKeyId: 'devaccesskey',
          secretAccessKey: 'devsecretkey',
        },
      });
      expect(saved.status).toBe(200);
      const thumb = fakeJpeg(720, 480);
      const id = await documentPhoto(admin.token, thumb);
      const { port } = hung.address() as AddressInfo;
      await db.sql`UPDATE storage_configs SET endpoint = ${`http://127.0.0.1:${port}`}
        WHERE family_id = ${family.id}`;

      const started = Date.now();
      const report = await run(family.id, { objectTimeoutMs: 1_000 });
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(report).toMatchObject({ examined: 1, shrunk: 0, failed: 1 });
      expect(report.failures).toEqual({ 存储长时间没有响应: 1 });
      expect(await rowOf(id, 'thumb')).toMatchObject({ size: String(thumb.length) });
      // 锁已经放开：同步要的那把锁马上拿得到。
      const [locked] = await db.sql<{ ok: number }[]>`
        SELECT 1 AS ok FROM families WHERE id = ${family.id} FOR UPDATE NOWAIT`;
      expect(locked?.ok).toBe(1);
    } finally {
      hung.closeAllConnections();
      await new Promise<void>((resolve) => hung.close(() => resolve()));
    }
  });

  it('缩完以后权限不变：家人拿到的是 256 的那份，只看回忆的家人仍然拿不到', async () => {
    const { admin, family } = await newFamily(app);
    const mom = await join(app, admin.token, 'caregiver', '妈妈');
    const grandpa = await join(app, admin.token, 'viewer', '外公');
    const id = await documentPhoto(admin.token);
    await run(family.id);
    const stored = await bytesOf(id, 'thumb');
    expect(jpegDimensions(stored)).toEqual({ width: 256, height: 171 });

    const urlOf = async (token: string, variant: 'thumb' | 'original') => {
      const { json } = await call<MediaUrlsResponse>(app, 'POST', '/v1/media/urls', {
        token,
        body: { items: [{ id, variant }] },
      });
      return json.urls[0]!;
    };
    for (const token of [admin.token, mom.token]) {
      const entry = await urlOf(token, 'thumb');
      expect(entry.expiresIn).toBeLessThanOrEqual(600);
      const fetched = Buffer.from(await (await fetch(entry.url!)).arrayBuffer());
      expect(fetched.equals(stored)).toBe(true);
    }
    expect((await urlOf(grandpa.token, 'thumb')).url).toBeNull();
    expect((await urlOf(grandpa.token, 'original')).url).toBeNull();
  });
});
