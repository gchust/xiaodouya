import { type AppUpdateInfo, shouldAutoCheckUpdate, shouldNotifyUpdate } from '@xiaodouya/shared';

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

export interface UpdateDeps {
  currentVersionCode(): number;
  /** 问服务端。断网、服务端出错时抛错。 */
  fetchUpdate(versionCode: number): Promise<AppUpdateInfo | null>;
  /** 这个版本的 APK 存在哪。同一个版本总是同一个位置，下好没装的下次能接着用。 */
  apkFile(versionCode: number): string;
  /** 不存在时是 null。 */
  fileSize(file: string): number | null;
  deleteFile(file: string): void;
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
/** 链接剩不到这么久就重新取一个：慢速网络上开始下载也要时间。 */
const URL_MARGIN_MS = 2 * 60_000;

export class UpdateController {
  private state: UpdatePhase = { kind: 'idle' };
  private listeners = new Set<() => void>();
  private abort: AbortController | null = null;
  /** 上一次从服务端拿到链接的时间，判断链接还能不能用。 */
  private fetchedAt = 0;

  constructor(readonly deps: UpdateDeps) {}

  getState = (): UpdatePhase => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(next: UpdatePhase) {
    this.state = next;
    for (const listener of this.listeners) listener();
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
   * 打开 App 时：一天最多问一次。返回值不为 null 时提示用户（同一个版本只提示一次）。
   * 失败时什么都不说，也不算检查过，下次打开再试：半夜记录时不该弹出“检查更新失败”。
   */
  async autoCheck(): Promise<AppUpdateInfo | null> {
    if (!this.idleForAutoCheck) return null;
    const now = this.deps.now();
    const last = Number(await this.deps.getMeta(LAST_CHECK_KEY));
    if (!shouldAutoCheckUpdate(Number.isFinite(last) && last > 0 ? last : null, now)) return null;
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
    const notified = Number(await this.deps.getMeta(NOTIFIED_KEY));
    if (!shouldNotifyUpdate(update, Number.isFinite(notified) ? notified : null)) return null;
    await this.deps.setMeta(NOTIFIED_KEY, String(update.versionCode));
    return update;
  }

  /** 下载（或重试）。下好的同版本文件校验通过就直接用。 */
  async download(): Promise<void> {
    const current = this.state;
    if (this.busy || !('update' in current) || !current.update) return;
    let update = current.update;
    const abort = new AbortController();
    this.abort = abort;
    try {
      const file = this.deps.apkFile(update.versionCode);
      if (this.deps.fileSize(file) === update.size && (await this.verify(update, file))) return;
      this.deps.deleteFile(file);

      if (this.deps.now() > this.fetchedAt + update.expiresIn * 1000 - URL_MARGIN_MS) {
        this.set({ kind: 'downloading', update, received: 0, total: update.size });
        let fresh: AppUpdateInfo | null;
        try {
          fresh = await this.fetch();
        } catch {
          this.set({ kind: 'failed', reason: 'network', update });
          return;
        }
        if (!fresh) {
          this.set({ kind: 'upToDate' });
          return;
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
        this.set(
          abort.signal.aborted
            ? { kind: 'available', update }
            : { kind: 'failed', reason: 'network', update },
        );
        return;
      }
      if (abort.signal.aborted) {
        this.deps.deleteFile(target);
        this.set({ kind: 'available', update });
        return;
      }
      if (this.deps.fileSize(target) !== update.size || !(await this.verify(update, target))) {
        this.deps.deleteFile(target);
        this.set({ kind: 'failed', reason: 'checksum', update });
      }
    } finally {
      if (this.abort === abort) this.abort = null;
    }
  }

  /** 通过时进入 ready；不通过时返回 false，由调用方删文件。 */
  private async verify(update: AppUpdateInfo, file: string): Promise<boolean> {
    this.set({ kind: 'verifying', update });
    let actual: string;
    try {
      actual = await this.deps.sha256(file);
    } catch {
      return false;
    }
    if (actual !== update.sha256) return false;
    this.set({ kind: 'ready', update, file });
    return true;
  }

  cancel(): void {
    this.abort?.abort();
  }

  async install(): Promise<void> {
    const current = this.state;
    if (current.kind !== 'ready') return;
    try {
      await this.deps.install(current.file);
    } catch {
      this.set({ kind: 'failed', reason: 'install', update: current.update });
    }
  }
}
