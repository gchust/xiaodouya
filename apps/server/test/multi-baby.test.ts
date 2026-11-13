import { randomUUID } from 'node:crypto';
import type {
  CreateShareResponse,
  PublicConfig,
  PublicShareResponse,
  PublicTimelineMomentResponse,
  PublicTimelineResponse,
  ShareListResponse,
  SyncResponse,
} from '@xiaodouya/shared';
import { CLIENT_LEVEL_HEADER, MULTI_BABY_CLIENT_LEVEL } from '@xiaodouya/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import type { PushMessage } from '../src/notifier';
import { type App, call, join, newFamily, openTestDb, type TestDb } from './harness';

/**
 * 多个宝宝的服务端部分（issue #106 第二步）：挡住不按宝宝过滤的旧版 App、`createdAt` 只在建档时定一次、
 * 地区、分享按宝宝过滤。真实的 Postgres，名字和内容都是虚构的。
 * “旧版”就是不带 `x-client-level` 的请求：v0.1.0 到第一步的版本都不带。
 */

const LONG_POLL = { intervalMs: 20, timeoutMs: 300 };
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const TZ = 'Asia/Singapore';
// 2026-06-15 在新加坡的 0 点。
const FROM = Date.UTC(2026, 5, 14, 16);
const units = { volume: 'ml', temperature: 'c', weight: 'kg', length: 'cm' };
const NEW_APP = { [CLIENT_LEVEL_HEADER]: String(MULTI_BABY_CLIENT_LEVEL) };

let db: TestDb;
let app: App;
let pushes: PushMessage[];

beforeAll(async () => {
  db = await openTestDb('multi_baby');
});
beforeEach(() => {
  pushes = [];
  app = createApp({
    sql: db.sql,
    config: db.config,
    longPoll: LONG_POLL,
    notifier: { send: async (messages) => void pushes.push(...messages) },
  });
});
afterAll(async () => {
  await db.close();
});

type Change = {
  id: string;
  collection: string;
  data: unknown;
  deleted: boolean;
  updatedAt: number;
};

let clock = Date.now();
const nextVersion = () => {
  clock += 1;
  return clock;
};

const change = (
  collection: string,
  data: unknown,
  id: string = randomUUID(),
  deleted = false,
): Change => ({
  id,
  collection,
  data,
  deleted,
  updatedAt: nextVersion(),
});

const baby = (id: string, data: Record<string, unknown> = {}, deleted = false) =>
  change('baby', { name: '虚构宝宝', birthAt: Date.UTC(2026, 5, 1), ...data }, id, deleted);

const sync = (token: string, changes: Change[] = [], headers: Record<string, string> = {}) =>
  call<SyncResponse>(app, 'POST', '/v1/sync', { token, headers, body: { cursor: 0, changes } });

/** 新版 App（按宝宝过滤）的同步。 */
const syncNew = (token: string, changes: Change[] = []) => sync(token, changes, NEW_APP);

const stored = async (id: string) => {
  const [row] = await db.sql<{ data: Record<string, unknown> }[]>`
    SELECT data FROM records WHERE id = ${id}`;
  return row?.data;
};

/** 家庭的第一个宝宝（建档页，没有 createdAt），再由新版 App 加一个宝宝。 */
async function twoBabies(firstRegion = 'SG') {
  const { admin, family } = await newFamily(app);
  const second = randomUUID();
  expect(
    (await sync(admin.token, [baby(family.id, { name: '大宝', region: firstRegion })])).status,
  ).toBe(200);
  const added = await syncNew(admin.token, [
    baby(second, { name: '二宝', birthAt: Date.UTC(2026, 5, 10), createdAt: 5000 }),
  ]);
  expect(added.json.rejected).toEqual([]);
  return { admin, family, first: family.id, second };
}

