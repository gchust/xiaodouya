import { randomUUID } from 'node:crypto';
import {
  type MediaRef,
  MULTIPART_PART_BYTES,
  MULTIPART_THRESHOLD_BYTES,
  mediaRefsIn,
  missingParts,
  multipartPartBytes,
  multipartPartCount,
  multipartPartSize,
  usesMultipart,
  validParts,
  withoutMedia,
} from '@xiaodouya/shared';
import { describe, expect, it } from 'vitest';
import { cancelUploads, momentsLeftEmpty, uploadOwners } from '../src/data/uploadCancel';
import {
  type MultipartTransport,
  UploadHttpError,
  type UploadJob,
  UploadQueue,
  type UploadQueueDb,
  type UploadTransport,
} from '../src/data/uploadQueue';
import { addSpeedSample, currentSpeed, etaSeconds } from '../src/data/uploadSpeed';

const PART = MULTIPART_PART_BYTES;

class MemoryDb implements UploadQueueDb {
  rows = new Map<string, UploadJob>();
  async loadJobs() {
    return [...this.rows.values()].map((j) => structuredClone(j));
  }
  async saveJob(job: UploadJob) {
    this.rows.set(job.key, structuredClone(job));
  }
  async deleteJob(key: string) {
    this.rows.delete(key);
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};

/** 假的服务端：只记哪些片传了，和真实服务端一样以“存储”为准回答。 */
function fakeServer(overrides: Partial<MultipartTransport> = {}) {
  const calls: string[] = [];
  const stored = new Map<string, Map<number, number>>();
  let nextUpload = 1;
  const multipart: MultipartTransport = {
    async start(req) {
      calls.push(`start:${req.id}`);
      const uploadId = `upload-${nextUpload++}`;
      stored.set(uploadId, new Map());
      return { uploadId, partSize: PART };
    },
    async listParts(_job, uploadId) {
      calls.push('list');
      const parts = stored.get(uploadId);
      if (!parts) throw new UploadHttpError(404, 'upload_gone', '失效了');
      return {
        parts: [...parts.entries()].map(([partNumber, size]) => ({ partNumber, size })),
        complete: false,
      };
    },
    async partUrls(_job, _uploadId, partNumbers) {
      calls.push(`urls:${partNumbers.join(',')}`);
      return {
        urls: partNumbers.map((partNumber) => ({
          partNumber,
          url: `https://s3.test/${partNumber}`,
          size: 0,
        })),
        expiresIn: 3600,
      };
    },
    async putPart(job, part, onProgress) {
      calls.push(`put:${part.partNumber}`);
      onProgress(part.size / 2);
      onProgress(part.size);
      stored.get(job.uploadId as string)?.set(part.partNumber, part.size);
      return { status: 200 };
    },
    async complete() {
      calls.push('complete');
    },
    async stat(job) {
      return { size: job.size, modifiedAt: 1000 };
    },
    ...overrides,
  };
  return { multipart, calls, stored };
}

function fakeTransport(multipart?: MultipartTransport, overrides: Partial<UploadTransport> = {}) {
  const calls: string[] = [];
  const transport: UploadTransport = {
    async requestUrl(req) {
      calls.push(`url:${req.variant}`);
      return { url: 'https://s3.test/x', headers: {}, expiresIn: 3600 };
    },
    async put(job, _target, onProgress) {
      calls.push(`put:${job.key}`);
      onProgress(job.size);
      return { status: 200 };
    },
    async complete(id, variant) {
      calls.push(`done:${id}/${variant}`);
    },
    async removeLocal(uri) {
      calls.push(`rm:${uri}`);
    },
    async cancelRemote(id) {
      calls.push(`cancel:${id}`);
    },
    multipart,
    ...overrides,
  };
  return { transport, calls };
}

const big = (over: Partial<Omit<UploadJob, 'key' | 'attempts'>> = {}) => ({
  id: randomUUID(),
  variant: 'original' as const,
  scope: 'memory' as const,
  localUri: 'file:///big',
  mime: 'video/mp4',
  mediaKind: 'video' as const,
  size: PART * 2 + 100,
  wifiOnly: false,
  ...over,
});

const small = (over: Partial<Omit<UploadJob, 'key' | 'attempts'>> = {}) => ({
  ...big(),
  localUri: 'file:///small',
  mime: 'image/jpeg',
  mediaKind: 'image' as const,
  size: 1000,
  ...over,
});

const noRetry = { sleepMs: () => 60_000 };

describe('分片计算', () => {
  it('超过阈值才分片，正好等于阈值的不分', () => {
    expect(usesMultipart(MULTIPART_THRESHOLD_BYTES)).toBe(false);
    expect(usesMultipart(MULTIPART_THRESHOLD_BYTES + 1)).toBe(true);
  });
  it('最后一片是剩下的部分，其余一样大（R2 的要求）', () => {
    const size = PART * 2 + 5;
    expect(multipartPartCount(size, PART)).toBe(3);
    expect(multipartPartBytes(1, size, PART)).toBe(PART);
    expect(multipartPartBytes(3, size, PART)).toBe(5);
    expect(multipartPartBytes(4, size, PART)).toBe(0);
    expect(multipartPartCount(PART * 2, PART)).toBe(2);
    expect(multipartPartBytes(2, PART * 2, PART)).toBe(PART);
  });
  it('超大文件把片放大，不超过 10000 片', () => {
    const size = 200 * 1024 * 1024 * 1024;
    expect(multipartPartCount(size, multipartPartSize(size))).toBeLessThanOrEqual(10_000);
    expect(multipartPartSize(100 * 1024 * 1024)).toBe(PART);
  });
  it('大小不对的片算没传', () => {
    const size = PART + 10;
    const parts = [
      { partNumber: 1, size: PART - 1 },
      { partNumber: 2, size: 10 },
    ];
    expect(validParts(parts, size, PART).map((p) => p.partNumber)).toEqual([2]);
    expect(missingParts(parts, size, PART)).toEqual([1]);
  });
});

describe('分片上传', () => {
  it('大文件分片，小文件还是单个 PUT', async () => {
    const server = fakeServer();
    const { transport, calls } = fakeTransport(server.multipart);
    const db = new MemoryDb();
    const queue = new UploadQueue(db, transport);
    const large = big();
    const tiny = small();
    await queue.enqueue([large, tiny]);
    await queue.idle();
    expect(server.calls).toEqual([
      `start:${large.id}`,
      'list',
      'urls:1,2,3',
      'put:1',
      'put:2',
      'put:3',
      'complete',
    ]);
    expect(calls).toContain(`put:${tiny.id}/original`);
    expect(calls).not.toContain(`put:${large.id}/original`);
    expect(db.rows.size).toBe(0);
    expect(queue.getProgress().finishedInBatch).toBe(2);
  });

  it('断点恢复只传缺的片，以服务端说的为准', async () => {
    const server = fakeServer();
    const { transport } = fakeTransport(server.multipart);
    const queue = new UploadQueue(new MemoryDb(), transport);
    server.stored.set('upload-9', new Map([[2, PART]]));
    await queue.enqueue([big({ uploadId: 'upload-9', partSize: PART })]);
    await queue.idle();
    expect(server.calls).toEqual(['list', 'urls:1,3', 'put:1', 'put:3', 'complete']);
  });

  it('App 重启后恢复 uploadId，不重新开始', async () => {
    const db = new MemoryDb();
    let failing = true;
    const server = fakeServer();
    const realPut = server.multipart.putPart;
    server.multipart.putPart = async (job, part, onProgress, signal) => {
      if (failing && part.partNumber === 2) throw new Error('断网了');
      return realPut(job, part, onProgress, signal);
    };
    const first = new UploadQueue(db, fakeTransport(server.multipart).transport, noRetry);
    const job = big();
    await first.enqueue([job]);
    await first.idle();
    first.stop();
    const saved = [...db.rows.values()][0];
    expect(saved?.uploadId).toBe('upload-1');
    expect(saved?.confirmedBytes).toBe(PART);

    failing = false;
    server.calls.length = 0;
    const second = new UploadQueue(db, fakeTransport(server.multipart).transport);
    await second.load();
    await second.idle();
    expect(server.calls.some((c) => c.startsWith('start'))).toBe(false);
    expect(server.calls.filter((c) => c.startsWith('put'))).toEqual(['put:2', 'put:3']);
    expect(db.rows.size).toBe(0);
  });

  it('重启后还没联网，进度也不从 0 开始', async () => {
    const db = new MemoryDb();
    const job = big({ uploadId: 'upload-1', partSize: PART, confirmedBytes: PART });
    await db.saveJob({ ...job, key: `${job.id}/original`, attempts: 1 });
    const queue = new UploadQueue(db, fakeTransport(fakeServer().multipart).transport);
    queue.setNetwork('none');
    await queue.load();
    const progress = queue.getProgress();
    expect(progress.fraction).toBeCloseTo(PART / job.size);
    expect(progress.items[0]?.sent).toBe(PART);
  });

  it('失败重试时进度不回退到 0，只丢正在传的这一片', async () => {
    let failures = 1;
    const server = fakeServer();
    const realPut = server.multipart.putPart;
    server.multipart.putPart = async (job, part, onProgress, signal) => {
      if (part.partNumber === 2 && failures > 0) {
        failures -= 1;
        onProgress(part.size / 2);
        throw new Error('断网了');
      }
      return realPut(job, part, onProgress, signal);
    };
    const queue = new UploadQueue(new MemoryDb(), fakeTransport(server.multipart).transport, {
      sleepMs: () => 0,
    });
    const job = big();
    const seen: number[] = [];
    queue.subscribe(() => seen.push(queue.getProgress().fraction));
    await queue.enqueue([job]);
    await new Promise((r) => setTimeout(r, 30));
    await queue.idle();
    const afterFirstPart = seen.findIndex((f) => f >= PART / job.size);
    expect(afterFirstPart).toBeGreaterThan(-1);
    for (const fraction of seen.slice(afterFirstPart, -1)) {
      expect(fraction).toBeGreaterThanOrEqual(PART / job.size);
    }
    expect(server.calls.filter((c) => c === 'put:1')).toHaveLength(1);
  });

  it('进度能到片内字节，不是按整片跳', async () => {
    const gate = deferred<void>();
    const server = fakeServer({
      async putPart(job, part, onProgress) {
        onProgress(1234);
        await gate.promise;
        onProgress(part.size);
        return { status: 200 };
      },
    });
    const queue = new UploadQueue(new MemoryDb(), fakeTransport(server.multipart).transport);
    await queue.enqueue([big()]);
    await flush();
    expect(queue.getProgress().items[0]?.sent).toBe(1234);
    expect(queue.getProgress().sentBytes).toBe(1234);
    gate.resolve();
    await queue.idle();
  });

  it('uploadId 失效后从头开始，不算失败', async () => {
    const server = fakeServer();
    const { transport } = fakeTransport(server.multipart);
    const db = new MemoryDb();
    const queue = new UploadQueue(db, transport);
    await queue.enqueue([big({ uploadId: 'gone', partSize: PART, confirmedBytes: PART })]);
    await queue.idle();
    expect(server.calls.filter((c) => c.startsWith('start'))).toHaveLength(1);
    expect(server.calls.filter((c) => c.startsWith('put'))).toHaveLength(3);
    expect(db.rows.size).toBe(0);
  });

  it('文件开始后被改动，报错而不是传坏', async () => {
    let modifiedAt = 1000;
    const server = fakeServer({
      async stat(job) {
        return { size: job.size, modifiedAt };
      },
    });
    const realPut = server.multipart.putPart;
    server.multipart.putPart = async (job, part, onProgress, signal) => {
      modifiedAt = 2000;
      return realPut(job, part, onProgress, signal);
    };
    const queue = new UploadQueue(new MemoryDb(), fakeTransport(server.multipart).transport);
    await queue.enqueue([big()]);
    await queue.idle();
    expect(server.calls.filter((c) => c.startsWith('put'))).toEqual(['put:1']);
    expect(server.calls).not.toContain('complete');
    expect(queue.getProgress().failedCount).toBe(1);
    expect(queue.getProgress().items[0]?.status).toBe('failed');
  });

  it('文件大小不符也报错', async () => {
    const server = fakeServer({
      async stat(job) {
        return { size: job.size - 1, modifiedAt: 1000 };
      },
    });
    const queue = new UploadQueue(new MemoryDb(), fakeTransport(server.multipart).transport);
    await queue.enqueue([big({ uploadId: 'upload-1', partSize: PART })]);
    await queue.idle();
    expect(server.calls.filter((c) => c.startsWith('put'))).toEqual([]);
    expect(queue.getProgress().failedCount).toBe(1);
  });

  it('本地文件没了是永久失败，不重试', async () => {
    const server = fakeServer({
      async stat() {
        return null;
      },
    });
    const queue = new UploadQueue(new MemoryDb(), fakeTransport(server.multipart).transport);
    await queue.enqueue([big()]);
    await queue.idle();
    expect(queue.getProgress().failedCount).toBe(1);
  });

  it('一片成功就清零失败次数，零星失败攒不到上限', async () => {
    let tick = 0;
    const server = fakeServer();
    const realPut = server.multipart.putPart;
    server.multipart.putPart = async (job, part, onProgress, signal) => {
      tick += 1;
      if (tick % 2 === 1) return { status: 500 };
      return realPut(job, part, onProgress, signal);
    };
    const size = PART * 11;
    const queue = new UploadQueue(new MemoryDb(), fakeTransport(server.multipart).transport, {
      sleepMs: () => 0,
    });
    await queue.enqueue([big({ size })]);
    for (let i = 0; i < 40 && queue.getProgress().total > 0; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    await queue.idle();
    queue.stop();
    expect(queue.getProgress().failedCount).toBe(0);
    expect(server.calls).toContain('complete');
  });

  it('存储持续报错有次数上限，交给用户', async () => {
    const server = fakeServer({
      async putPart() {
        return { status: 500 };
      },
    });
    const queue = new UploadQueue(new MemoryDb(), fakeTransport(server.multipart).transport, {
      sleepMs: () => 0,
    });
    await queue.enqueue([big()]);
    for (let i = 0; i < 60 && queue.getProgress().failedCount === 0; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    await queue.idle();
    expect(queue.getProgress().failedCount).toBe(1);
  });

  it('传到一半断开 Wi-Fi：只限 Wi-Fi 的文件在片之间停下，回来接着传', async () => {
    const gate = deferred<void>();
    const server = fakeServer();
    const realPut = server.multipart.putPart;
    server.multipart.putPart = async (job, part, onProgress, signal) => {
      if (part.partNumber === 1) await gate.promise;
      return realPut(job, part, onProgress, signal);
    };
    const queue = new UploadQueue(new MemoryDb(), fakeTransport(server.multipart).transport);
    await queue.enqueue([big({ wifiOnly: true })]);
    await flush();
    queue.setNetwork('cellular');
    gate.resolve();
    await flush();
    await queue.idle();
    expect(server.calls.filter((c) => c.startsWith('put'))).toEqual(['put:1']);
    expect(queue.getProgress().items[0]?.status).toBe('waitingWifi');
    expect(queue.getProgress().speed).toBeNull();

    queue.setNetwork('wifi');
    await flush();
    await queue.idle();
    expect(server.calls.filter((c) => c.startsWith('put'))).toEqual(['put:1', 'put:2', 'put:3']);
    expect(server.calls).toContain('complete');
  });

  it('服务端说已经合并好了（上次没收到响应）：直接完成，不再传', async () => {
    const server = fakeServer({
      async listParts() {
        return { parts: [], complete: true };
      },
    });
    const db = new MemoryDb();
    const queue = new UploadQueue(db, fakeTransport(server.multipart).transport);
    await queue.enqueue([big({ uploadId: 'upload-1', partSize: PART })]);
    await queue.idle();
    expect(server.calls.filter((c) => c.startsWith('put'))).toEqual([]);
    expect(server.calls).toContain('complete');
    expect(db.rows.size).toBe(0);
  });

  it('开始时说已经传完了，算成功', async () => {
    const server = fakeServer({
      async start() {
        throw new UploadHttpError(409, 'already_uploaded', '传过了');
      },
    });
    const db = new MemoryDb();
    const queue = new UploadQueue(db, fakeTransport(server.multipart).transport);
    await queue.enqueue([big()]);
    await queue.idle();
    expect(db.rows.size).toBe(0);
    expect(queue.getProgress().failedCount).toBe(0);
  });
});

describe('退回单个 PUT', () => {
  const expectFallback = async (server: ReturnType<typeof fakeServer>) => {
    const { transport, calls } = fakeTransport(server.multipart);
    const db = new MemoryDb();
    const queue = new UploadQueue(db, transport);
    const job = big();
    await queue.enqueue([job]);
    await queue.idle();
    expect(calls).toContain(`put:${job.id}/original`);
    expect(calls).toContain(`done:${job.id}/original`);
    expect(queue.getProgress().failedCount).toBe(0);
    expect(db.rows.size).toBe(0);
  };

  it('旧服务端没有这些接口（404）', async () => {
    await expectFallback(
      fakeServer({
        async start() {
          throw new UploadHttpError(404, 'not_found', '接口不存在');
        },
      }),
    );
  });

  it('存储不支持（服务端返回 multipart_unsupported）', async () => {
    await expectFallback(
      fakeServer({
        async start() {
          throw new UploadHttpError(501, 'multipart_unsupported', '不支持');
        },
      }),
    );
  });

  it('预签名分片被存储拒绝（501）', async () => {
    await expectFallback(
      fakeServer({
        async putPart() {
          return { status: 501 };
        },
      }),
    );
  });

  it('持久化：重启后不再试分片', async () => {
    const server = fakeServer({
      async start() {
        throw new UploadHttpError(501, 'multipart_unsupported', '不支持');
      },
    });
    const gate = deferred<{ status: number }>();
    const { transport } = fakeTransport(server.multipart, {
      put: () => gate.promise,
    });
    const db = new MemoryDb();
    const queue = new UploadQueue(db, transport);
    await queue.enqueue([big()]);
    await flush();
    expect([...db.rows.values()][0]?.singlePut).toBe(true);
    gate.resolve({ status: 200 });
    await queue.idle();
  });

  it('暂时的错误不退回：还能接着传，不该丢掉已传的片', async () => {
    const server = fakeServer({
      async start() {
        throw new UploadHttpError(503, 'storage_unavailable', '稍后');
      },
    });
    const { transport, calls } = fakeTransport(server.multipart);
    const queue = new UploadQueue(new MemoryDb(), transport, noRetry);
    await queue.enqueue([big()]);
    await queue.idle();
    queue.stop();
    expect(calls.filter((c) => c.startsWith('put'))).toEqual([]);
    expect(queue.getProgress().items[0]?.status).toBe('retrying');
  });
});

describe('取消', () => {
  const abortable = (onStart?: () => void) => ({
    putPart(
      _job: UploadJob,
      _part: unknown,
      _onProgress: (n: number) => void,
      signal: AbortSignal,
    ) {
      onStart?.();
      return new Promise<{ status: number }>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          const error = new Error('The operation was aborted.');
          error.name = 'AbortError';
          reject(error);
        });
      });
    },
  });

