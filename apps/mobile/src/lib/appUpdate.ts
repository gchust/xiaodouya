import {
  type AppUpdateInfo,
  type AutoDownloadBlocker,
  type AutoUpdatePrefs,
  autoAttemptsFor,
  autoDownloadBlocker,
  type DownloadedUpdate,
  defaultAutoUpdatePrefs,
  exhaustAutoAttempts,
  type NetworkKind,
  parseDownloadedUpdate,
  recordAutoAttempt,
  shouldAutoCheckUpdate,
  shouldNotifyUpdate,
} from '@xiaodouya/shared';

/**
 * 应用内更新的状态机：检查、下载、校验、交给系统安装。不依赖 React Native，平台相关的都从 deps 注入。
 * 活得比界面长（见 appUpdateRuntime）：关掉弹层不会停下下载，再打开时接着看进度。
 */

export type UpdateFailure = 'check' | 'network' | 'checksum' | 'install';

export type UpdatePhase =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'upToDate' }
  | { kind: 'available'; update: AppUpdateInfo }
  | { kind: 'downloading'; update: AppUpdateInfo; received: number; total: number }
  | { kind: 'verifying'; update: AppUpdateInfo }
  | { kind: 'ready'; update: AppUpdateInfo; file: string }
  | { kind: 'failed'; reason: UpdateFailure; update?: AppUpdateInfo };

export type DownloadOutcome =
  | 'skipped'
  | 'ready'
  | 'cancelled'
  | 'network'
  | 'checksum'
  | 'upToDate';

/** 这台手机上的设置，不同步。dismissedCode：今天页“已下载好”的提示卡被关掉的版本。 */
export interface UpdateSettings extends AutoUpdatePrefs {
  dismissedCode: number | null;
}

export interface UpdateDeps {
  currentVersionCode(): number;
  /** 问服务端。断网、服务端出错时抛错。 */
  fetchUpdate(versionCode: number): Promise<AppUpdateInfo | null>;
  /** 这个版本的 APK 存在哪。同一个版本总是同一个位置，下好没装的下次能接着用。 */
  apkFile(versionCode: number): string;
  /** 不存在时是 null。 */
  fileSize(file: string): number | null;
  deleteFile(file: string): void;
  /** 删掉所有下载的安装包（关掉自动下载、退出登录时）。 */
  deleteDownloads(): void;
  network(): Promise<NetworkKind>;
  download(
    url: string,
    file: string,
    onProgress: (received: number, total: number) => void,
    signal: AbortSignal,
  ): Promise<void>;
  sha256(file: string): Promise<string>;
  /** 调起系统安装界面。用户还要在那里点一次“安装”，Android 不允许跳过。 */
  install(file: string): Promise<void>;
  getMeta(key: string): Promise<string | null>;
  setMeta(key: string, value: string): Promise<void>;
  now(): number;
}

const LAST_CHECK_KEY = 'update.lastCheckAt';
const NOTIFIED_KEY = 'update.notifiedCode';
const AUTO_KEY = 'update.autoDownload';
const WIFI_ONLY_KEY = 'update.wifiOnly';
const ATTEMPTS_KEY = 'update.autoAttempts';
const DOWNLOADED_KEY = 'update.downloaded';
const DISMISSED_KEY = 'update.readyDismissed';
/** 链接剩不到这么久就重新取一个：慢速网络上开始下载也要时间。 */
const URL_MARGIN_MS = 2 * 60_000;

const defaultSettings = (): UpdateSettings => ({ ...defaultAutoUpdatePrefs, dismissedCode: null });

const downloadedInfo = (update: AppUpdateInfo): DownloadedUpdate => ({
  versionCode: update.versionCode,
  versionName: update.versionName,
  size: update.size,
  sha256: update.sha256,
  required: update.required,
  notes: update.notes,
});

type AutoStart = 'started' | 'busy' | AutoDownloadBlocker;

