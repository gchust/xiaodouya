import { randomUUID } from 'node:crypto';
import {
  type BabyRef,
  babyRefOf,
  type Collection,
  compareMoneyEntries,
  type DocumentData,
  defaultBaby,
  type EventData,
  firstBabyId,
  isFavoriteData,
  isFavoriteFolderData,
  isFormulaData,
  isMoneyData,
  isResourceData,
  isVaccinePlanData,
  type LetterData,
  type MomentData,
  orderBabies,
  parseCollectionData,
  recordBabyId,
  type ServerRecord,
} from '@xiaodouya/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  type Entry,
  type LocalDb,
  RecordStore,
  type Snapshot,
  type StoredRecord,
} from '../src/data/store';

// 数一数校验了几次：一条写入不应该把其他记录再校验一遍（issue #111）。
const parseCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock('@xiaodouya/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xiaodouya/shared')>();
  return {
    ...actual,
    parseCollectionData: (collection: Collection, data: unknown) => {
      parseCalls.count += 1;
      return actual.parseCollectionData(collection, data);
    },
  };
});

class MemoryDb implements LocalDb {
  records = new Map<string, StoredRecord>();
  cursor = 0;
  meta = new Map<string, string>();
  failNextPutMany = false;
  async loadAll() {
    return [...this.records.values()];
  }
  async put(r: StoredRecord) {
    this.records.set(r.id, r);
  }
  async putMany(rs: StoredRecord[], cursor: number) {
    if (this.failNextPutMany) {
      this.failNextPutMany = false;
      throw new Error('disk full');
    }
    for (const r of rs) this.records.set(r.id, r);
    this.cursor = cursor;
  }
  async getCursor() {
    return this.cursor;
  }
  async getMeta(key: string) {
    return this.meta.get(key) ?? null;
  }
  async setMeta(key: string, value: string) {
    this.meta.set(key, value);
  }
  async deleteCollections(collections: readonly Collection[]) {
    for (const [id, r] of this.records)
      if (collections.includes(r.collection)) this.records.delete(id);
  }
  async clear() {
    this.records.clear();
    this.cursor = 0;
    this.meta.clear();
  }
}

/**
 * 改之前的全量重建，原样抄过来当对照：增量更新的结果（包括同一时间的先后顺序）必须和它一模一样。
 * 它按 Map 的插入顺序遍历、用稳定排序，所以同一时间的记录按插入先后排。
 */