  it('正在传的马上中断，不再传后面的片，任务和本地副本都没了，并通知服务端', async () => {
    let started = 0;
    const server = fakeServer(abortable(() => (started += 1)));
    const { transport, calls } = fakeTransport(server.multipart);
    const db = new MemoryDb();
    const queue = new UploadQueue(db, transport, noRetry);
    const job = big();
    await queue.enqueue([job]);
    await flush();
    expect(started).toBe(1);

    await queue.cancel([job.id]);
    await queue.idle();
    expect(started).toBe(1);
    expect(server.calls).not.toContain('complete');
    expect(calls).toContain(`rm:${job.localUri}`);
    expect(calls).toContain(`cancel:${job.id}`);
    expect(db.rows.size).toBe(0);
    expect(queue.getProgress().total).toBe(0);
    expect(queue.getProgress().failedCount).toBe(0);
  });

  it('全部取消后不能说“都传好了”', async () => {
    const server = fakeServer(abortable());
    const queue = new UploadQueue(new MemoryDb(), fakeTransport(server.multipart).transport);
    const a = big();
    const b = big();
    await queue.enqueue([a, b]);
    await flush();
    await queue.cancel([a.id, b.id]);
    await queue.idle();
    expect(queue.getProgress().total).toBe(0);
    expect(queue.getProgress().finishedInBatch).toBe(0);
  });