describe('只有一个宝宝时一切照旧', () => {
  it('旧版照常同步和长轮询，一份档案的家庭不受影响', async () => {
    const { admin, family } = await newFamily(app);
    const mom = await join(app, admin.token, 'caregiver', '妈妈');
    expect((await sync(admin.token, [baby(family.id)])).status).toBe(200);
    const feed = change('event', { type: 'feed', at: Date.now(), ml: 90 });
    const written = await sync(mom.token, [feed]);
    expect(written.status).toBe(200);
    expect(written.json.rejected).toEqual([]);
    const pulled = await sync(admin.token);
    expect(pulled.json.records.map((r) => r.id).sort()).toEqual([family.id, feed.id].sort());
    const wait = await call<{ changed: boolean }>(app, 'GET', '/v1/sync/wait?cursor=0', {
      token: admin.token,
    });
    expect(wait.json).toEqual({ changed: true });
  });

  it('档案可以反复保存，删了再恢复；没有 createdAt 也不会被拒', async () => {
    const { admin, family } = await newFamily(app);
    for (const data of [{}, { name: '改名' }]) {
      expect((await sync(admin.token, [baby(family.id, data)])).json.rejected).toEqual([]);
    }
    expect((await sync(admin.token, [baby(family.id, {}, true)])).json.rejected).toEqual([]);
    expect((await sync(admin.token, [baby(family.id)])).json.rejected).toEqual([]);
    expect(await stored(family.id)).not.toHaveProperty('createdAt');
  });

  it('服务端声明自己能管住多个宝宝', async () => {
    const config = await call<PublicConfig>(app, 'GET', '/v1/config');
    expect(config.json.multiBaby).toBe(true);
  });
});

describe('有第二个宝宝后挡住旧版 App', () => {
  it('旧版同步拿到 426 upgrade_required，发来的改动不写入；新版照常', async () => {
    const { admin } = await twoBabies();
    const mom = await join(app, admin.token, 'caregiver', '妈妈');
    const feed = change('event', { type: 'feed', at: Date.now(), ml: 90 });
    const old = await sync(mom.token, [feed]);
    expect(old.status).toBe(426);
    // v0.1.0 直接显示 message，所以是中文；新版按 code 查。
    expect(old.json).toMatchObject({
      error: { code: 'upgrade_required', message: expect.stringContaining('更新') },
    });
    expect(await stored(feed.id)).toBeUndefined();

    const fresh = await syncNew(mom.token, [feed]);
    expect(fresh.status).toBe(200);
    expect(fresh.json.rejected).toEqual([]);
    expect(await stored(feed.id)).toBeDefined();
  });

  it('级别不够或写错的头和没有一样', async () => {
    const { admin } = await twoBabies();
    for (const level of [String(MULTI_BABY_CLIENT_LEVEL - 1), 'abc', '']) {
      expect((await sync(admin.token, [], { [CLIENT_LEVEL_HEADER]: level })).status).toBe(426);
    }
  });

  it('第二个宝宝删了也照样挡：删除可以撤销，它的记录还在', async () => {
    const { admin, second } = await twoBabies();
    expect((await syncNew(admin.token, [baby(second, { createdAt: 5000 }, true)])).status).toBe(
      200,
    );
    expect((await sync(admin.token)).status).toBe(426);
  });

  it('旧版的长轮询不说有新内容，等满一轮：否则它会马上来同步、失败、再来', async () => {
    const { admin } = await twoBabies();
    const started = Date.now();
    const old = await call<{ changed: boolean }>(app, 'GET', '/v1/sync/wait?cursor=0', {
      token: admin.token,
    });
    expect(old.json).toEqual({ changed: false });
    expect(Date.now() - started).toBeGreaterThanOrEqual(LONG_POLL.timeoutMs - 20);
    const fresh = await call<{ changed: boolean }>(app, 'GET', '/v1/sync/wait?cursor=0', {
      token: admin.token,
      headers: NEW_APP,
    });
    expect(fresh.json).toEqual({ changed: true });
  });

  it('同一次同步里刚加了第二个宝宝：旧版这一轮也拿不到它的记录', async () => {
    const { admin, family } = await newFamily(app);
    await sync(admin.token, [baby(family.id)]);
    const second = randomUUID();
    // 新版在旧版开始同步之后、读记录之前提交：用旧版自己的请求触发不了，这里直接模拟“读到时已经有两份”。
    const feed = change('event', { type: 'feed', at: Date.now(), ml: 60, babyId: second });
    const both = await sync(admin.token, [baby(second, { createdAt: 5000 }), feed]);
    // 这个请求开始时只有一份档案，改动照常写进去；读完再查一次，已经有两份了，不把记录发给旧版。
    expect(both.status).toBe(426);
    expect(await stored(second)).toBeDefined();
    expect(await stored(feed.id)).toBeDefined();
  });
});

