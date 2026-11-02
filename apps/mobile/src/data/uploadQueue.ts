import type {
  MediaKind,
  MediaScope,
  MediaVariant,
  MultipartPartsResponse,
  MultipartPartUrlsResponse,
  MultipartStartResponse,
  UploadUrlRequest,
  UploadUrlResponse,
} from '@xiaodouya/shared';
import {
  confirmedPartBytes,
  MULTIPART_URL_BATCH,
  missingParts,
  multipartPartBytes,
  t,
  usesMultipart,
} from '@xiaodouya/shared';
import { addSpeedSample, currentSpeed, etaSeconds, type SpeedSample } from './uploadSpeed';

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
  /** 用户看到的类型。缩略图的 mime 永远是 jpeg，所以单独记。升级前的任务没有，按 mime 算。 */
  mediaKind?: MediaKind;
  /** 分片上传的状态，持久化后 App 重启能接着传。已传了哪些片不记在这里，每次问服务端。 */
  uploadId?: string;
  partSize?: number;
  /** 上次问到的、已经确认传上去的字节。只用于显示进度，不决定传什么。 */
  confirmedBytes?: number;
  /** 开始分片时文件的修改时间。之后变了说明内容可能不一样，不能拼在一起。 */
  localModifiedAt?: number;
  /** 服务端或存储不支持分片，这个文件一直用单个 PUT。 */
  singlePut?: boolean;
  /** 墓碑：用户取消了，本地已经清掉，只差告诉服务端。离线取消时要留到有网。 */
  cancelled?: boolean;
}

export interface UploadQueueDb {
  loadJobs(): Promise<UploadJob[]>;
  saveJob(job: UploadJob): Promise<void>;
  deleteJob(key: string): Promise<void>;
}

/** 分片要放在哪些片之外的信息都由 job 决定，所以这里只传片号和链接。 */
export interface UploadPartTarget {
  partNumber: number;
  url: string;
  offset: number;
  size: number;
}

export interface MultipartTransport {
  start(request: UploadUrlRequest): Promise<MultipartStartResponse>;
  listParts(job: UploadJob, uploadId: string): Promise<MultipartPartsResponse>;
  partUrls(
    job: UploadJob,
    uploadId: string,
    partNumbers: number[],
  ): Promise<MultipartPartUrlsResponse>;
  /** onProgress 报这一片已发出的字节，不然大文件的进度和速度只能按整片跳。 */
  putPart(
    job: UploadJob,
    part: UploadPartTarget,
    onProgress: (sentBytes: number) => void,
    signal: AbortSignal,
  ): Promise<{ status: number }>;
  complete(job: UploadJob, uploadId: string): Promise<void>;
  /** 本地文件现在的样子。文件不在了返回 null。 */
  stat(job: UploadJob): Promise<{ size: number; modifiedAt?: number } | null>;
}