  it('取消一个，其余继续传完', async () => {
    const server = fakeServer();
    const gate = deferred<void>();
    const realPut = server.multipart.putPart;
    server.multipart.putPart = async (job, part, onProgress, signal) => {
      await gate.promise;
      return realPut(job, part, onProgress, signal);
    };
    const { transport } = fakeTransport(server.multipart);
    const db = new MemoryDb();
    const queue = new UploadQueue(db, transport);
    const first = big();
    const second = big();
    await queue.enqueue([first, second]);
    await flush();
    await queue.cancel([second.id]);
    gate.resolve();
    await queue.idle();
    expect(server.calls.filter((c) => c.startsWith('start'))).toEqual([`start:${first.id}`]);
    expect(queue.getProgress().finishedInBatch).toBe(1);
    expect(db.rows.size).toBe(0);
  });

  it('和正在完成的上传赛跑：取消赢了就不算传好', async () => {
    const gate = deferred<void>();
    const server = fakeServer({ complete: () => gate.promise });
    const uploaded: string[] = [];
    const db = new MemoryDb();
    const queue = new UploadQueue(db, fakeTransport(server.multipart).transport, {
      onUploaded: (id) => uploaded.push(id),
    });
    const job = big();
    await queue.enqueue([job]);
    await flush();
    await queue.cancel([job.id]);
    gate.resolve();
    await queue.idle();
    expect(uploaded).toEqual([]);
    expect(queue.getProgress().finishedInBatch).toBe(0);
    expect(db.rows.size).toBe(0);
  });

