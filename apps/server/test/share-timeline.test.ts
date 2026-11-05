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

/** 分享时间线（F-133）。真实的 Postgres 和 S3 兼容服务，所有名字和内容都是虚构的。 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const TZ = 'Asia/Singapore';
// 2026-06-15 在新加坡的 0 点，范围是之后的 30 天。
const FROM = Date.UTC(2026, 5, 14, 16);
const TO = FROM + 30 * DAY;
const units = { volume: 'ml', temperature: 'c', weight: 'kg', length: 'cm' };
const MISS = { error: { code: 'share_unavailable', message: '这个链接已失效或已撤销' } };
const TIMELINE_PATH = '/v1/public/share/timeline';
const MOMENT_PATH = '/v1/public/share/timeline/moment';

let db: TestDb;
let app: App;

beforeAll(async () => {
  db = await openTestDb('share_timeline');
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

async function createTimeline(
  token: string,
  overrides: Record<string, unknown> = {},
  target: App = app,
) {
  return call<CreateShareResponse>(target, 'POST', '/v1/shares/timeline', {
    token,
    body: { fromAt: FROM, toAt: TO, timezone: TZ, ...overrides },
  });
}

async function timelineToken(token: string, overrides: Record<string, unknown> = {}) {
  const created = await createTimeline(token, overrides);
  expect(created.status).toBe(201);
  return created.json;
}

const openTimeline = (token: unknown, cursor?: string, target: App = app) =>
  call<PublicTimelineResponse>(target, 'POST', TIMELINE_PATH, {
    body: cursor === undefined ? { token } : { token, cursor },
  });

const openMoment = (token: unknown, momentId: string, target: App = app) =>
  call<PublicTimelineMomentResponse>(target, 'POST', MOMENT_PATH, {
    body: { token, momentId },
  });

const openDay = (token: unknown) =>
  call<PublicShareResponse>(app, 'POST', '/v1/public/share', { body: { token } });

/** 一个链接的三个入口都打不开，响应和不存在的链接完全一样。 */
async function expectAllMiss(token: string, momentId: string) {
  for (const result of [
    await openTimeline(token),
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
    const created = await createTimeline(admin.token);
    expect(created.status).toBe(201);
    expect(created.json.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await createTimeline(caregiver.token)).status).toBe(201);
    expect((await createTimeline(viewer.token)).status).toBe(403);
    expect((await createTimeline(loner.token)).status).toBe(403);
    const [row] = await db.sql`
      SELECT kind, include_moments, include_daily, include_health FROM shares WHERE id = ${created.json.id}`;
    expect(row).toEqual({
      kind: 'timeline',
      include_moments: true,
      include_daily: false,
      include_health: false,
    });
  });

  it('一段日期和“全部”都能建；结束要晚于开始，也不能晚于明天以后', async () => {
    const { admin } = await familyWithBaby();
    expect((await createTimeline(admin.token, { fromAt: FROM, toAt: FROM + DAY })).status).toBe(
      201,
    );
    expect((await createTimeline(admin.token, { fromAt: 0 })).status).toBe(201);
    expect((await createTimeline(admin.token, { fromAt: FROM - 400 * DAY })).status).toBe(201);
    expect((await createTimeline(admin.token, { toAt: FROM })).status).toBe(400);
    expect((await createTimeline(admin.token, { timezone: 'Mars/Olympus' })).status).toBe(400);
    expect((await createTimeline(admin.token, { ttlDays: 2 })).status).toBe(400);
    const now = Date.now();
    expect((await createTimeline(admin.token, { fromAt: 0, toAt: now + DAY })).status).toBe(201);
    // 不让链接一直跟着往后看：之后新记的回忆不该自己跑进已经发出去的链接。
    expect((await createTimeline(admin.token, { fromAt: 0, toAt: now + 3 * DAY })).status).toBe(
      400,
    );
  });

  it('列表里分得清是一天还是时间线，旧的一天也写着 day', async () => {
    const { admin } = await familyWithBaby();
    const day = await call<CreateShareResponse>(app, 'POST', '/v1/shares', {
      token: admin.token,
      body: { fromAt: FROM, toAt: FROM + DAY, timezone: TZ, units },
    });
    const timeline = await timelineToken(admin.token, { fromAt: 0 });
    const list = await call<ShareListResponse>(app, 'GET', '/v1/shares', { token: admin.token });
    const byId = new Map(list.json.shares.map((share) => [share.id, share]));
    expect(byId.get(day.json.id)).toMatchObject({ kind: 'day', fromAt: FROM });
    expect(byId.get(timeline.id)).toMatchObject({
      kind: 'timeline',
      fromAt: 0,
      toAt: TO,
      timezone: TZ,
      include: { moments: true, daily: false, health: false },
      byLabel: '爸爸',
      canRevoke: true,
    });
    expect(list.text).not.toContain(timeline.token);
  });

  it('和一天的链接共用一个家庭的上限', async () => {
    const { admin, family } = await familyWithBaby();
    await db.sql`
      INSERT INTO shares (id, family_id, created_by, token_hash, from_at, to_at, timezone,
                          include_moments, include_daily, include_health, units, expires_at)
      SELECT gen_random_uuid(), ${family.id}, ${admin.user.id}, md5(random()::text) || g, ${FROM}, ${FROM + DAY},
             ${TZ}, true, true, false, ${db.sql.json(units)}, now() + interval '1 day'
      FROM generate_series(1, ${MAX_ACTIVE_SHARES - 1}) g`;
    expect((await createTimeline(admin.token)).status).toBe(201);
    const full = await createTimeline(admin.token);
    expect(full.status).toBe(409);
    expect(full.text).toContain('share_limit');
  });

  it('要登录，地址不开 CORS', async () => {
    expect((await createTimeline('nope')).status).toBe(401);
    const preflight = await app.request('/v1/shares/timeline', {
      method: 'OPTIONS',
      headers: { origin: 'https://share.fictional.test', 'access-control-request-method': 'POST' },
    });
    expect(preflight.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('公开接口：范围和内容', () => {
  it('只有 [from, to) 里的回忆；记录、信、证件、宝宝生日、家庭和用户 id 都不发', async () => {
    const { admin, family } = await familyWithBaby();
    const inside = randomUUID();
    await sync(admin.token, [
      changeOf(
        'moment',
        moment(FROM, { title: '开头', byName: '妈妈', extra: '不该出现' }),
        inside,
      ),
      changeOf('moment', moment(TO - 1, { title: '结尾', text: '虚构的一段话', milestone: true })),
      changeOf('moment', moment(FROM - 1, { title: '早了一毫秒' })),
      changeOf('moment', moment(TO, { title: '晚了一毫秒' })),
      changeOf('event', { type: 'feed', at: FROM + HOUR, ml: 90, note: '喂奶的备注' }),
      changeOf('event', { type: 'temp', at: FROM + HOUR, celsius: 38.6 }),
      changeOf('letter', { title: '写给宝宝的信', text: '信的内容', at: FROM + HOUR }),
      changeOf('document', { name: '证件标题', number: 'FAKE-0001', files: [], at: FROM + HOUR }),
    ]);
    const { token } = await timelineToken(admin.token);
    const result = await openTimeline(token);
    expect(result.status).toBe(200);
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect(result.json.kind).toBe('timeline');
    expect(result.json.entries.map((e) => e.title)).toEqual(['结尾', '开头']);
    expect(result.json.entries[1]).toEqual({
      id: inside,
      at: FROM,
      title: '开头',
      text: '',
      milestone: false,
      byName: '妈妈',
      dayNumber: 15,
      age: { months: 0, days: 14 },
      cover: null,
      visualCount: 0,
      audioCount: 0,
    });
    expect(result.json.entries[0]).toMatchObject({ milestone: true, text: '虚构的一段话' });
    expect(result.json.range).toEqual({ fromAt: FROM, toAt: TO, timezone: TZ });
    expect(result.json.baby).toEqual({ name: '测试豆', age: { months: 1, days: 13 } });
    expect(result.json.nextCursor).toBeNull();
    for (const secret of [
      '不该出现',
      '喂奶的备注',
      '38.6',
      '写给宝宝的信',
      '信的内容',
      '证件标题',
      'FAKE-0001',
      family.id,
      admin.user.id,
      String(babyData.birthAt),
      'birthAt',
      'events',
      'units',
    ]) {
      expect(result.text, secret).not.toContain(secret);
    }
  });

  it('新的在前，按页取，每页最多一页的条数，同一毫秒的也不漏不重', async () => {
    const { admin } = await familyWithBaby();
    const total = TIMELINE_PAGE_SIZE * 2 + 5;
    const changes = Array.from({ length: total }, (_, i) =>
      // 每三条同一个时刻，翻页的游标要靠 id 分开它们。
      changeOf('moment', moment(FROM + Math.floor(i / 3) * HOUR, { title: `第 ${i} 段` })),
    );
    await sync(admin.token, changes);
    const { token } = await timelineToken(admin.token);
    const pages: PublicTimelineResponse[] = [];
    let cursor: string | undefined;
    do {
      const page = await openTimeline(token, cursor);
      expect(page.status).toBe(200);
      pages.push(page.json);
      cursor = page.json.nextCursor ?? undefined;
    } while (cursor && pages.length < 10);
    expect(pages.map((p) => p.entries.length)).toEqual([TIMELINE_PAGE_SIZE, TIMELINE_PAGE_SIZE, 5]);
    const seen = pages.flatMap((p) => p.entries);
    expect(new Set(seen.map((e) => e.id)).size).toBe(total);
    expect(new Set(seen.map((e) => e.id))).toEqual(new Set(changes.map((c) => c.id)));
    const ats = seen.map((e) => e.at);
    expect(ats).toEqual([...ats].sort((a, b) => b - a));
  });

  it('空的回忆不发，但游标照样往后走，后面的还取得到', async () => {
    const { admin } = await familyWithBaby();
    const empty = Array.from({ length: TIMELINE_PAGE_SIZE + 2 }, (_, i) =>
      changeOf('moment', moment(FROM + DAY + i * HOUR, { title: '' })),
    );
    await sync(admin.token, [...empty, changeOf('moment', moment(FROM, { title: '最早的一段' }))]);
    const { token } = await timelineToken(admin.token);
    const first = await openTimeline(token);
    expect(first.json.entries).toEqual([]);
    expect(first.json.nextCursor).not.toBeNull();
    const second = await openTimeline(token, first.json.nextCursor!);
    expect(second.json.entries.map((e) => e.title)).toEqual(['最早的一段']);
    expect(second.json.nextCursor).toBeNull();
  });

  it('现查现发：之后补记的会出现，删掉的会消失，范围外的不会进来', async () => {
    const { admin } = await familyWithBaby();
    const gone = randomUUID();
    await sync(admin.token, [changeOf('moment', moment(FROM + HOUR, { title: '会删掉' }), gone)]);
    const { token } = await timelineToken(admin.token);
    await sync(admin.token, [
      changeOf('moment', moment(FROM + HOUR, { title: '会删掉' }), gone, true),
      changeOf('moment', moment(FROM + 2 * HOUR, { title: '后来补记' })),
      changeOf('moment', moment(TO + HOUR, { title: '范围外' })),
    ]);
    expect((await openTimeline(token)).json.entries.map((e) => e.title)).toEqual(['后来补记']);
  });

  it('“全部”从 0 开始也能打开，孕期的回忆没有月龄', async () => {
    const { admin } = await familyWithBaby();
    await sync(admin.token, [changeOf('moment', moment(Date.UTC(2026, 3, 1), { title: '孕期' }))]);
    const { token } = await timelineToken(admin.token, { fromAt: 0 });
    const result = await openTimeline(token);
    expect(result.json.entries).toHaveLength(1);
    expect(result.json.entries[0]!.age).toBeNull();
    expect(result.json.entries[0]!.dayNumber).toBeLessThan(1);
  });

  it('还没有宝宝档案时也能打开，名字留空', async () => {
    const { admin } = await newFamily(app);
    await sync(admin.token, [changeOf('moment', moment(FROM))]);
    const { token } = await timelineToken(admin.token);
    const result = await openTimeline(token);
    expect(result.json.baby).toEqual({ name: '', age: null });
    expect(result.json.entries[0]).toMatchObject({ dayNumber: null, age: null });
  });

  it('游标格式不对和链接失效是同一个回答', async () => {
    const { admin } = await familyWithBaby();
    const { token } = await timelineToken(admin.token);
    for (const cursor of ['nope', `1.${'x'.repeat(36)}`, '1']) {
      const result = await openTimeline(token, cursor);
      expect(result.status).toBe(404);
      expect(result.json).toEqual(MISS);
    }
  });
});

describe('公开接口：封面', () => {
  it('用设置的封面，照片发预览不发原图，每条只签封面的两个链接', async () => {
    const { admin } = await familyWithBaby();
    const first = await upload(app, admin.token);
    await upload(app, admin.token, { id: first, variant: 'thumb' });
    const cover = await upload(app, admin.token);
    await upload(app, admin.token, { id: cover, variant: 'thumb' });
    await upload(app, admin.token, { id: cover, variant: 'preview' });
    const audio = await upload(app, admin.token, { mime: 'audio/mp4' });
    await sync(admin.token, [
      changeOf(
        'moment',
        moment(FROM, {
          coverMediaId: cover,
          media: [ref(first), ref(cover), ref(audio, { kind: 'audio', mime: 'audio/mp4' })],
        }),
      ),
    ]);
    const { token } = await timelineToken(admin.token);
    const result = await openTimeline(token);
    const entry = result.json.entries[0]!;
    expect(entry.cover?.id).toBe(cover);
    expect(entry.cover?.kind).toBe('image');
    expect(entry.cover?.url).toContain(`${cover}/preview`);
    expect(entry.cover?.thumbUrl).toContain(`${cover}/thumb`);
    expect(entry).toMatchObject({ visualCount: 2, audioCount: 1 });
    expect(result.text).not.toContain(`${cover}/original`);
    expect(result.text).not.toContain(first);
    expect(result.text).not.toContain(audio);
    expect(result.text.match(/X-Amz-Signature/g)).toHaveLength(2);
    expect(result.json.mediaExpiresIn).toBe(3600);
    const download = await fetch(entry.cover!.thumbUrl!);
    expect(Buffer.from(await download.arrayBuffer()).equals(OBJECT_BYTES)).toBe(true);
  });

  it('封面没传完、指向录音或者被移除时，用第一个能显示的；视频当封面发原文件', async () => {
    const { admin } = await familyWithBaby();
    const video = randomUUID();
    await upload(app, admin.token, { id: video, mime: 'video/mp4' });
    await upload(app, admin.token, { id: video, variant: 'thumb' });
    const audio = await upload(app, admin.token, { mime: 'audio/mp4' });
    const pending = randomUUID();
    const started = await call(app, 'POST', '/v1/media/upload-url', {
      token: admin.token,
      body: { id: pending, scope: 'memory', variant: 'original', mime: 'image/jpeg', size: 10 },
    });
    expect(started.status).toBe(200);
    await sync(admin.token, [
      changeOf(
        'moment',
        moment(FROM + 2 * HOUR, {
          title: '没传完',
          coverMediaId: pending,
          media: [ref(pending), ref(video)],
        }),
      ),
      changeOf(
        'moment',
        moment(FROM + HOUR, {
          title: '录音',
          coverMediaId: audio,
          media: [ref(audio, { kind: 'audio' }), ref(video)],
        }),
      ),
      changeOf(
        'moment',
        moment(FROM, { title: '只有录音', media: [ref(audio, { kind: 'audio' })] }),
      ),
    ]);
    const { token } = await timelineToken(admin.token);
    const entries = (await openTimeline(token)).json.entries;
    expect(entries.map((e) => [e.title, e.cover?.id ?? null, e.visualCount, e.audioCount])).toEqual(
      [
        ['没传完', video, 1, 0],
        ['录音', video, 1, 1],
        ['只有录音', null, 0, 1],
      ],
    );
    expect(entries[0]!.cover).toMatchObject({ kind: 'video' });
    expect(entries[0]!.cover!.url).toContain(`${video}/original`);
  });

  it('回忆里写上证件、头像或别家的文件 id 也不会变成封面', async () => {
    const { admin } = await familyWithBaby();
    const other = await familyWithBaby();
    const docFile = await upload(app, admin.token, { scope: 'document' });
    const avatarFile = await upload(app, admin.token, { scope: 'avatar' });
    const otherFile = await upload(app, other.admin.token);
    await sync(admin.token, [
      changeOf(
        'moment',
        moment(FROM, {
          coverMediaId: docFile,
          media: [ref(docFile), ref(avatarFile), ref(otherFile)],
        }),
      ),
    ]);
    const { token } = await timelineToken(admin.token);
    const result = await openTimeline(token);
    expect(result.json.entries[0]).toMatchObject({ cover: null, visualCount: 0, audioCount: 0 });
    for (const id of [docFile, avatarFile, otherFile]) expect(result.text).not.toContain(id);
  });
});

describe('公开接口：点开一条回忆', () => {
  it('取到这条的全部文件：照片是预览，视频和录音是原文件', async () => {
    const { admin } = await familyWithBaby();
    const photo = await upload(app, admin.token);
    await upload(app, admin.token, { id: photo, variant: 'thumb' });
    await upload(app, admin.token, { id: photo, variant: 'preview' });
    const video = await upload(app, admin.token, { mime: 'video/mp4' });
    const audio = await upload(app, admin.token, { mime: 'audio/mp4' });
    const id = randomUUID();
    await sync(admin.token, [
      changeOf(
        'moment',
        moment(FROM, {
          media: [
            ref(photo, { width: 400, height: 300 }),
            ref(video, { kind: 'video', durationMs: 12_000 }),
            ref(audio, { kind: 'audio', durationMs: 3_000 }),
          ],
        }),
        id,
      ),
    ]);
    const { token } = await timelineToken(admin.token);
    const result = await openMoment(token, id);
    expect(result.status).toBe(200);
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect(result.json.media.map((m) => [m.id, m.kind])).toEqual([
      [photo, 'image'],
      [video, 'video'],
      [audio, 'audio'],
    ]);
    expect(result.json.media[0]).toMatchObject({ width: 400, height: 300 });
    expect(result.json.media[0]!.url).toContain(`${photo}/preview`);
    expect(result.json.media[1]).toMatchObject({ durationMs: 12_000 });
    expect(result.text).not.toContain(`${photo}/original`);
    expect(result.json.omittedMedia).toBe(0);
    expect(result.json.mediaExpiresIn).toBe(3600);
  });

  it('文件太多时如实说放不下多少', async () => {
    const { admin } = await familyWithBaby();
    const ids = [await upload(app, admin.token), await upload(app, admin.token)];
    const id = randomUUID();
    await sync(admin.token, [
      changeOf('moment', moment(FROM, { media: ids.map((m) => ref(m)) }), id),
    ]);
    const { token } = await timelineToken(admin.token);
    const limited = createApp({
      sql: db.sql,
      config: { ...db.config, limits: { ...db.config.limits, sharePublicMedia: 1 } },
    });
    const result = await openMoment(token, id, limited);
    expect(result.json.media).toHaveLength(1);
    expect(result.json.omittedMedia).toBe(1);
  });

  it('只能点开这个链接范围里的回忆：范围外、信、删掉的、别家的、不存在的都打不开', async () => {
    const { admin } = await familyWithBaby();
    const other = await familyWithBaby();
    const outside = randomUUID();
    const letter = randomUUID();
    const deleted = randomUUID();
    const othersMoment = randomUUID();
    await sync(admin.token, [
      changeOf('moment', moment(TO + HOUR), outside),
      changeOf('letter', { title: '信', text: '信的内容', at: FROM + HOUR }, letter),
      changeOf('moment', moment(FROM + HOUR), deleted, true),
    ]);
    await sync(other.admin.token, [changeOf('moment', moment(FROM + HOUR), othersMoment)]);
    const { token } = await timelineToken(admin.token);
    for (const id of [outside, letter, deleted, othersMoment, randomUUID()]) {
      const result = await openMoment(token, id);
      expect(result.status, id).toBe(404);
      expect(result.json).toEqual(MISS);
    }
  });
});

describe('公开接口：两种链接互不相通，旧的一天照常', () => {
  it('一天的令牌打不开时间线，时间线的令牌打不开一天', async () => {
    const { admin } = await familyWithBaby();
    const id = randomUUID();
    await sync(admin.token, [changeOf('moment', moment(FROM + HOUR), id)]);
    const day = await call<CreateShareResponse>(app, 'POST', '/v1/shares', {
      token: admin.token,
      body: { fromAt: FROM, toAt: FROM + DAY, timezone: TZ, units },
    });
    const timeline = await timelineToken(admin.token);
    for (const result of [
      await openTimeline(day.json.token),
      await openMoment(day.json.token, id),
    ]) {
      expect(result.status).toBe(404);
      expect(result.json).toEqual(MISS);
    }
    const asDay = await openDay(timeline.token);
    expect(asDay.status).toBe(404);
    expect(asDay.json).toEqual(MISS);
  });

  it('一天的链接还是原来的样子：同样的字段，有记录有回忆', async () => {
    const { admin } = await familyWithBaby();
    await sync(admin.token, [
      changeOf('event', { type: 'feed', at: FROM + HOUR, ml: 90 }),
      changeOf('moment', moment(FROM + 2 * HOUR)),
    ]);
    const day = await call<CreateShareResponse>(app, 'POST', '/v1/shares', {
      token: admin.token,
      body: { fromAt: FROM, toAt: FROM + DAY, timezone: TZ, units },
    });
    expect(day.status).toBe(201);
    const [row] = await db.sql`SELECT kind FROM shares WHERE id = ${day.json.id}`;
    expect(row?.kind).toBe('day');
    const result = await openDay(day.json.token);
    expect(result.status).toBe(200);
    expect(Object.keys(result.json).sort()).toEqual(
      ['baby', 'events', 'mediaExpiresIn', 'moments', 'omittedMedia', 'range', 'units'].sort(),
    );
    expect(result.json.events).toHaveLength(1);
    expect(result.json.moments).toHaveLength(1);
    expect(result.json.baby.dayNumber).toBe(15);
  });
});

describe('公开接口：什么时候失效', () => {
  async function liveTimeline(label = '妈妈') {
    const { admin } = await familyWithBaby();
    const caregiver = await join(app, admin.token, 'caregiver', label);
    const id = randomUUID();
    await sync(admin.token, [changeOf('moment', moment(FROM), id)]);
    const created = await timelineToken(caregiver.token);
    expect((await openTimeline(created.token)).status).toBe(200);
    expect((await openMoment(created.token, id)).status).toBe(200);
    return { admin, caregiver, created, id };
  }

  it('撤销：本人或管理员，撤销后三个入口都打不开', async () => {
    const { admin, created, id } = await liveTimeline();
    expect(
      (await call(app, 'DELETE', `/v1/shares/${created.id}`, { token: admin.token })).status,
    ).toBe(200);
    await expectAllMiss(created.token, id);
  });

  it('过期', async () => {
    const { created, id } = await liveTimeline();
    await db.sql`UPDATE shares SET expires_at = now() - interval '1 second' WHERE id = ${created.id}`;
    await expectAllMiss(created.token, id);
  });

  it('创建者降为只看回忆后失效，改回来也不恢复', async () => {
    const { admin, caregiver, created, id } = await liveTimeline();
    const path = `/v1/family/members/${caregiver.user.id}`;
    expect(
      (await call(app, 'PATCH', path, { token: admin.token, body: { role: 'viewer' } })).status,
    ).toBe(200);
    await expectAllMiss(created.token, id);
    await call(app, 'PATCH', path, { token: admin.token, body: { role: 'caregiver' } });
    await expectAllMiss(created.token, id);
  });

  it('创建者被移出家庭后失效', async () => {
    const { admin, caregiver, created, id } = await liveTimeline();
    expect(
      (await call(app, 'DELETE', `/v1/family/members/${caregiver.user.id}`, { token: admin.token }))
        .status,
    ).toBe(200);
    await expectAllMiss(created.token, id);
  });
});

describe('公开接口：CORS、限流和日志', () => {
  it('两个新入口的预检不用登录，响应带 CORS 头', async () => {
    for (const path of [TIMELINE_PATH, MOMENT_PATH]) {
      const preflight = await app.request(path, {
        method: 'OPTIONS',
        headers: {
          origin: 'https://share.fictional.test',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type,x-region',
        },
      });
      expect(preflight.status, path).toBe(204);
      expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
      expect(preflight.headers.get('access-control-allow-credentials')).toBeNull();
      expect(preflight.headers.get('access-control-allow-headers')?.toLowerCase()).toContain(
        'x-region',
      );
    }
    const miss = await openTimeline('A'.repeat(43));
    expect(miss.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('翻页和点开都算同一个链接的次数', async () => {
    const limited = createApp({
      sql: db.sql,
      config: { ...db.config, limits: { ...db.config.limits, sharePublicPerToken: 2 } },
    });
    const { admin } = await familyWithBaby();
    const id = randomUUID();
    await sync(admin.token, [changeOf('moment', moment(FROM), id)]);
    const { token } = await timelineToken(admin.token);
    expect((await openTimeline(token, undefined, limited)).status).toBe(200);
    expect((await openMoment(token, id, limited)).status).toBe(200);
    expect((await openTimeline(token, undefined, limited)).status).toBe(429);
    expect((await openMoment(token, id, limited)).status).toBe(429);
  });

  it('请求体太大也是同样的回答', async () => {
    const result = await call(app, 'POST', TIMELINE_PATH, {
      body: { token: 'A'.repeat(43), pad: 'x'.repeat(4000) },
    });
    expect(result.status).toBe(404);
    expect(result.json).toEqual(MISS);
  });

  it('成功、失效和限流时，日志里都没有令牌和签名链接', async () => {
    const lines: string[] = [];
    const capture = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
    const spies = [
      vi.spyOn(console, 'log').mockImplementation(capture),
      vi.spyOn(console, 'warn').mockImplementation(capture),
      vi.spyOn(console, 'error').mockImplementation(capture),
    ];
    try {
      const limited = createApp({
        sql: db.sql,
        config: { ...db.config, limits: { ...db.config.limits, sharePublicPerToken: 2 } },
      });
      const { admin } = await familyWithBaby();
      const file = await upload(app, admin.token);
      const id = randomUUID();
      await sync(admin.token, [changeOf('moment', moment(FROM, { media: [ref(file)] }), id)]);
      const { token } = await timelineToken(admin.token);
      expect((await openTimeline(token, undefined, limited)).status).toBe(200);
      expect((await openMoment(token, id, limited)).status).toBe(200);
      expect((await openMoment(token, id, limited)).status).toBe(429);
      await openTimeline('D'.repeat(43), undefined, limited);
      await openMoment('E'.repeat(43), id, limited);
      await openTimeline(token, 'bad-cursor', limited);
      const text = lines.join('\n');
      expect(text).not.toContain(token);
      expect(text).not.toContain('X-Amz');
      expect(text).not.toContain('D'.repeat(43));
      expect(text).not.toContain('E'.repeat(43));
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