export interface UploadTransport {
  requestUrl(request: UploadUrlRequest): Promise<UploadUrlResponse>;
  put(
    job: UploadJob,
    target: UploadUrlResponse,
    onProgress: (sentBytes: number) => void,
    signal?: AbortSignal,
  ): Promise<{ status: number }>;
  complete(id: string, variant: MediaVariant): Promise<void>;
  /** 上传成功后清理本地副本。 */
  removeLocal(uri: string): Promise<void>;
  /** 把缩略图生成到 job.localUri。做不出来返回 null，这个文件就只有原图。 */
  makeThumb?(job: UploadJob): Promise<{ size: number } | null>;
  /** 没有时大文件也走单个 PUT。 */
  multipart?: MultipartTransport;
  /** 告诉服务端不传了：清掉 pending 记录和已传的分片。 */
  cancelRemote?(id: string): Promise<void>;
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

export type UploadItemStatus =
  | 'uploading'
  | 'queued'
  | 'waitingWifi'
  | 'waitingNetwork'
  | 'retrying'
  | 'failed';

/** 用户看到的一项。一张照片的原图和缩略图是两个任务，但对用户只是一个文件。 */
export interface UploadItem {
  id: string;
  scope: MediaScope;
  kind: MediaKind;
  name?: string;
  size: number;
  /** 已传的字节：已确认的片加上正在传的这一片。 */
  sent: number;
  status: UploadItemStatus;
  reason: string | null;
}

export type UploadCounts = Record<MediaKind, number>;

export interface UploadProgress {
  /** 还在传的文件数（按媒体算，原图和缩略图算一个）。 */
  total: number;
  counts: UploadCounts;
  /** 0–1，按字节加权。 */
  fraction: number;
  sentBytes: number;
  totalBytes: number;
  active: boolean;
  /** 全部等 Wi-Fi 时为 true，界面据此提示而不是假装在传。 */
  waitingForWifi: boolean;
  offline: boolean;
  /** 队列停了：退出登录、登录失效，或者到了系统的后台上限。任务还在，只是现在不传。 */
  halted: boolean;
  failedCount: number;
  failedCounts: UploadCounts;
  /** 第一个失败文件的原因，界面要告诉用户为什么失败。 */
  failedReason: string | null;
  /** 这一批传完了多少个文件。取消的不算，全部取消时不能说“都传好了”。 */
  finishedInBatch: number;
  /** 字节每秒。排队、等 Wi-Fi、断网、刚开始时为 null，界面显示状态。 */
  speed: number | null;
  /** 预计还要多少秒，和 speed 一起有或没有。 */
  etaSeconds: number | null;
  items: UploadItem[];
}

const MAX_PUT_ATTEMPTS = 6;
const MIN_BACKOFF_MS = 3_000;
const MAX_BACKOFF_MS = 5 * 60_000;
/** 服务端的放弃清理（24 小时）是兜底，通知不到也不会一直占着。 */
const MAX_CANCEL_ATTEMPTS = 8;
/** 速度要在没有新字节时也能掉下来，所以传的时候定时刷新一次。 */
const SPEED_TICK_MS = 1_000;

const noCounts = (): UploadCounts => ({ image: 0, video: 0, audio: 0, pdf: 0 });

export function kindFromMime(mime: string): MediaKind {
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'application/pdf') return 'pdf';
  return 'image';
}

/**
 * 持久化上传队列。文件先复制到私有目录并入队，所以 App 被杀或断网后都能接着传。
 * 一次只传一个：手机上并发直传容易把网络占满，也让进度显示更好理解。
 */
export class UploadQueue {
  private jobs = new Map<string, UploadJob>();
  /** 已取消、还没通知到服务端的文件。不算进度，也不算待上传。 */
  private cancels = new Map<string, UploadJob>();
  private running = false;
  private network: NetworkKind = 'wifi';
  private listeners = new Set<() => void>();
  private progress: UploadProgress = {
    total: 0,
    counts: noCounts(),
    fraction: 1,
    sentBytes: 0,
    totalBytes: 0,
    active: false,
    waitingForWifi: false,
    offline: false,
    halted: false,
    failedCount: 0,
    failedCounts: noCounts(),
    failedReason: null,
    finishedInBatch: 0,
    speed: null,
    etaSeconds: null,
    items: [],
  };
  private batchBytes = 0;
  private batchDone = 0;
  private finishedInBatch = 0;
  /** 正在传的这个文件（或这一片）已发出的字节，还没确认。 */
  private inflight = 0;
  private current: { job: UploadJob; controller: AbortController } | null = null;
  private transferred = 0;
  private samples: SpeedSample[] = [];
  private speedTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private loaded = false;

  constructor(
    private db: UploadQueueDb,
    private transport: UploadTransport,
    private options: {
      sleepMs?: (attempts: number) => number;
      onUploaded?: (id: string) => void;
      now?: () => number;
    } = {},
  ) {}

