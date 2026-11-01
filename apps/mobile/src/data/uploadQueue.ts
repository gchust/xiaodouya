import type {
  MediaScope,
  MediaVariant,
  UploadUrlRequest,
  UploadUrlResponse,
} from '@xiaodouya/shared';

export interface UploadJob {
  /** `${id}/${variant}` */
  key: string;
  id: string;
  variant: MediaVariant;
  scope: MediaScope;
  /** App 私有目录里的文件副本，上传完成前不会被系统回收。 */
  localUri: string;
  mime: string;
  size: number;
  filename?: string;
  /** 视频可设置为只在 Wi-Fi 下上传。 */
  wifiOnly: boolean;
  attempts: number;
  /** 不可恢复的错误（例如文件类型被拒绝），需要用户处理。 */
  failed?: string;
  /** 缩略图还没生成时才有：记录要先写下来，解码原图放到队列里一张一张做。 */
  thumbSource?: { uri: string; kind: 'image' | 'video' };
}

export interface UploadQueueDb {
  loadJobs(): Promise<UploadJob[]>;
  saveJob(job: UploadJob): Promise<void>;
  deleteJob(key: string): Promise<void>;
}

export interface UploadTransport {
  requestUrl(request: UploadUrlRequest): Promise<UploadUrlResponse>;
  put(
    job: UploadJob,
    target: UploadUrlResponse,
    onProgress: (sentBytes: number) => void,
  ): Promise<{ status: number }>;
  complete(id: string, variant: MediaVariant): Promise<void>;
  /** 上传成功后清理本地副本。 */
  removeLocal(uri: string): Promise<void>;
  /** 把缩略图生成到 job.localUri。做不出来返回 null，这个文件就只有原图。 */
  makeThumb?(job: UploadJob): Promise<{ size: number } | null>;
}

/** 带状态码的错误，用来区分“可以重试”和“重试也没用”。 */
export class UploadHttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export type NetworkKind = 'wifi' | 'cellular' | 'none';

export interface UploadProgress {
  total: number;
  /** 0–1，按字节加权。 */
  fraction: number;
  active: boolean;
  /** 全部等 Wi-Fi 时为 true，界面据此提示而不是假装在传。 */
  waitingForWifi: boolean;
  failedCount: number;
  /** 第一个失败文件的原因，界面要告诉用户为什么失败。 */
  failedReason: string | null;
  doneInBatch: number;
}

const MAX_PUT_ATTEMPTS = 6;
const MIN_BACKOFF_MS = 3_000;
const MAX_BACKOFF_MS = 5 * 60_000;

/**
 * 持久化上传队列。文件先复制到私有目录并入队，所以 App 被杀或断网后都能接着传。
 * 一次只传一个：手机上并发直传容易把网络占满，也让进度显示更好理解。
 */
export class UploadQueue {
  private jobs = new Map<string, UploadJob>();
  private running = false;
  private network: NetworkKind = 'wifi';
  private listeners = new Set<() => void>();
  private progress: UploadProgress = {
    total: 0,
    fraction: 1,
    active: false,
    waitingForWifi: false,
    failedCount: 0,
    failedReason: null,
    doneInBatch: 0,
  };
  private batchBytes = 0;
  private batchSent = 0;
  private batchDone = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(
    private db: UploadQueueDb,
    private transport: UploadTransport,
    private options: {
      sleepMs?: (attempts: number) => number;
      onUploaded?: (id: string) => void;
    } = {},
  ) {}

  async load(): Promise<void> {
    this.stopped = false;
    this.jobs = new Map((await this.db.loadJobs()).map((j) => [j.key, j]));
    this.batchBytes = [...this.jobs.values()].reduce((sum, j) => sum + j.size, 0);
    this.publish();
    this.kick();
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getProgress = () => this.progress;

  pendingIds(): Set<string> {
    return new Set(
      [...this.jobs.values()].filter((j) => j.variant === 'original').map((j) => j.id),
    );
  }

  setNetwork(kind: NetworkKind): void {
    const before = this.network;
    this.network = kind;
    this.publish();
    if (before !== kind) this.kick();
  }

  async enqueue(jobs: Omit<UploadJob, 'key' | 'attempts'>[]): Promise<void> {
    for (const partial of jobs) {
      const job: UploadJob = { ...partial, key: `${partial.id}/${partial.variant}`, attempts: 0 };
      await this.db.saveJob(job);
      this.jobs.set(job.key, job);
      this.batchBytes += job.size;
    }
    this.publish();
    this.kick();
  }

  /** 重试失败的任务（用户在界面上点“重试”）。 */
  async retryFailed(): Promise<void> {
    for (const job of this.jobs.values()) {
      if (!job.failed) continue;
      job.failed = undefined;
      job.attempts = 0;
      await this.db.saveJob(job);
    }
    this.publish();
    this.kick();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  /** 手机上的数据被清空时调用。在路上的任务结束后不会再写回数据库，下次 load 才恢复工作。 */
  reset(): void {
    this.stop();
    this.jobs = new Map();
    this.batchBytes = 0;
    this.batchDone = 0;
    this.batchSent = 0;
    this.publish();
  }

  private nextJob(skip: ReadonlySet<string>): UploadJob | null {
    if (this.network === 'none') return null;
    for (const job of this.jobs.values()) {
      if (job.failed || skip.has(job.key)) continue;
      if (job.wifiOnly && this.network !== 'wifi') continue;
      // 原图传完本地副本就删了，还没做的缩略图要排在它前面。重启后读出来的顺序不一定是入队顺序。
      const thumb = this.jobs.get(`${job.id}/thumb`);
      if (thumb?.thumbSource && !skip.has(thumb.key)) return thumb;
      return job;
    }
    return null;
  }

  private kick(): void {
    if (this.running || this.stopped) return;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    void this.drain();
  }

  /** 等待队列跑完当前可执行的任务（测试用）。 */
  async idle(): Promise<void> {
    while (this.running) await new Promise((r) => setTimeout(r, 5));
  }

  private async drain(): Promise<void> {
    this.running = true;
    try {
      // 这一轮失败过的先跳过，一个传不上去的文件不能挡住后面的文件。
      const failedThisRound = new Set<string>();
      let lastFailed: UploadJob | null = null;
      for (;;) {
        if (this.stopped) return;
        const job = this.nextJob(failedThisRound);
        if (!job) break;
        const ok = await this.runJob(job);
        if (!ok) {
          failedThisRound.add(job.key);
          lastFailed = job;
        }
      }
      if (lastFailed) this.scheduleRetry(lastFailed);
    } finally {
      this.running = false;
      this.publish();
    }
  }

  private scheduleRetry(job: UploadJob): void {
    if (this.stopped) return;
    const delay = this.options.sleepMs
      ? this.options.sleepMs(job.attempts)
      : Math.min(MIN_BACKOFF_MS * 2 ** (job.attempts - 1), MAX_BACKOFF_MS);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.kick();
    }, delay);
  }

