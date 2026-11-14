import {
  type BabyRef,
  babyRefOf,
  type Collection,
  type CollectionData,
  compareMoneyEntries,
  defaultBaby,
  type EventData,
  type FavoriteData,
  type FavoriteFolderData,
  type FormulaData,
  firstBabyId,
  isFavoriteData,
  isFavoriteFolderData,
  isFormulaData,
  isMoneyData,
  isNewerVersion,
  isResourceData,
  isVaccinePlanData,
  type MoneyData,
  orderBabies,
  parseCollectionData,
  type ResourceData,
  recordBabyId,
  type ServerRecord,
  t,
  type VaccinePlanData,
  withBabyId,
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
  /** 当前宝宝（issue #106）：这台手机上选的，没选过或选的不在了就是第一个宝宝。 */
  baby: Entry<'baby'> | null;
  /** 能显示的宝宝，按建档先后。 */
  babies: Entry<'baby'>[];
  /**
   * 家庭有不止一份档案（删除的也算）。这时属于宝宝的列表（照护记录、疫苗本配置、小金库、回忆、信、
   * 宝宝的证件）只有当前宝宝的，奶粉、育儿资料、收藏和家人自己的证件不分。只有一份档案时什么都不过滤，
   * 和只支持一个宝宝的版本一模一样。
   */
  multiBaby: boolean;
  /** 不按宝宝过滤的列表。上传页要看到所有宝宝的文件。 */
  all: Lists;
  /** 按发生时间倒序。 */
  events: RecordEntry<EventData>[];
  /** 家庭对疫苗本的配置。存在 event 集合里，但不是一条记录，所以不进时间线。 */
  vaccinePlans: RecordEntry<VaccinePlanData>[];
  /** 家庭配置的奶粉。存在 event 集合里，但不是一条记录，所以不进时间线。 */
  formulas: RecordEntry<FormulaData>[];
  /** 小金库，按发生的日子倒序。存在 event 集合里，但不是照护记录，不进时间线。 */
  money: RecordEntry<MoneyData>[];
  /** 育儿资料，新存的在前。和下面两个一样存在 event 集合里，但不是照护记录，不进时间线。 */
  resources: RecordEntry<ResourceData>[];
  /** 收藏（回忆和资料），一个目标一条。 */
  favorites: RecordEntry<FavoriteData>[];
  /** 收藏夹，按建的先后。 */
  favoriteFolders: RecordEntry<FavoriteFolderData>[];
  moments: Entry<'moment'>[];
  letters: Entry<'letter'>[];
  documents: Entry<'document'>[];
  pendingCount: number;
}

export type ListKey =
  | 'events'
  | 'vaccinePlans'
  | 'formulas'
  | 'money'
  | 'resources'
  | 'favorites'
  | 'favoriteFolders'
  | 'moments'
  | 'letters'
  | 'documents';
export type Lists = Pick<Snapshot, ListKey>;
type AnyEntry = RecordEntry<unknown>;
type Compare = (a: AnyEntry, b: AnyEntry) => number;
type AnyLists = Record<ListKey, AnyEntry[]>;

const emptyLists: Lists = {
  events: [],
  vaccinePlans: [],
  formulas: [],
  money: [],
  resources: [],
  favorites: [],
  favoriteFolders: [],
  moments: [],
  letters: [],
  documents: [],
};

const emptySnapshot: Snapshot = {
  baby: null,
  babies: [],
  multiBaby: false,
  all: emptyLists,
  ...emptyLists,
  pendingCount: 0,
};

/** 当前宝宝存在这台手机上，不同步：每个家人看的可以不一样。 */
export const CURRENT_BABY_KEY = 'baby.current';

/** 属于宝宝、要按当前宝宝过滤的列表，和它们在哪个集合里。 */
const babyLists: Partial<Record<ListKey, Collection>> = {
  events: 'event',
  vaccinePlans: 'event',
  money: 'event',
  moments: 'moment',
  letters: 'letter',
  documents: 'document',
};

const listKeys: readonly ListKey[] = [
  'events',
  'vaccinePlans',
  'formulas',
  'money',
  'resources',
  'favorites',
  'favoriteFolders',
  'moments',
  'letters',
  'documents',
];

const atOf = (data: unknown) => (data as { at?: number }).at ?? 0;
const byAtDesc: Compare = (a, b) => atOf(b.data) - atOf(a.data);

