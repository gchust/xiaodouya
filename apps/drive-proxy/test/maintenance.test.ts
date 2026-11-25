import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_ALIGN } from '../src/blobs';
import { runMaintenance } from '../src/maintenance';
import { compactable, type Deps, handle, ORPHAN_DELAY_MS } from '../src/s3';
import { signRequest } from '../src/sigv4';
import { fixedLength, fsBlobs, sqliteDb } from './support';

const credentials = { accessKeyId: 'k', secretAccessKey: 's' };
const PART = 2 * SESSION_ALIGN * 10; // 5 MiB，S3 允许的最小片
let dir: string;
let deps: Deps & { blobs: ReturnType<typeof fsBlobs>; db: ReturnType<typeof sqliteDb> };
let clock: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'drive-proxy-maint-'));
  clock = Date.now();
  deps = {
    config: {
      bucket: 'b',
      credentials,
      drivePrefix: 'families/',
      upstream: null,
      maxPutBytes: 64 * 1024 * 1024,
    },
    db: sqliteDb(),
    blobs: fsBlobs(dir),
    fetch,
    fixedLength,
    now: () => clock,
  };
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function call(method: string, path: string, body?: Uint8Array<ArrayBuffer> | string) {
  const url = new URL(`http://proxy.test/b/${path}`);
  const headers = new Headers();
  if (body !== undefined) headers.set('content-length', String(new Blob([body]).size));
  await signRequest({ method, url, headers, credentials, region: 'auto', now: new Date(clock) });
  return handle(new Request(url, { method, headers, body }), deps);
}

function bytes(size: number, seed: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) out[i] = (i * 7 + seed) % 253;
  return out;
}

