import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  UploadHttpError,
  type UploadJob,
  type UploadProgress,
  UploadQueue,
  type UploadQueueDb,
  type UploadTransport,
} from '../src/data/uploadQueue';
import {
  type NativeUploadServiceApi,
  type ServiceNotice,
  UploadServiceController,
} from '../src/data/uploadServiceController';
import {
  OFFLINE_GRACE_MS,
  STALL_GRACE_MS,
  shouldRunUploadService,
} from '../src/data/uploadServicePolicy';

describe('前台服务该不该跑', () => {
  const now = 1_000_000_000;
  const base = {
    progress: { total: 2, waitingForWifi: false, offline: false, halted: false },
    now,
    offlineSince: null,
    lastProgressAt: now,
  };

  it('有能传的任务就跑', () => {
    expect(shouldRunUploadService(base)).toBe(true);
  });
  it('传完了就停', () => {
    expect(shouldRunUploadService({ ...base, progress: { ...base.progress, total: 0 } })).toBe(
      false,
    );
  });
  it('全部等 Wi-Fi 时马上停', () => {
    expect(
      shouldRunUploadService({ ...base, progress: { ...base.progress, waitingForWifi: true } }),
    ).toBe(false);
  });
  it('队列停了（退出登录、登录失效、到系统上限）就停', () => {
    expect(shouldRunUploadService({ ...base, progress: { ...base.progress, halted: true } })).toBe(
      false,
    );
  });
  it('短暂断网不停：停了之后后台起不来；断太久就停', () => {
    const offline = { ...base, progress: { ...base.progress, offline: true } };
    expect(shouldRunUploadService({ ...offline, offlineSince: now - 1000 })).toBe(true);
    expect(shouldRunUploadService({ ...offline, offlineSince: now - OFFLINE_GRACE_MS })).toBe(
      false,
    );
  });
  it('一直没有进展不能常驻', () => {
    expect(shouldRunUploadService({ ...base, lastProgressAt: now - STALL_GRACE_MS + 1 })).toBe(
      true,
    );
    expect(shouldRunUploadService({ ...base, lastProgressAt: now - STALL_GRACE_MS })).toBe(false);
  });
});

class MemoryDb implements UploadQueueDb {
  rows = new Map<string, UploadJob>();
  async loadJobs() {
    // 和 SQLite 一样每次都是新对象。
    return [...this.rows.values()].map((j) => structuredClone(j));
  }
  async saveJob(job: UploadJob) {
    this.rows.set(job.key, job);
  }
  async deleteJob(key: string) {
    this.rows.delete(key);
  }
}

const job = (over: Partial<Omit<UploadJob, 'key' | 'attempts'>> = {}) => ({
  id: randomUUID(),
  variant: 'original' as const,
  scope: 'memory' as const,
  localUri: 'file:///a',
  mime: 'image/jpeg',
  size: 1000,
  wifiOnly: false,
  ...over,
});

function fakeTransport(overrides: Partial<UploadTransport> = {}) {
  const transport: UploadTransport = {
    requestUrl: async () => ({ url: 'https://s3.test/x', headers: {}, expiresIn: 3600 }),
    put: async (j, _t, onProgress) => {
      onProgress(j.size);
      return { status: 200 };
    },
    complete: async () => {},
    removeLocal: async () => {},
    ...overrides,
  };
  return transport;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};

function fakeNative(startResult: () => boolean = () => true) {
  const calls: string[] = [];
  const native: NativeUploadServiceApi = {
    start() {
      calls.push('start');
      return startResult();
    },
    update(notice) {
      calls.push(`update:${notice.title}`);
    },
    stop() {
      calls.push('stop');
    },
    releaseKeepAlive() {
      calls.push('release');
    },
  };
  return { native, calls };
}

const notice = (progress: UploadProgress): ServiceNotice => ({
  channelName: 'uploads',
  title: `${progress.total}:${Math.round(progress.fraction * 100)}`,
  text: null,
  percent: Math.round(progress.fraction * 100),
  cancelLabel: 'cancel',
  pausedTitle: 'paused',
  detailsLink: 'xiaodouya://uploads',
  cancelLink: 'xiaodouya://uploads?cancelAll=1',
});

