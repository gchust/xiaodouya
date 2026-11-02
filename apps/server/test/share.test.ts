import { randomUUID } from 'node:crypto';
import type {
  CreateShareResponse,
  PublicShareResponse,
  ShareListResponse,
  SyncResponse,
} from '@xiaodouya/shared';
import { MAX_ACTIVE_SHARES } from '@xiaodouya/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { sha256 } from '../src/crypto';
import { runMaintenance } from '../src/maintenance';
import {
  type App,
  call,
  join,
  newFamily,
  newUser,
  OBJECT_BYTES,
  openTestDb,
  PASSWORD,
  type TestDb,
  upload,
} from './harness';

/** 分享一天。真实的 Postgres 和 S3 兼容服务，所有名字和内容都是虚构的。 */

const HOUR = 3_600_000;
const TZ = 'Asia/Singapore';
// 2026-06-15 在新加坡的 0 点。
const FROM = Date.UTC(2026, 5, 14, 16);
const TO = FROM + 24 * HOUR;
const units = { volume: 'ml', temperature: 'c', weight: 'kg', length: 'cm' };
const MISS = { error: { code: 'share_unavailable', message: '这个链接已失效或已撤销' } };

let db: TestDb;
let app: App;

beforeAll(async () => {
  db = await openTestDb('share');
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
) => ({
  id,
  collection,
  data,
  deleted,
  updatedAt: Date.now(),
});

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

async function createShare(
  token: string,
  overrides: Record<string, unknown> = {},
  target: App = app,
) {
  return call<CreateShareResponse>(target, 'POST', '/v1/shares', {
    token,
    body: { fromAt: FROM, toAt: TO, timezone: TZ, units, ...overrides },
  });
}

async function shareToken(token: string, overrides: Record<string, unknown> = {}) {
  const created = await createShare(token, overrides);
  expect(created.status).toBe(201);
  return created.json;
}

const openPublic = (token: unknown, headers?: Record<string, string>, target: App = app) =>
  call<PublicShareResponse>(target, 'POST', '/v1/public/share', {
    body: { token },
    ...(headers ? { headers } : {}),
  });

/** 文件链接的路径里一定有 object key，所以检查其他字段时要先把链接去掉。 */
function withoutUrls(response: PublicShareResponse) {
  return JSON.stringify({
    ...response,
    moments: response.moments.map((m) => ({
      ...m,
      media: m.media.map(({ url: _url, thumbUrl: _thumb, ...rest }) => rest),
    })),
  });
}

describe('创建、列出和撤销', () => {
  it('管理员和一起记录的家人能创建，只看回忆的家人和没有家庭的人不能', async () => {
    const { admin } = await familyWithBaby();
    const caregiver = await join(app, admin.token, 'caregiver', '妈妈');
    const viewer = await join(app, admin.token, 'viewer', '奶奶');
    const loner = await newUser(app);
    expect((await createShare(admin.token)).status).toBe(201);
    expect((await createShare(caregiver.token)).status).toBe(201);
    const refused = await createShare(viewer.token);
    expect(refused.status).toBe(403);
    expect((await createShare(loner.token)).status).toBe(403);
    expect((await call(app, 'GET', '/v1/shares', { token: viewer.token })).status).toBe(403);
  });

  it('令牌 32 字节，库里只有哈希，列表里也没有', async () => {
    const { admin } = await familyWithBaby();
    const created = await shareToken(admin.token);
    expect(Buffer.from(created.token, 'base64url').length).toBe(32);
    const rows = await db.sql`SELECT * FROM shares WHERE id = ${created.id}`;
    expect(rows[0]?.token_hash).toBe(sha256(created.token));
    expect(JSON.stringify(rows[0])).not.toContain(created.token);
    const list = await call(app, 'GET', '/v1/shares', { token: admin.token });
    expect(list.text).not.toContain(created.token);
    expect(list.text).not.toContain(sha256(created.token));
  });

  it('默认 7 天，只接受 1、7、30 天', async () => {
    const { admin } = await familyWithBaby();
    const before = Date.now();
    const created = await shareToken(admin.token);
    expect(created.expiresAt - before).toBeGreaterThanOrEqual(7 * 24 * HOUR - 1000);
    expect(created.expiresAt - before).toBeLessThan(7 * 24 * HOUR + 60_000);
    for (const ttlDays of [1, 7, 30]) {
      expect((await createShare(admin.token, { ttlDays })).status).toBe(201);
    }
    for (const ttlDays of [0, 2, 31, 365]) {
      expect((await createShare(admin.token, { ttlDays })).status).toBe(400);
    }
  });

  it('范围不超过 25 小时：过夏令时的那天要能分享，再长一点不行', async () => {
    const { admin } = await familyWithBaby();
    expect((await createShare(admin.token, { toAt: FROM + 25 * HOUR })).status).toBe(201);
    expect((await createShare(admin.token, { toAt: FROM + 25 * HOUR + 1 })).status).toBe(400);
    expect((await createShare(admin.token, { toAt: FROM })).status).toBe(400);
    expect((await createShare(admin.token, { toAt: FROM - 1 })).status).toBe(400);
  });

  it('时区要是真的时区，至少选一项内容', async () => {
    const { admin } = await familyWithBaby();
    expect((await createShare(admin.token, { timezone: 'Mars/Olympus' })).status).toBe(400);
    expect(
      (
        await createShare(admin.token, {
          include: { moments: false, daily: false, health: false },
        })
      ).status,
    ).toBe(400);
  });

  it('每个家庭同时有效的链接有上限，并行创建也不会超，撤销后能再建', async () => {
    const { admin } = await familyWithBaby();
    const results = await Promise.all(
      Array.from({ length: MAX_ACTIVE_SHARES + 5 }, () => createShare(admin.token)),
    );
    const created = results.filter((r) => r.status === 201);
    expect(created).toHaveLength(MAX_ACTIVE_SHARES);
    expect(results.filter((r) => r.status === 409)).toHaveLength(5);
    const first = created[0]!.json;
    await call(app, 'DELETE', `/v1/shares/${first.id}`, { token: admin.token });
    expect((await createShare(admin.token)).status).toBe(201);
    // 过期的不占名额。
    await db.sql`UPDATE shares SET expires_at = now() - interval '1 second' WHERE id = ${created[1]!.json.id}`;
    expect((await createShare(admin.token)).status).toBe(201);
  });

  it('列表只有本家庭未过期、未撤销的，字段够显示，没有用户 id 和邮箱', async () => {
    const { admin } = await familyWithBaby('爸爸');
    const caregiver = await join(app, admin.token, 'caregiver', '妈妈');
    const other = await familyWithBaby();
    const live = await shareToken(caregiver.token, { ttlDays: 30 });
    const revoked = await shareToken(admin.token);
    const expired = await shareToken(admin.token);
    await shareToken(other.admin.token);
    await call(app, 'DELETE', `/v1/shares/${revoked.id}`, { token: admin.token });
    await db.sql`UPDATE shares SET expires_at = now() - interval '1 second' WHERE id = ${expired.id}`;
    const list = await call<ShareListResponse>(app, 'GET', '/v1/shares', { token: admin.token });
    expect(list.json.shares.map((s) => s.id)).toEqual([live.id]);
    expect(list.json.shares[0]).toMatchObject({
      fromAt: FROM,
      toAt: TO,
      expiresAt: live.expiresAt,
      byLabel: '妈妈',
      canRevoke: true,
    });
    expect(list.text).not.toContain(caregiver.user.id);
    expect(list.text).not.toContain(caregiver.email);
    const mine = await call<ShareListResponse>(app, 'GET', '/v1/shares', {
      token: caregiver.token,
    });
    expect(mine.json.shares[0]?.canRevoke).toBe(true);
    const third = await join(app, admin.token, 'caregiver', '阿姨');
    const others = await call<ShareListResponse>(app, 'GET', '/v1/shares', { token: third.token });
    expect(others.json.shares[0]?.canRevoke).toBe(false);
  });

  it('撤销：本人或管理员可以，别的家人和别的家庭不行，地址不是 UUID 不算服务器错误', async () => {
    const { admin } = await familyWithBaby();
    const mom = await join(app, admin.token, 'caregiver', '妈妈');
    const aunt = await join(app, admin.token, 'caregiver', '阿姨');
    const other = await familyWithBaby();
    const mine = await shareToken(mom.token);
    const del = (id: string, token: string) => call(app, 'DELETE', `/v1/shares/${id}`, { token });
    expect((await del(mine.id, aunt.token)).status).toBe(403);
    expect((await del(mine.id, other.admin.token)).status).toBe(404);
    expect((await del('not-a-uuid', admin.token)).status).toBe(404);
    expect((await openPublic(mine.token)).status).toBe(200);
    expect((await del(mine.id, mom.token)).status).toBe(200);
    expect((await openPublic(mine.token)).status).toBe(404);
    const second = await shareToken(mom.token);
    expect((await del(second.id, admin.token)).status).toBe(200);
    expect((await openPublic(second.token)).status).toBe(404);
  });

  it('要登录', async () => {
    expect((await call(app, 'GET', '/v1/shares')).status).toBe(401);
    expect((await call(app, 'POST', '/v1/shares', { body: {} })).status).toBe(401);
  });
});

describe('公开接口：失效的链接说的都一样', () => {
  it('不存在、格式不对、过期、撤销的响应完全相同', async () => {
    const { admin } = await familyWithBaby();
    const expired = await shareToken(admin.token);
    const revoked = await shareToken(admin.token);
    await db.sql`UPDATE shares SET expires_at = now() - interval '1 second' WHERE id = ${expired.id}`;
    await call(app, 'DELETE', `/v1/shares/${revoked.id}`, { token: admin.token });
    const results = await Promise.all([
      openPublic(expired.token),
      openPublic(revoked.token),
      openPublic('A'.repeat(43)),
      openPublic('short'),
      openPublic(42),
      call(app, 'POST', '/v1/public/share', { body: {} }),
      Promise.resolve(app.request('/v1/public/share', { method: 'POST', body: 'not json' })).then(
        async (r) => ({ status: r.status, json: await r.json() }),
      ),
    ]);
    for (const result of results) {
      expect(result.status).toBe(404);
      expect(result.json).toEqual(MISS);
    }
  });

  it('请求体太大也是同样的响应，不读完它', async () => {
    const big = await openPublic('A'.repeat(50_000));
    expect(big.status).toBe(404);
    expect(big.json).toEqual(MISS);
  });

  it('响应禁止缓存，成功和失败都是', async () => {
    const { admin } = await familyWithBaby();
    const { token } = await shareToken(admin.token);
    for (const result of [await openPublic(token), await openPublic('A'.repeat(43))]) {
      expect(result.headers.get('cache-control')).toBe('no-store');
    }
  });
});

describe('公开接口：白名单', () => {
  it('不含证件、信、邮箱、用户和家庭 id、object key、存储配置，多余字段都发不出去', async () => {
    const { admin, family } = await familyWithBaby('爸爸');
    const mom = await join(app, admin.token, 'caregiver', '妈妈');
    const fileId = await upload(app, admin.token);
    const docFile = await upload(app, admin.token, { scope: 'document' });
    const at = FROM + 8 * HOUR;
    const secret = '虚构的不该出现的内容';
    await sync(admin.token, [
      changeOf(
        'baby',
        {
          ...babyData,
          hospital: `${secret}医院`,
          bloodType: 'O',
          birthWeightKg: 3.3,
          avatar: { id: randomUUID(), kind: 'image', mime: 'image/jpeg', size: 1 },
          region: 'SG',
          extra: secret,
        },
        family.id,
      ),
      changeOf('event', {
        type: 'feed',
        at,
        ml: 90,
        byName: '爸爸',
        note: '喝得快',
        formulaId: 'fictional-formula',
        formula: { name: `${secret}奶粉`, per100ml: { proteinG: 1 } },
        milkType: 'formula',
        extra: secret,
        email: mom.email,
      }),
      changeOf('moment', {
        title: '第一次抬头',
        text: '虚构的一段话',
        at,
        milestone: true,
        byName: '妈妈',
        extra: secret,
        media: [
          {
            id: fileId,
            kind: 'image',
            mime: 'image/jpeg',
            size: 1,
            name: `${secret}.jpg`,
            width: 400,
            height: 300,
            peaks: [0.1],
            hasThumb: true,
            extra: secret,
          },
        ],
      }),
      changeOf('letter', { title: `${secret}的信`, text: secret, at }),
      changeOf('document', {
        name: `${secret}证件`,
        number: 'T26-FICTIONAL',
        files: [{ id: docFile, kind: 'image', mime: 'image/jpeg', size: 1 }],
      }),
    ]);
    const { token } = await shareToken(admin.token, {
      include: { moments: true, daily: true, health: true },
    });
    const result = await openPublic(token);
    expect(result.status).toBe(200);
    expect(result.text).not.toContain(secret);
    expect(result.text).not.toContain('T26-FICTIONAL');
    expect(result.text).not.toContain(docFile);
    expect(result.text).not.toContain(admin.email);
    expect(result.text).not.toContain(mom.email);
    expect(result.text).not.toContain(admin.user.id);
    expect(result.text).not.toContain(mom.user.id);
    expect(result.text).not.toContain('secretAccessKey');
    expect(result.text).not.toContain('accessKeyId');
    expect(result.text).not.toContain('birthAt');
    expect(result.text).not.toContain(String(babyData.birthAt));

    const rest = withoutUrls(result.json);
    expect(rest).not.toContain(family.id);
    expect(rest).not.toContain('families/');
    expect(rest).not.toContain('object_key');
    expect(rest).not.toContain('objectKey');

    // 字段是逐个列出来的：多一个都要在这里看到。
    expect(Object.keys(result.json).sort()).toEqual([
      'baby',
      'events',
      'mediaExpiresIn',
      'moments',
      'omittedMedia',
      'range',
      'units',
    ]);
    expect(Object.keys(result.json.baby).sort()).toEqual(['age', 'dayNumber', 'name']);
    expect(result.json.events).toEqual([
      { at, type: 'feed', ml: 90, byName: '爸爸', note: '喝得快' },
    ]);
    const moment = result.json.moments[0]!;
    expect(Object.keys(moment).sort()).toEqual([
      'at',
      'byName',
      'media',
      'milestone',
      'text',
      'title',
    ]);
    expect(Object.keys(moment.media[0]!).sort()).toEqual([
      'height',
      'id',
      'kind',
      'thumbUrl',
      'url',
      'width',
    ]);
    expect(result.json.range).toEqual({ fromAt: FROM, toAt: TO, timezone: TZ });
    expect(result.json.units).toEqual(units);
  });

  it('自己加的疫苗不带记录的 UUID，内置剂次带 id 用来换语言', async () => {
    const { admin } = await familyWithBaby();
    const customId = randomUUID();
    await sync(admin.token, [
      changeOf('event', { type: 'vaccine', at: FROM + HOUR, vaccineId: 'sg:bcg', name: '卡介苗' }),
      changeOf('event', {
        type: 'vaccine',
        at: FROM + 2 * HOUR,
        vaccineId: `custom:${customId}`,
        name: '虚构疫苗',
      }),
    ]);
    const { token } = await shareToken(admin.token, {
      include: { moments: false, daily: false, health: true },
    });
    const result = await openPublic(token);
    expect(result.text).not.toContain(customId);
    expect(result.json.events).toEqual([
      { at: FROM + HOUR, type: 'vaccine', vaccineId: 'sg:bcg', name: '卡介苗' },
      { at: FROM + 2 * HOUR, type: 'vaccine', vaccineId: 'custom', name: '虚构疫苗' },
    ]);
  });

  it('配置型事件不出现，哪怕它们带着 at', async () => {
    const { admin } = await familyWithBaby();
    await sync(admin.token, [
      changeOf('event', {
        type: 'formula',
        name: '虚构奶粉配置',
        basis: 'per100ml',
        values: {},
        at: FROM + HOUR,
      }),
      changeOf('event', {
        type: 'vaccine-plan',
        vaccineId: 'sg:bcg',
        hidden: true,
        at: FROM + HOUR,
      }),
      changeOf('event', { type: 'formula', name: '没有时间的配置', basis: 'per100ml', values: {} }),
      changeOf('event', { type: 'bath', at: FROM + HOUR }),
    ]);
    const { token } = await shareToken(admin.token, {
      include: { moments: true, daily: true, health: true },
    });
    const result = await openPublic(token);
    expect(result.status).toBe(200);
    expect(result.json.events).toEqual([{ at: FROM + HOUR, type: 'bath' }]);
    expect(result.text).not.toContain('虚构奶粉配置');
    expect(result.text).not.toContain('没有时间的配置');
  });
});

describe('公开接口：内容范围', () => {
  it('at 在 [from, to) 里才算，边界各测一边', async () => {
    const { admin } = await familyWithBaby();
    await sync(admin.token, [
      changeOf('event', { type: 'feed', at: FROM - 1, ml: 10 }),
      changeOf('event', { type: 'feed', at: FROM, ml: 20 }),
      changeOf('event', { type: 'feed', at: TO - 1, ml: 30 }),
      changeOf('event', { type: 'feed', at: TO, ml: 40 }),
      changeOf('moment', { title: '早一点', text: '', at: FROM - 1, milestone: false, media: [] }),
      changeOf('moment', { title: '刚好', text: '', at: FROM, milestone: false, media: [] }),
      changeOf('moment', { title: '晚一点', text: '', at: TO, milestone: false, media: [] }),
    ]);
    const { token } = await shareToken(admin.token);
    const result = await openPublic(token);
    expect(result.json.events.map((e) => (e as { ml: number }).ml)).toEqual([20, 30]);
    expect(result.json.moments.map((m) => m.title)).toEqual(['刚好']);
  });

  it('现查现发：之后补记的会出现，删掉的会消失，改过的是新内容', async () => {
    const { admin } = await familyWithBaby();
    const feedId = randomUUID();
    const momentId = randomUUID();
    const feed = { type: 'feed', at: FROM + HOUR, ml: 60 };
    const moment = { title: '虚构回忆', text: '', at: FROM + HOUR, milestone: false, media: [] };
    await sync(admin.token, [
      changeOf('event', feed, feedId),
      changeOf('moment', moment, momentId),
    ]);
    const { token } = await shareToken(admin.token);
    expect((await openPublic(token)).json.events).toHaveLength(1);
    await sync(admin.token, [changeOf('event', { ...feed, ml: 70 }, feedId)]);
    expect((await openPublic(token)).json.events).toEqual([
      { at: FROM + HOUR, type: 'feed', ml: 70 },
    ]);
    await sync(admin.token, [
      { ...changeOf('event', feed, feedId, true), updatedAt: Date.now() + 1000 },
      { ...changeOf('moment', moment, momentId, true), updatedAt: Date.now() + 1000 },
    ]);
    const after = await openPublic(token);
    expect(after.json.events).toEqual([]);
    expect(after.json.moments).toEqual([]);
    expect(after.text).not.toContain('虚构回忆');
  });

  it('选项：健康记录默认不出现，打开才有；关掉的内容一条都不发', async () => {
    const { admin } = await familyWithBaby();
    const fileId = await upload(app, admin.token);
    await sync(admin.token, [
      changeOf('event', { type: 'feed', at: FROM + 1, ml: 60 }),
      changeOf('event', { type: 'diaper', at: FROM + 2, kind: 'wee' }),
      changeOf('event', { type: 'sleep', at: FROM + 3, endAt: FROM + HOUR }),
      changeOf('event', { type: 'solids', at: FROM + 4, food: '虚构米糊' }),
      changeOf('event', { type: 'bath', at: FROM + 5 }),
      changeOf('event', { type: 'temp', at: FROM + 6, celsius: 38.5 }),
      changeOf('event', { type: 'med', at: FROM + 7, name: '虚构药', dose: '1 滴' }),
      changeOf('event', { type: 'growth', at: FROM + 8, weightKg: 4, lengthCm: 55 }),
      changeOf('event', { type: 'vaccine', at: FROM + 9, vaccineId: 'sg:bcg', name: '卡介苗' }),
      changeOf('moment', {
        title: '虚构回忆',
        text: '',
        at: FROM + 10,
        milestone: false,
        media: [{ id: fileId, kind: 'image', mime: 'image/jpeg', size: 1 }],
      }),
    ]);
    const types = async (overrides: Record<string, unknown>) => {
      const { token } = await shareToken(admin.token, overrides);
      const { json, text } = await openPublic(token);
      return { types: json.events.map((e) => e.type), moments: json.moments.length, text };
    };
    const defaults = await types({});
    expect(defaults.types).toEqual(['feed', 'diaper', 'sleep', 'solids', 'bath']);
    expect(defaults.moments).toBe(1);
    expect(defaults.text).not.toContain('虚构药');
    expect(defaults.text).not.toContain('38.5');

    const withHealth = await types({ include: { moments: true, daily: true, health: true } });
    expect(withHealth.types).toEqual([
      'feed',
      'diaper',
      'sleep',
      'solids',
      'bath',
      'temp',
      'med',
      'growth',
      'vaccine',
    ]);

    const healthOnly = await types({ include: { moments: false, daily: false, health: true } });
    expect(healthOnly.types).toEqual(['temp', 'med', 'growth', 'vaccine']);
    expect(healthOnly.moments).toBe(0);
    expect(healthOnly.text).not.toContain(fileId);

    const momentsOnly = await types({ include: { moments: true, daily: false, health: false } });
    expect(momentsOnly.types).toEqual([]);
    expect(momentsOnly.moments).toBe(1);
  });

  it('第几天和月龄按分享者的时区算，不发出生时间；服务器在别的时区也一样', async () => {
    const { admin } = await familyWithBaby();
    const { token } = await shareToken(admin.token);
    // 出生在新加坡 6 月 1 日 23:30，分享 6 月 15 日：第 15 天，14 天大。
    expect((await openPublic(token)).json.baby).toEqual({
      name: '测试豆',
      dayNumber: 15,
      age: { months: 0, days: 14 },
    });
    // 同一个时刻在纽约还是 6 月 14 日，出生日在纽约是 6 月 1 日：差一天的话这里会变。
    const newYork = await shareToken(admin.token, {
      timezone: 'America/New_York',
      fromAt: Date.UTC(2026, 5, 15, 4),
      toAt: Date.UTC(2026, 5, 16, 4),
    });
    expect((await openPublic(newYork.token)).json.baby.dayNumber).toBe(15);
  });

  it('还没有宝宝档案时页面也能打开，名字留空给页面', async () => {
    const { admin } = await newFamily(app);
    const { token } = await shareToken(admin.token);
    const result = await openPublic(token);
    expect(result.status).toBe(200);
    expect(result.json.baby).toEqual({ name: '', dayNumber: null, age: null });
  });
});

describe('公开接口：文件', () => {
  const momentWith = (media: unknown[], title = '虚构回忆') =>
    changeOf('moment', { title, text: '', at: FROM + HOUR, milestone: false, media });
  const ref = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    kind: 'image',
    mime: 'image/jpeg',
    size: OBJECT_BYTES.length,
    ...extra,
  });

  it('原图和缩略图都能用签名链接下载，有时长和尺寸，类型以服务端记录为准', async () => {
    const { admin } = await familyWithBaby();
    const id = randomUUID();
    await upload(app, admin.token, { id, variant: 'original', mime: 'video/mp4' });
    await upload(app, admin.token, { id, variant: 'thumb', mime: 'image/jpeg' });
    await sync(admin.token, [
      // 记录里写的类型不算数：别人的客户端可以乱写。
      momentWith([ref(id, { kind: 'image', durationMs: 12_000, width: 720, height: 1280 })]),
    ]);
    const { token } = await shareToken(admin.token);
    const result = await openPublic(token);
    const media = result.json.moments[0]!.media[0]!;
    expect(media).toMatchObject({
      id,
      kind: 'video',
      durationMs: 12_000,
      width: 720,
      height: 1280,
    });
    expect(result.json.mediaExpiresIn).toBe(3600);
    for (const url of [media.url!, media.thumbUrl!]) {
      expect(url).toContain('X-Amz-Signature');
      expect(url).toContain('X-Amz-Expires=3600');
      const download = await fetch(url);
      expect(Buffer.from(await download.arrayBuffer()).equals(OBJECT_BYTES)).toBe(true);
    }
  });

  it('只发传完的文件：没传完的不出现，只有缩略图时也能显示', async () => {
    const { admin } = await familyWithBaby();
    const thumbOnly = randomUUID();
    await upload(app, admin.token, { id: thumbOnly, variant: 'thumb', mime: 'image/jpeg' });
    const pending = randomUUID();
    const started = await call(app, 'POST', '/v1/media/upload-url', {
      token: admin.token,
      body: { id: pending, scope: 'memory', variant: 'original', mime: 'image/jpeg', size: 10 },
    });
    expect(started.status).toBe(200);
    await sync(admin.token, [momentWith([ref(pending), ref(thumbOnly), ref(randomUUID())])]);
    const { token } = await shareToken(admin.token);
    const result = await openPublic(token);
    const media = result.json.moments[0]!.media;
    expect(media.map((m) => m.id)).toEqual([thumbOnly]);
    expect(media[0]!.url).toBeNull();
    expect(media[0]!.thumbUrl).toContain('X-Amz-Signature');
    expect(result.text).not.toContain(pending);
  });

  it('回忆里写上证件或别家的文件 id 也拿不到链接', async () => {
    const { admin } = await familyWithBaby();
    const other = await familyWithBaby();
    const docFile = await upload(app, admin.token, { scope: 'document' });
    const avatarFile = await upload(app, admin.token, { scope: 'avatar' });
    const otherFile = await upload(app, other.admin.token);
    await sync(admin.token, [
      momentWith([ref(docFile), ref(avatarFile), ref(otherFile)], '有标题'),
    ]);
    const { token } = await shareToken(admin.token);
    const result = await openPublic(token);
    expect(result.json.moments[0]!.media).toEqual([]);
    for (const id of [docFile, avatarFile, otherFile]) expect(result.text).not.toContain(id);
  });

  it('什么都显示不了的回忆不发', async () => {
    const { admin } = await familyWithBaby();
    await sync(admin.token, [momentWith([ref(randomUUID())], '')]);
    const { token } = await shareToken(admin.token);
    expect((await openPublic(token)).json.moments).toEqual([]);
  });

  it('文件太多时如实告诉页面放不下多少', async () => {
    const { admin } = await familyWithBaby();
    const ids = [await upload(app, admin.token), await upload(app, admin.token)];
    await sync(admin.token, [momentWith(ids.map((id) => ref(id)))]);
    const { token } = await shareToken(admin.token);
    const limited = createApp({
      sql: db.sql,
      config: { ...db.config, limits: { ...db.config.limits, sharePublicMedia: 1 } },
    });
    const result = await openPublic(token, undefined, limited);
    expect(result.json.moments[0]!.media).toHaveLength(1);
    expect(result.json.omittedMedia).toBe(1);
  });

  it('自带存储的家庭也能用；配了公开 CDN 也发会过期的签名链接，不发永久地址', async () => {
    const { admin } = await familyWithBaby();
    const saved = await call(app, 'PUT', '/v1/storage', {
      token: admin.token,
      body: {
        provider: 'other',
        endpoint: process.env.TEST_S3_ENDPOINT ?? 'http://localhost:59000',
        region: 'us-east-1',
        bucket: 'xiaodouya-dev',
        accessKeyId: 'devaccesskey',
        secretAccessKey: 'devsecretkey',
        publicBaseUrl: 'https://cdn.fictional.test',
      },
    });
    expect(saved.status).toBe(200);
    const id = await upload(app, admin.token);
    await sync(admin.token, [momentWith([ref(id)])]);
    const { token } = await shareToken(admin.token);
    const result = await openPublic(token);
    const url = result.json.moments[0]!.media[0]!.url!;
    expect(url).not.toContain('cdn.fictional.test');
    expect(url).toContain('X-Amz-Signature');
    expect(result.text).not.toContain('accessKeyId');
    const download = await fetch(url);
    expect(Buffer.from(await download.arrayBuffer()).equals(OBJECT_BYTES)).toBe(true);
  });
});

