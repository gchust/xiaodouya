import { randomUUID } from 'node:crypto';
import {
  type EventData,
  estimateNextFeed,
  type MediaRef,
  type MomentData,
  mergeEdit,
  mergeMediaEdit,
  type ServerRecord,
  type SyncRequest,
  type SyncResponse,
  type UploadUrlRequest,
} from '@xiaodouya/shared';
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
  meta = new Map<string, string>();
  async getMeta(key: string) {
    return this.meta.get(key) ?? null;
  }
  async setMeta(key: string, value: string) {
    this.meta.set(key, value);
  }
  async deleteCollections(collections: readonly string[]) {
    for (const [id, r] of this.records)
      if (collections.includes(r.collection)) this.records.delete(id);
  }
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

/** 模拟服务端：行为和 apps/server 的同步接口保持一致。 */
class FakeServer implements SyncTransport {
  log: ServerRecord[] = [];
  seq = 0;
  offline = false;
  requests: SyncRequest[] = [];
  rejectIds = new Set<string>();
  pageSize = 500;
  role: 'admin' | 'caregiver' | 'viewer' = 'admin';
  hideEvents = false;

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
    const after = this.log
      .filter((r) => r.seq > req.cursor)
      .filter((r) => !this.hideEvents || (r.collection !== 'event' && r.collection !== 'document'))
      .sort((a, b) => a.seq - b.seq);
    const page = after.slice(0, this.pageSize);
    const hasMore = after.length > this.pageSize;
    const records = [...page, ...conflicted.filter((c) => !page.some((p) => p.id === c.id))];
    return {
      cursor: hasMore ? page[page.length - 1]!.seq : this.seq,
      hasMore,
      records,
      rejected,
      role: this.role,
    };
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

  it('一批记录太大时分几次发，不会撞上服务端的请求体上限永远卡住', async () => {
    const a = device(server);
    await a.engine.start();
    // 200 封长信，每封 2 万字（UTF-8 约 60 KB），一次发就是 12 MB，服务端上限是 5 MB。
    const text = '字'.repeat(20_000);
    const sizes: number[] = [];
    const original = server.sync.bind(server);
    server.sync = async (req) => {
      const bytes = Buffer.byteLength(JSON.stringify(req));
      sizes.push(bytes);
      if (bytes > 5 * 1024 * 1024) throw new Error('413');
      return original(req);
    };
    for (let i = 0; i < 200; i++) {
      await a.store.write('letter', randomUUID(), { title: '', text, at: 1000 + i });
    }
    await a.engine.syncNow();
    expect(a.store.getSnapshot().pendingCount).toBe(0);
    expect(server.log).toHaveLength(200);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(5 * 1024 * 1024);
  });

