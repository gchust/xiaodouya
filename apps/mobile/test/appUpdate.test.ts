import type { AppUpdateInfo } from '@xiaodouya/shared';
import { describe, expect, it } from 'vitest';
import { UpdateController, type UpdateDeps, type UpdatePhase } from '../src/lib/appUpdate';

const SHA = 'c'.repeat(64);
const NOW = Date.parse('2026-11-03T08:00:00Z');

const info = (over: Partial<AppUpdateInfo> = {}): AppUpdateInfo => ({
  versionCode: 120,
  versionName: '0.4.0',
  size: 1000,
  sha256: SHA,
  url: 'https://storage.example.test/releases/android/x.apk?sig=1',
  expiresIn: 900,
  required: false,
  notes: null,
  ...over,
});

/** 假的文件系统、网络和安装界面。下载默认一次写完全部字节。 */
function harness(options: { update?: AppUpdateInfo | null; current?: number } = {}) {
  const files = new Map<string, { size: number; sha: string }>();
  const meta = new Map<string, string>();
  const calls = { fetch: 0, download: [] as string[], install: [] as string[], hashed: 0 };
  let now = NOW;
  let next: AppUpdateInfo | null | Error = options.update === undefined ? info() : options.update;
  let downloadImpl: (
    url: string,
    file: string,
    onProgress: (received: number, total: number) => void,
    signal: AbortSignal,
  ) => Promise<void> = async (url, file, onProgress) => {
    onProgress(500, 1000);
    onProgress(1000, 1000);
    files.set(file, { size: 1000, sha: SHA });
    void url;
  };
  const deps: UpdateDeps = {
    currentVersionCode: () => options.current ?? 119,
    async fetchUpdate(code) {
      calls.fetch += 1;
      expect(code).toBe(options.current ?? 119);
      if (next instanceof Error) throw next;
      return next;
    },
    apkFile: (code) => `file:///cache/updates/xiaodouya-${code}.apk`,
    fileSize: (file) => files.get(file)?.size ?? null,
    deleteFile: (file) => void files.delete(file),
    download(url, file, onProgress, signal) {
      calls.download.push(url);
      return downloadImpl(url, file, onProgress, signal);
    },
    async sha256(file) {
      calls.hashed += 1;
      const found = files.get(file);
      if (!found) throw new Error('没有文件');
      return found.sha;
    },
    async install(file) {
      calls.install.push(file);
    },
    getMeta: async (key) => meta.get(key) ?? null,
    setMeta: async (key, value) => void meta.set(key, value),
    now: () => now,
  };
  const controller = new UpdateController(deps);
  const phases: UpdatePhase['kind'][] = [];
  controller.subscribe(() => phases.push(controller.getState().kind));
  return {
    controller,
    files,
    meta,
    calls,
    phases,
    setNext: (value: AppUpdateInfo | null | Error) => {
      next = value;
    },
    setDownload: (impl: typeof downloadImpl) => {
      downloadImpl = impl;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('检查', () => {
  it('有新版本时进入可更新，没有时是已经最新', async () => {
    const h = harness();
    await h.controller.check();
    expect(h.controller.getState()).toMatchObject({
      kind: 'available',
      update: { versionCode: 120 },
    });
    const none = harness({ update: null });
    await none.controller.check();
    expect(none.controller.getState().kind).toBe('upToDate');
  });

  it('查不到（断网、服务端出错）时如实说失败，不说已经最新', async () => {
    const h = harness();
    h.setNext(new Error('network'));
    await h.controller.check();
    expect(h.controller.getState()).toMatchObject({ kind: 'failed', reason: 'check' });
  });

  it('下载中再点检查不打断下载', async () => {
    const h = harness();
    await h.controller.check();
    let release: () => void = () => {};
    h.setDownload(
      (_url, file, onProgress) =>
        new Promise<void>((resolve) => {
          onProgress(100, 1000);
          release = () => {
            h.files.set(file, { size: 1000, sha: SHA });
            resolve();
          };
        }),
    );
    const downloading = h.controller.download();
    await Promise.resolve();
    await h.controller.check();
    expect(h.controller.getState().kind).toBe('downloading');
    release();
    await downloading;
    expect(h.controller.getState().kind).toBe('ready');
  });
});

describe('自动检查', () => {
  it('一天最多一次，同一个版本只提示一次', async () => {
    const h = harness();
    expect((await h.controller.autoCheck())?.versionCode).toBe(120);
    expect(h.calls.fetch).toBe(1);
    // 一天以内不再问服务端。
    expect(await h.controller.autoCheck()).toBe(null);
    expect(h.calls.fetch).toBe(1);
    // 过了一天再问，但同一个版本不再提示。状态还是可更新，设置里能看到。
    h.advance(24 * 3_600_000);
    expect(await h.controller.autoCheck()).toBe(null);
    expect(h.calls.fetch).toBe(2);
    expect(h.controller.getState().kind).toBe('available');
    // 又出了新版本：提示。
    h.advance(24 * 3_600_000);
    h.setNext(info({ versionCode: 121, versionName: '0.4.1' }));
    expect((await h.controller.autoCheck())?.versionCode).toBe(121);
  });

  it('必须更新的每次检查都提示', async () => {
    const h = harness({ update: info({ required: true }) });
    expect(await h.controller.autoCheck()).not.toBe(null);
    h.advance(24 * 3_600_000);
    expect(await h.controller.autoCheck()).not.toBe(null);
  });

  it('自动检查失败时不打扰，也不记成检查过，下次打开再试', async () => {
    const h = harness();
    h.setNext(new Error('offline'));
    expect(await h.controller.autoCheck()).toBe(null);
    expect(h.controller.getState().kind).toBe('idle');
    h.setNext(info());
    expect((await h.controller.autoCheck())?.versionCode).toBe(120);
  });
});

describe('下载和校验', () => {
  it('下载时有进度，校验通过后可以安装', async () => {
    const h = harness();
    await h.controller.check();
    const progress: number[] = [];
    h.controller.subscribe(() => {
      const state = h.controller.getState();
      if (state.kind === 'downloading') progress.push(state.received);
    });
    await h.controller.download();
    expect(progress).toContain(500);
    expect(h.phases).toEqual(expect.arrayContaining(['downloading', 'verifying', 'ready']));
    expect(h.controller.getState()).toMatchObject({
      kind: 'ready',
      file: 'file:///cache/updates/xiaodouya-120.apk',
    });
    await h.controller.install();
    expect(h.calls.install).toEqual(['file:///cache/updates/xiaodouya-120.apk']);
  });

  it('sha256 不对时删掉文件、不调安装界面', async () => {
    const h = harness();
    await h.controller.check();
    h.setDownload(async (_url, file) => {
      h.files.set(file, { size: 1000, sha: 'd'.repeat(64) });
    });
    await h.controller.download();
    expect(h.controller.getState()).toMatchObject({ kind: 'failed', reason: 'checksum' });
    expect(h.files.size).toBe(0);
    await h.controller.install();
    expect(h.calls.install).toEqual([]);
  });

  it('大小不对时不用算哈希就拒绝', async () => {
    const h = harness();
    await h.controller.check();
    h.setDownload(async (_url, file) => {
      h.files.set(file, { size: 999, sha: SHA });
    });
    await h.controller.download();
    expect(h.controller.getState()).toMatchObject({ kind: 'failed', reason: 'checksum' });
    expect(h.calls.hashed).toBe(0);
    expect(h.files.size).toBe(0);
  });

  it('取消时停下、删掉没下完的文件，回到可更新', async () => {
    const h = harness();
    await h.controller.check();
    h.setDownload(
      (_url, file, onProgress, signal) =>
        new Promise<void>((_resolve, reject) => {
          h.files.set(file, { size: 300, sha: '' });
          onProgress(300, 1000);
          signal.addEventListener('abort', () => reject(new Error('AbortError')));
        }),
    );
    const downloading = h.controller.download();
    await Promise.resolve();
    expect(h.controller.getState().kind).toBe('downloading');
    h.controller.cancel();
    await downloading;
    expect(h.controller.getState().kind).toBe('available');
    expect(h.files.size).toBe(0);
  });

  it('断网失败后能重试；链接快过期时重新取一个', async () => {
    const h = harness();
    await h.controller.check();
    h.setDownload(async () => {
      throw new Error('network lost');
    });
    await h.controller.download();
    expect(h.controller.getState()).toMatchObject({ kind: 'failed', reason: 'network' });
    // 过了十几分钟，旧链接要过期了。
    h.advance(14 * 60_000);
    h.setNext(info({ url: 'https://storage.example.test/fresh?sig=2' }));
    h.setDownload(async (_url, file) => {
      h.files.set(file, { size: 1000, sha: SHA });
    });
    await h.controller.download();
    expect(h.calls.download.at(-1)).toBe('https://storage.example.test/fresh?sig=2');
    expect(h.controller.getState().kind).toBe('ready');
  });

  it('链接还新鲜时直接用，不多问一次服务端', async () => {
    const h = harness();
    await h.controller.check();
    await h.controller.download();
    expect(h.calls.fetch).toBe(1);
  });

  it('上次已经下好并校验过的文件直接用，不重新下载', async () => {
    const h = harness();
    h.files.set('file:///cache/updates/xiaodouya-120.apk', { size: 1000, sha: SHA });
    await h.controller.check();
    await h.controller.download();
    expect(h.calls.download).toEqual([]);
    expect(h.controller.getState().kind).toBe('ready');
  });

  it('重试时服务端说已经没有更新了（比如别处装好了），就是已经最新', async () => {
    const h = harness();
    await h.controller.check();
    h.setDownload(async () => {
      throw new Error('network lost');
    });
    await h.controller.download();
    h.advance(20 * 60_000);
    h.setNext(null);
    await h.controller.download();
    expect(h.controller.getState().kind).toBe('upToDate');
  });

  it('安装界面开着时再点安装不会再开一个，也不算失败', async () => {
    const h = harness();
    let close: () => void = () => {};
    const opened: string[] = [];
    const controller = new UpdateController({
      ...h.controller.deps,
      install: (file) =>
        new Promise<void>((resolve, reject) => {
          if (opened.length > 0) reject(new Error('ActivityAlreadyStartedException'));
          opened.push(file);
          close = resolve;
        }),
    });
    await controller.check();
    await controller.download();
    const first = controller.install();
    await controller.install();
    expect(opened).toHaveLength(1);
    expect(controller.getState().kind).toBe('ready');
    close();
    await first;
    expect(controller.getState().kind).toBe('ready');
  });

  it('安装界面打不开时说清楚，可以再试', async () => {
    const h = harness();
    await h.controller.check();
    await h.controller.download();
    const failing = new UpdateController({
      ...(h.controller as unknown as { deps: UpdateDeps }).deps,
      install: async () => {
        throw new Error('no activity');
      },
    });
    await failing.check();
    await failing.download();
    await failing.install();
    expect(failing.getState()).toMatchObject({ kind: 'failed', reason: 'install' });
    await failing.download();
    expect(failing.getState().kind).toBe('ready');
  });
});
