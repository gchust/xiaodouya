import type { ServerRecord, SyncRequest, SyncResponse } from '@xiaodouya/shared';
import type { LocalDb, RecordStore } from './store';

export interface SyncTransport {
  sync(request: SyncRequest): Promise<SyncResponse>;
  wait(cursor: number, signal: AbortSignal): Promise<{ changed: boolean }>;
}

export type SyncStatus = 'idle' | 'syncing' | 'offline';

export interface SyncEvents {
  /** 同步到了其他家人的新记录（不含自己刚上传的）。 */
  onRemote?(records: ServerRecord[]): void;
  onStatus?(status: SyncStatus): void;
}

const OUTBOX_BATCH = 200;
const MAX_ROUNDS = 50;
const MIN_RETRY_MS = 2_000;
const MAX_RETRY_MS = 60_000;

/**
 * 双向同步。约定：
 * - 任意时刻最多一轮同步在跑；期间的新请求合并成跑完后再来一轮。
 * - 失败不抛给界面：记录已经在本地了，用指数退避在后台重试。
 */
export class SyncEngine {
  private running: Promise<void> | null = null;
  private again = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryMs = MIN_RETRY_MS;
  private online = true;
  private live: AbortController | null = null;
  private stopped = true;
  private cursor = 0;
  private lastSentIds = new Set<string>();

  constructor(
    private store: RecordStore,
    private db: LocalDb,
    private transport: SyncTransport,
    private events: SyncEvents = {},
    private scheduler: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout } = {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    },
  ) {}

  async start(): Promise<void> {
    this.stopped = false;
    this.cursor = await this.db.getCursor();
    this.startLiveLoop();
    await this.syncNow();
  }

  stop(): void {
    this.stopped = true;
    this.live?.abort();
    this.live = null;
    if (this.retryTimer) this.scheduler.clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  setOnline(online: boolean): void {
    const cameBack = online && !this.online;
    this.online = online;
    this.events.onStatus?.(online ? 'idle' : 'offline');
    if (cameBack) void this.syncNow();
  }

  /** 触发一轮同步，并等待它（以及期间排队的同步）结束。 */
  syncNow(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.loop().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async loop(): Promise<void> {
    do {
      this.again = false;
      await this.runOnce();
    } while (this.again && !this.stopped);
  }

  private async runOnce(): Promise<void> {
    if (!this.online) return;
    this.events.onStatus?.('syncing');
    try {
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const sent = this.store.dirtyRecords(OUTBOX_BATCH);
        for (const record of sent) this.lastSentIds.add(record.id);
        const response = await this.transport.sync({
          cursor: this.cursor,
          changes: sent.map((r) => ({
            id: r.id,
            collection: r.collection,
            data: r.data,
            deleted: r.deleted,
            updatedAt: r.updatedAt,
          })),
        });
        const rejected = new Set(response.rejected.map((r) => r.id));
        const applied = await this.store.applySyncResult(
          sent,
          response.records,
          rejected,
          response.cursor,
        );
        this.cursor = response.cursor;
        const fromOthers = applied.filter((r) => !this.lastSentIds.has(r.id));
        if (fromOthers.length > 0) this.events.onRemote?.(fromOthers);
        for (const record of sent) this.lastSentIds.delete(record.id);
        const moreToSend = this.store.dirtyRecords(1).length > 0;
        if (!response.hasMore && !moreToSend) break;
      }
      this.retryMs = MIN_RETRY_MS;
      this.events.onStatus?.('idle');
    } catch {
      this.events.onStatus?.('offline');
      this.scheduleRetry();
    }
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer) return;
    this.retryTimer = this.scheduler.setTimeout(() => {
      this.retryTimer = null;
      void this.syncNow();
    }, this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, MAX_RETRY_MS);
  }

  /** App 在前台时持续长轮询，其他家人一记录就能看到。 */
  private startLiveLoop(): void {
    const controller = new AbortController();
    this.live = controller;
    void (async () => {
      while (!this.stopped && !controller.signal.aborted) {
        try {
          const { changed } = await this.transport.wait(this.cursor, controller.signal);
          if (changed) await this.syncNow();
        } catch {
          if (controller.signal.aborted) return;
          await new Promise<void>((resolve) => {
            this.scheduler.setTimeout(resolve, 5_000);
          });
        }
      }
    })();
  }
}