async function multipart(key: string, parts: Uint8Array<ArrayBuffer>[]) {
  const created = await (await call('POST', `${key}?uploads=`)).text();
  const uploadId = /<UploadId>(.+)<\/UploadId>/.exec(created)![1]!;
  const etags: string[] = [];
  for (const [i, part] of parts.entries()) {
    const r = await call('PUT', `${key}?partNumber=${i + 1}&uploadId=${uploadId}`, part);
    expect(r.status).toBe(200);
    etags.push(r.headers.get('etag')!);
  }
  const xml = `<CompleteMultipartUpload>${etags
    .map((e, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>${e}</ETag></Part>`)
    .join('')}</CompleteMultipartUpload>`;
  expect((await call('POST', `${key}?uploadId=${uploadId}`, xml)).status).toBe(200);
  return uploadId;
}

async function download(key: string): Promise<Buffer> {
  const r = await call('GET', key);
  expect(r.status).toBe(200);
  return Buffer.from(await r.arrayBuffer());
}

const count = (sql: string, ...args: string[]) =>
  (deps.db.raw.prepare(sql).get(...args) as { n: number }).n;

describe('compaction', () => {
  it('merges parts into one block across several runs, content unchanged', async () => {
    const key = 'families/f/memory/m/original';
    const parts = [bytes(PART, 1), bytes(PART, 2), bytes(PART, 3), bytes(123, 4)];
    await multipart(key, parts);
    const expected = Buffer.concat(parts);
    expect(count('SELECT COUNT(*) n FROM chunks WHERE key = ?', key)).toBe(4);

    // 每轮只够追加一段：要跑好几轮才合并完，中途照样能下载。
    let runs = 0;
    while (count('SELECT COUNT(*) n FROM compactions') > 0) {
      await runMaintenance(deps, { appends: 2, deletes: 0 });
      expect((await download(key)).equals(expected)).toBe(true);
      if (++runs > 10) throw new Error('compaction does not finish');
    }
    expect(runs).toBeGreaterThan(2);
    expect(count('SELECT COUNT(*) n FROM chunks WHERE key = ?', key)).toBe(1);
    expect((await download(key)).equals(expected)).toBe(true);
    const ranged = await call('GET', key);
    expect(ranged.headers.get('etag')).toMatch(/-4"$/);
    await ranged.body?.cancel();

    // 旧的四块一天后才删。
    expect(count('SELECT COUNT(*) n FROM orphans')).toBe(4);
    const before = deps.blobs.count();
    await runMaintenance(deps);
    expect(deps.blobs.count()).toBe(before);
    clock += ORPHAN_DELAY_MS + 1;
    await runMaintenance(deps);
    expect(deps.blobs.count()).toBe(before - 4);
    expect((await download(key)).equals(expected)).toBe(true);
  });

  it('drops the merged block when the object was replaced meanwhile', async () => {
    const key = 'families/f/memory/n/original';
    await multipart(key, [bytes(PART, 5), bytes(10, 6)]);
    // 合并写最后一段时，对象被覆盖了。
    const replacement = bytes(50, 9);
    const append = deps.blobs.append;
    deps.blobs.append = async (session, body, offset, size, total) => {
      if (offset + size === total) expect((await call('PUT', key, replacement)).status).toBe(200);
      return append(session, body, offset, size, total);
    };
    const report = await runMaintenance(deps, { appends: 15, deletes: 0 });
    expect(report.compacted).toBe(1);
    expect(count('SELECT COUNT(*) n FROM compactions')).toBe(0);
    expect((await download(key)).equals(Buffer.from(replacement))).toBe(true);
    // 合并出来的那一块没人用，等着删；覆盖前的两块也是。
    expect(count('SELECT COUNT(*) n FROM chunks WHERE key = ?', key)).toBe(1);
    expect(count('SELECT COUNT(*) n FROM orphans')).toBe(3);
  });

  it('only merges sizes Drive resumable uploads accept', () => {
    expect(compactable([SESSION_ALIGN * 32, SESSION_ALIGN * 32, 5])).toBe(true);
    expect(compactable([SESSION_ALIGN * 32 + 1, 5])).toBe(false);
  });
});

describe('failures', () => {
  it('a compaction stuck on a missing block does not stop cleanup or other compactions', async () => {
    const broken = 'families/f/memory/broken/original';
    const fine = 'families/f/memory/fine/original';
    await multipart(broken, [bytes(PART, 1), bytes(10, 2)]);
    clock += 1;
    await multipart(fine, [bytes(PART, 3), bytes(10, 4)]);
    const lost = (
      deps.db.raw.prepare('SELECT blob_id FROM chunks WHERE key = ? AND idx = 0').get(broken) as {
        blob_id: string;
      }
    ).blob_id;
    await deps.blobs.delete(lost);
    deps.db.raw.prepare("INSERT INTO orphans (blob_id, delete_after) VALUES ('old', 0)").run();
    const report = await runMaintenance(deps);
    expect(report.compactFailures).toBe(1);
    expect(report.compacted).toBe(1);
    expect(report.failedSteps).toEqual([]);
    expect(count("SELECT COUNT(*) n FROM orphans WHERE blob_id = 'old'")).toBe(0);
    expect(count('SELECT COUNT(*) n FROM chunks WHERE key = ?', fine)).toBe(1);
    // 坏的那个留在队列里、原来的块不动，下一轮再试。
    expect(count('SELECT COUNT(*) n FROM compactions WHERE key = ?', broken)).toBe(1);
    expect(count('SELECT COUNT(*) n FROM chunks WHERE key = ?', broken)).toBe(2);
  });

  it('uses the finished file when the last append landed but was not recorded', async () => {
    const key = 'families/f/memory/landed/original';
    const parts = [bytes(PART, 5), bytes(10, 6)];
    await multipart(key, parts);
    // 最后一段传上去了，然后这一轮在记下来之前死掉。
    const append = deps.blobs.append;
    deps.blobs.append = async (session, body, offset, size, total) => {
      const id = await append(session, body, offset, size, total);
      if (id) throw new Error('worker killed');
      return id;
    };
    expect((await runMaintenance(deps)).compactFailures).toBe(1);
    deps.blobs.append = append;
    clock += 10 * 60 * 1000 + 1;
    const appendsBefore = deps.blobs.calls.filter((c) => c === 'append').length;
    const report = await runMaintenance(deps);
    expect(report.compacted).toBe(1);
    expect(deps.blobs.calls.filter((c) => c === 'append').length).toBe(appendsBefore);
    expect(count('SELECT COUNT(*) n FROM chunks WHERE key = ?', key)).toBe(1);
    expect((await download(key)).equals(Buffer.concat(parts))).toBe(true);
  });

  it('labels parts and merged blocks with their object key', async () => {
    const key = 'families/f/memory/label/original';
    const uploadId = await multipart(key, [bytes(PART, 7), bytes(10, 8)]);
    expect([...deps.blobs.labels.values()]).toEqual([
      { key, part: 1, version: uploadId },
      { key, part: 2, version: uploadId },
    ]);
    await runMaintenance(deps);
    const merged = (
      deps.db.raw.prepare('SELECT blob_id FROM chunks WHERE key = ?').get(key) as {
        blob_id: string;
      }
    ).blob_id;
    expect(deps.blobs.labels.get(merged)).toMatchObject({ key, part: null });
  });
});

describe('cleanup', () => {
  it('never deletes a block that is still referenced', async () => {
    const key = 'families/f/memory/r/thumb';
    expect((await call('PUT', key, bytes(10, 1))).status).toBe(200);
    const blobId = (
      deps.db.raw.prepare('SELECT blob_id FROM chunks WHERE key = ?').get(key) as {
        blob_id: string;
      }
    ).blob_id;
    deps.db.raw.prepare('INSERT INTO orphans (blob_id, delete_after) VALUES (?, 0)').run(blobId);
    await runMaintenance(deps);
    expect((await download(key)).equals(Buffer.from(bytes(10, 1)))).toBe(true);
    expect(count('SELECT COUNT(*) n FROM orphans')).toBe(0);
  });

  it('retries failed deletes later without blocking the rest', async () => {
    deps.db.raw
      .prepare("INSERT INTO orphans (blob_id, delete_after) VALUES ('bad', 0), ('good', 0)")
      .run();
    const original = deps.blobs.delete;
    deps.blobs.delete = async (id) => {
      if (id === 'bad') throw new Error('drive down');
      return original(id);
    };
    const report = await runMaintenance(deps);
    expect(report).toMatchObject({ deleted: 1, deleteFailures: 1 });
    const row = deps.db.raw
      .prepare("SELECT attempts, delete_after FROM orphans WHERE blob_id = 'bad'")
      .get() as {
      attempts: number;
      delete_after: number;
    };
    expect(row.attempts).toBe(1);
    expect(row.delete_after).toBeGreaterThan(clock);
  });

  it('clears multipart uploads abandoned for a week', async () => {
    const key = 'families/f/memory/s/original';
    const created = await (await call('POST', `${key}?uploads=`)).text();
    const uploadId = /<UploadId>(.+)<\/UploadId>/.exec(created)![1]!;
    await call('PUT', `${key}?partNumber=1&uploadId=${uploadId}`, bytes(100, 1));
    await runMaintenance(deps);
    expect(count('SELECT COUNT(*) n FROM uploads')).toBe(1);
    clock += 7 * 24 * 3600 * 1000 + 1;
    expect((await runMaintenance(deps)).staleUploads).toBe(1);
    expect(count('SELECT COUNT(*) n FROM parts')).toBe(0);
    expect(count('SELECT COUNT(*) n FROM orphans')).toBe(1);
  });
});