export class UpdateController {
  private state: UpdatePhase = { kind: 'idle' };
  private settings: UpdateSettings = defaultSettings();
  private settingsLoad: Promise<void> | null = null;
  private listeners = new Set<() => void>();
  private abort: AbortController | null = null;
  /** 上一次从服务端拿到链接的时间，判断链接还能不能用。 */
  private fetchedAt = 0;
  /** 关掉自动下载、退出登录时加一：之前开始的下载和校验结果作废，不能进入可以安装。 */
  private epoch = 0;
  /** 正在进行的是自动下载（不是用户在弹层里点的），Wi-Fi 断了要停。 */
  private autoDownloading = false;
  private autoJob: Promise<unknown> = Promise.resolve();
  private restored = false;

  constructor(readonly deps: UpdateDeps) {}

  getState = (): UpdatePhase => this.state;
  getSettings = (): UpdateSettings => this.settings;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private emit() {
    for (const listener of this.listeners) listener();
  }

  private set(next: UpdatePhase) {
    this.state = next;
    this.emit();
  }

  private patchSettings(patch: Partial<UpdateSettings>) {
    this.settings = { ...this.settings, ...patch };
    this.emit();
  }

  private get busy(): boolean {
    const kind = this.state.kind;
    return kind === 'checking' || kind === 'downloading' || kind === 'verifying';
  }

  /** 用户正在下载、校验或安装时，自动检查不插手。 */
  private get idleForAutoCheck(): boolean {
    const s = this.state;
    return (
      s.kind === 'idle' ||
      s.kind === 'upToDate' ||
      s.kind === 'available' ||
      (s.kind === 'failed' && s.reason === 'check')
    );
  }

  private async fetch(): Promise<AppUpdateInfo | null> {
    const update = await this.deps.fetchUpdate(this.deps.currentVersionCode());
    this.fetchedAt = this.deps.now();
    return update;
  }

  loadSettings(): Promise<void> {
    if (!this.settingsLoad) {
      this.settingsLoad = (async () => {
        const [auto, wifiOnly, dismissed] = await Promise.all([
          this.deps.getMeta(AUTO_KEY),
          this.deps.getMeta(WIFI_ONLY_KEY),
          this.deps.getMeta(DISMISSED_KEY),
        ]);
        const code = Number(dismissed);
        this.patchSettings({
          autoDownload: auto === '1',
          // 没设置过是默认的“只在 Wi-Fi 下”。
          wifiOnly: wifiOnly !== '0',
          dismissedCode: dismissed && Number.isInteger(code) ? code : null,
        });
      })().catch(() => {});
    }
    return this.settingsLoad;
  }

  /** 关掉时停下正在下的、删掉下好没装的包。打开时马上查一次，不等节流。 */
  async setAutoDownload(on: boolean): Promise<void> {
    await this.loadSettings();
    this.patchSettings({ autoDownload: on });
    await this.deps.setMeta(AUTO_KEY, on ? '1' : '0');
    // 重新打开是用户新的决定，之前试过几次不算。
    await this.deps.setMeta(ATTEMPTS_KEY, '');
    if (!on) {
      await this.discardDownloads();
      return;
    }
    // 之前手动下载失败过（弹层里显示的失败）：打开开关就是让它自己再下，不能卡在失败上。
    const s = this.state;
    if (s.kind === 'failed' && s.update) this.set({ kind: 'available', update: s.update });
    await this.autoCheck({ force: true });
  }

  async setWifiOnly(on: boolean): Promise<void> {
    await this.loadSettings();
    this.patchSettings({ wifiOnly: on });
    await this.deps.setMeta(WIFI_ONLY_KEY, on ? '1' : '0');
    if (on) {
      if (this.autoDownloading && (await this.deps.network()) !== 'wifi') this.cancel();
    } else if (this.state.kind === 'available') {
      void this.tryAutoDownload(this.state.update);
    }
  }