/** 各列表的排序。没写的（疫苗配置、收藏）按记录进入集合的先后。 */
const listOrder: Partial<Record<ListKey, Compare>> = {
  events: byAtDesc,
  moments: byAtDesc,
  letters: byAtDesc,
  documents: (a, b) => a.updatedAt - b.updatedAt,
  formulas: (a, b) => (a.data as FormulaData).name.localeCompare((b.data as FormulaData).name),
  money: (a, b) => compareMoneyEntries(a as RecordEntry<MoneyData>, b as RecordEntry<MoneyData>),
  resources: (a, b) =>
    (b.data as ResourceData).addedAt - (a.data as ResourceData).addedAt || a.id.localeCompare(b.id),
  favoriteFolders: (a, b) =>
    (a.data as FavoriteFolderData).createdAt - (b.data as FavoriteFolderData).createdAt ||
    a.id.localeCompare(b.id),
};

function placeOf(collection: Collection, data: unknown): ListKey | 'baby' {
  switch (collection) {
    case 'baby':
      return 'baby';
    case 'event':
      if (isFormulaData(data)) return 'formulas';
      if (isVaccinePlanData(data)) return 'vaccinePlans';
      if (isMoneyData(data)) return 'money';
      if (isResourceData(data)) return 'resources';
      if (isFavoriteData(data)) return 'favorites';
      if (isFavoriteFolderData(data)) return 'favoriteFolders';
      return 'events';
    case 'moment':
      return 'moments';
    case 'letter':
      return 'letters';
    case 'document':
      return 'documents';
  }
}