  it('单条就超过分批大小时也要发出去，不能被挡在队列里', async () => {
    const a = device(server);
    await a.engine.start();
    await a.store.write('letter', randomUUID(), {
      title: '',
      text: 'x'.repeat(4 * 1024 * 1024),
      at: 1000,
    });
    await a.store.write('event', randomUUID(), feed());
    await a.engine.syncNow();
    expect(a.store.getSnapshot().pendingCount).toBe(0);
    expect(server.log).toHaveLength(2);
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

  it('离开时家人记了很多条：分几页拉回来，也只通知一次', async () => {
    const a = device(server);
    const db = new MemoryDb();
    const calls: number[] = [];
    const b = new SyncEngine(new RecordStore(db), db, server, {
      onRemote: (r) => calls.push(r.length),
    });
    await a.engine.start();
    await b.start();
    for (let i = 0; i < 5; i++) await a.store.write('event', randomUUID(), feed(60 + i, 1000 + i));
    await a.engine.syncNow();
    server.pageSize = 2;
    await b.syncNow();
    expect(calls).toEqual([5]);
    a.engine.stop();
    b.stop();
  });

  it('新设备第一次拉取全部历史时不算“家人刚记的”', async () => {
    const a = device(server);
    await a.engine.start();
    await a.store.write('event', randomUUID(), feed(120));
    await a.engine.syncNow();
    const b = device(server);
    await b.engine.start();
    expect(b.store.getSnapshot().events).toHaveLength(1);
    expect(b.remote).toHaveLength(0);
    // 之后别人再写的要提示。
    await a.store.write('event', randomUUID(), feed(90, 2000));
    await a.engine.syncNow();
    await b.engine.syncNow();
    expect(b.remote).toHaveLength(1);
    a.engine.stop();
    b.engine.stop();
  });

  it('权限升级后从头重新拉取的历史也不算“家人刚记的”', async () => {
    server.role = 'viewer';
    server.hideEvents = true;
    const b = device(server);
    await b.engine.start();
    const a = device(server);
    await a.engine.start();
    await a.store.write('event', randomUUID(), feed(120));
    await a.engine.syncNow();
    // 游标越过这条读不到的记录，升级后要从头拉才能拿到它。
    await b.engine.syncNow();
    server.role = 'caregiver';
    server.hideEvents = false;
    await b.engine.syncNow();
    expect(b.store.getSnapshot().events).toHaveLength(1);
    expect(b.remote).toHaveLength(0);
    a.engine.stop();
    b.engine.stop();
  });

  it('同步中途断网：已经写进本地的也要提示，否则下一轮游标已过，再也提示不了', async () => {
    const a = device(server);
    const b = device(server);
    await a.engine.start();
    await b.engine.start();
    for (let i = 0; i < 3; i++) await a.store.write('event', randomUUID(), feed(60 + i, 1000 + i));
    await a.engine.syncNow();
    server.pageSize = 2;
    const original = server.sync.bind(server);
    let calls = 0;
    server.sync = async (req) => {
      calls += 1;
      if (calls === 2) throw new Error('network');
      return original(req);
    };
    await b.engine.syncNow();
    expect(b.remote).toHaveLength(2);
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

  it('奶粉配置不进时间线，能同步给家人，新版记录的快照原样保留', async () => {
    const a = device(server);
    const b = device(server);
    await a.engine.start();
    await b.engine.start();
    const formulaId = randomUUID();
    await a.store.write('event', formulaId, {
      type: 'formula',
      name: '虚构奶粉',
      basis: 'per100ml',
      values: { proteinG: 1.4 },
    });
    await a.store.write('event', randomUUID(), {
      ...feed(),
      milkType: 'formula',
      formulaId,
      formula: { name: '虚构奶粉', per100ml: { proteinG: 1.4 } },
    });
    await a.engine.syncNow();
    await b.engine.syncNow();
    const snapshot = b.store.getSnapshot();
    expect(snapshot.formulas.map((f) => f.id)).toEqual([formulaId]);
    expect(snapshot.events).toHaveLength(1);
    const data = snapshot.events[0]?.data;
    expect(data?.type === 'feed' && data.formula?.per100ml.proteinG).toBe(1.4);
    a.engine.stop();
    b.engine.stop();
  });

  it('删掉奶粉后列表里没有了，记录还在', async () => {
    const a = device(server);
    await a.engine.start();
    const formulaId = randomUUID();
    await a.store.write('event', formulaId, {
      type: 'formula',
      name: '虚构奶粉',
      basis: 'per100ml',
      values: {},
    });
    await a.store.remove(formulaId);
    expect(a.store.getSnapshot().formulas).toEqual([]);
    expect(a.db.records.get(formulaId)?.deleted).toBe(true);
    a.engine.stop();
  });

  it('降级成 viewer 时奶粉配置和喂奶一起清掉', async () => {
    const a = device(server);
    await a.engine.start();
    await a.store.write('event', randomUUID(), {
      type: 'formula',
      name: '虚构奶粉',
      basis: 'per100ml',
      values: {},
    });
    await a.engine.syncNow();
    server.role = 'viewer';
    server.hideEvents = true;
    await a.engine.syncNow();
    expect(a.store.getSnapshot().formulas).toEqual([]);
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

  it('空间满了算永久失败：显示原因，不反复重试，腾出空间后点重试能传上去', async () => {
    let full = true;
    let urlCalls = 0;
    const message = '存储空间已满（共 5.0 GB），删除一些回忆或证件后可以重试';
    const { transport, calls } = fakeUploads({
      requestUrl: async () => {
        urlCalls += 1;
        if (full) throw new UploadHttpError(413, 'quota_exceeded', message);
        return { url: 'u', headers: {}, expiresIn: 1 };
      },
    });
    const db = new MemoryDb();
    const queue = new UploadQueue(db, transport, { sleepMs: () => 1 });
    await queue.enqueue([job()]);
    await queue.idle();
    await new Promise((r) => setTimeout(r, 20));
    await queue.idle();
    expect(queue.getProgress().failedCount).toBe(1);
    expect(queue.getProgress().failedReason).toBe(message);
    expect(urlCalls).toBe(1);
    // 重启后也还记得原因，文件没有丢。
    expect([...db.jobs.values()][0]?.failed).toBe(message);

    full = false;
    await queue.retryFailed();
    await queue.idle();
    expect(queue.getProgress().failedCount).toBe(0);
    expect(queue.getProgress().failedReason).toBeNull();
    expect(db.jobs.size).toBe(0);
    expect(calls.some((c) => c.startsWith('done:'))).toBe(true);
    queue.stop();
  });

  it('确认时才发现满了（预留过期）也一样：显示原因，重试时重新走一遍上传', async () => {
    let full = true;
    const message = '存储空间已满';
    const { transport, calls } = fakeUploads({
      complete: async () => {
        if (full) throw new UploadHttpError(413, 'quota_exceeded', message);
      },
    });
    const db = new MemoryDb();
    const queue = new UploadQueue(db, transport, { sleepMs: () => 1 });
    const j = job();
    await queue.enqueue([j]);
    await queue.idle();
    expect(queue.getProgress().failedReason).toBe(message);
    full = false;
    await queue.retryFailed();
    await queue.idle();
    expect(db.jobs.size).toBe(0);
    expect(calls.filter((c) => c.startsWith('put:'))).toHaveLength(2);
    queue.stop();
  });

  it('被限流不是失败：退避后自动继续，不打扰用户', async () => {
    let limited = true;
    const { transport } = fakeUploads({
      requestUrl: async () => {
        if (limited) throw new UploadHttpError(429, 'rate_limited', '上传太频繁了');
        return { url: 'u', headers: {}, expiresIn: 1 };
      },
    });
    const db = new MemoryDb();
    const queue = new UploadQueue(db, transport, { sleepMs: () => 5 });
    await queue.enqueue([job()]);
    await queue.idle();
    expect(queue.getProgress().failedCount).toBe(0);
    expect(queue.getProgress().total).toBe(1);
    limited = false;
    await new Promise((r) => setTimeout(r, 30));
    await queue.idle();
    expect(db.jobs.size).toBe(0);
    queue.stop();
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

describe('修改已有记录', () => {
  const HOUR = 3_600_000;

  it('改时间后立刻按新时间排序，距上次喂奶也跟着变，订阅者会收到通知（喂奶提醒靠它重算）', async () => {
    const now = 100 * HOUR;
    const server = new FakeServer();
    const a = device(server);
    const older = randomUUID();
    const newer = randomUUID();
    await a.store.write('event', older, feed(60, now - 3 * HOUR));
    await a.store.write('event', newer, feed(120, now - HOUR));
    let notified = 0;
    a.store.subscribe(() => {
      notified += 1;
    });
    const estimate = () =>
      estimateNextFeed(
        a.store.getSnapshot().events.map((e) => e.data),
        now,
      );
    expect(estimate().last?.ml).toBe(120);
    await a.store.write('event', newer, feed(120, now - 5 * HOUR));
    expect(notified).toBe(1);
    expect(a.store.getSnapshot().events[0]?.id).toBe(older);
    expect(estimate().last?.ml).toBe(60);
    expect(estimate().sinceMs).toBe(3 * HOUR);
  });

  it('离线时也能改，联网后同步给家人，新版本写的未知字段不丢', async () => {
    const server = new FakeServer();
    const a = device(server);
    const b = device(server);
    await a.engine.start();
    await b.engine.start();
    const id = randomUUID();
    const fromNewerVersion = {
      ...feed(90, 5000),
      byName: '妈妈',
      milkKind: 'formula',
      future: { nested: true },
    };
    await a.store.write('event', id, fromNewerVersion);
    await a.engine.syncNow();
    await b.engine.syncNow();

    server.offline = true;
    const base = b.store.getSnapshot().events[0]?.data as EventData;
    expect(base).toMatchObject({ milkKind: 'formula' });
    await b.store.write('event', id, mergeEdit(base, base, { ...base, at: 4000, ml: 100 }));
    expect(b.store.getSnapshot().events[0]?.data).toMatchObject({ at: 4000, ml: 100 });
    expect(b.store.getSnapshot().pendingCount).toBe(1);
    await b.engine.syncNow();
    expect(b.store.getSnapshot().pendingCount).toBe(1);

    server.offline = false;
    await b.engine.syncNow();
    await a.engine.syncNow();
    expect(a.store.getSnapshot().events[0]?.data).toEqual({
      ...fromNewerVersion,
      at: 4000,
      ml: 100,
    });
    a.engine.stop();
    b.engine.stop();
  });

  it('两个人离线改同一条，后写胜出，两边收敛', async () => {
    const server = new FakeServer();
    let clock = 1000;
    const a = device(server, { now: () => clock });
    const b = device(server, { now: () => clock });
    await a.engine.start();
    await b.engine.start();
    const id = randomUUID();
    await a.store.write('event', id, feed(90));
    await a.engine.syncNow();
    await b.engine.syncNow();
    server.offline = true;
    clock = 2000;
    await a.store.write('event', id, feed(100));
    clock = 3000;
    await b.store.write('event', id, feed(110));
    server.offline = false;
    await b.engine.syncNow();
    await a.engine.syncNow();
    await b.engine.syncNow();
    expect(a.store.getSnapshot().events[0]?.data).toMatchObject({ ml: 110 });
    expect(b.store.getSnapshot().events[0]?.data).toMatchObject({ ml: 110 });
    a.engine.stop();
    b.engine.stop();
  });

  it('修改回忆：移除只摘掉引用，家人同时加的文件和未知字段都在', async () => {
    const server = new FakeServer();
    const a = device(server);
    const id = randomUUID();
    const media = (name: string): MediaRef => ({
      id: randomUUID(),
      kind: 'image',
      mime: 'image/png',
      size: 1,
      name,
    });
    const [keep, drop, family, mine] = ['keep', 'drop', 'family', 'mine'].map(media) as [
      MediaRef,
      MediaRef,
      MediaRef,
      MediaRef,
    ];
    const opened: MomentData = {
      title: '第一次笑',
      text: '',
      at: 1000,
      milestone: false,
      media: [keep, drop],
      byName: '妈妈',
      futureField: 'keep',
    };
    await a.store.write('moment', id, opened);
    // 弹层开着的时候，家人加了一个文件。
    const latest = { ...opened, media: [keep, drop, family] };
    await a.store.write('moment', id, latest);
    const merged = mergeEdit(opened, latest, {
      title: '第一次笑出声',
      at: 500,
      milestone: true,
      media: mergeMediaEdit(opened.media, latest.media, [keep, mine]),
    });
    await a.store.write('moment', id, merged);
    const saved = a.store.getSnapshot().moments[0]?.data;
    expect(saved?.media.map((m) => m.name)).toEqual(['keep', 'family', 'mine']);
    expect(saved).toMatchObject({
      title: '第一次笑出声',
      at: 500,
      milestone: true,
      byName: '妈妈',
      futureField: 'keep',
    });
  });
});

describe('审查发现的客户端问题（回归）', () => {
  it('被拒绝的记录保留在本地，不会悄悄消失', async () => {
    const server = new FakeServer();
    const a = device(server);
    await a.engine.start();
    const id = randomUUID();
    server.rejectIds.add(id);
    await a.store.write('letter', id, { title: '很长的信', text: '内容', at: 1 });
    await a.engine.syncNow();
    expect(a.store.getSnapshot().letters).toHaveLength(1);
    expect(a.store.getSnapshot().pendingCount).toBe(0);
    a.engine.stop();
  });

  it('被拒绝时告诉用户', async () => {
    const server = new FakeServer();
    const db = new MemoryDb();
    const store = new RecordStore(db);
    const rejected: number[] = [];
    const engine = new SyncEngine(store, db, server, { onRejected: (n) => rejected.push(n) });
    await engine.start();
    const id = randomUUID();
    server.rejectIds.add(id);
    await store.write('event', id, feed());
    await engine.syncNow();
    expect(rejected).toEqual([1]);
    engine.stop();
  });

  it('viewer 升级后重新拉取历史记录', async () => {
    const server = new FakeServer();
    const seed = device(server);
    await seed.engine.start();
    await seed.store.write('event', randomUUID(), feed(111));
    await seed.engine.syncNow();
    seed.engine.stop();

    const a = device(server);
    server.role = 'viewer';
    server.hideEvents = true;
    await a.engine.start();
    expect(a.store.getSnapshot().events).toHaveLength(0);
    expect(a.db.cursor).toBeGreaterThan(0);

    server.role = 'caregiver';
    server.hideEvents = false;
    await a.engine.syncNow();
    expect(a.store.getSnapshot().events).toHaveLength(1);
    a.engine.stop();
  });

  it('角色在 App 重启后也能识别变化', async () => {
    const server = new FakeServer();
    const seed = device(server);
    await seed.engine.start();
    await seed.store.write('event', randomUUID(), feed());
    await seed.engine.syncNow();
    seed.engine.stop();

    const db = new MemoryDb();
    server.role = 'viewer';
    server.hideEvents = true;
    const first = new SyncEngine(new RecordStore(db), db, server);
    await first.start();
    first.stop();

    server.role = 'caregiver';
    server.hideEvents = false;
    const store = new RecordStore(db);
    await store.load();
    const second = new SyncEngine(store, db, server);
    await second.start();
    expect(store.getSnapshot().events).toHaveLength(1);
    second.stop();
  });

  it('降级成 viewer 后清掉本地读不到的记录和证件', async () => {
    const server = new FakeServer();
    const a = device(server);
    await a.engine.start();
    await a.store.write('event', randomUUID(), feed());
    await a.store.write('document', randomUUID(), { name: '虚构证件', files: [] });
    await a.store.write('letter', randomUUID(), { title: '信', text: '', at: 1 });
    await a.engine.syncNow();
    server.role = 'viewer';
    server.hideEvents = true;
    await a.engine.syncNow();
    const snap = a.store.getSnapshot();
    expect(snap.events).toHaveLength(0);
    expect(snap.documents).toHaveLength(0);
    expect(snap.letters).toHaveLength(1);
    expect([...a.db.records.values()].some((r) => r.collection === 'document')).toBe(false);
    a.engine.stop();
  });

  it('同步一直失败时，长轮询不会空转', async () => {
    class Failing extends FakeServer {
      waits = 0;
      override async sync(): Promise<SyncResponse> {
        throw new Error('500');
      }
      override async wait(): Promise<{ changed: boolean }> {
        this.waits += 1;
        return { changed: true };
      }
    }
    const server = new Failing();
    const db = new MemoryDb();
    const engine = new SyncEngine(new RecordStore(db), db, server);
    await engine.start();
    await new Promise((r) => setTimeout(r, 150));
    engine.stop();
    expect(server.waits).toBeLessThan(5);
  });

  it('首次同步完成后才通知，失败时不算完成', async () => {
    const server = new FakeServer();
    server.offline = true;
    const db = new MemoryDb();
    let synced = 0;
    const engine = new SyncEngine(new RecordStore(db), db, server, {
      onSynced: () => {
        synced += 1;
      },
    });
    await engine.start();
    expect(synced).toBe(0);
    server.offline = false;
    await engine.syncNow();
    expect(synced).toBe(1);
    engine.stop();
  });

  it('本地文件不见了：标记失败，不卡住队列', async () => {
    const bad = job();
    const good = job();
    const { transport, calls } = fakeUploads({
      put: async (j) => {
        if (j.id === bad.id) throw new UploadHttpError(410, 'local_missing', '本地文件不见了');
        calls.push(`put:${j.key}`);
        return { status: 200 };
      },
    });
    const queue = new UploadQueue(new MemoryDb(), transport, { sleepMs: () => 1 });
    await queue.enqueue([bad, good]);
    await new Promise((r) => setTimeout(r, 30));
    await queue.idle();
    expect(queue.getProgress().failedCount).toBe(1);
    expect(queue.getProgress().failedReason).toBe('本地文件不见了');
    expect(calls.some((c) => c.startsWith('done:') && c.includes(good.id))).toBe(true);
    queue.stop();
  });

  it('某个文件一直传不上去时，不挡住后面的文件', async () => {
    const stuck = job();
    const good = job();
    const { transport, calls } = fakeUploads({
      put: async (j, _t, onProgress) => {
        if (j.id === stuck.id) return { status: 500 };
        onProgress(j.size);
        return { status: 200 };
      },
    });
    const queue = new UploadQueue(new MemoryDb(), transport, { sleepMs: () => 1 });
    await queue.enqueue([stuck, good]);
    await new Promise((r) => setTimeout(r, 40));
    await queue.idle();
    expect(calls.some((c) => c.startsWith('done:') && c.includes(good.id))).toBe(true);
    queue.stop();
  });

  it('存储持续返回错误时，重试有上限，最后标记失败', async () => {
    const { transport } = fakeUploads({ put: async () => ({ status: 400 }) });
    const queue = new UploadQueue(new MemoryDb(), transport, { sleepMs: () => 1 });
    await queue.enqueue([job()]);
    await new Promise((r) => setTimeout(r, 120));
    await queue.idle();
    expect(queue.getProgress().failedCount).toBe(1);
    queue.stop();
  });
});