describe('createdAt 只在建档时定一次', () => {
  it('已经有档案时，新档案不带 createdAt 就拒绝，不入库', async () => {
    const { admin, family } = await newFamily(app);
    await sync(admin.token, [baby(family.id)]);
    const id = randomUUID();
    const result = await syncNew(admin.token, [baby(id)]);
    expect(result.json.rejected).toEqual([{ id, reason: 'invalid' }]);
    expect(await stored(id)).toBeUndefined();
    // 格式坏了被 zod 丢掉，和没写一样。
    const broken = randomUUID();
    const junk = await syncNew(admin.token, [baby(broken, { createdAt: 'yesterday' })]);
    expect(junk.json.rejected).toEqual([{ id: broken, reason: 'invalid' }]);
    // 删除标记也一样：它照样参与排序。
    const deleted = randomUUID();
    const marker = await syncNew(admin.token, [change('baby', {}, deleted, true)]);
    expect(marker.json.rejected).toEqual([{ id: deleted, reason: 'invalid' }]);
  });

  it('后加的宝宝被改丢了 createdAt（旧版保存、删除标记）时补回去', async () => {
    const { admin, second } = await twoBabies();
    expect((await syncNew(admin.token, [baby(second, { name: '改名' })])).json.rejected).toEqual(
      [],
    );
    expect(await stored(second)).toMatchObject({ name: '改名', createdAt: 5000 });
    expect((await syncNew(admin.token, [change('baby', {}, second, true)])).json.rejected).toEqual(
      [],
    );
    expect(await stored(second)).toEqual({ createdAt: 5000 });
  });

  it('谁也改不了 createdAt：第一个宝宝写不上，后加的宝宝改不早', async () => {
    const { admin, first, second } = await twoBabies();
    await syncNew(admin.token, [baby(first, { createdAt: 9000 }), baby(second, { createdAt: 1 })]);
    expect(await stored(first)).not.toHaveProperty('createdAt');
    expect((await stored(second))?.createdAt).toBe(5000);
  });

  it('建档页的档案比后加的宝宝晚传上来（同一批里排在后面）也收，它还是第一个宝宝', async () => {
    const { admin, family } = await newFamily(app);
    const second = randomUUID();
    const result = await syncNew(admin.token, [
      baby(second, { name: '二宝', createdAt: 5000 }),
      baby(family.id, { name: '大宝' }),
    ]);
    expect(result.json.rejected).toEqual([]);
    expect(await stored(family.id)).not.toHaveProperty('createdAt');
    const created = await call<CreateShareResponse>(app, 'POST', '/v1/shares/timeline', {
      token: admin.token,
      body: { fromAt: FROM, toAt: FROM + DAY, timezone: TZ },
    });
    const page = await call<PublicTimelineResponse>(app, 'POST', '/v1/public/share/timeline', {
      body: { token: created.json.token },
    });
    expect(page.json.baby.name).toBe('大宝');
  });
});