  async load(): Promise<void> {
    // 界面重新挂载（划掉最近任务后再打开）时，队列可能还在后台传。重新读一遍会换掉任务对象，正在传的就白传了。
    if (this.loaded && !this.stopped) {
      this.kick();
      return;
    }
    this.stopped = false;
    this.loaded = true;
    const saved = await this.db.loadJobs();
    this.cancels = new Map(saved.filter((j) => j.cancelled).map((j) => [j.key, j]));
    const cancelledIds = new Set([...this.cancels.values()].map((j) => j.id));
    const live: UploadJob[] = [];
    for (const job of saved) {
      if (job.cancelled) continue;
      if (cancelledIds.has(job.id)) {
        // 上次取消到一半被杀了：墓碑写下了，任务还没删。取消已经答应用户了，接着做完。
        await this.db.deleteJob(job.key);
        await this.transport.removeLocal(job.localUri).catch(() => {});
        continue;
      }
      live.push(job);
    }
    this.jobs = new Map(live.map((j) => [j.key, j]));
    this.batchBytes = live.reduce((sum, j) => sum + j.size, 0);
    this.batchDone = 0;
    this.finishedInBatch = 0;
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
    // 上一批全部结束后才算新的一批，否则“都传好了”会算上一批的。
    if (this.jobs.size === 0) this.finishedInBatch = 0;
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

  /**
   * 取消这些文件的上传。先在内存里拿掉，正在传的马上停，之后的任何回调都不会把它写回去。
   * 这是用户明确的删除：本地副本和任务都不留。服务端的清理靠墓碑，离线也能取消，有网再补。
   * 调用方要先把引用从记录里去掉（cancelUploads）：反过来的话，中途被杀会留下打不开的占位。
   */
  async cancel(ids: readonly string[]): Promise<void> {
    const wanted = new Set(ids);
    const removed = [...this.jobs.values()].filter((j) => wanted.has(j.id));
    const tombstones: UploadJob[] = [];
    for (const job of removed) {
      this.jobs.delete(job.key);
      this.batchBytes = Math.max(0, this.batchBytes - job.size);
      if (this.current?.job === job) this.current.controller.abort();
    }
    for (const id of wanted) {
      const source = removed.find((j) => j.id === id);
      if (!source) continue;
      const tombstone: UploadJob = {
        key: `${id}/cancel`,
        id,
        variant: source.variant,
        scope: source.scope,
        localUri: source.localUri,
        mime: source.mime,
        size: 0,
        wifiOnly: false,
        attempts: 0,
        cancelled: true,
      };
      this.cancels.set(tombstone.key, tombstone);
      tombstones.push(tombstone);
    }
    this.publish();
    // 墓碑先落盘：之后中途被杀，load 会把没删完的任务接着删掉。
    for (const tombstone of tombstones) await this.db.saveJob(tombstone);
    for (const job of removed) {
      await this.db.deleteJob(job.key);
      await this.transport.removeLocal(job.localUri).catch(() => {});
    }
    this.kick();
  }

  stop(): void {
    this.stopped = true;
    this.current?.controller.abort();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.publish();
  }

  /** 手机上的数据被清空时调用。在路上的任务结束后不会再写回数据库，下次 load 才恢复工作。 */
  reset(): void {
    this.stop();
    this.jobs = new Map();
    this.cancels = new Map();
    this.batchBytes = 0;
    this.batchDone = 0;
    this.finishedInBatch = 0;
    this.inflight = 0;
    this.samples = [];
    this.publish();
  }

  private isLive(job: UploadJob): boolean {
    return this.jobs.get(job.key) === job;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private blockedByNetwork(job: UploadJob): boolean {
    return this.network === 'none' || (job.wifiOnly && this.network !== 'wifi');
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

  private nextCancel(skip: ReadonlySet<string>): UploadJob | null {
    if (this.network === 'none') return null;
    for (const tombstone of this.cancels.values()) {
      if (!skip.has(tombstone.key)) return tombstone;
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
    this.speedTimer = setInterval(() => this.publish(), SPEED_TICK_MS);
    try {
      // 这一轮失败过的先跳过，一个传不上去的文件不能挡住后面的文件。
      const failedThisRound = new Set<string>();
      let lastFailed: UploadJob | null = null;
      for (;;) {
        if (this.stopped) return;
        const tombstone = this.nextCancel(failedThisRound);
        if (tombstone) {
          if (!(await this.runCancel(tombstone))) {
            failedThisRound.add(tombstone.key);
            lastFailed = tombstone;
          }
          continue;
        }
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
      if (this.speedTimer) clearInterval(this.speedTimer);
      this.speedTimer = null;
      this.samples = [];
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

  /** 通知不到没关系：服务端 24 小时后会清掉放弃的上传。不再上传的承诺在本地已经兑现了。 */
  private async runCancel(tombstone: UploadJob): Promise<boolean> {
    const forget = async () => {
      this.cancels.delete(tombstone.key);
      await this.db.deleteJob(tombstone.key);
    };
    try {
      await this.transport.cancelRemote?.(tombstone.id);
      await forget();
      return true;
    } catch (error) {
      // 这个任务已经被清空（退出登录）：写回去的话，下一个登录的人会看到别人的墓碑。
      if (this.cancels.get(tombstone.key) !== tombstone || this.stopped) return true;
      if (error instanceof UploadHttpError && error.code === 'unauthenticated') {
        this.stop();
        return true;
      }
      tombstone.attempts += 1;
      // 4xx 重试也没用（旧服务端没有这个接口时就是 404），401 要等重新登录。
      const permanent =
        error instanceof UploadHttpError &&
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 401 &&
        error.status !== 408 &&
        error.status !== 429;
      if (permanent || tombstone.attempts >= MAX_CANCEL_ATTEMPTS) {
        await forget();
        return true;
      }
      await this.db.saveJob(tombstone);
      return false;
    }
  }

  private async runJob(job: UploadJob): Promise<boolean> {
    const controller = new AbortController();
    this.current = { job, controller };
    this.inflight = 0;
    this.publish(true);
    try {
      if (job.thumbSource && !(await this.prepareThumb(job))) return true;
      if (!this.isLive(job)) return true;
      if (this.transport.multipart && !job.singlePut && usesMultipart(job.size)) {
        const outcome = await this.runMultipart(job, this.transport.multipart, controller.signal);
        if (outcome === 'paused') return true;
        if (outcome === 'done') {
          await this.finish(job);
          return true;
        }
        // 走到这里是退回单个 PUT。这个文件之后都不再试分片。
      }
      const target = await this.transport.requestUrl({
        id: job.id,
        scope: job.scope,
        variant: job.variant,
        mime: job.mime,
        size: job.size,
        filename: job.filename,
      });
      if (!this.isLive(job)) return true;
      const { status } = await this.transport.put(
        job,
        target,
        (sent) => this.noteSent(job, sent),
        controller.signal,
      );
      if (status < 200 || status >= 300)
        throw new UploadHttpError(status, 'put_failed', t().ui.uploadFailed);
      if (!this.isLive(job)) return true;
      await this.transport.complete(job.id, job.variant);
      await this.finish(job);
      return true;
    } catch (error) {
      // 取消了，或者队列已经被清空：写回去的话，下一个登录的人会看到别人的失败任务。
      // 用 stopped 判断：登录失效时会中止正在传的，那不算这个文件失败。
      if (!this.isLive(job) || this.stopped) return true;
      // 登录失效了，后台一直重试也没用。任务留着，重新登录后 load 接着传。只认服务端说的，代理也可能返回 401。
      if (error instanceof UploadHttpError && error.code === 'unauthenticated') {
        this.stop();
        return true;
      }
      if (error instanceof UploadHttpError && error.code === 'already_uploaded') {
        // 上次传完后还没来得及更新队列就被杀了，这种情况算成功。
        await this.finish(job);
        return true;
      }
      job.attempts += 1;
      if (error instanceof UploadHttpError) {
        if (isPermanent(error)) job.failed = error.message;
        // 存储持续报错（配额满、配置错）时重试没有意义，交给用户处理。
        else if (isCapped(error) && job.attempts >= MAX_PUT_ATTEMPTS) {
          job.failed = t().ui.storageKeepsFailing;
        }
      }
      await this.db.saveJob(job);
      this.samples = [];
      this.inflight = 0;
      this.publish();
      return Boolean(job.failed);
    } finally {
      if (this.current?.job === job) this.current = null;
      this.inflight = 0;
    }
  }

  /**
   * 分片上传。已传了哪些片每次都问服务端，所以断网、被杀、失败重试都走同一条路。
   * 返回 'fallback' 表示这个文件要改用单个 PUT，'paused' 表示网络条件变了，等下次轮到再接着传。
   */
  private async runMultipart(
    job: UploadJob,
    multipart: MultipartTransport,
    signal: AbortSignal,
  ): Promise<'done' | 'paused' | 'fallback'> {
    const switchToSinglePut = async () => {
      job.singlePut = true;
      job.uploadId = undefined;
      job.partSize = undefined;
      job.confirmedBytes = 0;
      if (this.isLive(job)) await this.db.saveJob(job);
      this.publish(true);
      return 'fallback' as const;
    };
    // uploadId 过期后从头再来，最多一次。再失效就当普通失败，退避后重试。
    for (let restart = 0; ; restart++) {
      try {
        return await this.sendParts(job, multipart, signal);
      } catch (error) {
        if (!(error instanceof UploadHttpError)) throw error;
        if (error.code === 'multipart_unsupported') return switchToSinglePut();
        if (error.code === 'upload_gone' && restart === 0) {
          job.uploadId = undefined;
          job.partSize = undefined;
          job.confirmedBytes = 0;
          if (this.isLive(job)) await this.db.saveJob(job);
          this.inflight = 0;
          this.publish(true);
          continue;
        }
        // 旧服务端没有这些接口（Hono 的 notFound），也可能是别的网关返回的 404。服务端回滚后也走到这里。
        if (error.status === 404 && error.code !== 'upload_gone') return switchToSinglePut();
        throw error;
      }
    }
  }

  private async sendParts(
    job: UploadJob,
    multipart: MultipartTransport,
    signal: AbortSignal,
  ): Promise<'done' | 'paused'> {
    const local = await multipart.stat(job);
    if (!local) throw new UploadHttpError(410, 'local_missing', t().ui.localFileGone);
    let { uploadId, partSize } = job;
    if (!uploadId || !partSize) {
      const started = await multipart.start({
        id: job.id,
        scope: job.scope,
        variant: job.variant,
        mime: job.mime,
        size: job.size,
        filename: job.filename,
      });
      if (!this.isLive(job)) return 'paused';
      uploadId = started.uploadId;
      partSize = started.partSize;
      job.uploadId = uploadId;
      job.partSize = partSize;
      job.localModifiedAt = local.modifiedAt;
      await this.db.saveJob(job);
    }
    const { size } = job;
    const assertUnchanged = async () => {
      const now = await multipart.stat(job);
      if (!now) throw new UploadHttpError(410, 'local_missing', t().ui.localFileGone);
      // 已经传上去的片和现在的文件拼不到一起，继续传只会得到一个坏文件。
      const changed =
        now.size !== size ||
        (job.localModifiedAt !== undefined &&
          now.modifiedAt !== undefined &&
          now.modifiedAt !== job.localModifiedAt);
      if (changed) throw new UploadHttpError(409, 'file_changed', t().ui.fileChanged);
    };
    await assertUnchanged();

    const listed = await multipart.listParts(job, uploadId);
    if (!this.isLive(job)) return 'paused';
    if (listed.complete) {
      await multipart.complete(job, uploadId);
      return 'done';
    }
    let confirmed = confirmedPartBytes(listed.parts, size, partSize);
    job.confirmedBytes = confirmed;
    await this.db.saveJob(job);
    this.publish(true);

    const missing = missingParts(listed.parts, size, partSize);
    for (let i = 0; i < missing.length; i += MULTIPART_URL_BATCH) {
      if (!this.isLive(job) || this.stopped || this.blockedByNetwork(job)) return 'paused';
      const batch = missing.slice(i, i + MULTIPART_URL_BATCH);
      const { urls } = await multipart.partUrls(job, uploadId, batch);
      for (const entry of urls) {
        if (!this.isLive(job) || this.stopped || this.blockedByNetwork(job)) return 'paused';
        await assertUnchanged();
        const { status } = await multipart.putPart(
          job,
          {
            partNumber: entry.partNumber,
            url: entry.url,
            offset: (entry.partNumber - 1) * partSize,
            size: multipartPartBytes(entry.partNumber, size, partSize),
          },
          (sent) => this.noteSent(job, sent),
          signal,
        );
        if (!this.isLive(job)) return 'paused';
        // 存储明说不支持这个操作，单个 PUT 还有机会。
        if (status === 501 || status === 405) {
          throw new UploadHttpError(501, 'multipart_unsupported', t().ui.uploadFailed);
        }
        if (status < 200 || status >= 300) {
          throw new UploadHttpError(status, 'put_failed', t().ui.uploadFailed);
        }
        confirmed += multipartPartBytes(entry.partNumber, size, partSize);
        job.confirmedBytes = confirmed;
        // 一片传成功就说明存储是好的，不能让 100 片里零星的失败攒到次数上限。
        job.attempts = 0;
        this.inflight = 0;
        await this.db.saveJob(job);
        this.publish(true);
      }
    }
    if (!this.isLive(job) || this.stopped) return 'paused';
    await multipart.complete(job, uploadId);
    return 'done';
  }

  /** 进度和速度的唯一入口。sent 回退（重传）时不算进速度，下一次增长才算。 */
  private noteSent(job: UploadJob, sent: number): void {
    if (!this.isLive(job)) return;
    const delta = sent - this.inflight;
    this.inflight = sent;
    if (delta > 0) {
      this.transferred += delta;
      this.samples = addSpeedSample(this.samples, { at: this.now(), bytes: this.transferred });
    }
    this.publish(true);
  }

  /** 返回 false 表示这个任务不用再传了。缩略图只是省流量，任何失败都不能挡住原图。 */
  private async prepareThumb(job: UploadJob): Promise<boolean> {
    const made = await Promise.resolve(this.transport.makeThumb?.(job)).catch(() => null);
    // 队列已经被清空或者取消了：写回去的话，下一个登录的人会看到别人的任务。
    if (!this.isLive(job)) {
      if (made) await this.transport.removeLocal(job.localUri).catch(() => {});
      return false;
    }
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
    // 取消和完成同时发生：取消赢了，不能再算传好，也不能通知“传完了”。
    if (!this.isLive(job)) return;
    this.jobs.delete(job.key);
    await this.db.deleteJob(job.key);
    this.batchDone += job.size;
    this.inflight = 0;
    await this.transport.removeLocal(job.localUri).catch(() => {});
    if (job.variant === 'original') {
      this.finishedInBatch += 1;
      this.options.onUploaded?.(job.id);
    }
    this.publish();
  }

  private itemsFrom(jobs: UploadJob[]): UploadItem[] {
    const groups = new Map<string, UploadJob[]>();
    for (const job of jobs) {
      const group = groups.get(job.id);
      if (group) group.push(job);
      else groups.set(job.id, [job]);
    }
    const uploading = this.current?.job;
    return [...groups.entries()].map(([id, group]) => {
      const original = group.find((j) => j.variant === 'original');
      const main = original ?? (group[0] as UploadJob);
      const failed = group.find((j) => j.failed);
      const status: UploadItemStatus = failed
        ? 'failed'
        : uploading && group.includes(uploading)
          ? 'uploading'
          : this.network === 'none'
            ? 'waitingNetwork'
            : main.wifiOnly && this.network !== 'wifi'
              ? 'waitingWifi'
              : group.some((j) => j.attempts > 0)
                ? 'retrying'
                : 'queued';
      const inflight = uploading === main ? this.inflight : 0;
      return {
        id,
        scope: main.scope,
        kind: main.mediaKind ?? kindFromMime(main.mime),
        name: main.filename,
        size: main.size,
        sent: Math.min(main.size, (main.confirmedBytes ?? 0) + inflight),
        status,
        reason: failed?.failed ?? null,
      };
    });
  }

  private publish(active = this.running): void {
    const jobs = [...this.jobs.values()];
    const live = jobs.filter((j) => !j.failed);
    const sendable = live.filter((j) => !j.wifiOnly || this.network === 'wifi');
    const items = this.itemsFrom(jobs);
    const counts = noCounts();
    const failedCounts = noCounts();
    for (const item of items) {
      if (item.status === 'failed') failedCounts[item.kind] += 1;
      else counts[item.kind] += 1;
    }
    const liveItems = items.filter((i) => i.status !== 'failed');
    const confirmed = live.reduce((sum, j) => sum + (j.confirmedBytes ?? 0), 0);
    const sentBytes = this.batchDone + confirmed + this.inflight;
    const fraction = this.batchBytes > 0 ? Math.min(1, sentBytes / this.batchBytes) : 1;
    const isActive = active && live.length > 0;
    const waitingForWifi = live.length > 0 && sendable.length === 0 && this.network !== 'none';
    const offline = live.length > 0 && this.network === 'none';
    // 排队、等 Wi-Fi、断网时不显示速度，显示状态。
    const transferring = isActive && !waitingForWifi && !offline && this.current !== null;
    const speed = transferring ? currentSpeed(this.samples, this.now()) : null;
    this.progress = {
      total: liveItems.length,
      counts,
      fraction,
      sentBytes,
      totalBytes: this.batchBytes,
      active: isActive,
      waitingForWifi,
      offline,
      halted: this.stopped,
      failedCount: items.length - liveItems.length,
      failedCounts,
      failedReason: jobs.find((j) => j.failed)?.failed ?? null,
      finishedInBatch: this.finishedInBatch,
      speed,
      etaSeconds: etaSeconds(Math.max(0, this.batchBytes - sentBytes), speed),
      items,
    };
    if (live.length === 0) {
      // 这批传完了，下次进度条从 0 开始。
      this.batchBytes = jobs.reduce((sum, j) => sum + j.size, 0);
      this.batchDone = 0;
      this.inflight = 0;
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
  if (error.code === 'put_failed' || error.code === 'parts_incomplete') return false;
  return error.status >= 400 && error.status < 500 && error.code !== 'not_uploaded';
}

/** 不算永久失败，但一直这样也没有意义，到次数上限后交给用户。 */
function isCapped(error: UploadHttpError): boolean {
  return error.code === 'put_failed' || error.code === 'parts_incomplete';
}
