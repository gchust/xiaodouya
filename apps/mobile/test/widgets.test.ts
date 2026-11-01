import { createRequire } from 'node:module';
import {
  type BabyData,
  buildWidgetView,
  type EventData,
  type FormulaData,
  formulaSnapshot,
  metricUnits,
  type SyncRequest,
  type SyncResponse,
  sleepState,
  startOfLocalDay,
  summarizeDay,
  type WidgetSession,
} from '@xiaodouya/shared';
import { describe, expect, it } from 'vitest';
import { type LocalDb, RecordStore, type StoredRecord } from '../src/data/store';
import { LAST_SYNC_KEY, SyncEngine, type SyncTransport } from '../src/data/syncEngine';
import { runWidgetAction } from '../src/widgets/actions';
import { eventLink, FEED_LINK, linkKey, parseWidgetLink, TODAY_LINK } from '../src/widgets/links';

class MemoryDb implements LocalDb {
  records = new Map<string, StoredRecord>();
  meta = new Map<string, string>();
  cursor = 0;
  async loadAll() {
    return [...this.records.values()];
  }
  async put(r: StoredRecord) {
    this.records.set(r.id, r);
  }
  async putMany(rs: StoredRecord[], cursor: number) {
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
  async deleteCollections() {}
  async clear() {
    this.records.clear();
  }
}

const { addOnNewIntent } = createRequire(import.meta.url)('../plugins/with-latest-intent.js') as {
  addOnNewIntent(source: string): string;
};

const session: WidgetSession = {
  signedIn: true,
  hasFamily: true,
  role: 'caregiver',
  label: '爸爸',
};
const baby: BabyData = { name: '测试豆', birthAt: 1 };
const HOUR = 3_600_000;
const now = 1_800_000_000_000;

async function setup(events: Record<string, EventData> = {}) {
  const db = new MemoryDb();
  const store = new RecordStore(db, { now: () => now });
  await store.load();
  await store.write('baby', 'baby-1', baby);
  for (const [id, data] of Object.entries(events)) await store.write('event', id, data);
  return { db, store };
}

const lastFeed: EventData = { type: 'feed', at: now - HOUR, ml: 90, note: '虚构备注' };

describe('小工具写入', () => {
  it('记录先落盘并进入发件箱，同步引擎能看到它', async () => {
    const { db, store } = await setup({ old: lastFeed });
    const plan = await runWidgetAction({ type: 'feed', id: 'new' }, store, session, now);
    expect(plan.kind).toBe('write');
    expect(db.records.get('new')).toMatchObject({
      collection: 'event',
      dirty: true,
      data: { type: 'feed', at: now, ml: 90, byName: '爸爸' },
    });
    expect(store.dirtyRecords(100).map((r) => r.id)).toContain('new');
    expect(store.getSnapshot().events[0]?.id).toBe('new');
  });

  it('同一个 id 重试不会多记，也不会改掉已有记录的版本', async () => {
    const { db, store } = await setup({ old: lastFeed });
    await runWidgetAction({ type: 'feed', id: 'new' }, store, session, now);
    const version = db.records.get('new')?.updatedAt;
    const again = await runWidgetAction({ type: 'feed', id: 'new' }, store, session, now + 1000);
    expect(again.kind).toBe('noop');
    expect(store.getSnapshot().events.filter((e) => e.data.type === 'feed')).toHaveLength(2);
    expect(db.records.get('new')?.updatedAt).toBe(version);
  });

  it('撤销之后迟到的重试不会让记录复活', async () => {
    const { store } = await setup({ old: lastFeed });
    await runWidgetAction({ type: 'feed', id: 'new' }, store, session, now);
    await store.remove('new');
    const again = await runWidgetAction({ type: 'feed', id: 'new' }, store, session, now + 1000);
    expect(again.kind).toBe('noop');
    expect(store.getSnapshot().events.map((e) => e.id)).not.toContain('new');
  });

  it('没有历史奶量时什么都不写', async () => {
    const { db, store } = await setup();
    const plan = await runWidgetAction({ type: 'feed', id: 'new' }, store, session, now);
    expect(plan.kind).toBe('needsAmount');
    expect(db.records.has('new')).toBe(false);
  });

  it('只看回忆的家人点击不写入', async () => {
    const { db, store } = await setup({ old: lastFeed });
    const plan = await runWidgetAction(
      { type: 'feed', id: 'new' },
      store,
      { ...session, role: 'viewer' },
      now,
    );
    expect(plan.kind).toBe('blocked');
    expect(db.records.has('new')).toBe(false);
  });

  it('开始和结束睡眠是同一条记录，第二次点“醒了”不再改', async () => {
    const { store } = await setup();
    await runWidgetAction({ type: 'sleepStart', id: 's' }, store, session, now - HOUR);
    await runWidgetAction({ type: 'sleepEnd', sleepId: 's' }, store, session, now);
    const again = await runWidgetAction(
      { type: 'sleepEnd', sleepId: 's' },
      store,
      session,
      now + 1,
    );
    expect(again.kind).toBe('noop');
    const sleeps = store.getSnapshot().events.filter((e) => e.data.type === 'sleep');
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]?.data).toMatchObject({ at: now - HOUR, endAt: now });
  });
});