  it('单个 PUT 的竞态：取消后响应才到，不算传好也不调 complete', async () => {
    const gate = deferred<{ status: number }>();
    const { transport, calls } = fakeTransport(undefined, { put: () => gate.promise });
    const db = new MemoryDb();
    const queue = new UploadQueue(db, transport);
    const job = small();
    await queue.enqueue([job]);
    await flush();
    await queue.cancel([job.id]);
    gate.resolve({ status: 200 });
    await queue.idle();
    expect(calls).not.toContain(`done:${job.id}/original`);
    expect(db.rows.size).toBe(0);
  });

  it('失败的响应晚到也不会复活，退避重试也不会', async () => {
    const gate = deferred<{ status: number }>();
    let putCount = 0;
    const { transport } = fakeTransport(undefined, {
      put: () => {
        putCount += 1;
        return gate.promise;
      },
    });
    const db = new MemoryDb();
    const queue = new UploadQueue(db, transport, { sleepMs: () => 0 });
    const job = small();
    await queue.enqueue([job]);
    await flush();
    await queue.cancel([job.id]);
    gate.reject(new Error('断网了'));
    await queue.idle();
    await new Promise((r) => setTimeout(r, 20));
    await queue.idle();
    await queue.retryFailed();
    await queue.idle();
    expect(putCount).toBe(1);
    expect(db.rows.size).toBe(0);
    expect(queue.getProgress().items).toEqual([]);
  });