describe('公开接口：成员变化', () => {
  it('移出家庭后，他创建的链接失效，再加回来也不恢复；别人创建的不受影响', async () => {
    const { admin } = await familyWithBaby();
    const mom = await join(app, admin.token, 'caregiver', '妈妈');
    const hers = await shareToken(mom.token);
    const mine = await shareToken(admin.token);
    expect((await openPublic(hers.token)).status).toBe(200);
    const removed = await call(app, 'DELETE', `/v1/family/members/${mom.user.id}`, {
      token: admin.token,
    });
    expect(removed.status).toBe(200);
    const after = await openPublic(hers.token);
    expect(after.status).toBe(404);
    expect(after.json).toEqual(MISS);
    expect((await openPublic(mine.token)).status).toBe(200);
    const list = await call<ShareListResponse>(app, 'GET', '/v1/shares', { token: admin.token });
    expect(list.json.shares.map((s) => s.id)).toEqual([mine.id]);
    // 重新登录加回来，旧链接不复活。
    const login = await call<{ token: string }>(app, 'POST', '/v1/auth/login', {
      body: { email: mom.email, password: PASSWORD },
    });
    const invite = await call<{ code: string }>(app, 'POST', '/v1/invites', {
      token: admin.token,
      body: { role: 'caregiver', label: '妈妈' },
    });
    await call(app, 'POST', '/v1/invites/accept', {
      token: login.json.token,
      body: { code: invite.json.code },
    });
    expect((await openPublic(hers.token)).status).toBe(404);
  });

  it('降为只看回忆后，他创建的链接失效：他自己都读不到记录了', async () => {
    const { admin } = await familyWithBaby();
    const mom = await join(app, admin.token, 'caregiver', '妈妈');
    const hers = await shareToken(mom.token);
    await call(app, 'PATCH', `/v1/family/members/${mom.user.id}`, {
      token: admin.token,
      body: { role: 'viewer' },
    });
    expect((await openPublic(hers.token)).status).toBe(404);
    await call(app, 'PATCH', `/v1/family/members/${mom.user.id}`, {
      token: admin.token,
      body: { role: 'caregiver' },
    });
    expect((await openPublic(hers.token)).status).toBe(404);
  });

  it('只改称呼不影响链接', async () => {
    const { admin } = await familyWithBaby();
    const mom = await join(app, admin.token, 'caregiver', '妈妈');
    const hers = await shareToken(mom.token);
    await call(app, 'PATCH', `/v1/family/members/${mom.user.id}`, {
      token: admin.token,
      body: { label: '妈咪' },
    });
    expect((await openPublic(hers.token)).status).toBe(200);
  });

  it('删除账号后，他创建的链接失效，行也没了', async () => {
    const { admin } = await familyWithBaby();
    const mom = await join(app, admin.token, 'caregiver', '妈妈');
    const hers = await shareToken(mom.token);
    const deleted = await call(app, 'POST', '/v1/me/delete', {
      token: mom.token,
      body: { password: PASSWORD },
    });
    expect(deleted.status).toBe(200);
    expect((await openPublic(hers.token)).status).toBe(404);
    expect(await db.sql`SELECT 1 FROM shares WHERE id = ${hers.id}`).toHaveLength(0);
  });

  it('家庭删除后链接跟着没了', async () => {
    const { admin } = await familyWithBaby();
    const mine = await shareToken(admin.token);
    await call(app, 'POST', '/v1/me/delete', { token: admin.token, body: { password: PASSWORD } });
    expect((await openPublic(mine.token)).status).toBe(404);
    expect(await db.sql`SELECT 1 FROM shares WHERE id = ${mine.id}`).toHaveLength(0);
  });
});

