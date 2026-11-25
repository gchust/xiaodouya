import { describe, expect, it } from 'vitest';
import { BlobNotFound, SESSION_ALIGN } from '../src/blobs';
import { DriveError, driveBlobs } from '../src/drive';
import { runMaintenance } from '../src/maintenance';
import { type Deps, handle } from '../src/s3';
import { signRequest } from '../src/sigv4';
import { fakeDrive } from './fake-drive';
import { fixedLength, sqliteDb } from './support';

function setup(refreshToken = `refresh`) {
  const drive = fakeDrive();
  const db = sqliteDb();
  const blobs = driveBlobs(
    { clientId: 'c', clientSecret: 's', refreshToken, rootFolderId: null },
    { fetch: drive.fetch, db, fixedLength },
  );
  return { drive, db, blobs };
}

const label = (key = 'families/f/memory/a/original', part: number | null = null) => ({
  key,
  part,
  version: '"v1"',
});
const stream = (data: Uint8Array<ArrayBuffer>) => new Response(data).body!;
const text = async (s: ReadableStream<Uint8Array>) =>
  new Uint8Array(await new Response(s).arrayBuffer());

describe('driveBlobs', () => {
  it('stores, reads ranges and deletes; folders are created once and reused', async () => {
    const { drive, blobs } = setup();
    const data = new Uint8Array(1000).map((_, i) => i % 256);
    const ids = [];
    for (let i = 0; i < 20; i++) ids.push(await blobs.put(stream(data), data.length, label()));
    expect(await text(await blobs.get(ids[0]!, 10, 19))).toEqual(data.slice(10, 20));
    const folders = [...drive.files.values()].filter((f) => f.folder);
    // 一个根文件夹，加上用到的分桶文件夹，每个只建一次。
    const roots = folders.filter((f) => f.parents[0] === 'root');
    expect(roots).toHaveLength(1);
    const shardIds = new Set(
      [...drive.files.entries()].filter(([, f]) => !f.folder).map(([, f]) => f.parents[0]),
    );
    expect(folders.length).toBe(1 + shardIds.size);
    // 删除是放进回收站，不是永久删除；删两次、删不存在的都算成功。
    await blobs.delete(ids[0]!);
    await blobs.delete(ids[0]!);
    expect(drive.files.get(ids[0]!)?.trashed).toBe(true);
    await blobs.delete('missing');
    await expect(blobs.get('missing', 0, 1)).rejects.toBeInstanceOf(BlobNotFound);
  });

  it('labels every file with its object key so the index can be rebuilt from Drive', async () => {
    const { drive, blobs } = setup();
    const key = 'families/f/memory/b/original';
    const one = await blobs.put(stream(new Uint8Array(3)), 3, label(key, 2));
    expect(drive.files.get(one)?.meta).toMatchObject({
      description: key,
      name: 'v1-2',
      appProperties: { xdy: '1', part: '2' },
    });
    const session = await blobs.startSession(1, label(key));
    const merged = await blobs.append(session, stream(new Uint8Array(1)), 0, 1, 1);
    expect(drive.files.get(merged!)?.meta).toMatchObject({ description: key, name: 'v1-all' });
  });

  it('refreshes the access token once per hour, not per request', async () => {
    const { drive, blobs } = setup('refresh');
    const data = new Uint8Array(10);
    await blobs.put(stream(data), 10, label());
    await blobs.put(stream(data), 10, label());
    expect(drive.tokens.refreshes).toBeLessThanOrEqual(1);
  });

  it('reports a revoked authorization without leaking anything', async () => {
    const { blobs } = setup('revoked');
    const error = await blobs.put(stream(new Uint8Array(1)), 1, label()).catch((e) => e);
    expect(error).toBeInstanceOf(DriveError);
    expect(String(error.message)).toBe('drive token failed: 400');
  });

  it('resumes a session from what Drive confirmed', async () => {
    const { blobs } = setup();
    const total = SESSION_ALIGN * 2 + 5;
    const data = new Uint8Array(total).map((_, i) => (i * 13) % 256);
    const session = await blobs.startSession(total, label());
    expect(await blobs.sessionOffset(session, total)).toBe(0);
    expect(
      await blobs.append(session, stream(data.slice(0, SESSION_ALIGN)), 0, SESSION_ALIGN, total),
    ).toBeNull();
    expect(await blobs.sessionOffset(session, total)).toBe(SESSION_ALIGN);
    const id = await blobs.append(
      session,
      stream(data.slice(SESSION_ALIGN)),
      SESSION_ALIGN,
      total - SESSION_ALIGN,
      total,
    );
    expect(id).toBeTruthy();
    expect(await text(await blobs.get(id!, 0, total - 1))).toEqual(data);
    // 传完后再问，拿到的是那个文件：合并没来得及记下时直接用它，不再传一遍。
    expect(await blobs.sessionOffset(session, total)).toEqual({ blobId: id });
  });
});