  it('已经失败的任务也能取消，重试不会把它带回来', async () => {
    const { transport } = fakeTransport(undefined, {
      async requestUrl() {
        throw new UploadHttpError(413, 'quota_exceeded', '满了');
      },
    });
    const db = new MemoryDb();
    const queue = new UploadQueue(db, transport);
    const job = small();
    await queue.enqueue([job]);
    await queue.idle();
    expect(queue.getProgress().failedCount).toBe(1);
    await queue.cancel([job.id]);
    await queue.retryFailed();
    await queue.idle();
    expect(queue.getProgress().failedCount).toBe(0);
    expect(db.rows.size).toBe(0);
  });

  it('缩略图做到一半被取消：做好的文件要清掉，不再上传', async () => {
    const thumbGate = deferred<{ size: number }>();
    const { transport, calls } = fakeTransport(undefined, { makeThumb: () => thumbGate.promise });
    const queue = new UploadQueue(new MemoryDb(), transport);
    const id = randomUUID();
    await queue.enqueue([
      small({
        id,
        variant: 'thumb',
        localUri: 'file:///thumb',
        size: 0,
        thumbSource: { uri: 'file:///orig', kind: 'image' },
      }),
      small({ id, localUri: 'file:///orig' }),
    ]);
    await flush();
    await queue.cancel([id]);
    thumbGate.resolve({ size: 7 });
    await queue.idle();
    expect(calls).toContain('rm:file:///thumb');
    expect(calls).toContain('rm:file:///orig');
    expect(calls.some((c) => c.startsWith('put:'))).toBe(false);
  });

  it('离线取消：本地立刻生效，墓碑留到有网再通知服务端，App 重启也不丢', async () => {
    const db = new MemoryDb();
    const first = fakeTransport(fakeServer().multipart);
    const queue = new UploadQueue(db, first.transport);
    queue.setNetwork('none');
    const job = big();
    await queue.enqueue([job]);
    await queue.cancel([job.id]);
    await queue.idle();
    expect(queue.getProgress().total).toBe(0);
    expect(queue.pendingIds().size).toBe(0);
    expect(first.calls).toContain(`rm:${job.localUri}`);
    expect(first.calls).not.toContain(`cancel:${job.id}`);
    expect([...db.rows.values()].map((r) => r.cancelled)).toEqual([true]);
    queue.stop();

    const second = fakeTransport(fakeServer().multipart);
    const reopened = new UploadQueue(db, second.transport);
    await reopened.load();
    await reopened.idle();
    expect(second.calls).toContain(`cancel:${job.id}`);
    expect(db.rows.size).toBe(0);
    expect(reopened.getProgress().total).toBe(0);
  });

