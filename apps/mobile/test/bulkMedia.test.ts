import { randomUUID } from 'node:crypto';
import { MAX_MEDIA_PER_RECORD, type MediaRef } from '@xiaodouya/shared';
import { describe, expect, it } from 'vitest';
import { type LocalDb, RecordStore, type StoredRecord } from '../src/data/store';
import {
  type UploadJob,
  UploadQueue,
  type UploadQueueDb,
  type UploadTransport,
} from '../src/data/uploadQueue';
import { firstFound, importEach, mergePicked } from '../src/lib/mediaUtils';

class MemoryDb implements LocalDb, UploadQueueDb {
  records = new Map<string, StoredRecord>();
  jobs = new Map<string, UploadJob>();
  async loadAll() {
    return [...this.records.values()];
  }
  async put(r: StoredRecord) {
    this.records.set(r.id, r);
  }
  async putMany() {}
  async getCursor() {
    return 0;
  }
  async getMeta() {
    return null;
  }
  async setMeta() {}
  async deleteCollections() {}
  async clear() {}
  async loadJobs() {
    return [...this.jobs.values()];
  }
  async saveJob(j: UploadJob) {
    this.jobs.set(j.key, { ...j });
  }
  async deleteJob(key: string) {
    this.jobs.delete(key);
  }
}

const ref = (): MediaRef => ({ id: randomUUID(), kind: 'image', mime: 'image/jpeg', size: 1 });

describe('记录写入', () => {
  const moment = (count: number) => ({
    title: '',
    text: '',
    at: 1000,
    milestone: false,
    media: Array.from({ length: count }, ref),
  });

  it('过不了校验的内容要报错，不能存下来再悄悄不显示', async () => {
    const db = new MemoryDb();
    const store = new RecordStore(db);
    await expect(
      store.write('moment', randomUUID(), moment(MAX_MEDIA_PER_RECORD + 1)),
    ).rejects.toThrow();
    expect(db.records.size).toBe(0);
  });

  it('编辑时超过上限，原来的记录还在', async () => {
    const db = new MemoryDb();
    const store = new RecordStore(db);
    const id = randomUUID();
    await store.write('moment', id, moment(MAX_MEDIA_PER_RECORD));
    await expect(store.write('moment', id, moment(MAX_MEDIA_PER_RECORD + 1))).rejects.toThrow();
    expect(store.getSnapshot().moments[0]?.data.media).toHaveLength(MAX_MEDIA_PER_RECORD);
  });

  it('正好到上限可以保存', async () => {
    const store = new RecordStore(new MemoryDb());
    await store.write('moment', randomUUID(), moment(MAX_MEDIA_PER_RECORD));
    expect(store.getSnapshot().moments).toHaveLength(1);
  });
});

describe('合并选好的文件', () => {
  it('没超过上限时全部保留', () => {
    expect(mergePicked(['a'], ['b', 'c'], 1, 100)).toEqual({ files: ['a', 'b', 'c'], dropped: 0 });
  });

  it('超过上限时留下放得下的，并说清楚少了几个', () => {
    expect(mergePicked(['a'], ['b', 'c', 'd'], 97, 100)).toEqual({
      files: ['a', 'b', 'c'],
      dropped: 1,
    });
  });

  it('编辑时已有的文件也占名额', () => {
    expect(mergePicked([], ['a', 'b'], 100, 100)).toEqual({ files: [], dropped: 2 });
  });
});

describe('批量导入', () => {
  it('一个文件失败不挡后面的，并告诉调用方是哪个', async () => {
    const result = await importEach(['a', 'bad', 'c'], async (name) => {
      if (name === 'bad') throw new Error('bad 是空的');
      return name.toUpperCase();
    });
    expect(result.done).toEqual(['A', 'C']);
    expect(result.failed).toEqual(['bad 是空的']);
  });

  it('一次只处理一个文件', async () => {
    let running = 0;
    let peak = 0;
    await importEach(
      Array.from({ length: 150 }, (_, i) => i),
      async (n) => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 0));
        running -= 1;
        return n;
      },
    );
    expect(peak).toBe(1);
  });
});

describe('找回选择器的结果', () => {
  it('前几次没拿到时继续等，拿到就停', async () => {
    const answers = [null, null, ['a']];
    let calls = 0;
    const found = await firstFound(
      async () => answers[calls++] ?? null,
      [0, 1, 1, 1, 1],
      async () => {},
    );
    expect(found).toEqual(['a']);
    expect(calls).toBe(3);
  });

  it('一直没有就返回空', async () => {
    expect(
      await firstFound(
        async () => null,
        [0, 1],
        async () => {},
      ),
    ).toBeNull();
  });

  it('原生调用出错不影响启动', async () => {
    expect(
      await firstFound(
        async () => {
          throw new Error('native');
        },
        [0],
        async () => {},
      ),
    ).toBeNull();
  });
});