  private async runJob(job: UploadJob): Promise<boolean> {
    this.batchSent = 0;
    this.publish(true);
    if (job.thumbSource && !(await this.prepareThumb(job))) return true;
    try {
      const target = await this.transport.requestUrl({
        id: job.id,
        scope: job.scope,
        variant: job.variant,
        mime: job.mime,
        size: job.size,
        filename: job.filename,
      });
      const { status } = await this.transport.put(job, target, (sent) => {
        this.batchSent = sent;
        this.publish(true);
      });
      if (status < 200 || status >= 300)
        throw new UploadHttpError(status, 'put_failed', '上传失败');
      await this.transport.complete(job.id, job.variant);
      await this.finish(job);
      return true;
    } catch (error) {
      if (error instanceof UploadHttpError && error.code === 'already_uploaded') {
        // 上次传完后还没来得及更新队列就被杀了，这种情况算成功。
        await this.finish(job);
        return true;
      }
      // 队列已经被清空：写回去的话，下一个登录的人会看到别人的失败任务。
      if (this.jobs.get(job.key) !== job) return false;
      job.attempts += 1;
      if (error instanceof UploadHttpError) {
        if (isPermanent(error)) job.failed = error.message;
        // 存储持续报错（配额满、配置错）时重试没有意义，交给用户处理。
        else if (error.code === 'put_failed' && job.attempts >= MAX_PUT_ATTEMPTS) {
          job.failed = '存储一直返回错误，请检查存储设置后重试';
        }
      }
      await this.db.saveJob(job);
      this.publish();
      return Boolean(job.failed);
    }
  }

  /** 返回 false 表示这个任务不用再传了。缩略图只是省流量，任何失败都不能挡住原图。 */
  private async prepareThumb(job: UploadJob): Promise<boolean> {
    const made = await Promise.resolve(this.transport.makeThumb?.(job)).catch(() => null);
    // 队列已经被清空：写回去的话，下一个登录的人会看到别人的任务。
    if (this.jobs.get(job.key) !== job) return false;
    if (!made) {
      await this.db.deleteJob(job.key);
      this.jobs.delete(job.key);
      this.publish();
      return false;
    }
    job.size = made.size;
    job.thumbSource = undefined;
    this.batchBytes += made.size;
    await this.db.saveJob(job);
    return true;
  }

  private async finish(job: UploadJob): Promise<void> {
    await this.db.deleteJob(job.key);
    this.jobs.delete(job.key);
    this.batchDone += job.size;
    this.batchSent = 0;
    await this.transport.removeLocal(job.localUri).catch(() => {});
    if (job.variant === 'original') this.options.onUploaded?.(job.id);
    this.publish();
  }

  private publish(active = this.running): void {
    const jobs = [...this.jobs.values()];
    const live = jobs.filter((j) => !j.failed);
    const sendable = live.filter((j) => !j.wifiOnly || this.network === 'wifi');
    const fraction =
      this.batchBytes > 0 ? Math.min(1, (this.batchDone + this.batchSent) / this.batchBytes) : 1;
    this.progress = {
      total: live.length,
      fraction,
      active: active && live.length > 0,
      waitingForWifi: live.length > 0 && sendable.length === 0 && this.network !== 'none',
      failedCount: jobs.length - live.length,
      failedReason: jobs.find((j) => j.failed)?.failed ?? null,
      doneInBatch: this.batchDone,
    };
    if (live.length === 0) {
      // 这批传完了，下次进度条从 0 开始。
      this.batchBytes = jobs.reduce((sum, j) => sum + j.size, 0);
      this.batchDone = 0;
      this.batchSent = 0;
    }
    for (const listener of this.listeners) listener();
  }
}

/** 4xx 表示请求本身有问题，但鉴权过期和限流可以恢复。 */
function isPermanent(error: UploadHttpError): boolean {
  if (
    error.status === 401 ||
    error.status === 403 ||
    error.status === 408 ||
    error.status === 429
  ) {
    return error.status === 403 && error.code !== 'put_failed';
  }
  // 预签名链接过期等 S3 层错误，重新申请链接即可恢复。
  if (error.code === 'put_failed') return false;
  return error.status >= 400 && error.status < 500 && error.code !== 'not_uploaded';
}
