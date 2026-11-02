import type { UploadProgress, UploadQueue } from './uploadQueue';
import { shouldRunUploadService } from './uploadServicePolicy';

export interface ServiceNotice {
  channelName: string;
  title: string;
  text: string | null;
  percent: number | null;
  cancelLabel: string;
  pausedTitle: string;
  detailsLink: string;
  cancelLink: string;
}

export interface NativeUploadServiceApi {
  start(notice: ServiceNotice): boolean;
  update(notice: ServiceNotice): void;
  stop(): void;
  releaseKeepAlive(): void;
}

/** 通知每秒最多刷新一次：系统对频繁更新的通知会限流，甚至直接丢弃。 */
const NOTICE_MIN_INTERVAL_MS = 1_000;
/** 没有进度事件时（断网等待）也要定期看一眼，到时间就停。 */
const POLICY_TICK_MS = 15_000;

/**
 * 把队列的状态变成前台服务的启停和通知。何时该跑的规则在 uploadServicePolicy。
 * 活得比 React 界面长：从最近任务划掉后界面卸载了，上传还在继续。
 */
export class UploadServiceController {
  private running = false;
  /** 系统不让启动（App 在后台）。回到前台时再试，别的时候试了也是白试。 */
  private startBlocked = false;
  /** 到了系统的 6 小时上限，用户回到 App 前都不能再启动。 */
  private timedOut = false;
  private offlineSince: number | null = null;
  private lastProgressAt: number;
  private lastBytes = 0;
  private lastRemaining = 0;
  private lastNoticeAt = 0;
  private lastNoticeKey = '';
  private tick: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private queue: Pick<UploadQueue, 'subscribe' | 'getProgress' | 'stop' | 'load'>,
    private native: NativeUploadServiceApi,
    private notice: (progress: UploadProgress) => ServiceNotice,
    private now: () => number = Date.now,
  ) {
    this.lastProgressAt = now();
  }

  attach(): void {
    this.unsubscribe = this.queue.subscribe(() => this.evaluate()) as () => void;
    this.evaluate();
  }

  detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.stopService();
  }

  /** App 回到前台：系统放开了启动限制，6 小时的计时也重新开始。 */
  onForeground(): void {
    this.startBlocked = false;
    this.lastProgressAt = this.now();
    if (this.timedOut) {
      this.timedOut = false;
      void this.queue.load();
    }
    this.evaluate();
  }

  /** 系统要求服务几秒内停下。服务自己已经停了，这里让队列也停下来，任务留着，下次打开接着传。 */
  onSystemTimeout(): void {
    this.timedOut = true;
    this.running = false;
    this.clearTick();
    this.native.releaseKeepAlive();
    this.queue.stop();
  }

  private evaluate = () => {
    const progress = this.queue.getProgress();
    const now = this.now();
    if (progress.offline) this.offlineSince ??= now;
    else this.offlineSince = null;
    const remaining = progress.total + progress.failedCount;
    if (progress.sentBytes > this.lastBytes || remaining < this.lastRemaining) {
      this.lastProgressAt = now;
    }
    this.lastBytes = progress.sentBytes;
    this.lastRemaining = remaining;

    const want = shouldRunUploadService({
      progress,
      now,
      offlineSince: this.offlineSince,
      lastProgressAt: this.lastProgressAt,
    });
    if (!want || this.timedOut) {
      this.stopService();
      return;
    }
    const notice = this.notice(progress);
    if (!this.running) {
      if (this.startBlocked) return;
      if (this.native.start(notice)) {
        this.running = true;
        this.lastNoticeAt = now;
        this.lastNoticeKey = JSON.stringify(notice);
        this.tick = setInterval(this.evaluate, POLICY_TICK_MS);
      } else {
        this.startBlocked = true;
      }
      return;
    }
    const key = JSON.stringify(notice);
    if (key === this.lastNoticeKey || now - this.lastNoticeAt < NOTICE_MIN_INTERVAL_MS) return;
    this.lastNoticeKey = key;
    this.lastNoticeAt = now;
    this.native.update(notice);
  };

  private clearTick(): void {
    if (this.tick) clearInterval(this.tick);
    this.tick = null;
  }

  private stopService(): void {
    if (!this.running) return;
    this.running = false;
    this.clearTick();
    this.native.stop();
  }
}