describe('奶粉配置和小工具', () => {
  // 配置存在 event 集合里，但没有 at，也不是一次喂奶。
  const formula: FormulaData = {
    type: 'formula',
    name: '虚构奶粉',
    basis: 'per100ml',
    values: { energyKcal: 67 },
  };

  it('小工具记的喂奶沿用奶类型，快照用奶粉现在的数值', async () => {
    const { db, store } = await setup({
      old: {
        type: 'feed',
        at: now - HOUR,
        ml: 90,
        milkType: 'formula',
        formulaId: 'f1',
        formula: { name: '虚构奶粉', per100ml: { energyKcal: 60 } },
      },
    });
    await store.write('event', 'f1', formula);
    await runWidgetAction({ type: 'feed', id: 'new' }, store, session, now);
    expect(db.records.get('new')?.data).toEqual({
      type: 'feed',
      at: now,
      ml: 90,
      milkType: 'formula',
      formulaId: 'f1',
      formula: formulaSnapshot(formula),
      byName: '爸爸',
    });
  });

  it('配置不会被当成喂奶、睡眠，也不计入今日汇总', async () => {
    const { store } = await setup();
    await store.write('event', 'f1', formula);
    const { events, formulas } = store.getSnapshot();
    expect(formulas.map((f) => f.id)).toEqual(['f1']);
    const view = buildWidgetView({
      session,
      baby,
      entries: events,
      units: metricUnits,
      now,
      dayStart: startOfLocalDay(now),
      syncedAt: null,
    });
    expect(view).toMatchObject({
      kind: 'ready',
      lastFeed: null,
      canQuickFeed: false,
      sleep: { status: 'awake', lastEnd: null },
      today: { feeds: 0, ml: 0, diapers: 0, sleepMs: 0 },
    });
    const plan = await runWidgetAction({ type: 'feed', id: 'new' }, store, session, now);
    expect(plan.kind).toBe('needsAmount');
  });

  it('就算配置混进了记录列表，判断也不受影响', () => {
    // 防御：store 现在会把它分开，但这些函数接收的是外部数据。
    const mixed = [formula as unknown as EventData];
    expect(sleepState(mixed, now)).toEqual({ status: 'awake' });
    expect(summarizeDay(mixed, startOfLocalDay(now), now)).toMatchObject({ feeds: 0, sleepMs: 0 });
  });
});

class FakeTransport implements SyncTransport {
  requests: SyncRequest[] = [];
  fail = false;
  waits = 0;
  async sync(request: SyncRequest): Promise<SyncResponse> {
    if (this.fail) throw new Error('offline');
    this.requests.push(request);
    return { cursor: 1, records: [], rejected: [], hasMore: false, role: 'caregiver' };
  }
  async wait(): Promise<{ changed: boolean }> {
    this.waits += 1;
    return { changed: false };
  }
}

