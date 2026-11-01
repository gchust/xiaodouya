import {
  type BabyData,
  type Collection,
  type CollectionData,
  type DocumentData,
  type EventData,
  isNewerVersion,
  isVaccinePlanData,
  type LetterData,
  type MomentData,
  parseCollectionData,
  type ServerRecord,
  type VaccinePlanData,
} from '@xiaodouya/shared';

/** 本地持久化接口。生产用 SQLite（`sqlite.ts`），测试用内存实现。 */
export interface LocalDb {
  loadAll(): Promise<StoredRecord[]>;
  put(record: StoredRecord): Promise<void>;
  putMany(records: StoredRecord[], cursor: number): Promise<void>;
  getCursor(): Promise<number>;
  getMeta(key: string): Promise<string | null>;
  setMeta(key: string, value: string): Promise<void>;
  deleteCollections(collections: readonly Collection[]): Promise<void>;
  clear(): Promise<void>;
}

export interface StoredRecord {
  id: string;
  collection: Collection;
  /** 原始数据。无法解析时也保留，防止旧版 App 把新版数据覆盖掉。 */
  data: unknown;
  deleted: boolean;
  updatedAt: number;
  /** true 表示还没有成功上传到服务端。 */
  dirty: boolean;
}

export interface RecordEntry<T> {
  id: string;
  data: T;
  updatedAt: number;
  dirty: boolean;
}

export type Entry<C extends Collection> = RecordEntry<CollectionData[C]>;

export interface Snapshot {
  baby: Entry<'baby'> | null;
  /** 按发生时间倒序。 */
  events: RecordEntry<EventData>[];
  /** 家庭对疫苗本的配置。存在 event 集合里，但不是一条记录，所以不进时间线。 */
  vaccinePlans: RecordEntry<VaccinePlanData>[];
  moments: Entry<'moment'>[];
  letters: Entry<'letter'>[];
  documents: Entry<'document'>[];
  pendingCount: number;
}

const emptySnapshot: Snapshot = {
  baby: null,
  events: [],
  vaccinePlans: [],
  moments: [],
  letters: [],
  documents: [],
  pendingCount: 0,
};

const atOf = (data: unknown) => (data as { at?: number }).at ?? 0;

/**
 * 内存中的记录集合，写入时同步落盘。所有页面读这里，所以界面在离线时也完全可用。
 * 记录量是家庭级别（每年几千条），全部放内存足够快，也让界面逻辑保持简单。
 */
export class RecordStore {
  private records = new Map<string, StoredRecord>();
  private listeners = new Set<() => void>();
  private snapshot: Snapshot = emptySnapshot;
  private now: () => number;

