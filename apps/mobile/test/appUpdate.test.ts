import {
  type AppUpdateInfo,
  AUTO_DOWNLOAD_MAX_ATTEMPTS,
  type NetworkKind,
} from '@xiaodouya/shared';
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
  let network: NetworkKind = 'wifi';
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
    deleteDownloads: () => files.clear(),
    network: async () => network,
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
    deps,
    /** App 被杀后重新打开：内存里的状态没了，文件和本机记录还在。 */
    relaunch: () => new UpdateController(deps),
    setNetwork: (kind: NetworkKind) => {
      network = kind;
    },
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

describe('自动下载', () => {
  const APK = 'file:///cache/updates/xiaodouya-120.apk';

  /** 用户在设置里打开了自动下载，之后又过了一天（打开开关时那次检查不算在节流里）。 */
  async function enabled(h: ReturnType<typeof harness>) {
    h.setNext(null);
    await h.controller.setAutoDownload(true);
    await h.controller.autoTask();
    h.setNext(info());
    h.advance(24 * 3_600_000);
  }

  it('默认关：发现新版本只提示，不下载', async () => {
    const h = harness();
    await h.controller.loadSettings();
    expect(h.controller.getSettings()).toMatchObject({ autoDownload: false, wifiOnly: true });
    expect((await h.controller.autoCheck())?.versionCode).toBe(120);
    await h.controller.autoTask();
    expect(h.calls.download).toEqual([]);
    expect(h.controller.getState().kind).toBe('available');
  });

  it('打开后发现新版本在后台下好、校验好，不弹提示，等用户点安装', async () => {
    const h = harness();
    await enabled(h);
    expect(await h.controller.autoCheck()).toBe(null);
    await h.controller.autoTask();
    expect(h.calls.download).toHaveLength(1);
    expect(h.controller.getState()).toMatchObject({ kind: 'ready', file: APK });
    expect(h.calls.install).toEqual([]);
    // 自动下载不加检查次数：还是一天最多问一次服务端。
    expect(h.calls.fetch).toBe(2);
    expect(await h.controller.autoCheck()).toBe(null);
    expect(h.calls.fetch).toBe(2);
  });

  it('手动下载失败过，再打开开关也会自己下', async () => {
    const h = harness();
    await h.controller.check();
    h.setDownload(async () => {
      throw new Error('network lost');
    });
    await h.controller.download();
    expect(h.controller.getState()).toMatchObject({ kind: 'failed', reason: 'network' });
    h.setDownload(async (_url, file) => {
      h.files.set(file, { size: 1000, sha: SHA });
    });
    await h.controller.setAutoDownload(true);
    await h.controller.autoTask();
    expect(h.controller.getState().kind).toBe('ready');
  });

  it('必须更新、但现在下不了时：和以前一样每次问过服务端才提示，不是每次回到前台都提示', async () => {
    const h = harness({ update: info({ required: true }) });
    h.setNetwork('cellular');
    await h.controller.setAutoDownload(true);
    h.advance(24 * 3_600_000);
    expect(await h.controller.autoCheck()).not.toBe(null);
    expect(await h.controller.autoCheck()).toBe(null);
    h.advance(24 * 3_600_000);
    expect(await h.controller.autoCheck()).not.toBe(null);
  });

  it('打开开关时马上检查并下载，不等到明天', async () => {
    const h = harness();
    expect((await h.controller.autoCheck())?.versionCode).toBe(120);
    expect(h.calls.fetch).toBe(1);
    await h.controller.setAutoDownload(true);
    await h.controller.autoTask();
    expect(h.controller.getState().kind).toBe('ready');
    // 已经查到的新版本不用再问一次。
    expect(h.calls.fetch).toBe(1);
  });

  it('只在 Wi-Fi 下：用移动数据时不下，照旧提示一次；连上 Wi-Fi 后开始下', async () => {
    const h = harness();
    await enabled(h);
    h.setNetwork('cellular');
    expect((await h.controller.autoCheck())?.versionCode).toBe(120);
    await h.controller.autoTask();
    expect(h.calls.download).toEqual([]);
    h.setNetwork('wifi');
    h.controller.onNetworkChange('wifi');
    await h.controller.autoTask();
    expect(h.controller.getState().kind).toBe('ready');
  });

  it('关掉“仅在 Wi-Fi 下”后用移动数据也下', async () => {
    const h = harness();
    await enabled(h);
    await h.controller.setWifiOnly(false);
    h.setNetwork('cellular');
    await h.controller.autoCheck();
    await h.controller.autoTask();
    expect(h.controller.getState().kind).toBe('ready');
  });

  it('自动下载时 Wi-Fi 断了就停下、删掉半截文件；用户自己点的下载不停', async () => {
    const h = harness();
    await enabled(h);
    const hang = (_url: string, file: string, _p: unknown, signal: AbortSignal) =>
      new Promise<void>((_resolve, reject) => {
        h.files.set(file, { size: 300, sha: '' });
        signal.addEventListener('abort', () => reject(new Error('AbortError')));
      });
    h.setDownload(hang);
    await h.controller.autoCheck();
    await Promise.resolve();
    expect(h.controller.getState().kind).toBe('downloading');
    h.setNetwork('cellular');
    h.controller.onNetworkChange('cellular');
    await h.controller.autoTask();
    expect(h.controller.getState().kind).toBe('available');
    expect(h.files.size).toBe(0);

    // 用户在弹层里自己点了下载：用移动数据是他自己决定的。
    const manual = h.controller.download();
    await Promise.resolve();
    h.controller.onNetworkChange('cellular');
    await Promise.resolve();
    expect(h.controller.getState().kind).toBe('downloading');
    h.controller.cancel();
    await manual;
  });

  it('失败时不显示失败，下次进入再试；同一个版本最多试几次，之后只提示', async () => {
    const h = harness();
    await enabled(h);
    h.setDownload(async () => {
      throw new Error('network lost');
    });
    for (let i = 0; i < AUTO_DOWNLOAD_MAX_ATTEMPTS; i += 1) {
      expect(await h.controller.autoCheck()).toBe(null);
      await h.controller.autoTask();
      // 没人在等这次下载，失败也只是回到“有新版本”，设置里还能手动下。
      expect(h.controller.getState().kind).toBe('available');
    }
    expect(h.calls.download).toHaveLength(AUTO_DOWNLOAD_MAX_ATTEMPTS);
    // 次数用完：不再自动下，改成提示一次，让用户自己决定。
    expect((await h.controller.autoCheck())?.versionCode).toBe(120);
    await h.controller.autoTask();
    h.controller.onNetworkChange('wifi');
    await h.controller.autoTask();
    expect(h.calls.download).toHaveLength(AUTO_DOWNLOAD_MAX_ATTEMPTS);
    // 出了新版本，从头算。
    h.advance(24 * 3_600_000);
    h.setNext(info({ versionCode: 121, versionName: '0.4.1' }));
    await h.controller.autoCheck();
    await h.controller.autoTask();
    expect(h.calls.download).toHaveLength(AUTO_DOWNLOAD_MAX_ATTEMPTS + 1);
  });

  it('App 在下载中被杀也算一次，重新打开不会无限重来', async () => {
    const h = harness();
    await enabled(h);
    h.setDownload(() => new Promise<void>(() => {}));
    let controller = h.controller;
    for (let i = 0; i < AUTO_DOWNLOAD_MAX_ATTEMPTS + 2; i += 1) {
      await controller.autoCheck({ force: true });
      controller = h.relaunch();
    }
    expect(h.calls.download).toHaveLength(AUTO_DOWNLOAD_MAX_ATTEMPTS);
  });

  it('sha256 不对：删掉文件，这个版本不再自动下', async () => {
    const h = harness();
    await enabled(h);
    h.setDownload(async (_url, file) => {
      h.files.set(file, { size: 1000, sha: 'd'.repeat(64) });
    });
    await h.controller.autoCheck();
    await h.controller.autoTask();
    expect(h.files.size).toBe(0);
    expect(h.controller.getState().kind).toBe('available');
    h.controller.onNetworkChange('wifi');
    await h.controller.autoTask();
    expect(h.calls.download).toHaveLength(1);
  });

  it('关掉自动下载：删掉下好没装的包，回到有新版本', async () => {
    const h = harness();
    await enabled(h);
    await h.controller.autoCheck();
    await h.controller.autoTask();
    expect(h.files.has(APK)).toBe(true);
    await h.controller.setAutoDownload(false);
    expect(h.files.size).toBe(0);
    expect(h.controller.getState()).toMatchObject({
      kind: 'available',
      update: { versionCode: 120 },
    });
    // 重新打开 App 也不会再冒出来。
    const again = h.relaunch();
    await again.restore();
    expect(again.getState().kind).toBe('idle');
  });

  it('关掉自动下载时正在下的停下，半截文件删掉', async () => {
    const h = harness();
    await enabled(h);
    h.setDownload(
      (_url, file, _p, signal) =>
        new Promise<void>((_resolve, reject) => {
          h.files.set(file, { size: 300, sha: '' });
          signal.addEventListener('abort', () => reject(new Error('AbortError')));
        }),
    );
    await h.controller.autoCheck();
    await Promise.resolve();
    expect(h.controller.getState().kind).toBe('downloading');
    await h.controller.setAutoDownload(false);
    await h.controller.autoTask();
    expect(h.controller.getState().kind).toBe('available');
    expect(h.files.size).toBe(0);
  });

  it('核对文件时关掉开关：文件删了，不能进入可以安装', async () => {
    const h = harness();
    await enabled(h);
    // 哈希读的是删掉之前就打开的文件，照样算得出正确的值。
    let finishHash: () => void = () => {};
    const controller = new UpdateController({
      ...h.deps,
      sha256: () =>
        new Promise((resolve) => {
          finishHash = () => resolve(SHA);
        }),
    });
    await controller.autoCheck({ force: true });
    for (let i = 0; i < 20 && controller.getState().kind !== 'verifying'; i += 1) {
      await Promise.resolve();
    }
    expect(controller.getState().kind).toBe('verifying');
    await controller.setAutoDownload(false);
    finishHash();
    await controller.autoTask();
    expect(controller.getState().kind).toBe('available');
    expect(h.files.size).toBe(0);
  });

  it('App 被杀后重新打开：在本机核对下好的文件，不问服务端就提示安装', async () => {
    const h = harness();
    await enabled(h);
    await h.controller.autoCheck();
    await h.controller.autoTask();
    const fetched = h.calls.fetch;
    const again = h.relaunch();
    await again.restore();
    expect(again.getState()).toMatchObject({
      kind: 'ready',
      file: APK,
      update: { versionCode: 120 },
    });
    expect(h.calls.fetch).toBe(fetched);
    await again.install();
    expect(h.calls.install).toEqual([APK]);
  });

  it('重新打开时文件被改过或者不在了：不提示安装，坏文件删掉', async () => {
    const h = harness();
    await enabled(h);
    await h.controller.autoCheck();
    await h.controller.autoTask();
    h.files.set(APK, { size: 1000, sha: 'e'.repeat(64) });
    const tampered = h.relaunch();
    await tampered.restore();
    expect(tampered.getState().kind).toBe('idle');
    expect(h.files.size).toBe(0);
    const missing = h.relaunch();
    await missing.restore();
    expect(missing.getState().kind).toBe('idle');
  });

  it('装上新版本之后（版本号已经不低于它）不再提示安装', async () => {
    const h = harness();
    await enabled(h);
    await h.controller.autoCheck();
    await h.controller.autoTask();
    const upgraded = new UpdateController({ ...h.deps, currentVersionCode: () => 120 });
    await upgraded.restore();
    expect(upgraded.getState().kind).toBe('idle');
  });

  it('提示卡关掉后同一个版本不再出现，新版本会再出现', async () => {
    const h = harness();
    await h.controller.loadSettings();
    expect(h.controller.getSettings().dismissedCode).toBe(null);
    await h.controller.dismissReady(120);
    expect(h.controller.getSettings().dismissedCode).toBe(120);
    const again = h.relaunch();
    await again.loadSettings();
    expect(again.getSettings().dismissedCode).toBe(120);
  });

  it('设置只存在这台手机上，重新打开还在', async () => {
    const h = harness();
    await h.controller.setAutoDownload(true);
    await h.controller.setWifiOnly(false);
    const again = h.relaunch();
    await again.loadSettings();
    expect(again.getSettings()).toMatchObject({ autoDownload: true, wifiOnly: false });
  });

  it('退出登录清掉本机数据后：下好的包删掉，设置回到默认', async () => {
    const h = harness();
    await enabled(h);
    await h.controller.autoCheck();
    await h.controller.autoTask();
    // 退出时 store.clear() 已经清掉了 meta。
    h.meta.clear();
    await h.controller.forgetLocal();
    expect(h.files.size).toBe(0);
    expect(h.controller.getState().kind).toBe('idle');
    expect(h.controller.getSettings()).toMatchObject({ autoDownload: false, wifiOnly: true });
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