describe('公开接口：限流', () => {
  const limitedApp = (limits: Record<string, number>, header = 'x-forwarded-for') =>
    createApp({
      sql: db.sql,
      config: {
        ...db.config,
        clientIp: { header, position: 'last' },
        limits: { ...db.config.limits, ...limits },
      },
    });

  it('按令牌：换来源也挡得住，别的令牌不受影响', async () => {
    const limited = limitedApp({ sharePublicPerToken: 2, sharePublicPerIp: 1000 });
    const { admin } = await familyWithBaby();
    const a = await shareToken(admin.token);
    const b = await shareToken(admin.token);
    const from = (ip: string) => ({ 'x-forwarded-for': ip });
    expect((await openPublic(a.token, from('203.0.113.1'), limited)).status).toBe(200);
    expect((await openPublic(a.token, from('203.0.113.2'), limited)).status).toBe(200);
    const blocked = await openPublic(a.token, from('203.0.113.3'), limited);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('access-control-allow-origin')).toBe('*');
    expect(blocked.headers.get('cache-control')).toBe('no-store');
    expect((await openPublic(b.token, from('203.0.113.3'), limited)).status).toBe(200);
  });

  it('按来源：换令牌也挡得住，别的来源不受影响', async () => {
    const limited = limitedApp({ sharePublicPerToken: 1000, sharePublicPerIp: 2 });
    const { admin } = await familyWithBaby();
    const { token } = await shareToken(admin.token);
    const from = { 'x-forwarded-for': '203.0.113.20' };
    expect((await openPublic('A'.repeat(43), from, limited)).status).toBe(404);
    expect((await openPublic('B'.repeat(43), from, limited)).status).toBe(404);
    expect((await openPublic(token, from, limited)).status).toBe(429);
    expect((await openPublic(token, { 'x-forwarded-for': '203.0.113.21' }, limited)).status).toBe(
      200,
    );
  });

  it('取不到来源时跳过按来源那条，所有人不共用一个计数；按令牌的还在', async () => {
    const limited = limitedApp({ sharePublicPerToken: 2, sharePublicPerIp: 1 });
    const { admin } = await familyWithBaby();
    const a = await shareToken(admin.token);
    const b = await shareToken(admin.token);
    expect((await openPublic(a.token, undefined, limited)).status).toBe(200);
    expect((await openPublic(b.token, undefined, limited)).status).toBe(200);
    expect((await openPublic(a.token, undefined, limited)).status).toBe(200);
    expect((await openPublic(a.token, undefined, limited)).status).toBe(429);
    // 内网地址也算取不到。
    expect((await openPublic(b.token, { 'x-forwarded-for': '10.0.0.5' }, limited)).status).toBe(
      200,
    );
  });

  it('令牌失效和存在时限流的行为一样：不能靠 429 判断链接存不存在', async () => {
    const limited = limitedApp({ sharePublicPerToken: 1, sharePublicPerIp: 1000 });
    const missing = 'C'.repeat(43);
    expect((await openPublic(missing, undefined, limited)).status).toBe(404);
    expect((await openPublic(missing, undefined, limited)).status).toBe(429);
  });
});

