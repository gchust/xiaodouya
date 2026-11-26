import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { type ServerType, serve } from '@hono/node-server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Deps, handle, ORPHAN_DELAY_MS, parseRange, slicePieces } from '../src/s3';
import { fixedLength, fsBlobs, sqliteDb } from './support';

const credentials = { accessKeyId: 'proxy-key', secretAccessKey: 'proxy-secret' };
const upstreamCredentials = { accessKeyId: 'upstream-key', secretAccessKey: 'upstream-secret' };
const MiB = 1024 * 1024;

interface Running {
  url: string;
  deps: Deps;
  blobs: ReturnType<typeof fsBlobs>;
  db: ReturnType<typeof sqliteDb>;
  server: ServerType;
  clock: { offset: number };
}

const dirs: string[] = [];

async function start(options: {
  drivePrefix: string;
  bucket: string;
  creds: typeof credentials;
  upstream?: Running;
}): Promise<Running> {
  const dir = mkdtempSync(join(tmpdir(), 'drive-proxy-'));
  dirs.push(dir);
  const blobs = fsBlobs(dir);
  const db = sqliteDb();
  const clock = { offset: 0 };
  const deps: Deps = {
    config: {
      bucket: options.bucket,
      credentials: options.creds,
      drivePrefix: options.drivePrefix,
      upstream: options.upstream
        ? {
            endpoint: options.upstream.url,
            bucket: options.upstream.deps.config.bucket,
            region: 'auto',
            credentials: upstreamCredentials,
          }
        : null,
      maxPutBytes: 64 * MiB,
    },
    db,
    blobs,
    fetch,
    fixedLength,
    now: () => Date.now() + clock.offset,
  };
  const server = await new Promise<ServerType>((resolve) => {
    const s = serve({ fetch: (req) => handle(req, deps), port: 0, hostname: '127.0.0.1' }, () =>
      resolve(s),
    );
  });
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, deps, blobs, db, server, clock };
}

let upstream: Running;
let proxy: Running;
let s3: S3Client;
let upstreamS3: S3Client;
const Bucket = 'xiaodouya';

function client(url: string, creds = credentials) {
  return new S3Client({
    region: 'auto',
    endpoint: url,
    forcePathStyle: true,
    credentials: creds,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    maxAttempts: 1,
  });
}

function bytes(size: number, seed = 1): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) out[i] = (i * 31 + seed) % 251;
  return out;
}

async function put(
  url: string,
  body: Uint8Array<ArrayBuffer>,
  headers: Record<string, string> = {},
) {
  const response = await fetch(url, { method: 'PUT', body, headers });
  await response.arrayBuffer();
  return response;
}

/** toEqual 逐个元素比较，几 MB 的数组要几十秒。 */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return Buffer.from(a).equals(Buffer.from(b));
}

async function read(key: string, range?: string): Promise<Uint8Array> {
  const r = await s3.send(new GetObjectCommand({ Bucket, Key: key, Range: range }));
  return r.Body!.transformToByteArray();
}

beforeAll(async () => {
  // 上游也是这个代理，只是前缀为空（全部存本地）：用它来校验转发时重签的签名。
  upstream = await start({
    drivePrefix: '',
    bucket: 'upstream-bucket',
    creds: upstreamCredentials,
  });
  proxy = await start({ drivePrefix: 'families/', bucket: Bucket, creds: credentials, upstream });
  s3 = client(proxy.url);
  upstreamS3 = client(upstream.url, upstreamCredentials);
});

