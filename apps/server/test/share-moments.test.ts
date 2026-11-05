import { randomUUID } from 'node:crypto';
import type {
  CreateShareResponse,
  PublicShareResponse,
  PublicTimelineMomentResponse,
  PublicTimelineResponse,
  ShareListResponse,
  SyncResponse,
} from '@xiaodouya/shared';
import { MAX_ACTIVE_SHARES, TIMELINE_PAGE_SIZE } from '@xiaodouya/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import {
  type App,
  call,
  join,
  newFamily,
  newUser,
  OBJECT_BYTES,
  openTestDb,
  type TestDb,
  upload,
} from './harness';

/**
 * 分享回忆（F-136）：选一段或几段回忆发出去。走时间线的两个公开接口，只是按选中的 id 查，不按时间范围。
 * 真实的 Postgres 和 S3 兼容服务，所有名字和内容都是虚构的。
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const TZ = 'Asia/Singapore';
// 2026-06-15 在新加坡的 0 点。
const FROM = Date.UTC(2026, 5, 14, 16);
const units = { volume: 'ml', temperature: 'c', weight: 'kg', length: 'cm' };
const MISS = { error: { code: 'share_unavailable', message: '这个链接已失效或已撤销' } };
const TIMELINE_PATH = '/v1/public/share/timeline';
const MOMENT_PATH = '/v1/public/share/timeline/moment';

let db: TestDb;
let app: App;

beforeAll(async () => {
  db = await openTestDb('share_moments');
  app = createApp({ sql: db.sql, config: db.config });
});
afterAll(async () => {
  await db.close();
});

const changeOf = (
  collection: string,
  data: unknown,
  id: string = randomUUID(),
  deleted = false,
) => ({ id, collection, data, deleted, updatedAt: Date.now() });

async function sync(token: string, changes: ReturnType<typeof changeOf>[]) {
  const result = await call<SyncResponse>(app, 'POST', '/v1/sync', {
    token,
    body: { cursor: 0, changes },
  });
  expect(result.status).toBe(200);
  expect(result.json.rejected).toEqual([]);
}

const babyData = { name: '测试豆', birthAt: Date.UTC(2026, 5, 1, 15, 30) };

async function familyWithBaby(label = '爸爸') {
  const { admin, family } = await newFamily(app, label);
  await sync(admin.token, [changeOf('baby', babyData, family.id)]);
  return { admin, family };
}

const ref = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  kind: 'image',
  mime: 'image/jpeg',
  size: OBJECT_BYTES.length,
  ...extra,
});

const moment = (at: number, extra: Record<string, unknown> = {}) => ({
  title: '虚构回忆',
  text: '',
  at,
  milestone: false,
  media: [],
  ...extra,
});

async function createMoments(
  token: string,
  momentIds: string[],
  overrides: Record<string, unknown> = {},
) {
  return call<CreateShareResponse>(app, 'POST', '/v1/shares/moments', {
    token,
    body: { momentIds, fromAt: FROM, toAt: FROM + DAY, timezone: TZ, ...overrides },
  });
}

async function momentsToken(token: string, momentIds: string[]) {
  const created = await createMoments(token, momentIds);
  expect(created.status).toBe(201);
  return created.json;
}

const openPage = (token: unknown, cursor?: string, target: App = app) =>
  call<PublicTimelineResponse>(target, 'POST', TIMELINE_PATH, {
    body: cursor === undefined ? { token } : { token, cursor },
  });

const openMoment = (token: unknown, momentId: string, target: App = app) =>
  call<PublicTimelineMomentResponse>(target, 'POST', MOMENT_PATH, {
    body: { token, momentId },
  });

const openDay = (token: unknown) =>
  call<PublicShareResponse>(app, 'POST', '/v1/public/share', { body: { token } });

async function expectAllMiss(token: string, momentId: string) {
  for (const result of [
    await openPage(token),
    await openMoment(token, momentId),
    await openDay(token),
  ]) {
    expect(result.status).toBe(404);
    expect(result.json).toEqual(MISS);
  }
}

describe('创建', () => {
  it('管理员和一起记录的家人能创建，只看回忆的家人和没有家庭的人不能', async () => {
    const { admin } = await familyWithBaby();
    const caregiver = await join(app, admin.token, 'caregiver', '妈妈');
    const viewer = await join(app, admin.token, 'viewer', '奶奶');
    const loner = await newUser(app);
    const id = randomUUID();
    await sync(admin.token, [changeOf('moment', moment(FROM), id)]);
    const created = await createMoments(admin.token, [id]);
    expect(created.status).toBe(201);
    expect(created.json.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await createMoments(caregiver.token, [id])).status).toBe(201);
    expect((await createMoments(viewer.token, [id])).status).toBe(403);
    expect((await createMoments(loner.token, [id])).status).toBe(403);
    const [row] = await db.sql`
      SELECT kind, include_moments, include_daily, include_health, moment_ids
      FROM shares WHERE id = ${created.json.id}`;
    expect(row).toEqual({
      kind: 'moments',
      include_moments: true,
      include_daily: false,
      include_health: false,
      moment_ids: [id],
    });
  });

  it('要选至少一段，id 要是 UUID 不能重复；范围和时区照样要对', async () => {
    const { admin } = await familyWithBaby();
    const id = randomUUID();
    expect((await createMoments(admin.token, [])).status).toBe(400);
    expect((await createMoments(admin.token, ['abc'])).status).toBe(400);
    expect((await createMoments(admin.token, [id, id])).status).toBe(400);
    expect((await createMoments(admin.token, [id], { toAt: FROM })).status).toBe(400);
    expect((await createMoments(admin.token, [id], { timezone: 'Mars/Olympus' })).status).toBe(400);
    // 还没传到服务器的回忆也能先建：之后传上来就看得到（下面“现查现发”）。
    expect((await createMoments(admin.token, [randomUUID()])).status).toBe(201);
  });

  it('列表里写着 moments 和选中的回忆，不带令牌', async () => {
    const { admin } = await familyWithBaby();
    const ids = [randomUUID(), randomUUID()];
    const created = await momentsToken(admin.token, ids);
    const list = await call<ShareListResponse>(app, 'GET', '/v1/shares', { token: admin.token });
    const found = list.json.shares.find((share) => share.id === created.id);
    expect(found).toMatchObject({
      kind: 'moments',
      fromAt: FROM,
      toAt: FROM + DAY,
      timezone: TZ,
      include: { moments: true, daily: false, health: false },
      byLabel: '爸爸',
      canRevoke: true,
    });
    expect(found?.momentIds).toEqual(ids);
    expect(list.text).not.toContain(created.token);
  });

  it('和一天、时间线的链接共用一个家庭的上限', async () => {
    const { admin, family } = await familyWithBaby();
    await db.sql`
      INSERT INTO shares (id, family_id, created_by, token_hash, from_at, to_at, timezone,
                          include_moments, include_daily, include_health, units, expires_at)
      SELECT gen_random_uuid(), ${family.id}, ${admin.user.id}, md5(random()::text) || g, ${FROM}, ${FROM + DAY},
             ${TZ}, true, true, false, ${db.sql.json(units)}, now() + interval '1 day'
      FROM generate_series(1, ${MAX_ACTIVE_SHARES - 1}) g`;
    expect((await createMoments(admin.token, [randomUUID()])).status).toBe(201);
    const full = await createMoments(admin.token, [randomUUID()]);
    expect(full.status).toBe(409);
    expect(full.text).toContain('share_limit');
  });

  it('要登录，地址不开 CORS', async () => {
    expect((await createMoments('nope', [randomUUID()])).status).toBe(401);
    const preflight = await app.request('/v1/shares/moments', {
      method: 'OPTIONS',
      headers: { origin: 'https://share.fictional.test', 'access-control-request-method': 'POST' },
    });
    expect(preflight.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('公开接口：只有选中的回忆', () => {
  it('不管时间隔多远都在；没选的、信、证件、别家的、删掉的都不发，记录和生日也不发', async () => {
    const { admin, family } = await familyWithBaby();
    const other = await familyWithBaby();
    const early = randomUUID();
    const late = randomUUID();
    const between = randomUUID();
    const letter = randomUUID();
    const deleted = randomUUID();
    const othersMoment = randomUUID();
    const docId = randomUUID();
    await sync(admin.token, [
      changeOf('moment', moment(FROM, { title: '很早的', text: '第一段' }), early),
      changeOf('moment', moment(FROM + 40 * DAY, { title: '很晚的', milestone: true }), late),
      changeOf('moment', moment(FROM + 10 * DAY, { title: '没选的中间那段' }), between),
      changeOf('letter', { title: '信', text: '信的内容', at: FROM + HOUR }, letter),
      changeOf('moment', moment(FROM + 2 * HOUR, { title: '删掉的' }), deleted, true),
      changeOf('event', { type: 'feed', at: FROM + HOUR, ml: 90, note: '喂奶备注' }),
      changeOf('document', { name: '证件', files: [] }, docId),
    ]);
    await sync(other.admin.token, [
      changeOf('moment', moment(FROM + HOUR, { title: '别家的' }), othersMoment),
    ]);
    const { token } = await momentsToken(admin.token, [
      late,
      early,
      letter,
      deleted,
      othersMoment,
      docId,
    ]);
    const result = await openPage(token);
    expect(result.status).toBe(200);
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect(result.json.kind).toBe('moments');
    expect(result.json.entries.map((e) => [e.id, e.title, e.milestone])).toEqual([
      [late, '很晚的', true],
      [early, '很早的', false],
    ]);
    expect(result.json.entries[1]).toMatchObject({ dayNumber: 15, text: '第一段' });
    expect(result.json.nextCursor).toBeNull();
    // 范围是现在还在的选中回忆的头尾，不是创建时手机算的。
    expect(result.json.range).toEqual({ fromAt: FROM, toAt: FROM + 40 * DAY + 1, timezone: TZ });
    expect(result.json.baby.name).toBe('测试豆');
    for (const hidden of [
      '没选的中间那段',
      '信的内容',
      '删掉的',
      '别家的',
      '喂奶备注',
      String(babyData.birthAt),
      family.id,
      admin.user.id,
    ]) {
      expect(result.text).not.toContain(hidden);
    }
  });

  it('现查现发：建链接时还没传上来的之后会出现，删掉的会消失，改了时间也还在', async () => {
    const { admin } = await familyWithBaby();
    const kept = randomUUID();
    const later = randomUUID();
    await sync(admin.token, [changeOf('moment', moment(FROM, { title: '先有的' }), kept)]);
    const { token } = await momentsToken(admin.token, [kept, later]);
    expect((await openPage(token)).json.entries.map((e) => e.title)).toEqual(['先有的']);
    await sync(admin.token, [changeOf('moment', moment(FROM + HOUR, { title: '后传的' }), later)]);
    expect((await openPage(token)).json.entries.map((e) => e.title)).toEqual(['后传的', '先有的']);
    await sync(admin.token, [
      changeOf('moment', moment(FROM + 90 * DAY, { title: '改了时间' }), kept),
      changeOf('moment', moment(FROM + HOUR, { title: '后传的' }), later, true),
    ]);
    const after = await openPage(token);
    expect(after.json.entries.map((e) => e.title)).toEqual(['改了时间']);
  });

  it('选中的都不在了：空的一页，范围用创建时的', async () => {
    const { admin } = await familyWithBaby();
    const { token } = await momentsToken(admin.token, [randomUUID()]);
    const result = await openPage(token);
    expect(result.status).toBe(200);
    expect(result.json.entries).toEqual([]);
    expect(result.json.nextCursor).toBeNull();
    expect(result.json.range).toEqual({ fromAt: FROM, toAt: FROM + DAY, timezone: TZ });
  });

  it('选得多时按页取，同一毫秒的也不漏不重', async () => {
    const { admin } = await familyWithBaby();
    const count = TIMELINE_PAGE_SIZE + 5;
    const ids = Array.from({ length: count }, () => randomUUID());
    await sync(
      admin.token,
      ids.map((id, i) => changeOf('moment', moment(FROM + Math.floor(i / 3) * HOUR), id)),
    );
    const { token } = await momentsToken(admin.token, ids);
    const first = await openPage(token);
    expect(first.json.entries).toHaveLength(TIMELINE_PAGE_SIZE);
    expect(first.json.nextCursor).not.toBeNull();
    const second = await openPage(token, first.json.nextCursor!);
    expect(second.json.nextCursor).toBeNull();
    const seen = [...first.json.entries, ...second.json.entries].map((e) => e.id);
    expect(new Set(seen).size).toBe(count);
    expect(new Set(seen)).toEqual(new Set(ids));
  });

  it('封面照片发预览不发原图', async () => {
    const { admin } = await familyWithBaby();
    const photo = await upload(app, admin.token);
    await upload(app, admin.token, { id: photo, variant: 'thumb' });
    await upload(app, admin.token, { id: photo, variant: 'preview' });
    const id = randomUUID();
    await sync(admin.token, [changeOf('moment', moment(FROM, { media: [ref(photo)] }), id)]);
    const { token } = await momentsToken(admin.token, [id]);
    const result = await openPage(token);
    expect(result.json.entries[0]!.cover!.url).toContain(`${photo}/preview`);
    expect(result.text).not.toContain(`${photo}/original`);
  });
});

describe('公开接口：点开一条回忆', () => {
  it('选中的能点开，取到全部文件', async () => {
    const { admin } = await familyWithBaby();
    const photo = await upload(app, admin.token);
    const audio = await upload(app, admin.token, { mime: 'audio/mp4' });
    const id = randomUUID();
    await sync(admin.token, [
      changeOf(
        'moment',
        moment(FROM, { media: [ref(photo), ref(audio, { kind: 'audio', durationMs: 3_000 })] }),
        id,
      ),
    ]);
    const { token } = await momentsToken(admin.token, [id]);
    const result = await openMoment(token, id);
    expect(result.status).toBe(200);
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect(result.json.media.map((m) => [m.id, m.kind])).toEqual([
      [photo, 'image'],
      [audio, 'audio'],
    ]);
  });

  it('同一天没选的、信、删掉的、别家的（哪怕写进了选中的 id）、不存在的都打不开', async () => {
    const { admin } = await familyWithBaby();
    const other = await familyWithBaby();
    const chosen = randomUUID();
    const sameDay = randomUUID();
    const letter = randomUUID();
    const deleted = randomUUID();
    const othersMoment = randomUUID();
    await sync(admin.token, [
      changeOf('moment', moment(FROM), chosen),
      changeOf('moment', moment(FROM + HOUR), sameDay),
      changeOf('letter', { title: '信', text: '信的内容', at: FROM + HOUR }, letter),
      changeOf('moment', moment(FROM + HOUR), deleted, true),
    ]);
    await sync(other.admin.token, [changeOf('moment', moment(FROM + HOUR), othersMoment)]);
    const { token } = await momentsToken(admin.token, [chosen, letter, deleted, othersMoment]);
    expect((await openMoment(token, chosen)).status).toBe(200);
    for (const id of [sameDay, letter, deleted, othersMoment, randomUUID()]) {
      const result = await openMoment(token, id);
      expect(result.status, id).toBe(404);
      expect(result.json).toEqual(MISS);
    }
  });
});

describe('公开接口：三种链接互不混用，旧的照常', () => {
  it('回忆的令牌打不开一天；一天的令牌打不开回忆的接口；时间线还是 timeline', async () => {
    const { admin } = await familyWithBaby();
    const id = randomUUID();
    await sync(admin.token, [changeOf('moment', moment(FROM + HOUR), id)]);
    const moments = await momentsToken(admin.token, [id]);
    const asDay = await openDay(moments.token);
    expect(asDay.status).toBe(404);
    expect(asDay.json).toEqual(MISS);
    const day = await call<CreateShareResponse>(app, 'POST', '/v1/shares', {
      token: admin.token,
      body: { fromAt: FROM, toAt: FROM + DAY, timezone: TZ, units },
    });
    for (const result of [await openPage(day.json.token), await openMoment(day.json.token, id)]) {
      expect(result.status).toBe(404);
      expect(result.json).toEqual(MISS);
    }
    expect((await openDay(day.json.token)).status).toBe(200);
    const timeline = await call<CreateShareResponse>(app, 'POST', '/v1/shares/timeline', {
      token: admin.token,
      body: { fromAt: FROM, toAt: FROM + DAY, timezone: TZ },
    });
    const opened = await openPage(timeline.json.token);
    expect(opened.json.kind).toBe('timeline');
    expect(opened.json.range).toEqual({ fromAt: FROM, toAt: FROM + DAY, timezone: TZ });
  });
});

describe('公开接口：什么时候失效', () => {
  async function liveMoments() {
    const { admin } = await familyWithBaby();
    const caregiver = await join(app, admin.token, 'caregiver', '妈妈');
    const id = randomUUID();
    await sync(admin.token, [changeOf('moment', moment(FROM), id)]);
    const created = await momentsToken(caregiver.token, [id]);
    expect((await openPage(created.token)).status).toBe(200);
    expect((await openMoment(created.token, id)).status).toBe(200);
    return { admin, caregiver, created, id };
  }

  it('撤销后都打不开', async () => {
    const { admin, created, id } = await liveMoments();
    expect(
      (await call(app, 'DELETE', `/v1/shares/${created.id}`, { token: admin.token })).status,
    ).toBe(200);
    await expectAllMiss(created.token, id);
  });

  it('过期', async () => {
    const { created, id } = await liveMoments();
    await db.sql`UPDATE shares SET expires_at = now() - interval '1 second' WHERE id = ${created.id}`;
    await expectAllMiss(created.token, id);
  });

  it('创建者降为只看回忆后失效', async () => {
    const { admin, caregiver, created, id } = await liveMoments();
    const path = `/v1/family/members/${caregiver.user.id}`;
    expect(
      (await call(app, 'PATCH', path, { token: admin.token, body: { role: 'viewer' } })).status,
    ).toBe(200);
    await expectAllMiss(created.token, id);
  });
});

describe('公开接口：日志', () => {
  it('成功和失效时，日志里都没有令牌和签名链接', async () => {
    const lines: string[] = [];
    const capture = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
    const spies = [
      vi.spyOn(console, 'log').mockImplementation(capture),
      vi.spyOn(console, 'warn').mockImplementation(capture),
      vi.spyOn(console, 'error').mockImplementation(capture),
    ];
    try {
      const { admin } = await familyWithBaby();
      const file = await upload(app, admin.token);
      const id = randomUUID();
      await sync(admin.token, [changeOf('moment', moment(FROM, { media: [ref(file)] }), id)]);
      const { token } = await momentsToken(admin.token, [id]);
      expect((await openPage(token)).status).toBe(200);
      expect((await openMoment(token, id)).status).toBe(200);
      await openMoment(token, randomUUID());
      await openDay(token);
      const text = lines.join('\n');
      expect(text).not.toContain(token);
      expect(text).not.toContain('X-Amz');
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
