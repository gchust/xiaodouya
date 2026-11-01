import { randomUUID } from 'node:crypto';
import type { SyncResponse } from '@xiaodouya/shared';
import { describe, expect, it } from 'vitest';
import { type LocalDb, RecordStore, type StoredRecord } from '../src/data/store';
import { SyncEngine, type SyncTransport } from '../src/data/syncEngine';
import {
  type UploadJob,
  UploadQueue,
  type UploadQueueDb,
  type UploadTransport,
} from '../src/data/uploadQueue';

/**
 * 删除账号或退出时要清空手机上的数据。这里测的是清空之后还在路上的请求：
 * 响应晚到时不能把别人的数据、已删除账号的数据写回来。
 */
class MemoryDb implements LocalDb, UploadQueueDb {
  records = new Map<string, StoredRecord>();
  cursor = 0;
  meta = new Map<string, string>();
  jobs = new Map<string, UploadJob>();
  async loadAll() {
    return [...this.records.values()];
  }
  async put(r: StoredRecord) {
    this.records.set(r.id, r);
  }
  async putMany(rs: StoredRecord[], cursor: number) {
    for (const r of rs) this.records.set(r.id, r);
    this.cursor = cursor;
  }
  async getCursor() {
    return this.cursor;
  }
  async getMeta(key: string) {
    return this.meta.get(key) ?? null;
  }
  async setMeta(key: string, value: string) {
    this.meta.set(key, value);
  }
  async deleteCollections() {}
  async clear() {
    this.records.clear();
    this.cursor = 0;
    this.meta.clear();
    this.jobs.clear();
  }
  async loadJobs() {
    return [...this.jobs.values()];
  }
  async saveJob(j: UploadJob) {
    this.jobs.set(j.key, { ...j });
  }
  async deleteJob(k: string) {
    this.jobs.delete(k);
  }
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const response = (): SyncResponse => ({
  cursor: 7,
  hasMore: false,
  rejected: [],
  role: 'admin',
  records: [
    {
      id: randomUUID(),
      collection: 'event',
      data: { type: 'feed', at: 1000, ml: 90 },
      deleted: false,
      updatedAt: 1000,
      seq: 7,
      createdBy: null,
    },
  ],
});

describe('清空手机数据之后还在路上的同步', () => {
  it('响应晚到不能把记录写回来，也不能标记“同步过”', async () => {
    const db = new MemoryDb();
    const store = new RecordStore(db);
    const pending = deferred<SyncResponse>();
    const transport: SyncTransport = {
      sync: () => pending.promise,
      wait: (_c, signal) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => resolve({ changed: false }));
        }),
    };
    let synced = 0;
    const engine = new SyncEngine(store, db, transport, {
      onSynced: () => {
        synced += 1;
      },
    });
    const running = engine.start();
    await new Promise((r) => setTimeout(r, 0));

    engine.stop();
    await store.clear();
    pending.resolve(response());
    await running;

    expect(store.getSnapshot().events).toEqual([]);
    expect(db.records.size).toBe(0);
    expect(db.cursor).toBe(0);
    expect(synced).toBe(0);
  });

  it('正常运行时响应照常写入', async () => {
    const db = new MemoryDb();
    const store = new RecordStore(db);
    const transport: SyncTransport = {
      sync: async () => response(),
      wait: (_c, signal) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => resolve({ changed: false }));
        }),
    };
    const engine = new SyncEngine(store, db, transport);
    await engine.start();
    engine.stop();
    expect(store.getSnapshot().events).toHaveLength(1);
  });
});

const jobInput = () => ({
  id: randomUUID(),
  variant: 'original' as const,
  scope: 'memory' as const,
  localUri: 'file:///a.jpg',
  mime: 'image/jpeg',
  size: 100,
  wifiOnly: false,
});

describe('清空手机数据之后还在路上的上传', () => {
  function transport(put: UploadTransport['put']): UploadTransport {
    return {
      requestUrl: async () => ({ url: 'https://s3.test/x', headers: {}, expiresIn: 3600 }),
      put,
      complete: async () => {},
      removeLocal: async () => {},
    };
  }

  it('失败的响应晚到，不能把任务写回数据库：否则下一个登录的人会看到它', async () => {
    const db = new MemoryDb();
    const pending = deferred<{ status: number }>();
    const queue = new UploadQueue(
      db,
      transport(() => pending.promise),
    );
    queue.setNetwork('wifi');
    await queue.enqueue([jobInput()]);
    await new Promise((r) => setTimeout(r, 0));

    queue.reset();
    await db.clear();
    pending.reject(new Error('unauthenticated'));
    await queue.idle();

    expect(db.jobs.size).toBe(0);
  });

  it('reset 清掉内存里的任务和进度，上传卡片不再显示', async () => {
    const db = new MemoryDb();
    const queue = new UploadQueue(
      db,
      transport(() => new Promise(() => {})),
    );
    queue.setNetwork('wifi');
    await queue.enqueue([jobInput()]);
    expect(queue.getProgress().total).toBe(1);
    let notified = 0;
    queue.subscribe(() => {
      notified += 1;
    });

    queue.reset();

    expect(queue.getProgress().total).toBe(0);
    expect(queue.getProgress().failedCount).toBe(0);
    expect(queue.pendingIds().size).toBe(0);
    expect(notified).toBeGreaterThan(0);
  });

  it('reset 之后重新登录可以正常传', async () => {
    const db = new MemoryDb();
    let puts = 0;
    const queue = new UploadQueue(
      db,
      transport(async (job, _t, onProgress) => {
        puts += 1;
        onProgress(job.size);
        return { status: 200 };
      }),
    );
    queue.setNetwork('wifi');
    queue.reset();
    await queue.load();
    await queue.enqueue([jobInput()]);
    await queue.idle();
    expect(puts).toBe(1);
    expect(db.jobs.size).toBe(0);
  });
});