afterAll(() => {
  proxy?.server.close();
  upstream?.server.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

beforeEach(() => {
  proxy.clock.offset = 0;
});

describe('single PUT', () => {
  it('binds the size into the presigned link and reads the object back', async () => {
    const key = `families/${crypto.randomUUID()}/memory/a/original`;
    const url = await getSignedUrl(
      s3,
      new PutObjectCommand({ Bucket, Key: key, ContentType: 'image/jpeg', ContentLength: 16 }),
      { expiresIn: 300, signableHeaders: new Set(['content-length']) },
    );
    expect((await put(url, bytes(17), { 'content-type': 'image/jpeg' })).status).toBe(403);
    expect((await put(url, bytes(16), { 'content-type': 'image/jpeg' })).status).toBe(200);
    expect(await read(key)).toEqual(bytes(16));
    const head = await s3.send(new HeadObjectCommand({ Bucket, Key: key }));
    expect(head.ContentLength).toBe(16);
    expect(head.ContentType).toBe('image/jpeg');
    // 存进了块存储，没有去上游。
    expect(
      await upstreamS3
        .send(new HeadObjectCommand({ Bucket: 'upstream-bucket', Key: key }))
        .catch((e) => e.$metadata.httpStatusCode),
    ).toBe(404);
  });

  it('accepts server-side puts signed with a payload hash, rejects a tampered body', async () => {
    const key = `families/${crypto.randomUUID()}/document/a/thumb`;
    await s3.send(
      new PutObjectCommand({ Bucket, Key: key, Body: bytes(1000), ContentType: 'image/jpeg' }),
    );
    expect(await read(key)).toEqual(bytes(1000));
  });

  it('rejects a bad signature, an expired link and a link for another key', async () => {
    const key = `families/${crypto.randomUUID()}/memory/b/original`;
    await s3.send(new PutObjectCommand({ Bucket, Key: key, Body: bytes(10) }));
    const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket, Key: key }), {
      expiresIn: 600,
    });
    expect((await fetch(url)).status).toBe(200);
    expect((await fetch(url.replace(key, `${key}x`))).status).toBe(403);
    expect(
      (await fetch(url.replace(/X-Amz-Signature=[0-9a-f]{4}/, 'X-Amz-Signature=0000'))).status,
    ).toBe(403);
    const wrong = client(proxy.url, { accessKeyId: 'proxy-key', secretAccessKey: 'nope' });
    const forged = await getSignedUrl(wrong, new GetObjectCommand({ Bucket, Key: key }), {
      expiresIn: 600,
    });
    expect((await fetch(forged)).status).toBe(403);
    proxy.clock.offset = 601_000;
    expect((await fetch(url)).status).toBe(403);
  });

  it('honours response-content-type on presigned downloads', async () => {
    const key = `families/${crypto.randomUUID()}/feedback/a/original`;
    await s3.send(
      new PutObjectCommand({ Bucket, Key: key, Body: bytes(10), ContentType: 'text/html' }),
    );
    const url = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket, Key: key, ResponseContentType: 'image/png' }),
      { expiresIn: 600 },
    );
    const r = await fetch(url);
    expect(r.headers.get('content-type')).toBe('image/png');
  });

  it('overwriting orphans the old block and deleting orphans the rest', async () => {
    const key = `families/${crypto.randomUUID()}/memory/c/thumb`;
    await s3.send(new PutObjectCommand({ Bucket, Key: key, Body: bytes(10) }));
    await s3.send(new PutObjectCommand({ Bucket, Key: key, Body: bytes(20, 7) }));
    expect(await read(key)).toEqual(bytes(20, 7));
    const orphans = () =>
      proxy.db.raw.prepare('SELECT COUNT(*) AS n FROM orphans').get() as { n: number };
    const before = orphans().n;
    await s3.send(new DeleteObjectCommand({ Bucket, Key: key }));
    expect(orphans().n).toBe(before + 1);
    const status = await s3
      .send(new HeadObjectCommand({ Bucket, Key: key }))
      .catch((e) => e.$metadata.httpStatusCode);
    expect(status).toBe(404);
    const row = proxy.db.raw.prepare('SELECT MIN(delete_after) AS t FROM orphans').get() as {
      t: number;
    };
    expect(row.t).toBeGreaterThan(Date.now() + ORPHAN_DELAY_MS - 60_000);
  });
});