describe('syncOnce', () => {
  it('App 没开时把小工具的记录推上去，不开长轮询', async () => {
    const { db, store } = await setup({ old: lastFeed });
    await runWidgetAction({ type: 'feed', id: 'new' }, store, session, now);
    const transport = new FakeTransport();
    const engine = new SyncEngine(store, db, transport);
    await engine.syncOnce();
    expect(transport.requests[0]?.changes.map((c) => c.id)).toContain('new');
    expect(store.dirtyRecords(100)).toHaveLength(0);
    expect(transport.waits).toBe(0);
    expect(Number(db.meta.get(LAST_SYNC_KEY))).toBeGreaterThan(0);
  });

  it('没网时不抛错，记录留在发件箱，下次还能传', async () => {
    const { db, store } = await setup({ old: lastFeed });
    await runWidgetAction({ type: 'feed', id: 'new' }, store, session, now);
    const transport = new FakeTransport();
    transport.fail = true;
    const engine = new SyncEngine(store, db, transport);
    await expect(engine.syncOnce()).resolves.toBeUndefined();
    expect(store.dirtyRecords(100).map((r) => r.id)).toContain('new');
    expect(db.meta.has(LAST_SYNC_KEY)).toBe(false);
    transport.fail = false;
    await engine.syncOnce();
    expect(store.dirtyRecords(100)).toHaveLength(0);
  });

  it('并发调用合并成一轮', async () => {
    const { db, store } = await setup();
    const transport = new FakeTransport();
    const engine = new SyncEngine(store, db, transport);
    await Promise.all([engine.syncOnce(), engine.syncOnce()]);
    expect(transport.requests).toHaveLength(1);
  });

  it('角色变小后同步也会写入本地，小工具才能据此挡住', async () => {
    const { db, store } = await setup();
    const transport = new FakeTransport();
    transport.sync = async () => ({
      cursor: 1,
      records: [],
      rejected: [],
      hasMore: false,
      role: 'viewer',
    });
    const engine = new SyncEngine(store, db, transport);
    await engine.syncOnce();
    expect(db.meta.get('role')).toBe('viewer');
  });
});

describe('小工具的链接', () => {
  it('记录的链接解析回同一个 id', () => {
    expect(parseWidgetLink(eventLink('a b/c'))).toEqual({ kind: 'event', id: 'a b/c' });
  });

  it('选奶量的链接', () => {
    expect(parseWidgetLink(FEED_LINK)).toEqual({ kind: 'feed' });
  });

  it('别的链接不当成小工具的动作', () => {
    for (const url of [
      null,
      '',
      TODAY_LINK,
      'xiaodouya://recall?event=x',
      'https://example.test/today?event=x',
      `${TODAY_LINK}?other=1`,
      `${TODAY_LINK}?sheet=delete`,
      `${TODAY_LINK}?event=%E0%A4%A`,
    ]) {
      expect(parseWidgetLink(url)).toBeNull();
    }
  });

  it('相同的动作得到相同的去重键', () => {
    expect(linkKey({ kind: 'event', id: 'a' })).toBe('event:a');
    expect(linkKey({ kind: 'feed' })).toBe('feed');
  });
});

describe('with-latest-intent', () => {
  const template = `package a
import android.os.Bundle
class MainActivity : ReactActivity() {
  override fun getMainComponentName(): String = "main"
}`;

  it('把新的 Intent 存下来，并补上 import', () => {
    const result = addOnNewIntent(template);
    expect(result).toContain('import android.content.Intent');
    expect(result).toContain('setIntent(intent)');
  });

  it('重复运行 prebuild 不会加两次', () => {
    const once = addOnNewIntent(template);
    expect(addOnNewIntent(once)).toBe(once);
  });

  it('模板变了要报错，不能悄悄失效', () => {
    expect(() => addOnNewIntent('class Other {}')).toThrow();
  });
});