describe('服务的启停跟着队列走', () => {
  afterEach(() => vi.useRealTimers());

  const setup = (
    transport = fakeTransport(),
    startResult?: () => boolean,
    db: MemoryDb = new MemoryDb(),
  ) => {
    const queue = new UploadQueue(db, transport);
    const { native, calls } = fakeNative(startResult);
    let clock = 1_000_000;
    const controller = new UploadServiceController(queue, native, notice, () => clock);
    controller.attach();
    return { queue, controller, calls, db, advance: (ms: number) => (clock += ms) };
  };

  it('有任务时启动，传完马上停', async () => {
    const { queue, calls, controller } = setup();
    await queue.enqueue([job()]);
    await queue.idle();
    expect(calls[0]).toBe('start');
    expect(calls.at(-1)).toBe('stop');
    expect(calls.filter((c) => c === 'start')).toHaveLength(1);
    controller.detach();
  });

  it('全部等 Wi-Fi 时不启动，有 Wi-Fi 了才启动', async () => {
    const gate = deferred<{ status: number }>();
    const { queue, calls, controller } = setup(fakeTransport({ put: () => gate.promise }));
    queue.setNetwork('cellular');
    await queue.enqueue([job({ wifiOnly: true })]);
    await queue.idle();
    expect(calls).toEqual([]);
    queue.setNetwork('wifi');
    await flush();
    expect(calls).toContain('start');
    gate.resolve({ status: 200 });
    await queue.idle();
    controller.detach();
  });

  it('传的途中切到移动网络：只剩等 Wi-Fi 的文件时立刻停', async () => {
    const gate = deferred<{ status: number }>();
    const { queue, calls, controller } = setup(fakeTransport({ put: () => gate.promise }));
    await queue.enqueue([job({ wifiOnly: true })]);
    await flush();
    expect(calls).toEqual(['start']);
    queue.setNetwork('cellular');
    expect(calls.at(-1)).toBe('stop');
    gate.resolve({ status: 200 });
    await queue.idle();
    controller.detach();
  });

  it('取消全部后马上停', async () => {
    const gate = deferred<{ status: number }>();
    const { queue, calls, controller } = setup(fakeTransport({ put: () => gate.promise }));
    const j = job();
    await queue.enqueue([j]);
    await flush();
    await queue.cancel([j.id]);
    expect(calls.at(-1)).toBe('stop');
    gate.resolve({ status: 200 });
    await queue.idle();
    controller.detach();
  });

  it('退出登录（reset）后马上停，没有任务也不会再启动', async () => {
    const gate = deferred<{ status: number }>();
    const { queue, calls, controller } = setup(fakeTransport({ put: () => gate.promise }));
    await queue.enqueue([job()]);
    await flush();
    queue.reset();
    expect(calls.at(-1)).toBe('stop');
    gate.resolve({ status: 200 });
    await queue.idle();
    expect(calls.filter((c) => c === 'start')).toHaveLength(1);
    controller.detach();
  });

  it('登录失效：401 让队列自己停下，不在后台一直重试，任务留着', async () => {
    let tries = 0;
    const db = new MemoryDb();
    const { queue, calls, controller } = setup(
      fakeTransport({
        requestUrl: async () => {
          tries += 1;
          throw new UploadHttpError(401, 'unauthenticated', '登录过期');
        },
      }),
      undefined,
      db,
    );
    await queue.enqueue([job()]);
    await queue.idle();
    await flush();
    expect(tries).toBe(1);
    expect(queue.getProgress().halted).toBe(true);
    expect(calls.at(-1)).toBe('stop');
    expect(db.rows.size).toBe(1);
    expect(queue.getProgress().failedCount).toBe(0);
    controller.detach();
  });

  it('代理返回的 401 不算登录失效，照常退避重试', async () => {
    const { queue, controller } = setup(
      fakeTransport({
        requestUrl: async () => {
          throw new UploadHttpError(401, 'http_error', '代理');
        },
      }),
    );
    await queue.enqueue([job()]);
    await queue.idle();
    expect(queue.getProgress().halted).toBe(false);
    queue.stop();
    controller.detach();
  });

  it('配额错误是永久失败：不再占着服务', async () => {
    const { queue, calls, controller } = setup(
      fakeTransport({
        requestUrl: async () => {
          throw new UploadHttpError(413, 'quota_exceeded', '满了');
        },
      }),
    );
    await queue.enqueue([job()]);
    await queue.idle();
    expect(queue.getProgress().failedCount).toBe(1);
    expect(calls.at(-1)).toBe('stop');
    controller.detach();
  });

  it('系统不让启动时不反复试，回到前台再试', async () => {
    let allowed = false;
    const gate = deferred<{ status: number }>();
    const { queue, calls, controller } = setup(
      fakeTransport({ put: () => gate.promise }),
      () => allowed,
    );
    await queue.enqueue([job()]);
    await flush();
    expect(calls.filter((c) => c === 'start')).toHaveLength(1);
    queue.setNetwork('cellular');
    queue.setNetwork('wifi');
    expect(calls.filter((c) => c === 'start')).toHaveLength(1);
    allowed = true;
    controller.onForeground();
    expect(calls.filter((c) => c === 'start')).toHaveLength(2);
    gate.resolve({ status: 200 });
    await queue.idle();
    controller.detach();
  });

  it('到系统的 6 小时上限：队列停下，任务留着，回到前台接着传', async () => {
    const db = new MemoryDb();
    const gate = deferred<{ status: number }>();
    const { queue, calls, controller } = setup(
      fakeTransport({ put: () => gate.promise }),
      undefined,
      db,
    );
    await queue.enqueue([job()]);
    await flush();
    controller.onSystemTimeout();
    expect(calls).toContain('release');
    expect(queue.getProgress().halted).toBe(true);
    expect(db.rows.size).toBe(1);
    // 服务是系统停的，不用再 stop，也不能再 start。
    expect(calls).not.toContain('stop');
    const starts = calls.filter((c) => c === 'start').length;
    queue.setNetwork('cellular');
    queue.setNetwork('wifi');
    expect(calls.filter((c) => c === 'start')).toHaveLength(starts);

    controller.onForeground();
    await flush();
    expect(queue.getProgress().halted).toBe(false);
    expect(calls.filter((c) => c === 'start')).toHaveLength(starts + 1);
    gate.resolve({ status: 200 });
    await queue.idle();
    controller.detach();
  });

  it('通知每秒最多刷新一次，内容没变不刷新', async () => {
    const sent: ((n: number) => void)[] = [];
    const gate = deferred<{ status: number }>();
    const { queue, calls, controller, advance } = setup(
      fakeTransport({
        put: (_j, _t, onProgress) => {
          sent.push(onProgress);
          return gate.promise;
        },
      }),
    );
    await queue.enqueue([job()]);
    await flush();
    const before = calls.length;
    sent[0]?.(100);
    sent[0]?.(200);
    expect(calls.length).toBe(before);
    advance(1100);
    sent[0]?.(300);
    expect(calls.length).toBe(before + 1);
    advance(1100);
    sent[0]?.(300);
    expect(calls.length).toBe(before + 1);
    gate.resolve({ status: 200 });
    await queue.idle();
    controller.detach();
  });
});

describe('队列重复加载', () => {
  it('界面重新挂载再调一次 load 不会打断正在传的文件', async () => {
    const gate = deferred<{ status: number }>();
    const db = new MemoryDb();
    let puts = 0;
    const queue = new UploadQueue(
      db,
      fakeTransport({
        put: () => {
          puts += 1;
          return gate.promise;
        },
      }),
    );
    await queue.load();
    await queue.enqueue([job()]);
    await flush();
    await queue.load();
    await flush();
    expect(puts).toBe(1);
    expect(queue.getProgress().items[0]?.status).toBe('uploading');
    gate.resolve({ status: 200 });
    await flush();
    await queue.idle();
    expect(puts).toBe(1);
    expect(db.rows.size).toBe(0);
  });

  it('stop 之后 load 恢复工作', async () => {
    const db = new MemoryDb();
    let puts = 0;
    const queue = new UploadQueue(
      db,
      fakeTransport({
        put: async (j, _t, onProgress) => {
          puts += 1;
          onProgress(j.size);
          return { status: 200 };
        },
      }),
    );
    queue.stop();
    await queue.enqueue([job()]);
    expect(puts).toBe(0);
    await queue.load();
    await queue.idle();
    expect(puts).toBe(1);
  });
});