describe('multipart', () => {
  it('does what the app and cli check-multipart do', async () => {
    const key = `families/${crypto.randomUUID()}/memory/v/original`;
    const partSize = 5 * MiB;
    const file = bytes(partSize * 2 + 1234, 3);
    const { UploadId } = await s3.send(
      new CreateMultipartUploadCommand({ Bucket, Key: key, ContentType: 'video/mp4' }),
    );
    const partUrl = (n: number, size: number) =>
      getSignedUrl(
        s3,
        new UploadPartCommand({ Bucket, Key: key, UploadId, PartNumber: n, ContentLength: size }),
        { expiresIn: 300, signableHeaders: new Set(['content-length']) },
      );
    expect((await put(await partUrl(1, partSize), file.slice(0, partSize + 1))).status).toBe(403);
    // 并行、乱序，第 2 片还重传一次。
    const results = await Promise.all([
      put(await partUrl(3, 1234), file.slice(partSize * 2)),
      put(await partUrl(2, partSize), bytes(partSize, 99)),
      put(await partUrl(1, partSize), file.slice(0, partSize)),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect((await put(await partUrl(2, partSize), file.slice(partSize, partSize * 2))).status).toBe(
      200,
    );

    const listed = await s3.send(new ListPartsCommand({ Bucket, Key: key, UploadId }));
    expect(listed.Parts?.map((p) => [p.PartNumber, p.Size])).toEqual([
      [1, partSize],
      [2, partSize],
      [3, 1234],
    ]);
    await s3.send(
      new CompleteMultipartUploadCommand({
        Bucket,
        Key: key,
        UploadId,
        MultipartUpload: {
          Parts: listed.Parts!.map((p) => ({ PartNumber: p.PartNumber, ETag: p.ETag })),
        },
      }),
    );
    expect(sameBytes(await read(key), file)).toBe(true);
    // 跨块的分段读取。
    const from = partSize - 10;
    expect(await read(key, `bytes=${from}-${from + 19}`)).toEqual(file.slice(from, from + 20));
    expect(await read(key, 'bytes=-5')).toEqual(file.slice(-5));
    // 第 2 片重传前的那一块等着删，三块都还被引用。
    const orphaned = proxy.db.raw
      .prepare(
        'SELECT COUNT(*) AS n FROM orphans WHERE blob_id NOT IN (SELECT blob_id FROM chunks)',
      )
      .get() as { n: number };
    expect(orphaned.n).toBeGreaterThanOrEqual(1);
    const compaction = proxy.db.raw.prepare('SELECT key FROM compactions WHERE key = ?').get(key);
    expect(compaction).toBeTruthy();

    // 完成以后再列就是 NoSuchUpload（服务端靠它判断已经完成）。
    const gone = await s3
      .send(new ListPartsCommand({ Bucket, Key: key, UploadId }))
      .catch((e) => e);
    expect(gone.name).toBe('NoSuchUpload');
  });

  it('abort removes the parts', async () => {
    const key = `families/${crypto.randomUUID()}/memory/w/original`;
    const { UploadId } = await s3.send(new CreateMultipartUploadCommand({ Bucket, Key: key }));
    await s3.send(
      new UploadPartCommand({ Bucket, Key: key, UploadId, PartNumber: 1, Body: bytes(100) }),
    );
    await s3.send(new AbortMultipartUploadCommand({ Bucket, Key: key, UploadId }));
    const gone = await s3
      .send(new ListPartsCommand({ Bucket, Key: key, UploadId }))
      .catch((e) => e);
    expect(gone.name).toBe('NoSuchUpload');
    const again = await s3
      .send(new AbortMultipartUploadCommand({ Bucket, Key: key, UploadId }))
      .catch((e) => e);
    expect(again.$metadata.httpStatusCode).toBe(404);
  });

  it('rejects small middle parts and unknown etags', async () => {
    const key = `families/${crypto.randomUUID()}/memory/x/original`;
    const { UploadId } = await s3.send(new CreateMultipartUploadCommand({ Bucket, Key: key }));
    const p1 = await s3.send(
      new UploadPartCommand({ Bucket, Key: key, UploadId, PartNumber: 1, Body: bytes(100) }),
    );
    const p2 = await s3.send(
      new UploadPartCommand({ Bucket, Key: key, UploadId, PartNumber: 2, Body: bytes(100) }),
    );
    const small = await s3
      .send(
        new CompleteMultipartUploadCommand({
          Bucket,
          Key: key,
          UploadId,
          MultipartUpload: {
            Parts: [
              { PartNumber: 1, ETag: p1.ETag },
              { PartNumber: 2, ETag: p2.ETag },
            ],
          },
        }),
      )
      .catch((e) => e);
    expect(small.name).toBe('EntityTooSmall');
    const wrongTag = await s3
      .send(
        new CompleteMultipartUploadCommand({
          Bucket,
          Key: key,
          UploadId,
          MultipartUpload: { Parts: [{ PartNumber: 1, ETag: '"nope"' }] },
        }),
      )
      .catch((e) => e);
    expect(wrongTag.name).toBe('InvalidPart');
  });
});

describe('upstream', () => {
  it('forwards keys outside the prefix, re-signed with the upstream key', async () => {
    const key = `releases/android/${crypto.randomUUID()}.json`;
    const url = await getSignedUrl(
      s3,
      new PutObjectCommand({ Bucket, Key: key, ContentType: 'application/json', ContentLength: 5 }),
      { expiresIn: 300, signableHeaders: new Set(['content-length']) },
    );
    expect((await put(url, bytes(6), { 'content-type': 'application/json' })).status).toBe(403);
    expect((await put(url, bytes(5), { 'content-type': 'application/json' })).status).toBe(200);
    const upstreamCopy = await upstreamS3.send(
      new GetObjectCommand({ Bucket: 'upstream-bucket', Key: key }),
    );
    expect(await upstreamCopy.Body!.transformToByteArray()).toEqual(bytes(5));
    expect(await read(key)).toEqual(bytes(5));
    expect(
      proxy.db.raw.prepare('SELECT COUNT(*) AS n FROM objects WHERE key = ?').get(key),
    ).toEqual({ n: 0 });
  });

  it('reads old family files from upstream and deletes them there too', async () => {
    const key = `families/${crypto.randomUUID()}/memory/old/original`;
    await upstreamS3.send(
      new PutObjectCommand({
        Bucket: 'upstream-bucket',
        Key: key,
        Body: bytes(42),
        ContentType: 'image/jpeg',
      }),
    );
    expect(await read(key)).toEqual(bytes(42));
    const head = await s3.send(new HeadObjectCommand({ Bucket, Key: key }));
    expect(head.ContentLength).toBe(42);
    const url = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket, Key: key, ResponseContentType: 'image/png' }),
      { expiresIn: 60 },
    );
    expect((await fetch(url)).headers.get('content-type')).toBe('image/png');
    await s3.send(new DeleteObjectCommand({ Bucket, Key: key }));
    const status = await upstreamS3
      .send(new HeadObjectCommand({ Bucket: 'upstream-bucket', Key: key }))
      .catch((e) => e.$metadata.httpStatusCode);
    expect(status).toBe(404);
  });

  it('forwards multipart uploads outside the prefix', async () => {
    const key = `backups/${crypto.randomUUID()}.enc`;
    const { UploadId } = await s3.send(new CreateMultipartUploadCommand({ Bucket, Key: key }));
    const p1 = await s3.send(
      new UploadPartCommand({ Bucket, Key: key, UploadId, PartNumber: 1, Body: bytes(5 * MiB) }),
    );
    const p2 = await s3.send(
      new UploadPartCommand({ Bucket, Key: key, UploadId, PartNumber: 2, Body: bytes(10) }),
    );
    await s3.send(
      new CompleteMultipartUploadCommand({
        Bucket,
        Key: key,
        UploadId,
        MultipartUpload: {
          Parts: [
            { PartNumber: 1, ETag: p1.ETag },
            { PartNumber: 2, ETag: p2.ETag },
          ],
        },
      }),
    );
    const copy = await upstreamS3.send(
      new HeadObjectCommand({ Bucket: 'upstream-bucket', Key: key }),
    );
    expect(copy.ContentLength).toBe(5 * MiB + 10);
  });
});

describe('helpers', () => {
  it('parses ranges like S3', () => {
    expect(parseRange(null, 10)).toBeNull();
    expect(parseRange('bytes=2-4', 10)).toEqual({ start: 2, end: 4 });
    expect(parseRange('bytes=8-', 10)).toEqual({ start: 8, end: 9 });
    expect(parseRange('bytes=5-100', 10)).toEqual({ start: 5, end: 9 });
    expect(parseRange('bytes=-3', 10)).toEqual({ start: 7, end: 9 });
    expect(parseRange('bytes=10-', 10)).toBe('unsatisfiable');
    expect(parseRange('items=1-2', 10)).toBeNull();
  });

  it('maps a range onto chunks', () => {
    const chunks = [
      { blob_id: 'a', size: 4 },
      { blob_id: 'b', size: 4 },
      { blob_id: 'c', size: 2 },
    ];
    expect(slicePieces(chunks, 3, 8)).toEqual([
      { blobId: 'a', start: 3, end: 3 },
      { blobId: 'b', start: 0, end: 3 },
      { blobId: 'c', start: 0, end: 0 },
    ]);
  });
});