function fullSnapshot(
  records: Iterable<StoredRecord>,
  chosenBabyId: string | null = null,
): Snapshot {
  const next = {
    events: [] as Snapshot['events'],
    vaccinePlans: [] as Snapshot['vaccinePlans'],
    formulas: [] as Snapshot['formulas'],
    money: [] as Snapshot['money'],
    resources: [] as Snapshot['resources'],
    favorites: [] as Snapshot['favorites'],
    favoriteFolders: [] as Snapshot['favoriteFolders'],
    moments: [] as Snapshot['moments'],
    letters: [] as Snapshot['letters'],
    documents: [] as Snapshot['documents'],
  };
  let pendingCount = 0;
  // 删除的、读不懂的档案也参与排序，谁是第一个宝宝不能因此改变（issue #106）；它们只是不显示。
  const babies: (BabyRef & { entry: Entry<'baby'> | null })[] = [];
  for (const record of records) {
    if (record.dirty) pendingCount += 1;
    if (record.collection === 'baby') {
      const data = record.deleted ? null : parseCollectionData('baby', record.data);
      const entry = data && {
        id: record.id,
        updatedAt: record.updatedAt,
        dirty: record.dirty,
        data,
      };
      babies.push({ ...babyRefOf(record.id, record.data, entry === null), entry });
      continue;
    }
    if (record.deleted) continue;
    const data = parseCollectionData(record.collection, record.data);
    if (!data) continue;
    const base = { id: record.id, updatedAt: record.updatedAt, dirty: record.dirty };
    switch (record.collection) {
      case 'event':
        if (isFormulaData(data)) next.formulas.push({ ...base, data });
        else if (isVaccinePlanData(data)) next.vaccinePlans.push({ ...base, data });
        else if (isMoneyData(data)) next.money.push({ ...base, data });
        else if (isResourceData(data)) next.resources.push({ ...base, data });
        else if (isFavoriteData(data)) next.favorites.push({ ...base, data });
        else if (isFavoriteFolderData(data)) next.favoriteFolders.push({ ...base, data });
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
  const atOf = (data: unknown) => (data as { at?: number }).at ?? 0;
  const byAtDesc = (a: { data: unknown }, b: { data: unknown }) => atOf(b.data) - atOf(a.data);
  next.events.sort(byAtDesc);
  next.moments.sort(byAtDesc);
  next.letters.sort(byAtDesc);
  next.documents.sort((a, b) => a.updatedAt - b.updatedAt);
  next.formulas.sort((a, b) => a.data.name.localeCompare(b.data.name));
  next.money.sort(compareMoneyEntries);
  next.resources.sort((a, b) => b.data.addedAt - a.data.addedAt || a.id.localeCompare(b.id));
  next.favoriteFolders.sort(
    (a, b) => a.data.createdAt - b.data.createdAt || a.id.localeCompare(b.id),
  );
  // 多个宝宝（issue #106 第二步）：当前宝宝是选的那个，否则是第一个能显示的；有不止一份档案时，
  // 属于宝宝的列表只留当前宝宝的。
  const shown = orderBabies(babies.filter((b) => b.entry !== null && !b.deleted));
  const shownEntries = shown.map((b) => b.entry as Entry<'baby'>);
  const baby =
    shownEntries.find((e) => e.id === chosenBabyId) ?? defaultBaby(babies)?.entry ?? null;
  const multiBaby = babies.length > 1;
  const firstId = firstBabyId(babies);
  const mine = <T extends { data: unknown }>(collection: Collection, list: T[]) =>
    multiBaby
      ? list.filter((e) => {
          const owner = recordBabyId(collection, e.data, firstId);
          return owner === null || owner === (baby?.id ?? null);
        })
      : list;
  return {
    ...next,
    events: mine('event', next.events),
    vaccinePlans: mine('event', next.vaccinePlans),
    money: mine('event', next.money),
    moments: mine('moment', next.moments),
    letters: mine('letter', next.letters),
    documents: mine('document', next.documents),
    all: next,
    baby,
    babies: shownEntries,
    multiBaby,
    pendingCount,
  };
}

/** 测试里读私有的选择：这台手机选的宝宝。 */
const chosenOf = (store: RecordStore) =>
  (store as unknown as { chosenBabyId: string | null }).chosenBabyId;

/** 测试里读私有的记录表：对照要按 Map 的插入顺序重建。 */
const recordsOf = (store: RecordStore) =>
  (store as unknown as { records: Map<string, StoredRecord> }).records.values();

const listKeys = [
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
] as const;

const feed = (at: number, ml = 90): EventData => ({ type: 'feed', at, ml });
const moment = (at: number): MomentData => ({
  title: '',
  text: '虚构',
  at,
  milestone: false,
  media: [],
});

const server = (
  id: string,
  collection: Collection,
  data: unknown,
  updatedAt: number,
  deleted = false,
): ServerRecord => ({ id, collection, data, updatedAt, deleted, seq: 1, createdBy: null });

async function filledStore(events: number, moments: number) {
  const db = new MemoryDb();
  for (let i = 0; i < events; i++) {
    const id = randomUUID();
    db.records.set(id, {
      id,
      collection: 'event',
      data: feed(1_000 + i),
      deleted: false,
      updatedAt: 1,
      dirty: false,
    });
  }
  for (let i = 0; i < moments; i++) {
    const id = randomUUID();
    db.records.set(id, {
      id,
      collection: 'moment',
      data: moment(1_000 + i),
      deleted: false,
      updatedAt: 1,
      dirty: false,
    });
  }
  const store = new RecordStore(db);
  await store.load();
  return { db, store };
}

describe('多个宝宝：按当前宝宝过滤（issue #106 第二步）', () => {
  const FIRST = '11111111-1111-4111-8111-111111111111';
  const SECOND = '22222222-2222-4222-8222-222222222222';
  const UNKNOWN = '33333333-3333-4333-8333-333333333333';
  const PERSON = '44444444-4444-4444-8444-444444444444';

  function seed(records: [string, Collection, unknown, boolean?][]) {
    const db = new MemoryDb();
    for (const [id, collection, data, deleted] of records) {
      db.records.set(id, {
        id,
        collection,
        data,
        deleted: deleted ?? false,
        updatedAt: 1,
        dirty: false,
      });
    }
    return db;
  }
  const first = { name: '大宝', birthAt: 1 };
  const second = { name: '二宝', birthAt: 2, createdAt: 5000 };
  const ids = (list: readonly { id: string }[]) => list.map((e) => e.id).sort();

  it('只有一份档案时什么都不过滤：写着别的宝宝的记录照样显示，列表就是原来的数组', async () => {
    const db = seed([
      [FIRST, 'baby', first],
      ['e1', 'event', feed(10)],
      ['e2', 'event', { ...feed(20), babyId: UNKNOWN }],
      ['m1', 'moment', { ...moment(30), babyId: UNKNOWN }],
    ]);
    const store = new RecordStore(db);
    await store.load();
    const snapshot = store.getSnapshot();
    expect(snapshot.multiBaby).toBe(false);
    expect(ids(snapshot.events)).toEqual(['e1', 'e2']);
    expect(ids(snapshot.moments)).toEqual(['m1']);
    for (const key of listKeys) expect(snapshot[key]).toBe(snapshot.all[key]);
    expect(snapshot.babies.map((b) => b.id)).toEqual([FIRST]);
    expect(snapshot.baby?.id).toBe(FIRST);
  });

  it('两份档案：照护记录、疫苗本配置、小金库、回忆、信、宝宝的证件只有当前宝宝的，全家共用的都在', async () => {
    const db = seed([
      [FIRST, 'baby', first],
      [SECOND, 'baby', second],
      ['legacy', 'event', feed(10)],
      ['mine', 'event', { ...feed(11), babyId: FIRST }],
      ['theirs', 'event', { ...feed(12), babyId: SECOND }],
      [
        'plan2',
        'event',
        { type: 'vaccine-plan', vaccineId: 'sg:bcg', hidden: true, babyId: SECOND },
      ],
      [
        'money1',
        'event',
        { type: 'money', flow: 'in', amountMinor: 100, currency: 'SGD', happenedAt: 1 },
      ],
      ['formula', 'event', { type: 'formula', name: '虚构奶粉', basis: 'per100ml', values: {} }],
      ['m2', 'moment', { ...moment(30), babyId: SECOND }],
      ['l1', 'letter', { title: '', text: '虚构', at: 1 }],
      ['doc2', 'document', { name: '虚构证件', files: [], babyId: SECOND }],
      ['own', 'document', { name: '护照', files: [], owner: PERSON }],
    ]);
    const store = new RecordStore(db);
    await store.load();
    let snapshot = store.getSnapshot();
    expect(snapshot.multiBaby).toBe(true);
    expect(snapshot.babies.map((b) => b.id)).toEqual([FIRST, SECOND]);
    expect(snapshot.baby?.id).toBe(FIRST);
    expect(ids(snapshot.events)).toEqual(['legacy', 'mine']);
    expect(ids(snapshot.vaccinePlans)).toEqual([]);
    expect(ids(snapshot.money)).toEqual(['money1']);
    expect(ids(snapshot.moments)).toEqual([]);
    expect(ids(snapshot.letters)).toEqual(['l1']);
    expect(ids(snapshot.documents)).toEqual(['own']);
    expect(ids(snapshot.formulas)).toEqual(['formula']);
    expect(ids(snapshot.all.events)).toEqual(['legacy', 'mine', 'theirs']);

    await store.setCurrentBaby(SECOND);
    snapshot = store.getSnapshot();
    expect(snapshot.baby?.id).toBe(SECOND);
    expect(ids(snapshot.events)).toEqual(['theirs']);
    expect(ids(snapshot.vaccinePlans)).toEqual(['plan2']);
    expect(ids(snapshot.money)).toEqual([]);
    expect(ids(snapshot.moments)).toEqual(['m2']);
    expect(ids(snapshot.letters)).toEqual([]);
    expect(ids(snapshot.documents)).toEqual(['doc2', 'own']);
    expect(ids(snapshot.formulas)).toEqual(['formula']);
  });

  it('新记录写给当前宝宝；切换后选的宝宝记在手机上，重新打开还是它', async () => {
    const db = seed([
      [FIRST, 'baby', first],
      [SECOND, 'baby', second],
    ]);
    const store = new RecordStore(db);
    await store.load();
    await store.setCurrentBaby(SECOND);
    await store.write('event', 'new', feed(50));
    expect(db.records.get('new')?.data).toMatchObject({ babyId: SECOND });
    expect(ids(store.getSnapshot().events)).toEqual(['new']);

    const reopened = new RecordStore(db);
    await reopened.load();
    expect(reopened.getSnapshot().baby?.id).toBe(SECOND);
    expect(ids(reopened.getSnapshot().events)).toEqual(['new']);
  });

  it('选的宝宝删了或还没同步到时回到第一个宝宝；删了的宝宝的记录不显示', async () => {
    const db = seed([
      [FIRST, 'baby', first],
      [SECOND, 'baby', second],
      ['theirs', 'event', { ...feed(12), babyId: SECOND }],
    ]);
    const store = new RecordStore(db);
    await store.load();
    await store.setCurrentBaby(UNKNOWN);
    expect(store.getSnapshot().baby?.id).toBe(FIRST);
    await store.setCurrentBaby(SECOND);
    expect(ids(store.getSnapshot().events)).toEqual(['theirs']);
    await store.remove(SECOND);
    const snapshot = store.getSnapshot();
    expect(snapshot.baby?.id).toBe(FIRST);
    expect(snapshot.babies.map((b) => b.id)).toEqual([FIRST]);
    expect(snapshot.multiBaby).toBe(true);
    expect(ids(snapshot.events)).toEqual([]);
  });

  it('切换宝宝只换按宝宝过滤的列表，奶粉、收藏这些还是原来的数组', async () => {
    const db = seed([
      [FIRST, 'baby', first],
      [SECOND, 'baby', second],
      ['formula', 'event', { type: 'formula', name: '虚构奶粉', basis: 'per100ml', values: {} }],
    ]);
    const store = new RecordStore(db);
    await store.load();
    const before = store.getSnapshot();
    await store.setCurrentBaby(SECOND);
    const after = store.getSnapshot();
    expect(after.formulas).toBe(before.formulas);
    expect(after.favorites).toBe(before.favorites);
    expect(after.all).toBe(before.all);
  });

  it('全部档案（删除的也在）给加宝宝用', async () => {
    const db = seed([
      [FIRST, 'baby', first],
      [SECOND, 'baby', second, true],
    ]);
    const store = new RecordStore(db);
    await store.load();
    expect(store.babyRefs()).toEqual([
      { id: FIRST, deleted: false },
      { id: SECOND, createdAt: 5000, deleted: true },
    ]);
  });
});

describe('写一条记录只更新变了的部分（issue #111）', () => {
  it('写一条喂奶后，回忆和其他没变的列表还是原来的数组', async () => {
    const { store } = await filledStore(50, 5);
    await store.write('document', randomUUID(), { name: '虚构证件', files: [] });
    await store.write('letter', randomUUID(), { title: '', text: '虚构', at: 1 });
    const before = store.getSnapshot();
    await store.write('event', randomUUID(), feed(9_999));
    const after = store.getSnapshot();
    expect(after).not.toBe(before);
    expect(after.events).not.toBe(before.events);
    expect(after.events[0]?.data).toMatchObject({ at: 9_999 });
    expect(after.pendingCount).toBe(before.pendingCount + 1);
    for (const key of listKeys) {
      if (key !== 'events') expect(after[key], key).toBe(before[key]);
    }
    expect(after.baby).toBe(before.baby);
    // 没变的那几十条喂奶也是原来的对象，被 memo 的行不用重画。
    expect(after.events[1]).toBe(before.events[0]);
  });

  it('写一条回忆后，喂奶列表还是原来的数组', async () => {
    const { store } = await filledStore(50, 5);
    const before = store.getSnapshot();
    await store.write('moment', randomUUID(), moment(9_999));
    expect(store.getSnapshot().events).toBe(before.events);
    expect(store.getSnapshot().moments).not.toBe(before.moments);
  });

  it('同步确认和拉下来的喂奶只换喂奶列表；记录本身变成已同步要能看出来', async () => {
    const { store } = await filledStore(20, 5);
    const id = randomUUID();
    await store.write('event', id, feed(9_999));
    const before = store.getSnapshot();
    const sent = store.dirtyRecords(10);
    await store.applySyncResult(sent, [server(randomUUID(), 'event', feed(5), 7)], new Set(), 3);
    const after = store.getSnapshot();
    expect(after.moments).toBe(before.moments);
    expect(after.events).not.toBe(before.events);
    expect(after.events.find((e) => e.id === id)?.dirty).toBe(false);
    expect(after.pendingCount).toBe(0);
  });

  it('删掉一条喂奶不碰回忆', async () => {
    const { store } = await filledStore(20, 5);
    const before = store.getSnapshot();
    const victim = before.events[3]?.id ?? '';
    await store.remove(victim);
    expect(store.getSnapshot().moments).toBe(before.moments);
    expect(store.getSnapshot().events.some((e) => e.id === victim)).toBe(false);
  });

  it('写一条记录只校验这一条，不把已有的几千条再校验一遍', async () => {
    const { store } = await filledStore(3_000, 100);
    parseCalls.count = 0;
    await store.write('event', randomUUID(), feed(9_999));
    expect(parseCalls.count).toBeLessThanOrEqual(1);
    parseCalls.count = 0;
    const sent = store.dirtyRecords(10);
    await store.applySyncResult(sent, [server(randomUUID(), 'event', feed(5), 7)], new Set(), 3);
    // 确认上传只改了 dirty，数据是同一份，不用再校验；拉下来的那一条要校验。
    expect(parseCalls.count).toBeLessThanOrEqual(1);
  });

  it('落盘失败时内存里已经应用的同步结果仍然算数，下一次更新也不会丢', async () => {
    const { db, store } = await filledStore(5, 1);
    const id = randomUUID();
    db.failNextPutMany = true;
    await expect(
      store.applySyncResult([], [server(id, 'event', feed(8_888), 7)], new Set(), 3),
    ).rejects.toThrow('disk full');
    await store.write('moment', randomUUID(), moment(1));
    expect(store.getSnapshot()).toEqual(fullSnapshot(recordsOf(store)));
    expect(store.getSnapshot().events.some((e) => e.id === id)).toBe(true);
  });
});

/** 固定种子的伪随机数，失败时能复现。 */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('增量更新和全量重建结果一致', () => {
  for (const seed of Array.from({ length: 40 }, (_, i) => i + 1)) {
    it(`随机的写入、删除、撤销、同步、清理（种子 ${seed}）`, async () => {
      const rand = rng(seed);
      const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
      const small = () => Math.floor(rand() * 6);
      let clock = 100;
      const db = new MemoryDb();
      // 时钟常常不走：同一时间、同一版本号的情况最容易排错顺序。
      const store = new RecordStore(db, { now: () => (rand() < 0.5 ? clock : ++clock) });
      await store.load();

      const ids: Record<'event' | 'moment' | 'letter' | 'document' | 'baby', string[]> = {
        event: Array.from({ length: 24 }, () => randomUUID()),
        moment: Array.from({ length: 6 }, () => randomUUID()),
        letter: Array.from({ length: 4 }, () => randomUUID()),
        document: Array.from({ length: 4 }, () => randomUUID()),
        baby: Array.from({ length: 3 }, () => randomUUID()),
      };
      // 多个宝宝（issue #106 第二步）：记录有的写了 babyId，有的没写（属于第一个宝宝）。
      const owned = <T extends object>(data: T): T =>
        rand() < 0.5 ? data : { ...data, babyId: pick(ids.baby) };
      const eventData = (): EventData | Record<string, unknown> =>
        pick([
          () => feed(small()),
          () => ({ type: 'diaper', at: small(), kind: 'wee' }),
          () => ({ type: 'sleep', at: small() }),
          () => ({
            type: 'formula',
            name: pick(['a', 'b', 'B', '']),
            basis: 'per100ml',
            values: {},
          }),
          () => ({ type: 'vaccine-plan', vaccineId: 'sg:bcg', hidden: rand() < 0.5 }),
          () => ({
            type: 'money',
            flow: 'in',
            amountMinor: 100,
            currency: 'SGD',
            happenedAt: small(),
          }),
          () => ({ type: 'resource', url: 'https://example.test/a', title: 't', addedAt: small() }),
          () => ({
            type: 'favorite',
            target: 'resource',
            targetId: pick(ids.event),
            addedAt: small(),
            folders: [],
          }),
          () => ({ type: 'favorite-folder', name: 'f', createdAt: small() }),
          // 校验不过：存着但不显示。
          () => ({ type: 'feed', at: small(), ml: -1 }),
          () => ({ type: 'from-a-newer-app', at: small() }),
        ])();
      const dataFor = (collection: keyof typeof ids): unknown => {
        switch (collection) {
          case 'event':
            return owned(eventData());
          case 'moment':
            return rand() < 0.1 ? { at: small() } : owned(moment(small()));
          case 'letter':
            return owned({ title: '', text: 'x', at: small() });
          case 'document':
            return owned(
              rand() < 0.2
                ? { name: pick(['d', 'e']), files: [], owner: randomUUID() }
                : { name: pick(['d', 'e']), files: [] },
            );
          case 'baby':
            // 第一个宝宝按建档先后排（issue #106），一样时按 id。
            return rand() < 0.5
              ? { name: 'Sprout', birthAt: small() }
              : { name: 'Sprout', birthAt: small(), createdAt: small() };
        }
      };
      const randomCollection = () =>
        pick(['event', 'event', 'event', 'event', 'moment', 'letter', 'document', 'baby'] as const);

      // 落盘失败时界面不刷新（和改之前一样），要等下一次真正更新时才对得上。
      let stale = false;
      const check = (step: string) => {
        if (stale) return;
        expect(store.getSnapshot(), step).toEqual(fullSnapshot(recordsOf(store), chosenOf(store)));
      };
      const notified = () => {
        let count = 0;
        const unsubscribe = store.subscribe(() => {
          count += 1;
        });
        return () => {
          unsubscribe();
          if (count > 0) stale = false;
        };
      };

      let lastUndo: (() => Promise<void>) | null = null;
      for (let step = 0; step < 300; step++) {
        const roll = rand();
        let label: string;
        const done = notified();
        if (roll < 0.35) {
          const collection = randomCollection();
          const id = pick(ids[collection]);
          const data = dataFor(collection);
          label = `write ${collection} ${JSON.stringify(data)}`;
          const previous = store.getSnapshot();
          try {
            await store.write(collection, id, data as never);
            lastUndo = () => store.remove(id);
          } catch {
            // 校验不过的写入被拒，什么都不变。
            expect(store.getSnapshot()).toBe(previous);
          }
        } else if (roll < 0.45) {
          const collection = randomCollection();
          const id = pick(ids[collection]);
          label = `remove ${id}`;
          await store.remove(id);
        } else if (roll < 0.5 && lastUndo) {
          label = 'undo';
          await lastUndo();
          lastUndo = null;
        } else if (roll < 0.85) {
          const sent = store.dirtyRecords(1 + small());
          // 上传途中又改了一条：确认时不能把新改动当成已同步。
          if (sent.length > 0 && rand() < 0.3) {
            const changed = pick(sent);
            await store
              .write(
                changed.collection,
                changed.id,
                dataFor(changed.collection as keyof typeof ids) as never,
              )
              .catch(() => {});
          }
          const incoming: ServerRecord[] = [];
          // 偶尔一大批（离开一阵后拉下来的），走另一条合并路径。
          for (let i = rand() < 0.15 ? 20 + small() * 5 : small(); i > 0; i--) {
            const collection = randomCollection();
            const id = pick(ids[collection]);
            // 版本号常和本地一样：服务端按字段替换或判平局时会这样发回来。
            incoming.push(
              server(id, collection, dataFor(collection), clock - small(), rand() < 0.15),
            );
          }
          const rejected = new Set(sent.filter(() => rand() < 0.2).map((r) => r.id));
          label = `sync sent=${sent.length} incoming=${incoming.length}`;
          db.failNextPutMany = rand() < 0.05;
          const failed = await store.applySyncResult(sent, incoming, rejected, step).then(
            () => false,
            () => true,
          );
          if (failed) {
            done();
            stale = true;
            continue;
          }
        } else if (roll < 0.93) {
          const collections = (['event', 'moment', 'letter', 'document', 'baby'] as const).filter(
            () => rand() < 0.3,
          );
          label = `purge ${collections.join(',')}`;
          await store.purgeCollections(collections);
        } else if (roll < 0.95) {
          label = 'clear';
          await store.clear();
        } else if (rand() < 0.5) {
          const id = pick(ids.baby);
          label = `choose ${id}`;
          await store.setCurrentBaby(id);
        } else {
          // 重启：从落盘的数据重新加载，结果也要一致。选的宝宝也记在手机上。
          label = 'reload';
          const reloaded = new RecordStore(db);
          await reloaded.load();
          expect(reloaded.getSnapshot(), label).toEqual(
            fullSnapshot(recordsOf(reloaded), chosenOf(store)),
          );
          done();
          continue;
        }
        done();
        check(`step ${step}: ${label}`);
      }
    });
  }
});
