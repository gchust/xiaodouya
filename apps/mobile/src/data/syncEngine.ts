import {
  canReadCollection,
  collections,
  type Role,
  type ServerRecord,
  type SyncRequest,
  type SyncResponse,
} from '@xiaodouya/shared';
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
  /** 有记录被服务端拒绝（比如权限变了）。 */
  onRejected?(count: number): void;
  /** 一轮同步成功完成。 */
  onSynced?(): void;
}

const ROLE_KEY = 'role';
const OUTBOX_BATCH = 200;
/**
 * 服务端的请求体上限是 5 MB。超了会一直 413，退避重试也没用，后面的记录全被堵住。
 * 用字符数乘 3 估算：一个汉字在 UTF-8 里 3 字节。估高了只是多发一次请求。
 */
const OUTBOX_MAX_BYTES = 4 * 1024 * 1024;
const LIVE_BACKOFF_MS = 5_000;
const MAX_ROUNDS = 50;
const MIN_RETRY_MS = 2_000;
const MAX_RETRY_MS = 60_000;

/** 取开头不超过大小上限的一段。至少一条：单条太大也要发出去，让服务端决定，不能卡在队列里。 */
export function batchWithinBytes<T extends { data: unknown }>(records: T[], maxBytes: number): T[] {
  let bytes = 0;
  for (const [index, record] of records.entries()) {
    bytes += (JSON.stringify(record.data)?.length ?? 0) * 3 + 200;
    if (bytes > maxBytes && index > 0) return records.slice(0, index);
  }
  return records;
}

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
  private lastRole: Role | null = null;

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
    this.lastRole = (await this.db.getMeta(ROLE_KEY)) as Role | null;
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
        const sent = batchWithinBytes(this.store.dirtyRecords(OUTBOX_BATCH), OUTBOX_MAX_BYTES);
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
        if (response.rejected.length > 0) this.events.onRejected?.(response.rejected.length);
        const resync = await this.applyRole(response.role);
        const moreToSend = this.store.dirtyRecords(1).length > 0;
        if (!response.hasMore && !moreToSend && !resync) break;
      }
      this.retryMs = MIN_RETRY_MS;
      this.events.onStatus?.('idle');
      this.events.onSynced?.();
    } catch {
      this.events.onStatus?.('offline');
      this.scheduleRetry();
    }
  }

  /**
   * 角色变化会改变“能读到什么”，而游标已经越过了当时读不到的记录。
   * 升级后从头重新拉取，降级后清掉现在无权查看的内容。返回是否需要继续拉取。
   */
  private async applyRole(role: Role): Promise<boolean> {
    const previous = this.lastRole;
    if (previous === role) return false;
    if (previous !== null) {
      const unreadable = collections.filter((name) => !canReadCollection(role, name));
      if (unreadable.length > 0) await this.store.purgeCollections(unreadable);
    }
    const widened =
      previous !== null &&
      collections.some(
        (name) => canReadCollection(role, name) && !canReadCollection(previous, name),
      );
    // 先重置游标再记角色：中途崩溃时最多多拉一遍，不会漏。
    if (widened) {
      this.cursor = 0;
      await this.db.putMany([], 0);
    }
    await this.db.setMeta(ROLE_KEY, role);
    this.lastRole = role;
    return widened;
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
          if (changed) {
            const before = this.cursor;
            await this.syncNow();
            // 服务端说有新内容但游标没动（同步失败）：等一等，否则这里会变成死循环。
            if (this.cursor === before) await this.pause(LIVE_BACKOFF_MS);
          }
        } catch {
          if (controller.signal.aborted) return;
          await this.pause(LIVE_BACKOFF_MS);
        }
      }
    })();
  }

  private pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.scheduler.setTimeout(resolve, ms);
    });
  }
}