  constructor(
    private db: LocalDb,
    options: { now?: () => number } = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  async load(): Promise<void> {
    this.records = new Map((await this.db.loadAll()).map((r) => [r.id, r]));
    this.rebuild();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): Snapshot => this.snapshot;

  private rebuild() {
    const next: Snapshot = {
      baby: null,
      events: [],
      vaccinePlans: [],
      moments: [],
      letters: [],
      documents: [],
      pendingCount: 0,
    };
    for (const record of this.records.values()) {
      if (record.dirty) next.pendingCount += 1;
      if (record.deleted) continue;
      const data = parseCollectionData(record.collection, record.data);
      if (!data) continue;
      const base = { id: record.id, updatedAt: record.updatedAt, dirty: record.dirty };
      switch (record.collection) {
        case 'baby':
          if (!next.baby || record.updatedAt > next.baby.updatedAt) {
            next.baby = { ...base, data: data as BabyData };
          }
          break;
        case 'event':
          if (isVaccinePlanData(data)) next.vaccinePlans.push({ ...base, data });
          else next.events.push({ ...base, data: data as EventData });
          break;
        case 'moment':
          next.moments.push({ ...base, data: data as MomentData });
          break;
        case 'letter':
          next.letters.push({ ...base, data: data as LetterData });
          break;
        case 'document':
          next.documents.push({ ...base, data: data as DocumentData });
          break;
      }
    }
    const byAtDesc = (a: { data: unknown }, b: { data: unknown }) => atOf(b.data) - atOf(a.data);
    next.events.sort(byAtDesc);
    next.moments.sort(byAtDesc);
    next.letters.sort(byAtDesc);
    next.documents.sort((a, b) => a.updatedAt - b.updatedAt);
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }

  /** 新建或修改一条记录。内存先变，界面立即响应；落盘失败才抛错。 */
  async write<C extends Collection>(
    collection: C,
    id: string,
    data: CollectionData[C],
  ): Promise<void> {
    const record: StoredRecord = {
      id,
      collection,
      data,
      deleted: false,
      updatedAt: this.nextVersion(id),
      dirty: true,
    };
    this.records.set(id, record);
    this.rebuild();
    await this.db.put(record);
  }

  async remove(id: string): Promise<void> {
    const existing = this.records.get(id);
    if (!existing) return;
    const record: StoredRecord = {
      ...existing,
      deleted: true,
      updatedAt: this.nextVersion(id),
      dirty: true,
    };
    this.records.set(id, record);
    this.rebuild();
    await this.db.put(record);
  }

  /** 手机时钟可能比已有版本慢，这里保证本地修改一定比它基于的版本新。 */
  private nextVersion(id: string): number {
    const existing = this.records.get(id);
    return Math.max(this.now(), (existing?.updatedAt ?? 0) + 1);
  }

  dirtyRecords(limit: number): StoredRecord[] {
    const dirty: StoredRecord[] = [];
    for (const record of this.records.values()) {
      if (record.dirty) dirty.push(record);
      if (dirty.length >= limit) break;
    }
    return dirty;
  }

  /**
   * 把这次同步确认过的记录标记为干净。
   * 只有版本没变才标记：上传途中用户又改了的话，新改动不能被当成已同步。
   */
  private isUnchanged(sent: StoredRecord): boolean {
    const current = this.records.get(sent.id);
    return current?.updatedAt === sent.updatedAt;
  }

  async applySyncResult(
    sent: readonly StoredRecord[],
    incoming: readonly ServerRecord[],
    rejectedIds: ReadonlySet<string>,
    cursor: number,
  ): Promise<ServerRecord[]> {
    const toPersist = new Map<string, StoredRecord>();
    for (const record of sent) {
      if (!this.isUnchanged(record)) continue;
      // 被拒绝的记录也不再重试，否则发件箱会卡死。但数据要留着：服务端有更权威的版本时，
      // 下面的 incoming 会覆盖它；没有的话，这是用户写的内容，不能悄悄删掉。
      void rejectedIds;
      const cleaned = { ...record, dirty: false };
      toPersist.set(record.id, cleaned);
      this.records.set(record.id, cleaned);
    }
    const applied: ServerRecord[] = [];
    for (const remote of incoming) {
      const local = this.records.get(remote.id);
      // 本地有更新的未同步改动时保留本地版本，下一轮上传。
      if (
        local?.dirty &&
        isNewerVersion(
          { updatedAt: local.updatedAt, tiebreak: 'local' },
          { updatedAt: remote.updatedAt, tiebreak: 'kept' },
        )
      ) {
        continue;
      }
      const stored: StoredRecord = {
        id: remote.id,
        collection: remote.collection,
        data: remote.data,
        deleted: remote.deleted,
        updatedAt: remote.updatedAt,
        dirty: false,
      };
      this.records.set(remote.id, stored);
      toPersist.set(remote.id, stored);
      applied.push(remote);
    }
    await this.db.putMany([...toPersist.values()], cursor);
    this.rebuild();
    return applied;
  }

  /** 权限变小后，清掉现在无权查看的数据。 */
  async purgeCollections(collections: readonly Collection[]): Promise<void> {
    await this.db.deleteCollections(collections);
    for (const [id, record] of this.records) {
      if (collections.includes(record.collection)) this.records.delete(id);
    }
    this.rebuild();
  }

  async clear(): Promise<void> {
    await this.db.clear();
    this.records.clear();
    this.rebuild();
  }
}