describe('公开接口：CORS', () => {
  it('预检不用登录，放行要用到的头，不带凭据', async () => {
    const response = await app.request('/v1/public/share', {
      method: 'OPTIONS',
      headers: {
        origin: 'https://share.fictional.test',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type,x-region',
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('access-control-allow-credentials')).toBeNull();
    expect(response.headers.get('access-control-allow-methods')).toContain('POST');
    const allowed = response.headers.get('access-control-allow-headers')?.toLowerCase() ?? '';
    expect(allowed).toContain('content-type');
    expect(allowed).toContain('x-region');
  });

  it('成功和失败的响应都带 CORS 头，不要求登录', async () => {
    const { admin } = await familyWithBaby();
    const { token } = await shareToken(admin.token);
    for (const result of [await openPublic(token), await openPublic('A'.repeat(43))]) {
      expect(result.headers.get('access-control-allow-origin')).toBe('*');
      expect(result.headers.get('access-control-allow-credentials')).toBeNull();
    }
  });

  it('其他接口都没有 CORS', async () => {
    const { admin } = await familyWithBaby();
    const origin = { origin: 'https://share.fictional.test' };
    const paths: [string, string, string?][] = [
      ['GET', '/healthz'],
      ['GET', '/v1/config'],
      ['GET', '/v1/me', admin.token],
      ['GET', '/v1/shares', admin.token],
      ['POST', '/v1/auth/login'],
    ];
    for (const [method, path, token] of paths) {
      const response = await call(app, method, path, {
        ...(token ? { token } : {}),
        ...(method === 'POST' ? { body: {} } : {}),
        headers: origin,
      });
      expect(response.headers.get('access-control-allow-origin'), path).toBeNull();
    }
    const preflight = await app.request('/v1/shares', {
      method: 'OPTIONS',
      headers: { ...origin, 'access-control-request-method': 'POST' },
    });
    expect(preflight.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('日志和清理', () => {
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
        config: { ...db.config, limits: { ...db.config.limits, sharePublicPerToken: 1 } },
      });
      const { admin } = await familyWithBaby();
      const id = await upload(app, admin.token);
      await sync(admin.token, [
        changeOf('moment', {
          title: '虚构',
          text: '',
          at: FROM,
          milestone: false,
          media: [{ id, kind: 'image', mime: 'image/jpeg', size: 1 }],
        }),
      ]);
      const created = await createShare(admin.token, {}, limited);
      const { token } = created.json;
      expect((await openPublic(token, undefined, limited)).status).toBe(200);
      expect((await openPublic(token, undefined, limited)).status).toBe(429);
      await openPublic('D'.repeat(43), undefined, limited);
      await openPublic('short', undefined, limited);
      expect(lines.join('\n')).not.toContain(token);
      expect(lines.join('\n')).not.toContain('X-Amz');
      expect(lines.join('\n')).not.toContain('D'.repeat(43));
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it('定时清理只删过期或撤销很久的行', async () => {
    const { admin } = await familyWithBaby();
    const [oldExpired, recentExpired, oldRevoked, live] = [
      await shareToken(admin.token),
      await shareToken(admin.token),
      await shareToken(admin.token),
      await shareToken(admin.token),
    ];
    await db.sql`UPDATE shares SET expires_at = now() - interval '31 days' WHERE id = ${oldExpired.id}`;
    await db.sql`UPDATE shares SET expires_at = now() - interval '1 day' WHERE id = ${recentExpired.id}`;
    await db.sql`UPDATE shares SET revoked_at = now() - interval '31 days' WHERE id = ${oldRevoked.id}`;
    const report = await runMaintenance(db.sql, db.config);
    expect(report.sharesRemoved).toBe(2);
    const rows = await db.sql<{ id: string }[]>`
      SELECT id FROM shares WHERE id = ANY(${[oldExpired.id, recentExpired.id, oldRevoked.id, live.id]}::uuid[])`;
    expect(rows.map((r) => r.id).sort()).toEqual([recentExpired.id, live.id].sort());
  });
});