  it('取消到一半被杀：墓碑写了任务还在，重启后接着清，不会再传', async () => {
    const db = new MemoryDb();
    const job = big();
    await db.saveJob({ ...job, key: `${job.id}/original`, attempts: 0 });
    await db.saveJob({
      ...job,
      key: `${job.id}/cancel`,
      attempts: 0,
      size: 0,
      cancelled: true,
    });
    const server = fakeServer();
    const { transport, calls } = fakeTransport(server.multipart);
    const queue = new UploadQueue(db, transport);
    await queue.load();
    await queue.idle();
    expect(server.calls).toEqual([]);
    expect(calls).toContain(`rm:${job.localUri}`);
    expect(calls).toContain(`cancel:${job.id}`);
    expect(db.rows.size).toBe(0);
  });

  it('旧服务端没有取消接口：404 就算了，靠它的放弃清理', async () => {
    const { transport } = fakeTransport(undefined, {
      async cancelRemote() {
        throw new UploadHttpError(404, 'not_found', '接口不存在');
      },
    });
    const db = new MemoryDb();
    const queue = new UploadQueue(db, transport);
    queue.setNetwork('none');
    const job = small();
    await queue.enqueue([job]);
    await queue.cancel([job.id]);
    queue.setNetwork('wifi');
    await flush();
    await queue.idle();
    expect(db.rows.size).toBe(0);
  });

  it('通知不到服务端会重试，有次数上限，不会永远占着队列', async () => {
    let tries = 0;
    const { transport } = fakeTransport(undefined, {
      async cancelRemote() {
        tries += 1;
        throw new Error('断网了');
      },
    });
    const db = new MemoryDb();
    const queue = new UploadQueue(db, transport, { sleepMs: () => 0 });
    const job = small();
    queue.setNetwork('none');
    await queue.enqueue([job]);
    await queue.cancel([job.id]);
    queue.setNetwork('wifi');
    for (let i = 0; i < 40 && db.rows.size > 0; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    await queue.idle();
    expect(tries).toBeGreaterThan(1);
    expect(db.rows.size).toBe(0);
  });

  it('退出登录后不能把别人的墓碑写回去', async () => {
    const gate = deferred<void>();
    const { transport } = fakeTransport(undefined, { cancelRemote: () => gate.promise });
    const db = new MemoryDb();
    const queue = new UploadQueue(db, transport);
    const job = small();
    queue.setNetwork('none');
    await queue.enqueue([job]);
    await queue.cancel([job.id]);
    queue.setNetwork('wifi');
    await flush();
    db.rows.clear();
    queue.reset();
    gate.reject(new Error('断网了'));
    await queue.idle();
    await flush();
    expect(db.rows.size).toBe(0);
  });
});

describe('按媒体显示', () => {
  const pair = (id: string, over: Partial<Omit<UploadJob, 'key' | 'attempts'>> = {}) => [
    small({
      id,
      variant: 'thumb',
      localUri: `file:///${id}-thumb`,
      size: 10,
      mime: 'image/jpeg',
      ...over,
    }),
    small({ id, localUri: `file:///${id}`, ...over }),
  ];

  it('原图和缩略图合成一项，视频按视频算，不看缩略图的 mime', async () => {
    const queue = new UploadQueue(new MemoryDb(), fakeTransport().transport);
    queue.setNetwork('none');
    const photo = randomUUID();
    const video = randomUUID();
    await queue.enqueue([
      ...pair(photo),
      ...pair(video, { mediaKind: 'video' }).map((j) =>
        j.variant === 'original' ? { ...j, mime: 'video/mp4', size: 5000 } : j,
      ),
    ]);
    const progress = queue.getProgress();
    expect(progress.total).toBe(2);
    expect(progress.counts).toEqual({ image: 1, video: 1, audio: 0, pdf: 0 });
    expect(progress.items.map((i) => [i.id, i.kind, i.size])).toEqual([
      [photo, 'image', 1000],
      [video, 'video', 5000],
    ]);
    expect(progress.items.every((i) => i.status === 'waitingNetwork')).toBe(true);
  });

  it('升级前的任务没有 mediaKind，按 mime 算', async () => {
    const db = new MemoryDb();
    const job = small({ mime: 'application/pdf', mediaKind: undefined });
    await db.saveJob({ ...job, key: `${job.id}/original`, attempts: 0 });
    const queue = new UploadQueue(db, fakeTransport().transport);
    queue.setNetwork('none');
    await queue.load();
    expect(queue.getProgress().items[0]?.kind).toBe('pdf');
  });

  it('状态：上传中、排队中、等 Wi-Fi、重试中、失败及原因', async () => {
    const gate = deferred<{ status: number }>();
    const { transport } = fakeTransport(undefined, {
      put(job) {
        if (job.mime === 'image/jpeg') return gate.promise;
        return Promise.reject(new UploadHttpError(413, 'too_large', '太大了'));
      },
    });
    const queue = new UploadQueue(new MemoryDb(), transport);
    const uploading = small();
    const queued = small();
    const wifi = small({ wifiOnly: true });
    await queue.enqueue([uploading, queued]);
    queue.setNetwork('cellular');
    await queue.enqueue([wifi]);
    await flush();
    const byId = new Map(queue.getProgress().items.map((i) => [i.id, i]));
    expect(byId.get(uploading.id)?.status).toBe('uploading');
    expect(byId.get(queued.id)?.status).toBe('queued');
    expect(byId.get(wifi.id)?.status).toBe('waitingWifi');
    gate.resolve({ status: 200 });
    await queue.idle();

    const failed = small({ mime: 'video/mp4', mediaKind: 'video' });
    await queue.enqueue([failed]);
    await queue.idle();
    const item = queue.getProgress().items.find((i) => i.id === failed.id);
    expect(item?.status).toBe('failed');
    expect(item?.reason).toBe('太大了');
    expect(queue.getProgress().failedCounts.video).toBe(1);
    expect(queue.getProgress().failedReason).toBe('太大了');
  });

  it('下一批开始时“传完了多少”重新算', async () => {
    const queue = new UploadQueue(new MemoryDb(), fakeTransport().transport);
    await queue.enqueue([small()]);
    await queue.idle();
    expect(queue.getProgress().finishedInBatch).toBe(1);
    queue.setNetwork('none');
    await queue.enqueue([small()]);
    expect(queue.getProgress().finishedInBatch).toBe(0);
  });
});