describe('上传队列里的缩略图', () => {
  function uploads(overrides: Partial<UploadTransport> = {}) {
    const calls: string[] = [];
    let running = 0;
    let peak = 0;
    const transport: UploadTransport = {
      async requestUrl(req) {
        calls.push(`url:${req.variant}:${req.size}`);
        return { url: 'https://s3.test/x', headers: {}, expiresIn: 3600 };
      },
      async put() {
        return { status: 200 };
      },
      async complete() {},
      async removeLocal() {},
      async makeThumb(job) {
        running += 1;
        peak = Math.max(peak, running);
        calls.push(`thumb:${job.id}`);
        await new Promise((r) => setTimeout(r, 0));
        running -= 1;
        return { size: 7 };
      },
      ...overrides,
    };
    return { transport, calls, peak: () => peak };
  }

  const pair = (id = randomUUID()) => [
    {
      id,
      variant: 'thumb' as const,
      scope: 'memory' as const,
      localUri: `file:///${id}-thumb`,
      mime: 'image/jpeg',
      size: 0,
      wifiOnly: false,
      thumbSource: { uri: `file:///${id}-original`, kind: 'image' as const },
    },
    {
      id,
      variant: 'original' as const,
      scope: 'memory' as const,
      localUri: `file:///${id}-original`,
      mime: 'image/jpeg',
      size: 100,
      wifiOnly: false,
    },
  ];

  it('入队后才生成缩略图，生成后用真实大小申请链接', async () => {
    const { transport, calls } = uploads();
    const queue = new UploadQueue(new MemoryDb(), transport);
    const jobs = pair();
    await queue.enqueue(jobs);
    await queue.idle();
    expect(calls).toEqual([`thumb:${jobs[0]?.id}`, 'url:thumb:7', 'url:original:100']);
  });

  it('150 张照片同一时间只解码一张', async () => {
    const { transport, peak } = uploads();
    const queue = new UploadQueue(new MemoryDb(), transport);
    await queue.enqueue(Array.from({ length: 150 }, () => pair()).flat());
    await queue.idle();
    expect(peak()).toBe(1);
  });

  it('缩略图做不出来不影响原图，也不会一直重试', async () => {
    const db = new MemoryDb();
    const { transport, calls } = uploads({ makeThumb: async () => null });
    const queue = new UploadQueue(db, transport);
    await queue.enqueue(pair());
    await queue.idle();
    expect(calls).toEqual(['url:original:100']);
    expect(db.jobs.size).toBe(0);
    expect(queue.getProgress().failedCount).toBe(0);
  });

  it('生成缩略图时出错也不挡住原图', async () => {
    const db = new MemoryDb();
    const { transport, calls } = uploads({
      makeThumb: async () => {
        throw new Error('decode');
      },
    });
    const queue = new UploadQueue(db, transport);
    await queue.enqueue(pair());
    await queue.idle();
    expect(calls).toEqual(['url:original:100']);
    expect(db.jobs.size).toBe(0);
  });

  it('App 被杀后接着生成，全部文件都能传完', async () => {
    const db = new MemoryDb();
    const stuck = uploads({ makeThumb: () => new Promise(() => {}) });
    const first = new UploadQueue(db, stuck.transport);
    const jobs = Array.from({ length: 3 }, () => pair()).flat();
    await first.enqueue(jobs);
    expect(db.jobs.size).toBe(6);
    first.stop();

    const { transport, calls } = uploads();
    const second = new UploadQueue(db, transport);
    await second.load();
    await second.idle();
    expect(db.jobs.size).toBe(0);
    expect(calls.filter((c) => c.startsWith('thumb:'))).toHaveLength(3);
    expect(calls.filter((c) => c.startsWith('url:original'))).toHaveLength(3);
  });

  it('重启后顺序变了，也要先做缩略图再传原图：原图传完本地副本就删了', async () => {
    const db = new MemoryDb();
    const [thumb, original] = pair();
    if (!thumb || !original) throw new Error('fixture');
    await db.saveJob({ ...original, key: `${original.id}/original`, attempts: 0 });
    await db.saveJob({ ...thumb, key: `${thumb.id}/thumb`, attempts: 0 });
    const { transport, calls } = uploads();
    const queue = new UploadQueue(db, transport);
    await queue.load();
    await queue.idle();
    expect(calls[0]).toBe(`thumb:${thumb.id}`);
    expect(calls).toContain('url:original:100');
  });

  it('清空队列时正在生成的缩略图不会写回去', async () => {
    const db = new MemoryDb();
    let finish: (v: { size: number }) => void = () => {};
    const { transport } = uploads({
      makeThumb: () =>
        new Promise((r) => {
          finish = r;
        }),
    });
    const queue = new UploadQueue(db, transport);
    await queue.enqueue(pair());
    await new Promise((r) => setTimeout(r, 0));
    queue.reset();
    db.jobs.clear();
    finish({ size: 7 });
    await queue.idle();
    expect(db.jobs.size).toBe(0);
  });
});