/** 第一个不排在 `entry` 前面的位置。 */
function lowerBound(list: readonly AnyEntry[], entry: AnyEntry, compare: Compare): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (compare(list[mid] as AnyEntry, entry) < 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** 第一个排在 `entry` 后面的位置。 */
function upperBound(
  list: readonly AnyEntry[],
  entry: AnyEntry,
  compare: Compare,
  from = 0,
): number {
  let lo = from;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (compare(list[mid] as AnyEntry, entry) <= 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** 一条记录上次重建时在快照的哪里。`entry` 为 null 表示不显示：已删除，或者校验不过。 */
interface Placement {
  record: StoredRecord;
  seq: number;
  key: ListKey | 'baby' | null;
  entry: AnyEntry | null;
}

/** 变化不超过这么多条时在副本上二分插入；多了（同步拉下来一批）就过滤一遍再归并。 */
const SPLICE_LIMIT = 16;

/**
 * 内存中的记录集合，写入时同步落盘。所有页面读这里，所以界面在离线时也完全可用。
 * 记录量是家庭级别（勤快的家庭一年约 8,400 条），全部放内存，界面逻辑保持简单。
 *
 * 快照是增量更新的（issue #111）：只校验、排进变了的那几条；没变的列表沿用原来的数组，
 * 没变的记录沿用原来的条目对象，只订阅某个列表的页面（`useRecordsOf`）就不会跟着重画。
 * 结果和以前每次全量重建一模一样，包括同一时间的先后，`recordStore.test.ts` 拿全量重建做对照。
 */
export class RecordStore {
  private records = new Map<string, StoredRecord>();
  private listeners = new Set<() => void>();
  private snapshot: Snapshot = emptySnapshot;
  private now: () => number;
  /** 每条记录上次重建时的位置和条目。记录对象没换就直接沿用。 */
  private placements = new Map<string, Placement>();
  /**
   * 记录进入 `records` 的先后，也就是 Map 的遍历顺序。以前的全量重建按这个顺序做稳定排序，
   * 所以排序打平手时按它排，结果才和以前一样。删掉再加回来的算新进来的。
   */
  private seqOf = new Map<string, number>();
  private nextSeq = 0;
  private entrySeq = new WeakMap<AnyEntry, number>();
  /** 上次重建之后变过的记录。落盘失败、没走到重建时也留着，下次一起算。 */
  private changed = new Set<string>();
  private needsFullRebuild = true;
  private dirtyCount = 0;
  /** 能显示的档案。 */
  private babyIds = new Set<string>();
  /** 全部档案，删除的、读不懂的也在：它们参与排序，也决定要不要按宝宝过滤。 */
  private babyRecordIds = new Set<string>();
  /** 这台手机选的宝宝（`CURRENT_BABY_KEY`）。 */
  private chosenBabyId: string | null = null;
  /** 上次算出的第一个宝宝，档案没变时沿用。 */
  private firstIdCache: string | null = null;
  /** 不按宝宝过滤的列表，增量更新的就是它。 */
  private lists: Lists = emptyLists;
  /** 按宝宝过滤的结果，源列表和宝宝都没变时沿用，页面才不会白白重画。 */
  private filtered = new Map<
    ListKey,
    { source: AnyEntry[]; babyId: string | null; firstId: string | null; result: AnyEntry[] }
  >();
  /** 校验结果按原始数据对象缓存：确认上传只改了 dirty，数据还是同一个对象，不用再过一遍 zod。 */
  private parsed = new WeakMap<object, { collection: Collection; data: unknown }>();
  private compares = new Map<ListKey, Compare>();

  constructor(
    private db: LocalDb,
    options: { now?: () => number } = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  async load(): Promise<void> {
    this.chosenBabyId = await this.db.getMeta(CURRENT_BABY_KEY);
    this.reset(await this.db.loadAll());
    this.rebuild();
  }

  /** 全部档案排序要用的部分，删除的、读不懂的也在。加宝宝时按它算 `createdAt`。 */
  babyRefs(): BabyRef[] {
    const refs: BabyRef[] = [];
    for (const id of this.babyRecordIds) {
      const record = this.records.get(id);
      if (record) refs.push(babyRefOf(id, record.data, record.deleted));
    }
    return refs;
  }

  /** 切换当前宝宝。记在这台手机上，小工具的后台任务读的是同一份。 */
  async setCurrentBaby(id: string): Promise<void> {
    if (id === this.chosenBabyId) return;
    this.chosenBabyId = id;
    // 落盘失败时没来得及重建的改动也一起算进去。
    this.rebuild(true);
    await this.db.setMeta(CURRENT_BABY_KEY, id);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): Snapshot => this.snapshot;

  // 记录表只能通过 put、drop、reset 修改，否则增量更新会漏掉变化。

  private put(record: StoredRecord) {
    const existing = this.records.get(record.id);
    if (!existing) this.seqOf.set(record.id, this.nextSeq++);
    if (record.collection === 'baby') this.babyRecordIds.add(record.id);
    this.dirtyCount += (record.dirty ? 1 : 0) - (existing?.dirty ? 1 : 0);
    this.records.set(record.id, record);
    this.changed.add(record.id);
  }

  private drop(id: string) {
    const existing = this.records.get(id);
    if (!existing) return;
    if (existing.dirty) this.dirtyCount -= 1;
    this.records.delete(id);
    this.seqOf.delete(id);
    this.babyRecordIds.delete(id);
    this.changed.add(id);
  }

  private reset(records: readonly StoredRecord[]) {
    this.records = new Map();
    this.seqOf.clear();
    this.babyRecordIds.clear();
    this.changed.clear();
    this.dirtyCount = 0;
    this.needsFullRebuild = true;
    for (const record of records) this.put(record);
  }

  private parse(collection: Collection, data: unknown): unknown {
    const cacheable = typeof data === 'object' && data !== null;
    if (cacheable) {
      const hit = this.parsed.get(data);
      if (hit && hit.collection === collection) return hit.data;
    }
    const result = parseCollectionData(collection, data);
    if (cacheable) this.parsed.set(data, { collection, data: result });
    return result;
  }

  private place(record: StoredRecord): Placement {
    const seq = this.seqOf.get(record.id) ?? 0;
    const data = record.deleted ? null : this.parse(record.collection, record.data);
    if (!data) return { record, seq, key: null, entry: null };
    const entry: AnyEntry = {
      id: record.id,
      data,
      updatedAt: record.updatedAt,
      dirty: record.dirty,
    };
    this.entrySeq.set(entry, seq);
    return { record, seq, key: placeOf(record.collection, data), entry };
  }

  private compareFor(key: ListKey): Compare {
    let compare = this.compares.get(key);
    if (!compare) {
      const base = listOrder[key];
      const seq = (e: AnyEntry) => this.entrySeq.get(e) ?? 0;
      compare = base ? (a, b) => base(a, b) || seq(a) - seq(b) : (a, b) => seq(a) - seq(b);
      this.compares.set(key, compare);
    }
    return compare;
  }

  /**
   * 能显示的宝宝按建档先后排（issue #106），当前宝宝是这台手机选的那个，没选过、选的删了或还没同步到时
   * 是第一个能显示的（`defaultBaby`）。删除的、读不懂的档案不显示，但参与排序：没写 `babyId` 的记录
   * 属于第一个宝宝（`firstBabyId`），它删了也是。
   */
  private pickBabies(): Pick<Snapshot, 'baby' | 'babies' | 'multiBaby'> & {
    firstId: string | null;
  } {
    const all: BabyRef[] = [];
    const shown: (BabyRef & { entry: AnyEntry })[] = [];
    for (const id of this.babyRecordIds) {
      const record = this.records.get(id);
      if (!record) continue;
      const placement = this.placements.get(id);
      const entry = placement?.key === 'baby' ? placement.entry : null;
      all.push(babyRefOf(id, record.data, record.deleted || !entry));
      if (entry) shown.push({ ...babyRefOf(id, record.data, false), entry });
    }
    const babies = orderBabies(shown).map((baby) => baby.entry as Entry<'baby'>);
    const baby =
      babies.find((entry) => entry.id === this.chosenBabyId) ??
      (defaultBaby(shown)?.entry as Entry<'baby'> | undefined) ??
      null;
    return { baby, babies, multiBaby: all.length > 1, firstId: firstBabyId(all) };
  }

  /** 只要当前宝宝的。和 `recordBabyId` 一样：没写 `babyId` 的属于第一个宝宝，全家共用的都留着。 */
  private filterFor(
    key: ListKey,
    source: AnyEntry[],
    babyId: string | null,
    firstId: string | null,
  ): AnyEntry[] {
    const collection = babyLists[key];
    if (!collection) return source;
    const cached = this.filtered.get(key);
    if (
      cached &&
      cached.source === source &&
      cached.babyId === babyId &&
      cached.firstId === firstId
    ) {
      return cached.result;
    }
    const result = source.filter((entry) => {
      const owner = recordBabyId(collection, entry.data, firstId);
      return owner === null || owner === babyId;
    });
    this.filtered.set(key, { source, babyId, firstId, result });
    return result;
  }

  /** 由不按宝宝过滤的列表和宝宝算出快照。只有一份档案时什么都不过滤，列表就是原来那几个数组。 */
  private publish(lists: Lists, babiesChanged: boolean) {
    const previous = this.snapshot;
    const picked = babiesChanged ? this.pickBabies() : { ...previous, firstId: this.firstIdCache };
    this.firstIdCache = picked.firstId;
    const babies =
      picked.babies.length === previous.babies.length &&
      picked.babies.every((entry, index) => entry === previous.babies[index])
        ? previous.babies
        : picked.babies;
    const babyId = picked.baby?.id ?? null;
    const exposed = {} as AnyLists;
    for (const key of listKeys) {
      const source = (lists as unknown as AnyLists)[key];
      exposed[key] = picked.multiBaby
        ? this.filterFor(key, source, babyId, picked.firstId)
        : source;
    }
    const all = listKeys.every((key) => lists[key] === previous.all[key]) ? previous.all : lists;
    const unchanged =
      picked.baby === previous.baby &&
      babies === previous.babies &&
      picked.multiBaby === previous.multiBaby &&
      all === previous.all &&
      this.dirtyCount === previous.pendingCount &&
      listKeys.every((key) => exposed[key] === (previous as unknown as AnyLists)[key]);
    this.lists = all;
    if (unchanged) return;
    this.snapshot = {
      ...(exposed as unknown as Lists),
      all,
      baby: picked.baby,
      babies,
      multiBaby: picked.multiBaby,
      pendingCount: this.dirtyCount,
    };
  }

  private rebuild(babiesChanged = false) {
    if (this.needsFullRebuild) this.rebuildAll();
    else this.applyChanges(babiesChanged);
    for (const listener of this.listeners) listener();
  }

  private rebuildAll() {
    this.placements.clear();
    this.babyIds.clear();
    const lists = Object.fromEntries(listKeys.map((key) => [key, []])) as unknown as AnyLists;
    for (const record of this.records.values()) {
      const placement = this.place(record);
      this.placements.set(record.id, placement);
      if (placement.key === 'baby') this.babyIds.add(record.id);
      else if (placement.key && placement.entry) lists[placement.key].push(placement.entry);
    }
    for (const key of listKeys) lists[key].sort(this.compareFor(key));
    this.filtered.clear();
    this.publish(lists as unknown as Lists, true);
    this.changed.clear();
    this.needsFullRebuild = false;
  }

  private applyChanges(babiesChanged: boolean) {
    const removed = new Map<ListKey, Set<AnyEntry>>();
    const added = new Map<ListKey, AnyEntry[]>();
    let babyChanged = babiesChanged;
    for (const id of this.changed) {
      const before = this.placements.get(id);
      const record = this.records.get(id);
      if (before && record && before.record === record && before.seq === this.seqOf.get(id)) {
        continue;
      }
      // 删除的档案也算：它决定谁是第一个宝宝、要不要按宝宝过滤。
      if ((record ?? before?.record)?.collection === 'baby') babyChanged = true;
      const after = record ? this.place(record) : null;
      if (after) this.placements.set(id, after);
      else this.placements.delete(id);
      if (before?.key === 'baby') {
        this.babyIds.delete(id);
      } else if (before?.key && before.entry) {
        const set = removed.get(before.key) ?? new Set<AnyEntry>();
        set.add(before.entry);
        removed.set(before.key, set);
      }
      if (after?.key === 'baby') {
        this.babyIds.add(id);
      } else if (after?.key && after.entry) {
        const list = added.get(after.key) ?? [];
        list.push(after.entry);
        added.set(after.key, list);
      }
    }
    this.changed.clear();
    const lists = { ...this.lists } as unknown as AnyLists;
    for (const key of new Set([...removed.keys(), ...added.keys()])) {
      lists[key] = this.patch(key, lists[key], removed.get(key), added.get(key));
    }
    this.publish(lists as unknown as Lists, babyChanged);
  }

  /** 在排好序的列表里去掉、加上几条，返回新数组。原数组不能动：页面可能还拿着它。 */
  private patch(
    key: ListKey,
    list: readonly AnyEntry[],
    removed: ReadonlySet<AnyEntry> | undefined,
    added: AnyEntry[] | undefined,
  ): AnyEntry[] {
    const compare = this.compareFor(key);
    if ((removed?.size ?? 0) + (added?.length ?? 0) <= SPLICE_LIMIT) {
      const next = list.slice();
      for (const entry of removed ?? []) {
        let index = lowerBound(next, entry, compare);
        if (next[index] !== entry) index = next.indexOf(entry);
        if (index >= 0) next.splice(index, 1);
      }
      for (const entry of added ?? []) next.splice(upperBound(next, entry, compare), 0, entry);
      return next;
    }
    const kept = removed ? list.filter((entry) => !removed.has(entry)) : list.slice();
    if (!added) return kept;
    // 新来的排好序，逐条二分找位置再整段复制：比较次数是 k·log n，不是 n。
    added.sort(compare);
    const merged: AnyEntry[] = [];
    let from = 0;
    for (const entry of added) {
      const at = upperBound(kept, entry, compare, from);
      for (let i = from; i < at; i++) merged.push(kept[i] as AnyEntry);
      merged.push(entry);
      from = at;
    }
    for (let i = from; i < kept.length; i++) merged.push(kept[i] as AnyEntry);
    return merged;
  }

  /** 新建或修改一条记录。内存先变，界面立即响应；落盘失败才抛错。 */
  async write<C extends Collection>(
    collection: C,
    id: string,
    data: CollectionData[C],
  ): Promise<void> {
    // 新记录写上属于哪个宝宝（issue #106）。改已有的记录不动：没有的本来就属于第一个宝宝。
    const stored = this.records.has(id)
      ? data
      : withBabyId(collection, data, this.snapshot.baby?.id);
    // 快照会跳过校验不过的记录：不在这里拦的话，它存得下却看不见，服务端也不收，改已有记录时原来的内容也没了。
    // 校验的是要存的这一份，结果留在缓存里，重建时不用再校验一次。
    if (!this.parse(collection, stored)) {
      throw new Error(t().ui.recordTooLarge);
    }
    const record: StoredRecord = {
      id,
      collection,
      data: stored,
      deleted: false,
      updatedAt: this.nextVersion(id),
      dirty: true,
    };
    this.put(record);
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
    this.put(record);
    this.rebuild();
    await this.db.put(record);
  }

  /** 手机时钟可能比已有版本慢，这里保证本地修改一定比它基于的版本新。 */
  private nextVersion(id: string): number {
    const existing = this.records.get(id);
    return Math.max(this.now(), (existing?.updatedAt ?? 0) + 1);
  }

  /** 这个 id 是否存在，已删除的也算。 */
  has(id: string): boolean {
    return this.records.has(id);
  }

  dirtyRecords(limit: number): StoredRecord[] {
    const dirty: StoredRecord[] = [];
    if (this.dirtyCount === 0) return dirty;
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
      this.put(cleaned);
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
      this.put(stored);
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
      if (collections.includes(record.collection)) this.drop(id);
    }
    this.rebuild();
  }

  async clear(): Promise<void> {
    await this.db.clear();
    this.chosenBabyId = null;
    this.reset([]);
    this.rebuild();
  }
}