  async dismissReady(versionCode: number): Promise<void> {
    this.patchSettings({ dismissedCode: versionCode });
    await this.deps.setMeta(DISMISSED_KEY, String(versionCode));
  }

  /** 网络变了（运行时订阅 NetInfo）：只在 Wi-Fi 下时，自动下载断开 Wi-Fi 就停；连上了就接着下。 */
  onNetworkChange(network: NetworkKind): void {
    if (this.autoDownloading) {
      if (network === 'none' || (this.settings.wifiOnly && network !== 'wifi')) this.cancel();
      return;
    }
    if (this.state.kind === 'available' && this.settings.autoDownload && network !== 'none') {
      void this.tryAutoDownload(this.state.update);
    }
  }

  /** 测试和界面等自动下载告一段落（决定要不要下、下完、失败）。 */
  async autoTask(): Promise<void> {
    for (;;) {
      const job = this.autoJob;
      await job;
      if (job === this.autoJob) return;
    }
  }

  private track(job: Promise<unknown>) {
    const previous = this.autoJob;
    this.autoJob = Promise.allSettled([previous, job]);
  }

  private tryAutoDownload(update: AppUpdateInfo): Promise<AutoStart> {
    const decision = (async (): Promise<AutoStart> => {
      if (!this.settings.autoDownload) return 'off';
      if (this.busy) return 'busy';
      const [stored, network] = await Promise.all([
        this.deps.getMeta(ATTEMPTS_KEY),
        this.deps.network(),
      ]);
      const blocker = autoDownloadBlocker({
        prefs: this.settings,
        network,
        attempts: autoAttemptsFor(stored, update),
      });
      if (blocker) return blocker;
      const current = this.state;
      if (current.kind !== 'available' || current.update.versionCode !== update.versionCode) {
        return 'busy';
      }
      // 开始之前先记一次：下载中 App 被杀也算，重新打开不会无限重来。
      await this.deps.setMeta(ATTEMPTS_KEY, recordAutoAttempt(stored, update));
      if (this.busy) return 'busy';
      this.autoDownloading = true;
      const job = this.download({ auto: true })
        .then(async (outcome) => {
          if (outcome === 'checksum') {
            await this.deps.setMeta(ATTEMPTS_KEY, exhaustAutoAttempts(update));
          }
        })
        .finally(() => {
          this.autoDownloading = false;
        });
      this.track(job);
      return 'started';
    })().catch((): AutoStart => 'busy');
    this.track(decision);
    return decision;
  }

  /** 用户点“检查更新”：总是问服务端。下载中不打断。 */
  async check(): Promise<void> {
    if (this.busy) return;
    const previous = this.state;
    this.set({ kind: 'checking' });
    try {
      const update = await this.fetch();
      if (!update) {
        this.set({ kind: 'upToDate' });
      } else if (
        previous.kind === 'ready' &&
        previous.update.versionCode === update.versionCode &&
        previous.update.sha256 === update.sha256
      ) {
        this.set({ ...previous, update });
      } else {
        this.set({ kind: 'available', update });
      }
    } catch {
      this.set({ kind: 'failed', reason: 'check' });
    }
  }