describe('v0.1.0 之前各建了一份档案的家庭', () => {
  it('两份档案都没有 createdAt（没有加过宝宝）时不挡旧版：挡了也没有新版可换', async () => {
    const { admin, family } = await newFamily(app);
    await sync(admin.token, [baby(family.id)]);
    // 现在的服务端不收这样的第二份，直接写进库里，模拟那时留下的数据。
    await db.sql`
      INSERT INTO records (id, family_id, collection, data, deleted, updated_at_client, seq)
      VALUES (${randomUUID()}, ${family.id}, 'baby', ${db.sql.json({ name: '虚构宝宝', birthAt: 1 })},
              false, ${nextVersion()}, 0)`;
    expect((await sync(admin.token)).status).toBe(200);
  });
});

describe('地区', () => {
  it('其他家人保存哪个宝宝的档案，就换回那个宝宝的地区', async () => {
    const { admin, first, second } = await twoBabies('SG');
    await syncNew(admin.token, [baby(second, { region: 'US', createdAt: 5000 })]);
    const mom = await join(app, admin.token, 'caregiver', '妈妈');
    await syncNew(mom.token, [baby(second, { region: 'SG', name: '换头像' })]);
    expect(await stored(second)).toMatchObject({ region: 'US', name: '换头像' });
    await syncNew(mom.token, [baby(first, { region: 'US' })]);
    expect((await stored(first))?.region).toBe('SG');
  });

  it('其他家人加的宝宝用第一个宝宝的地区，不看最后改了哪份档案', async () => {
    const { admin, second } = await twoBabies('SG');
    // 二宝的档案后改，以前按 updated_at_client 取的就是它的地区。
    await syncNew(admin.token, [baby(second, { region: 'US', createdAt: 5000 })]);
    const mom = await join(app, admin.token, 'caregiver', '妈妈');
    const third = randomUUID();
    await syncNew(mom.token, [baby(third, { region: 'US', createdAt: 6000 })]);
    expect((await stored(third))?.region).toBe('SG');
  });

  it('推送的单位跟着第一个宝宝的地区', async () => {
    const { admin, second } = await twoBabies('US');
    await syncNew(admin.token, [baby(second, { region: 'SG', createdAt: 5000 })]);
    const mom = await join(app, admin.token, 'caregiver', '妈妈');
    await call(app, 'POST', '/v1/me/push-token', {
      token: mom.token,
      body: { token: 'ExponentPushToken[fictional-multi-baby]', deviceId: randomUUID() },
    });
    await call(app, 'PUT', '/v1/me/prefs', {
      token: mom.token,
      body: {
        feedReminder: true,
        familyNotify: true,
        quietNight: false,
        timezone: TZ,
        documentLock: false,
        videoWifiOnly: true,
      },
    });
    pushes = [];
    await syncNew(admin.token, [change('event', { type: 'temp', at: Date.now(), celsius: 38 })]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(pushes.map((p) => p.body)).toEqual(['体温 100.4°F']);
  });
});

describe('分享按宝宝区分', () => {
  const at = FROM + 10 * HOUR;
  const moment = (title: string, extra: Record<string, unknown> = {}) => ({
    title,
    text: '',
    at,
    milestone: false,
    media: [],
    ...extra,
  });

  /** 大宝的记录有的没写 babyId（第一步之前记的），有的写了；二宝的都写了。 */
  async function familyWithRecords() {
    const family = await twoBabies();
    const { admin, first, second } = family;
    const records = {
      firstLegacyFeed: change('event', { type: 'feed', at, ml: 90 }),
      firstFeed: change('event', { type: 'feed', at: at + 1, ml: 100, babyId: first }),
      secondFeed: change('event', { type: 'feed', at: at + 2, ml: 40, babyId: second }),
      firstMoment: change('moment', moment('大宝的一刻')),
      secondMoment: change('moment', moment('二宝的一刻', { babyId: second })),
    };
    expect((await syncNew(admin.token, Object.values(records))).json.rejected).toEqual([]);
    return { ...family, records };
  }

  const createDay = (token: string, extra: Record<string, unknown> = {}) =>
    call<CreateShareResponse>(app, 'POST', '/v1/shares', {
      token,
      headers: NEW_APP,
      body: {
        fromAt: FROM,
        toAt: FROM + DAY,
        timezone: TZ,
        units,
        include: { moments: true, daily: true, health: true },
        ...extra,
      },
    });
  const openDay = (token: string) =>
    call<PublicShareResponse>(app, 'POST', '/v1/public/share', { body: { token } });
  const openTimeline = (token: string) =>
    call<PublicTimelineResponse>(app, 'POST', '/v1/public/share/timeline', { body: { token } });
  const openMoment = (token: string, momentId: string) =>
    call<PublicTimelineMomentResponse>(app, 'POST', '/v1/public/share/timeline/moment', {
      body: { token, momentId },
    });

  it('旧版 App 建的一天（没有 babyId）是第一个宝宝的：名字、天数和记录都只有它的', async () => {
    const { admin } = await familyWithRecords();
    const created = await createDay(admin.token);
    expect(created.status).toBe(201);
    const page = await openDay(created.json.token);
    expect(page.json.baby.name).toBe('大宝');
    expect(page.json.baby.dayNumber).toBe(15);
    expect(page.json.events.map((e) => (e as { ml?: number }).ml)).toEqual([90, 100]);
    expect(page.json.moments.map((m) => m.title)).toEqual(['大宝的一刻']);
  });

  it('选了二宝的一天：二宝的名字、天数和记录', async () => {
    const { admin, second } = await familyWithRecords();
    const created = await createDay(admin.token, { babyId: second });
    const page = await openDay(created.json.token);
    expect(page.json.baby.name).toBe('二宝');
    expect(page.json.baby.dayNumber).toBe(6);
    expect(page.json.events.map((e) => (e as { ml?: number }).ml)).toEqual([40]);
    expect(page.json.moments.map((m) => m.title)).toEqual(['二宝的一刻']);
    const list = await call<ShareListResponse>(app, 'GET', '/v1/shares', { token: admin.token });
    expect(list.json.shares.find((s) => s.id === created.json.id)?.babyId).toBe(second);
  });

  it('时间线和选中的回忆：只有链接那个宝宝的，别的宝宝的回忆点开也是失效', async () => {
    const { admin, second, records } = await familyWithRecords();
    const timeline = await call<CreateShareResponse>(app, 'POST', '/v1/shares/timeline', {
      token: admin.token,
      body: { fromAt: FROM, toAt: FROM + DAY, timezone: TZ, babyId: second },
    });
    const page = await openTimeline(timeline.json.token);
    expect(page.json.baby.name).toBe('二宝');
    expect(page.json.entries.map((e) => e.title)).toEqual(['二宝的一刻']);
    expect((await openMoment(timeline.json.token, records.firstMoment.id)).status).toBe(404);

    // 旧版 App 建的（没有 babyId），选进了二宝的回忆也不发。
    const legacy = await call<CreateShareResponse>(app, 'POST', '/v1/shares/moments', {
      token: admin.token,
      body: {
        momentIds: [records.firstMoment.id, records.secondMoment.id],
        fromAt: at,
        toAt: at + 1,
        timezone: TZ,
      },
    });
    const picked = await openTimeline(legacy.json.token);
    expect(picked.json.baby.name).toBe('大宝');
    expect(picked.json.entries.map((e) => e.title)).toEqual(['大宝的一刻']);
    expect((await openMoment(legacy.json.token, records.secondMoment.id)).status).toBe(404);
  });

  it('不按最后改了哪份档案选：二宝的档案后改，旧链接还是大宝', async () => {
    const { admin, second } = await familyWithRecords();
    const created = await createDay(admin.token);
    await syncNew(admin.token, [baby(second, { name: '二宝改名', createdAt: 5000 })]);
    expect((await openDay(created.json.token)).json.baby.name).toBe('大宝');
  });
});