describe('proxy on top of Drive', () => {
  it('multipart upload, compaction and download through the fake Drive', async () => {
    const { drive, db, blobs } = setup();
    const credentials = { accessKeyId: 'k', secretAccessKey: 's' };
    const deps: Deps = {
      config: {
        bucket: 'b',
        credentials,
        drivePrefix: 'families/',
        upstream: null,
        maxPutBytes: 1 << 30,
      },
      db,
      blobs,
      fetch: drive.fetch,
      fixedLength,
      now: Date.now,
    };
    const call = async (method: string, path: string, body?: Uint8Array<ArrayBuffer> | string) => {
      const url = new URL(`http://proxy.test/b/${path}`);
      const headers = new Headers();
      if (body !== undefined) headers.set('content-length', String(new Blob([body]).size));
      await signRequest({ method, url, headers, credentials, region: 'auto' });
      return handle(new Request(url, { method, headers, body }), deps);
    };
    const key = 'families/f/memory/v/original';
    const part = 5 * 1024 * 1024;
    const file = new Uint8Array(part * 2 + 77).map((_, i) => (i * 31) % 255);
    const uploadId = /<UploadId>(.+)<\/UploadId>/.exec(
      await (await call('POST', `${key}?uploads=`)).text(),
    )![1];
    const tags: string[] = [];
    for (const [n, slice] of [
      file.slice(0, part),
      file.slice(part, part * 2),
      file.slice(part * 2),
    ].entries()) {
      const r = await call('PUT', `${key}?partNumber=${n + 1}&uploadId=${uploadId}`, slice);
      expect(r.status).toBe(200);
      tags.push(r.headers.get('etag')!);
    }
    const xml = `<CompleteMultipartUpload>${tags.map((t, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>${t}</ETag></Part>`).join('')}</CompleteMultipartUpload>`;
    expect((await call('POST', `${key}?uploadId=${uploadId}`, xml)).status).toBe(200);
    const before = new Uint8Array(await (await call('GET', key)).arrayBuffer());
    expect(Buffer.from(before).equals(Buffer.from(file))).toBe(true);

    drive.requests.length = 0;
    const report = await runMaintenance(deps);
    expect(report.compacted).toBe(1);
    // 子请求很少：分桶文件夹可能是新的（1 个），开会话 1 个，每片读 1 个、写 1 个。
    expect(drive.requests.length).toBeLessThanOrEqual(2 + 3 * 2);
    drive.requests.length = 0;
    const after = new Uint8Array(await (await call('GET', key)).arrayBuffer());
    expect(Buffer.from(after).equals(Buffer.from(file))).toBe(true);
    expect(drive.requests.filter((r) => r.method === 'GET')).toHaveLength(1);
  });
});

describe('body length on the Drive path', () => {
  it('rejects a body shorter or longer than the signed Content-Length and stores nothing', async () => {
    const { drive, db, blobs } = setup();
    const credentials = { accessKeyId: 'k', secretAccessKey: 's' };
    const deps: Deps = {
      config: {
        bucket: 'b',
        credentials,
        drivePrefix: 'families/',
        upstream: null,
        maxPutBytes: 1 << 20,
      },
      db,
      blobs,
      fetch: drive.fetch,
      fixedLength,
      now: Date.now,
    };
    for (const actual of [5, 15]) {
      const url = new URL('http://proxy.test/b/families/f/memory/z/original');
      const headers = new Headers({ 'content-length': '10' });
      await signRequest({ method: 'PUT', url, headers, credentials, region: 'auto' });
      // 流式正文，fetch 不会替我们核对长度：只能靠代理自己数。
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new Uint8Array(actual));
          c.close();
        },
      });
      const response = await handle(
        new Request(url, { method: 'PUT', headers, body, duplex: 'half' } as RequestInit),
        deps,
      );
      expect(response.status).toBe(400);
      expect(await response.text()).toContain('IncompleteBody');
    }
    expect([...drive.files.values()].filter((f) => !f.folder)).toHaveLength(0);
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM objects').get()).toEqual({ n: 0 });
  });
});
