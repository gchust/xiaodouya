import { randomUUID } from 'node:crypto';
import type { ServerRecord, SyncRequest, SyncResponse, UploadUrlRequest } from '@xiaodouya/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { type LocalDb, RecordStore, type StoredRecord } from '../src/data/store';
import { SyncEngine, type SyncTransport } from '../src/data/syncEngine';
import {
  UploadHttpError,
  type UploadJob,
  UploadQueue,
  type UploadQueueDb,
  type UploadTransport,
} from '../src/data/uploadQueue';

class MemoryDb implements LocalDb, UploadQueueDb {
  records = new Map<string, StoredRecord>();
  cursor = 0;
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
  async clear() {
    this.records.clear();
    this.cursor = 0;
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

/** 模拟服务端：行为和 apps/server 的同步接口保持一致。 */
class FakeServer implements SyncTransport {
  log: ServerRecord[] = [];
  seq = 0;
  offline = false;
  requests: SyncRequest[] = [];
  rejectIds = new Set<string>();
  pageSize = 500;

  async sync(req: SyncRequest): Promise<SyncResponse> {
    this.requests.push(req);
    if (this.offline) throw new Error('network');
    const rejected: SyncResponse['rejected'] = [];
    const conflicted: ServerRecord[] = [];
    for (const change of req.changes) {
      if (this.rejectIds.has(change.id)) {
        rejected.push({ id: change.id, reason: 'invalid' });
        continue;
      }
      const existing = this.log.find((r) => r.id === change.id);
      if (existing && change.updatedAt <= existing.updatedAt) {
        conflicted.push(existing);
        continue;
      }
      this.log = this.log.filter((r) => r.id !== change.id);
      this.log.push({ ...change, seq: ++this.seq, createdBy: null });
    }
    const after = this.log.filter((r) => r.seq > req.cursor).sort((a, b) => a.seq - b.seq);
    const page = after.slice(0, this.pageSize);
    const hasMore = after.length > this.pageSize;
    const records = [...page, ...conflicted.filter((c) => !page.some((p) => p.id === c.id))];
    return { cursor: hasMore ? page[page.length - 1]!.seq : this.seq, hasMore, records, rejected };
  }
  async wait(_cursor: number, signal: AbortSignal) {
    await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
    return { changed: false };
  }
}

const feed = (ml = 90, at = 1000) => ({ type: 'feed' as const, at, ml });

function device(server: FakeServer, options: { now?: () => number } = {}) {
  const db = new MemoryDb();
  const store = new RecordStore(db, options);
  const remote: ServerRecord[] = [];
  const engine = new SyncEngine(store, db, server, { onRemote: (r) => remote.push(...r) });
  return { db, store, engine, remote };
}

describe('离线优先的记录和同步', () => {
  let server: FakeServer;
  beforeEach(() => {
    server = new FakeServer();
  });

  it('断网时记录立即可见，恢复后自动上传', async () => {
    const a = device(server);
    server.offline = true;
    await a.engine.start();
    await a.store.write('event', randomUUID(), feed());
    expect(a.store.getSnapshot().events).toHaveLength(1);
    expect(a.store.getSnapshot().pendingCount).toBe(1);
    await a.engine.syncNow();
    expect(a.store.getSnapshot().pendingCount).toBe(1);
    server.offline = false;
    await a.engine.syncNow();
    expect(a.store.getSnapshot().pendingCount).toBe(0);
    expect(server.log).toHaveLength(1);
    a.engine.stop();
  });

  it('两台设备互相看到对方的记录，且能分辨是别人写的', async () => {
    const a = device(server);
    const b = device(server);
    await a.engine.start();
    await b.engine.start();
    await a.store.write('event', randomUUID(), feed(120));
    await a.engine.syncNow();
    await b.engine.syncNow();
    expect(b.store.getSnapshot().events[0]?.data).toMatchObject({ ml: 120 });
    expect(b.remote).toHaveLength(1);
    expect(a.remote).toHaveLength(0);
    a.engine.stop();
    b.engine.stop();
  });

  it('App 重启后，未上传的记录和游标都还在', async () => {
    const db = new MemoryDb();
    const first = new RecordStore(db);
    await first.write('event', 'b8f2a1e4-0000-4000-8000-000000000001', feed());
    const second = new RecordStore(db);
    await second.load();
    expect(second.getSnapshot().events).toHaveLength(1);
    expect(second.getSnapshot().pendingCount).toBe(1);
  });

  it('删除作为软删除同步，其他设备也看不到了', async () => {
    const a = device(server);
    const b = device(server);
    await a.engine.start();
    await b.engine.start();
    const id = randomUUID();
    await a.store.write('event', id, feed());
    await a.engine.syncNow();
    await b.engine.syncNow();
    expect(b.store.getSnapshot().events).toHaveLength(1);
    await a.store.remove(id);
    await a.engine.syncNow();
    await b.engine.syncNow();
    expect(b.store.getSnapshot().events).toHaveLength(0);
    a.engine.stop();
    b.engine.stop();
  });

  it('上传途中用户又修改：新改动不会被标记成已同步', async () => {
    const a = device(server);
    const id = randomUUID();
    await a.store.write('event', id, feed(90));
    const sent = a.store.dirtyRecords(10);
    await a.store.write('event', id, feed(100));
    await a.store.applySyncResult(sent, [], new Set(), 1);
    expect(a.store.getSnapshot().pendingCount).toBe(1);
    expect(a.store.getSnapshot().events[0]?.data).toMatchObject({ ml: 100 });
  });

  it('被服务端拒绝的记录不会卡住发件箱', async () => {
    const a = device(server);
    await a.engine.start();
    const bad = randomUUID();
    server.rejectIds.add(bad);
    await a.store.write('event', bad, feed());
    await a.store.write('event', randomUUID(), feed(100));
    await a.engine.syncNow();
    expect(a.store.getSnapshot().pendingCount).toBe(0);
    expect(server.log).toHaveLength(1);
    a.engine.stop();
  });

  it('手机时钟比服务端版本慢时，本地修改仍然生效', async () => {
    let now = 5000;
    const a = device(server, { now: () => now });
    const id = randomUUID();
    await a.engine.start();
    await a.store.write('event', id, feed(90));
    await a.engine.syncNow();
    now = 100;
    await a.store.write('event', id, feed(150));
    await a.engine.syncNow();
    expect(server.log[0]?.data).toMatchObject({ ml: 150 });
    a.engine.stop();
  });

  it('旧版本改动被拒时，客户端收敛到服务端的新版本', async () => {
    const a = device(server, { now: () => 100 });
    const b = device(server, { now: () => 900 });
    const id = randomUUID();
    await a.engine.start();
    await b.engine.start();
    await b.store.write('event', id, feed(200));
    await b.engine.syncNow();
    await a.engine.syncNow();
    await a.store.write('event', id, feed(1));
    expect(a.store.getSnapshot().events[0]?.data).toMatchObject({ ml: 1 });
    await a.engine.syncNow();
    expect(server.log[0]?.data).toMatchObject({ ml: 1 });
    a.engine.stop();
    b.engine.stop();
  });

  it('大量记录分页上传和拉取，全部同步', async () => {
    server.pageSize = 50;
    const a = device(server);
    const b = device(server);
    await a.engine.start();
    await b.engine.start();
    for (let i = 0; i < 450; i++) await a.store.write('event', randomUUID(), feed(90, i));
    await a.engine.syncNow();
    await b.engine.syncNow();
    expect(server.log).toHaveLength(450);
    expect(b.store.getSnapshot().events).toHaveLength(450);
    a.engine.stop();
    b.engine.stop();
  });

  it('无法解析的数据不影响其他记录，也不会被覆盖丢失', async () => {
    const a = device(server);
    await a.engine.start();
    server.log.push({
      id: randomUUID(),
      collection: 'event',
      data: { type: 'future-type', at: 1 },
      deleted: false,
      updatedAt: 1,
      seq: ++server.seq,
      createdBy: null,
    });
    await a.store.write('event', randomUUID(), feed());
    await a.engine.syncNow();
    expect(a.store.getSnapshot().events).toHaveLength(1);
    expect(a.db.records.size).toBe(2);
    a.engine.stop();
  });

  it('退出登录时清空本地数据', async () => {
    const a = device(server);
    await a.store.write('event', randomUUID(), feed());
    await a.store.clear();
    expect(a.store.getSnapshot().events).toHaveLength(0);
    expect(await a.db.loadAll()).toHaveLength(0);
  });
});

function fakeUploads(overrides: Partial<UploadTransport> = {}) {
  const calls: string[] = [];
  const transport: UploadTransport = {
    async requestUrl(req: UploadUrlRequest) {
      calls.push(`url:${req.id}/${req.variant}`);
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
    ...overrides,
  };
  return { transport, calls };
}

const job = (over: Partial<Omit<UploadJob, 'key' | 'attempts'>> = {}) => ({
  id: randomUUID(),
  variant: 'original' as const,
  scope: 'memory' as const,
  localUri: 'file:///a.jpg',
  mime: 'image/jpeg',
  size: 100,
  wifiOnly: false,
  ...over,
});

describe('上传队列', () => {
  it('按顺序申请链接、上传、确认，并清理本地副本', async () => {
    const { transport, calls } = fakeUploads();
    const db = new MemoryDb();
    const queue = new UploadQueue(db, transport);
    const j = job();
    await queue.enqueue([j]);
    await queue.idle();
    expect(calls).toEqual([
      `url:${j.id}/original`,
      `put:${j.id}/original`,
      `done:${j.id}/original`,
      'rm:file:///a.jpg',
    ]);
    expect(db.jobs.size).toBe(0);
    expect(queue.getProgress().total).toBe(0);
  });

  it('App 被杀后，重启时接着传', async () => {
    const db = new MemoryDb();
    const stuck = fakeUploads({ put: () => new Promise(() => {}) });
    const first = new UploadQueue(db, stuck.transport);
    await first.enqueue([job()]);
    expect(db.jobs.size).toBe(1);
    first.stop();

    const { transport, calls } = fakeUploads();
    const second = new UploadQueue(db, transport);
    await second.load();
    await second.idle();
    expect(calls.some((c) => c.startsWith('done:'))).toBe(true);
    expect(db.jobs.size).toBe(0);
  });

  it('网络失败后自动重试，不丢任务', async () => {
    let attempts = 0;
    const { transport } = fakeUploads({
      put: async (j, _t, onProgress) => {
        attempts += 1;
        if (attempts < 3) throw new Error('network');
        onProgress(j.size);
        return { status: 200 };
      },
    });
    const db = new MemoryDb();
    const queue = new UploadQueue(db, transport, { sleepMs: () => 1 });
    await queue.enqueue([job()]);
    await new Promise((r) => setTimeout(r, 50));
    await queue.idle();
    expect(attempts).toBe(3);
    expect(db.jobs.size).toBe(0);
    queue.stop();
  });

  it('S3 返回错误（如链接过期）时重新申请链接重试', async () => {
    let puts = 0;
    let urls = 0;
    const { transport } = fakeUploads({
      requestUrl: async () => {
        urls += 1;
        return { url: 'u', headers: {}, expiresIn: 1 };
      },
      put: async () => {
        puts += 1;
        return { status: puts === 1 ? 403 : 200 };
      },
    });
    const queue = new UploadQueue(new MemoryDb(), transport, { sleepMs: () => 1 });
    await queue.enqueue([job()]);
    await new Promise((r) => setTimeout(r, 30));
    await queue.idle();
    expect(puts).toBe(2);
    expect(urls).toBe(2);
    queue.stop();
  });

  it('类型被拒这种永久错误不再重试，并显示失败，也不影响后面的文件', async () => {
    let urlCalls = 0;
    const bad = job();
    const good = job();
    const { transport, calls } = fakeUploads({
      requestUrl: async (req) => {
        urlCalls += 1;
        if (req.id === bad.id) throw new UploadHttpError(400, 'bad_type', '不支持这种文件类型');
        return { url: 'u', headers: {}, expiresIn: 1 };
      },
    });
    const db = new MemoryDb();
    const queue = new UploadQueue(db, transport, { sleepMs: () => 1 });
    await queue.enqueue([bad, good]);
    await new Promise((r) => setTimeout(r, 30));
    await queue.idle();
    expect(queue.getProgress().failedCount).toBe(1);
    expect(calls.some((c) => c.includes(good.id))).toBe(true);
    expect(urlCalls).toBe(2);
    expect(db.jobs.size).toBe(1);
    queue.stop();
  });

  it('用户点重试后恢复失败的任务', async () => {
    let reject = true;
    const { transport } = fakeUploads({
      requestUrl: async () => {
        if (reject) throw new UploadHttpError(400, 'bad_type', 'no');
        return { url: 'u', headers: {}, expiresIn: 1 };
      },
    });
    const db = new MemoryDb();
    const queue = new UploadQueue(db, transport, { sleepMs: () => 1 });
    await queue.enqueue([job()]);
    await queue.idle();
    expect(queue.getProgress().failedCount).toBe(1);
    reject = false;
    await queue.retryFailed();
    await queue.idle();
    expect(queue.getProgress().failedCount).toBe(0);
    expect(db.jobs.size).toBe(0);
  });

  it('上次传完没来得及更新队列（already_uploaded）算成功', async () => {
    const { transport } = fakeUploads({
      requestUrl: async () => {
        throw new UploadHttpError(409, 'already_uploaded', '已上传');
      },
    });
    const db = new MemoryDb();
    const queue = new UploadQueue(db, transport);
    await queue.enqueue([job()]);
    await queue.idle();
    expect(db.jobs.size).toBe(0);
    expect(queue.getProgress().failedCount).toBe(0);
  });

  it('视频开启仅 Wi-Fi 时，流量下等待，连上 Wi-Fi 后才传；照片不受影响', async () => {
    const { transport, calls } = fakeUploads();
    const queue = new UploadQueue(new MemoryDb(), transport);
    queue.setNetwork('cellular');
    const video = job({ wifiOnly: true, mime: 'video/mp4' });
    const photo = job();
    await queue.enqueue([video, photo]);
    await queue.idle();
    expect(calls.some((c) => c.includes(photo.id))).toBe(true);
    expect(calls.some((c) => c.includes(video.id))).toBe(false);
    expect(queue.getProgress().waitingForWifi).toBe(true);
    queue.setNetwork('wifi');
    await queue.idle();
    expect(calls.some((c) => c.includes(video.id))).toBe(true);
  });

  it('断网时不尝试，恢复后继续', async () => {
    const { transport, calls } = fakeUploads();
    const queue = new UploadQueue(new MemoryDb(), transport);
    queue.setNetwork('none');
    await queue.enqueue([job()]);
    await queue.idle();
    expect(calls).toEqual([]);
    queue.setNetwork('cellular');
    await queue.idle();
    expect(calls.some((c) => c.startsWith('done:'))).toBe(true);
  });

  it('进度按字节累计，并在结束后归零', async () => {
    const seen: number[] = [];
    const { transport } = fakeUploads({
      put: async (j, _t, onProgress) => {
        onProgress(j.size / 2);
        onProgress(j.size);
        return { status: 200 };
      },
    });
    const queue = new UploadQueue(new MemoryDb(), transport);
    queue.subscribe(() => seen.push(queue.getProgress().fraction));
    await queue.enqueue([job({ size: 100 }), job({ size: 300 })]);
    await queue.idle();
    expect(seen.some((f) => f > 0 && f < 1)).toBe(true);
    for (let i = 1; i < seen.length; i++) {
      if (queue.getProgress().total > 0) expect(seen[i]!).toBeGreaterThanOrEqual(seen[i - 1]!);
    }
    expect(queue.getProgress().total).toBe(0);
  });
});