describe('速度', () => {
  const series = (...points: [number, number][]) => {
    let samples: ReturnType<typeof addSpeedSample> = [];
    for (const [at, bytes] of points) samples = addSpeedSample(samples, { at, bytes });
    return samples;
  };

  it('没数据时不显示', () => {
    expect(currentSpeed([], 1000)).toBeNull();
    expect(currentSpeed(series([0, 0]), 1000)).toBeNull();
    expect(etaSeconds(100, null)).toBeNull();
  });
  it('刚开始样本太短，不显示', () => {
    expect(currentSpeed(series([0, 0], [500, 1000]), 600)).toBeNull();
  });
  it('是最近几秒的平均，不被一个尖峰带跑', () => {
    const samples = series([0, 0], [1000, 1_000_000], [2000, 2_000_000], [3000, 12_000_000]);
    expect(currentSpeed(samples, 3000)).toBe(4_000_000);
  });
  it('窗口之外的不算：网速变了很快能反应过来', () => {
    const samples = series(
      [0, 0],
      [10_000, 100_000_000],
      [15_000, 105_000_000],
      [18_000, 108_000_000],
    );
    expect(currentSpeed(samples, 18_000)).toBe(1_000_000);
  });
  it('暂停、等待时不显示：很久没有新字节就不算在传了', () => {
    const samples = series([0, 0], [2000, 2_000_000]);
    expect(currentSpeed(samples, 2500)).not.toBeNull();
    expect(currentSpeed(samples, 8000)).toBeNull();
  });
  it('速度掉下来时能看出来，不是停在上一个数', () => {
    const samples = series([0, 0], [2000, 2_000_000]);
    const fresh = currentSpeed(samples, 2000) as number;
    const later = currentSpeed(samples, 4000) as number;
    expect(later).toBeLessThan(fresh);
  });
  it('剩余时间向上取整', () => {
    expect(etaSeconds(1001, 1000)).toBe(2);
    expect(etaSeconds(0, 1000)).toBe(0);
  });

  it('队列：传的时候有速度，失败后清掉，重试后重新算', async () => {
    let clock = 0;
    const gate = deferred<void>();
    let failNext = true;
    const server = fakeServer({
      async putPart(_job, part, onProgress) {
        for (const sent of [1_000_000, 2_000_000, 3_000_000]) {
          clock += 1000;
          onProgress(sent);
        }
        if (failNext) {
          failNext = false;
          throw new Error('断网了');
        }
        await gate.promise;
        onProgress(part.size);
        return { status: 200 };
      },
    });
    const queue = new UploadQueue(new MemoryDb(), fakeTransport(server.multipart).transport, {
      sleepMs: () => 0,
      now: () => clock,
    });
    const speeds: (number | null)[] = [];
    queue.subscribe(() => speeds.push(queue.getProgress().speed));
    await queue.enqueue([big()]);
    await flush();
    expect(speeds.some((v) => v === 1_000_000)).toBe(true);
    // 重试之后的第一个样本不会和失败前的连在一起算。
    const after = queue.getProgress();
    expect(after.speed).toBe(1_000_000);
    expect(after.etaSeconds).toBeGreaterThan(0);
    gate.resolve();
    await queue.idle();
    expect(queue.getProgress().speed).toBeNull();
  });

  it('队列：等 Wi-Fi、断网时不显示速度', async () => {
    const queue = new UploadQueue(new MemoryDb(), fakeTransport(fakeServer().multipart).transport);
    queue.setNetwork('cellular');
    await queue.enqueue([big({ wifiOnly: true })]);
    await queue.idle();
    expect(queue.getProgress().waitingForWifi).toBe(true);
    expect(queue.getProgress().speed).toBeNull();
    queue.setNetwork('none');
    expect(queue.getProgress().offline).toBe(true);
    expect(queue.getProgress().speed).toBeNull();
  });
});