  /**
   * 打开 App、回到前台时：最多每隔 UPDATE_CHECK_INTERVAL_MS 问一次服务端（force 时不等）。
   * 打开了自动下载、条件也允许时在后台下载，不提示；否则返回值不为 null 时提示用户（同一个版本只提示一次）。
   * 失败时什么都不说，也不算检查过，下次打开再试：半夜记录时不该弹出“检查更新失败”。
   */
  async autoCheck(options: { force?: boolean } = {}): Promise<AppUpdateInfo | null> {
    await this.loadSettings();
    await this.restore();
    if (!this.idleForAutoCheck) return null;
    const now = this.deps.now();
    const last = Number(await this.deps.getMeta(LAST_CHECK_KEY));
    const due = options.force
      ? this.state.kind !== 'available'
      : shouldAutoCheckUpdate(Number.isFinite(last) && last > 0 ? last : null, now);
    if (due) {
      let update: AppUpdateInfo | null;
      try {
        update = await this.fetch();
      } catch {
        return null;
      }
      await this.deps.setMeta(LAST_CHECK_KEY, String(now));
      // 等待的时候用户可能已经点了“检查更新”或开始下载，那边为准。
      if (!this.idleForAutoCheck) return null;
      if (!update) {
        this.set({ kind: 'upToDate' });
        return null;
      }
      this.set({ kind: 'available', update });
    }
    const current = this.state;
    if (current.kind !== 'available') return null;
    const update = current.update;
    const auto = await this.tryAutoDownload(update);
    if (auto === 'started' || auto === 'busy') return null;
    // 没开自动下载时和以前一样，只在真的问过服务端之后提示；开了但现在下不了（用移动数据、试够了次数）也提示一次。
    // 必须更新的每次都提示，所以它还是只在问过服务端之后提示，不能变成每次回到前台都提示。
    if (!due && (auto === 'off' || update.required)) return null;
    const notified = Number(await this.deps.getMeta(NOTIFIED_KEY));
    if (!shouldNotifyUpdate(update, Number.isFinite(notified) ? notified : null)) return null;
    await this.deps.setMeta(NOTIFIED_KEY, String(update.versionCode));
    return update;
  }

  /**
   * App 被杀后重新打开：自动下载好、还没装的包在本机核对一遍，对得上就直接提示安装，不问服务端。
   * 每个进程只做一次。
   */
  async restore(): Promise<void> {
    await this.loadSettings();
    if (this.restored) return;
    this.restored = true;
    if (!this.settings.autoDownload || this.state.kind !== 'idle') return;
    const saved = parseDownloadedUpdate(await this.deps.getMeta(DOWNLOADED_KEY));
    if (!saved) return;
    if (saved.versionCode <= this.deps.currentVersionCode()) {
      await this.deps.setMeta(DOWNLOADED_KEY, '');
      return;
    }
    const file = this.deps.apkFile(saved.versionCode);
    if (this.deps.fileSize(file) !== saved.size) {
      this.deps.deleteFile(file);
      return;
    }
    if (this.state.kind !== 'idle') return;
    // 链接没存，fetchedAt 是 0：要重新下载时 download 会先去取一个新的。
    const update: AppUpdateInfo = { ...saved, url: '', expiresIn: 1 };
    if ((await this.verify(update, file, this.epoch)) !== 'ok') {
      this.deps.deleteFile(file);
      await this.deps.setMeta(DOWNLOADED_KEY, '');
      this.set({ kind: 'idle' });
    }
  }

  /** 停下下载、删掉所有安装包。正在校验的结果作废。 */
  private async discardDownloads(): Promise<void> {
    this.epoch += 1;
    this.abort?.abort();
    this.deps.deleteDownloads();
    await this.deps.setMeta(DOWNLOADED_KEY, '');
    const s = this.state;
    if (s.kind === 'ready') this.set({ kind: 'available', update: s.update });
  }

  /** 退出登录清掉本机数据之后（meta 已经清空）：包删掉，状态和设置回到默认。 */
  async forgetLocal(): Promise<void> {
    this.epoch += 1;
    this.abort?.abort();
    this.deps.deleteDownloads();
    this.restored = false;
    this.settingsLoad = null;
    this.settings = defaultSettings();
    this.set({ kind: 'idle' });
    await this.loadSettings();
  }