describe('取消后从记录里去掉引用', () => {
  const ref = (id: string, kind: MediaRef['kind'] = 'image'): MediaRef => ({
    id,
    kind,
    mime: 'image/jpeg',
    size: 10,
  });
  const moment = (id: string, media: MediaRef[], over: Record<string, unknown> = {}) => ({
    id,
    data: { title: '', text: '', at: 1, milestone: false, media, ...over },
  });
  const records = (over: Partial<Parameters<typeof cancelUploads>[1]['records']> = {}) =>
    ({ moments: [], documents: [], baby: null, ...over }) as Parameters<
      typeof cancelUploads
    >[1]['records'];

  const deps = (rec: ReturnType<typeof records>) => {
    const order: string[] = [];
    const writes: [string, unknown, string][] = [];
    return {
      order,
      writes,
      value: {
        records: rec,
        write: async (collection: string, data: unknown, id: string) => {
          order.push('write');
          writes.push([collection, data, id]);
        },
        queue: {
          cancel: async () => {
            order.push('cancel');
          },
        },
      } as unknown as Parameters<typeof cancelUploads>[1],
    };
  };

  it('文字和别的文件保留，新版本写的未知字段也保留', async () => {
    const a = randomUUID();
    const b = randomUUID();
    const d = deps(
      records({
        moments: [moment('m1', [ref(a), ref(b)], { text: '第一次笑', future: 'keep' })] as never,
      }),
    );
    await cancelUploads([a], d.value);
    expect(d.writes).toHaveLength(1);
    const written = d.writes[0]?.[1] as { media: MediaRef[]; text: string; future: string };
    expect(written.media.map((m) => m.id)).toEqual([b]);
    expect(written.text).toBe('第一次笑');
    expect(written.future).toBe('keep');
  });

  it('一条回忆取消 100 个文件只写一次', async () => {
    const ids = Array.from({ length: 100 }, () => randomUUID());
    const d = deps(
      records({
        moments: [
          moment(
            'm1',
            ids.map((id) => ref(id)),
          ),
        ] as never,
      }),
    );
    await cancelUploads(ids, d.value);
    expect(d.writes).toHaveLength(1);
  });

  it('先写记录再取消任务：中途被杀最多多传一个没人引用的文件，不会留下打不开的占位', async () => {
    const a = randomUUID();
    const d = deps(records({ moments: [moment('m1', [ref(a)])] as never }));
    await cancelUploads([a], d.value);
    expect(d.order).toEqual(['write', 'cancel']);
  });

  it('证件和头像也能去掉；档案其余字段不动', async () => {
    const file = randomUUID();
    const avatar = randomUUID();
    const d = deps(
      records({
        documents: [{ id: 'd1', data: { name: '虚构证件', files: [ref(file)] } }] as never,
        baby: {
          id: 'b1',
          data: { name: '小豆', birthAt: 1, avatar: ref(avatar), region: 'SG' },
        } as never,
      }),
    );
    await cancelUploads([file, avatar], d.value);
    const byCollection = new Map(d.writes.map(([c, data]) => [c, data as Record<string, unknown>]));
    expect(byCollection.get('document')?.files).toEqual([]);
    expect(byCollection.get('document')?.name).toBe('虚构证件');
    expect('avatar' in (byCollection.get('baby') ?? {})).toBe(false);
    expect(byCollection.get('baby')?.region).toBe('SG');
  });

  it('文件不属于任何记录时不写记录，任务照样取消', async () => {
    const d = deps(records());
    await cancelUploads([randomUUID()], d.value);
    expect(d.order).toEqual(['cancel']);
  });

  it('空回忆不删，只提示', () => {
    const a = randomUUID();
    const b = randomUUID();
    const rec = records({
      moments: [
        moment('empty', [ref(a)]),
        moment('text', [ref(b)], { text: '有字' }),
        moment('title', [ref(randomUUID())], { title: '有标题' }),
      ] as never,
    });
    expect(momentsLeftEmpty(rec, new Set([a, b]))).toBe(1);
    expect(momentsLeftEmpty(rec, new Set([b]))).toBe(0);
  });

  it('反查文件属于哪条记录', () => {
    const a = randomUUID();
    const f = randomUUID();
    const v = randomUUID();
    const owners = uploadOwners(
      records({
        moments: [moment('m1', [ref(a)], { title: '第一次' })] as never,
        documents: [{ id: 'd1', data: { name: '虚构证件', files: [ref(f)] } }] as never,
        baby: { id: 'b1', data: { name: '小豆', birthAt: 1, avatar: ref(v) } } as never,
      }),
    );
    expect(owners.get(a)).toMatchObject({ kind: 'moment', title: '第一次' });
    expect(owners.get(f)).toMatchObject({ kind: 'document', title: '虚构证件' });
    expect(owners.get(v)).toEqual({ kind: 'avatar' });
  });

  it('shared 的两个函数：没有引用时返回 null', () => {
    const data = { title: 'x', text: '', at: 1, milestone: false, media: [ref(randomUUID())] };
    expect(withoutMedia('moment', data, new Set([randomUUID()]))).toBeNull();
    expect(mediaRefsIn('event', {})).toEqual([]);
  });
});