  /** 下载（或重试）。下好的同版本文件校验通过就直接用。自动下载失败时不显示失败，回到有新版本。 */
  async download(options: { auto?: boolean } = {}): Promise<DownloadOutcome> {
    const current = this.state;
    if (this.busy || !('update' in current) || !current.update) return 'skipped';
    let update = current.update;
    const epoch = this.epoch;
    const abort = new AbortController();
    this.abort = abort;
    const fail = (reason: 'network' | 'checksum', failed: AppUpdateInfo): DownloadOutcome => {
      this.set(
        options.auto
          ? { kind: 'available', update: failed }
          : { kind: 'failed', reason, update: failed },
      );
      return reason;
    };
    const stale = (file: string, discarded: AppUpdateInfo): DownloadOutcome => {
      this.deps.deleteFile(file);
      this.set({ kind: 'available', update: discarded });
      return 'cancelled';
    };
    try {
      const file = this.deps.apkFile(update.versionCode);
      if (this.deps.fileSize(file) === update.size) {
        const existing = await this.verify(update, file, epoch);
        if (existing === 'ok') return 'ready';
        if (existing === 'stale') return stale(file, update);
      }
      this.deps.deleteFile(file);

      if (this.deps.now() > this.fetchedAt + update.expiresIn * 1000 - URL_MARGIN_MS) {
        this.set({ kind: 'downloading', update, received: 0, total: update.size });
        let fresh: AppUpdateInfo | null;
        try {
          fresh = await this.fetch();
        } catch {
          return fail('network', update);
        }
        if (!fresh) {
          this.set({ kind: 'upToDate' });
          return 'upToDate';
        }
        update = fresh;
      }

      const target = this.deps.apkFile(update.versionCode);
      this.set({ kind: 'downloading', update, received: 0, total: update.size });
      try {
        await this.deps.download(
          update.url,
          target,
          (received, total) => {
            if (abort.signal.aborted) return;
            this.set({
              kind: 'downloading',
              update,
              received,
              total: total > 0 ? total : update.size,
            });
          },
          abort.signal,
        );
      } catch {
        this.deps.deleteFile(target);
        if (abort.signal.aborted) {
          this.set({ kind: 'available', update });
          return 'cancelled';
        }
        return fail('network', update);
      }
      if (abort.signal.aborted) return stale(target, update);
      if (this.deps.fileSize(target) !== update.size) {
        this.deps.deleteFile(target);
        return fail('checksum', update);
      }
      const verified = await this.verify(update, target, epoch);
      if (verified === 'ok') return 'ready';
      if (verified === 'stale') return stale(target, update);
      this.deps.deleteFile(target);
      return fail('checksum', update);
    } finally {
      if (this.abort === abort) this.abort = null;
    }
  }

  /** 通过时进入 ready；不通过时由调用方删文件。期间关掉了自动下载（epoch 变了）就是 stale。 */
  private async verify(
    update: AppUpdateInfo,
    file: string,
    epoch: number,
  ): Promise<'ok' | 'bad' | 'stale'> {
    this.set({ kind: 'verifying', update });
    let actual: string;
    try {
      actual = await this.deps.sha256(file);
    } catch {
      return this.epoch === epoch ? 'bad' : 'stale';
    }
    if (this.epoch !== epoch) return 'stale';
    if (actual !== update.sha256) return 'bad';
    this.set({ kind: 'ready', update, file });
    // 记下来：App 被杀后重新打开时在本机核对，不用等下一次检查。失败了只是少了这个方便。
    await this.deps.setMeta(DOWNLOADED_KEY, JSON.stringify(downloadedInfo(update))).catch(() => {});
    return 'ok';
  }

  cancel(): void {
    this.abort?.abort();
  }

  /**
   * 安装界面开着时 install 一直不返回（用户取消后才返回，装上了进程就被换掉）。
   * 这期间再点一次不能再开一个：expo-intent-launcher 会报“已经开着”，不能当成打不开。
   */
  private installing = false;

  async install(): Promise<void> {
    const current = this.state;
    if (current.kind !== 'ready' || this.installing) return;
    this.installing = true;
    try {
      await this.deps.install(current.file);
    } catch {
      this.set({ kind: 'failed', reason: 'install', update: current.update });
    } finally {
      this.installing = false;
    }
  }
}
