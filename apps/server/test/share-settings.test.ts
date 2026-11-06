import { randomUUID } from 'node:crypto';
import type {
  CreateShareResponse,
  MeResponse,
  PublicConfig,
  PublicShareResponse,
  PublicTimelineMomentResponse,
  PublicTimelineResponse,
  ShareDisplay,
  ShareListResponse,
  SyncResponse,
} from '@xiaodouya/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import {
  type App,
  call,
  newFamily,
  OBJECT_BYTES,
  openTestDb,
  type TestDb,
  upload,
} from './harness';

/**
 * 分享设置（F-141，issue #96）：名字换成称呼或者不显示、带不带头像。
 * 隐私靠服务端：公开接口的回答里不能出现真实名字和没选的头像，只在页面上藏起来不算。
 * 真实的 Postgres 和 S3 兼容服务，所有名字和内容都是虚构的；回忆的标题和文字里故意不写宝宝的名字，
 * 这样“回答里没有真实名字”查的就是服务端换没换，不是内容碰巧没写。
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const TZ = 'Asia/Singapore';
// 2026-06-15 在新加坡的 0 点。
const FROM = Date.UTC(2026, 5, 14, 16);
const units = { volume: 'ml', temperature: 'c', weight: 'kg', length: 'cm' };
const REAL_NAME = '虚构豆豆';

let db: TestDb;
let app: App;

beforeAll(async () => {
  db = await openTestDb('share_settings');
  app = createApp({ sql: db.sql, config: db.config });
});
afterAll(async () => {
  await db.close();
});

const changeOf = (collection: string, data: unknown, id: string = randomUUID()) => ({
  id,
  collection,
  data,
  deleted: false,
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

const ref = (id: string) => ({ id, kind: 'image', mime: 'image/jpeg', size: OBJECT_BYTES.length });

/** 一个有头像（原图和缩略图）、一段回忆、一条喂奶记录的家庭。 */
async function setup(options: { avatarThumb?: boolean } = {}) {
  const { admin, family } = await newFamily(app, '爸爸');
  const avatar = await upload(app, admin.token, { scope: 'avatar' });
  if (options.avatarThumb !== false) {
    await upload(app, admin.token, { id: avatar, scope: 'avatar', variant: 'thumb' });
  }
  const momentId = randomUUID();
  await sync(admin.token, [
    changeOf(
      'baby',
      { name: REAL_NAME, birthAt: Date.UTC(2026, 5, 1, 15, 30), avatar: ref(avatar) },
      family.id,
    ),
    changeOf(
      'moment',
      { title: '第一次翻身', text: '虚构的一段话', at: FROM + HOUR, milestone: true, media: [] },
      momentId,
    ),
    changeOf('event', { type: 'feed', at: FROM + 2 * HOUR, ml: 90 }),
  ]);
  return { admin, family, avatar, momentId };
}

const display = (patch: Partial<ShareDisplay> = {}): ShareDisplay => ({
  showName: true,
  nickname: '',
  showAvatar: false,
  ...patch,
});

type Kind = 'day' | 'timeline' | 'moments';

async function create(token: string, kind: Kind, momentId: string, extra: Record<string, unknown>) {
  const base = { fromAt: FROM, toAt: FROM + DAY, timezone: TZ, ...extra };
  const [path, body] =
    kind === 'day'
      ? ['/v1/shares', { ...base, units }]
      : kind === 'timeline'
        ? ['/v1/shares/timeline', base]
        : ['/v1/shares/moments', { ...base, momentIds: [momentId] }];
  return call<CreateShareResponse>(app, 'POST', path, { token, body });
}

async function shareToken(token: string, kind: Kind, momentId: string, extra = {}) {
  const created = await create(token, kind, momentId, extra);
  expect(created.status).toBe(201);
  return created.json.token;
}

/** 公开接口的回答，原文和解析后的 baby。时间线和回忆的链接再点开那一段，确认那里也没有名字。 */
async function open(kind: Kind, token: string, momentId: string) {
  if (kind === 'day') {
    const result = await call<PublicShareResponse>(app, 'POST', '/v1/public/share', {
      body: { token },
    });
    expect(result.status).toBe(200);
    return { text: result.text, baby: result.json.baby };
  }
  const page = await call<PublicTimelineResponse>(app, 'POST', '/v1/public/share/timeline', {
    body: { token },
  });
  expect(page.status).toBe(200);
  expect(page.json.entries).toHaveLength(1);
  const moment = await call<PublicTimelineMomentResponse>(
    app,
    'POST',
    '/v1/public/share/timeline/moment',
    { body: { token, momentId } },
  );
  expect(moment.status).toBe(200);
  return { text: page.text + moment.text, baby: page.json.baby };
}

const KINDS: Kind[] = ['day', 'timeline', 'moments'];

describe.each(KINDS)('%s 的链接', (kind) => {
  it('设了称呼：回答里是称呼，没有真实名字', async () => {
    const { admin, momentId } = await setup();
    const token = await shareToken(admin.token, kind, momentId, {
      display: display({ nickname: '小宝' }),
    });
    const { text, baby } = await open(kind, token, momentId);
    expect(baby.name).toBe('小宝');
    expect(text).not.toContain(REAL_NAME);
  });

  it('不显示名字：名字是空的，称呼也不发', async () => {
    const { admin, momentId } = await setup();
    const token = await shareToken(admin.token, kind, momentId, {
      display: display({ showName: false, nickname: '小宝' }),
    });
    const { text, baby } = await open(kind, token, momentId);
    expect(baby.name).toBe('');
    expect(text).not.toContain(REAL_NAME);
    expect(text).not.toContain('小宝');
  });

  it('不带头像：回答里没有头像的链接，也没有头像文件的 id', async () => {
    const { admin, momentId, avatar } = await setup();
    for (const extra of [{}, { display: display() }]) {
      const token = await shareToken(admin.token, kind, momentId, extra);
      const { text, baby } = await open(kind, token, momentId);
      expect(baby.avatarUrl ?? null).toBeNull();
      expect(text).not.toContain(avatar);
    }
  });

  it('带头像：只发签过名的缩略图，不发原图', async () => {
    const { admin, momentId, avatar } = await setup();
    const token = await shareToken(admin.token, kind, momentId, {
      display: display({ showAvatar: true }),
    });
    const { text, baby } = await open(kind, token, momentId);
    expect(baby.avatarUrl).toContain(`${avatar}/thumb`);
    expect(baby.avatarUrl).toContain('X-Amz-Signature');
    expect(text).not.toContain(`${avatar}/original`);
    const fetched = await fetch(baby.avatarUrl!);
    expect(fetched.status).toBe(200);
    expect(Buffer.from(await fetched.arrayBuffer()).equals(Buffer.from(OBJECT_BYTES))).toBe(true);
  });

  it('旧版 App 不带选项：和以前一样，真实名字、没有头像，库里存空值', async () => {
    const { admin, momentId, avatar } = await setup();
    const created = await create(admin.token, kind, momentId, {});
    expect(created.status).toBe(201);
    const { text, baby } = await open(kind, created.json.token, momentId);
    expect(baby.name).toBe(REAL_NAME);
    expect(text).not.toContain(avatar);
    const [row] = await db.sql<
      { show_name: boolean | null; baby_nickname: string | null; show_avatar: boolean | null }[]
    >`SELECT show_name, baby_nickname, show_avatar FROM shares WHERE id = ${created.json.id}`;
    expect(row).toEqual({ show_name: null, baby_nickname: null, show_avatar: null });
  });
});

describe('头像', () => {
  it('还没有缩略图时不发头像，也不退回原图', async () => {
    const { admin, momentId, avatar } = await setup({ avatarThumb: false });
    const token = await shareToken(admin.token, 'day', momentId, {
      display: display({ showAvatar: true }),
    });
    const { text, baby } = await open('day', token, momentId);
    expect(baby.avatarUrl).toBeNull();
    expect(text).not.toContain(avatar);
  });

  it('档案里的头像写成回忆或别家的文件时不发', async () => {
    const { admin, family, momentId } = await setup();
    const memoryPhoto = await upload(app, admin.token);
    await upload(app, admin.token, { id: memoryPhoto, variant: 'thumb' });
    const other = await newFamily(app, '妈妈');
    const foreign = await upload(app, other.admin.token, { scope: 'avatar' });
    await upload(app, other.admin.token, { id: foreign, scope: 'avatar', variant: 'thumb' });
    for (const id of [memoryPhoto, foreign]) {
      await sync(admin.token, [
        changeOf(
          'baby',
          { name: REAL_NAME, birthAt: Date.UTC(2026, 5, 1), avatar: ref(id) },
          family.id,
        ),
      ]);
      const token = await shareToken(admin.token, 'day', momentId, {
        display: display({ showAvatar: true }),
      });
      const { text, baby } = await open('day', token, momentId);
      expect(baby.avatarUrl).toBeNull();
      expect(text).not.toContain(id);
    }
  });

  it('没有头像时是 null', async () => {
    const { admin, family } = await newFamily(app, '爸爸');
    await sync(admin.token, [
      changeOf('baby', { name: REAL_NAME, birthAt: Date.UTC(2026, 5, 1) }, family.id),
    ]);
    const token = await shareToken(admin.token, 'timeline', randomUUID(), {
      display: display({ showAvatar: true }),
    });
    const page = await call<PublicTimelineResponse>(app, 'POST', '/v1/public/share/timeline', {
      body: { token },
    });
    expect(page.json.baby.avatarUrl).toBeNull();
  });
});

describe('按创建时的设置', () => {
  it('之后改了账号的分享设置、改了宝宝的名字，已经发出去的链接不变', async () => {
    const { admin, family, momentId } = await setup();
    const token = await shareToken(admin.token, 'day', momentId, {
      display: display({ nickname: '小宝' }),
    });
    const me = await call<MeResponse>(app, 'GET', '/v1/me', { token: admin.token });
    const prefs = {
      ...me.json.prefs,
      share: {
        ttlDays: 30,
        timeline: 'all',
        display: display({ nickname: '豆豆', showAvatar: true }),
      },
    };
    expect(
      (await call(app, 'PUT', '/v1/me/prefs', { token: admin.token, body: prefs })).status,
    ).toBe(200);
    await sync(admin.token, [
      changeOf('baby', { name: '虚构新名', birthAt: Date.UTC(2026, 5, 1) }, family.id),
    ]);
    const { text, baby } = await open('day', token, momentId);
    expect(baby.name).toBe('小宝');
    expect(baby.avatarUrl ?? null).toBeNull();
    expect(text).not.toContain('虚构新名');
  });

  it('列表里带着每个链接的设置，旧链接按默认值', async () => {
    const { admin, momentId } = await setup();
    const withNickname = await create(admin.token, 'timeline', momentId, {
      display: display({ nickname: '小宝', showAvatar: true }),
    });
    const legacy = await create(admin.token, 'day', momentId, {});
    const list = await call<ShareListResponse>(app, 'GET', '/v1/shares', { token: admin.token });
    const byId = new Map(list.json.shares.map((share) => [share.id, share]));
    expect(byId.get(withNickname.json.id)?.display).toEqual(
      display({ nickname: '小宝', showAvatar: true }),
    );
    expect(byId.get(legacy.json.id)?.display).toEqual(display());
  });

  it('称呼前后的空格去掉；太长、换行的不收', async () => {
    const { admin, momentId } = await setup();
    const token = await shareToken(admin.token, 'day', momentId, {
      display: display({ nickname: '  小宝  ' }),
    });
    expect((await open('day', token, momentId)).baby.name).toBe('小宝');
    for (const nickname of ['豆'.repeat(21), '小\n宝']) {
      const bad = await create(admin.token, 'moments', momentId, {
        display: display({ nickname }),
      });
      expect(bad.status).toBe(400);
    }
  });
});

describe('设置跟着账号', () => {
  it('/v1/config 说明服务端认识这些选项', async () => {
    const config = await call<PublicConfig>(app, 'GET', '/v1/config');
    expect(config.json.shareDisplay).toBe(true);
  });

  it('存进偏好；旧版 App 写偏好时不带 share，原来的留着', async () => {
    const { admin } = await setup();
    const me = await call<MeResponse>(app, 'GET', '/v1/me', { token: admin.token });
    const share = { ttlDays: 1, timeline: 'week', display: display({ showName: false }) };
    await call(app, 'PUT', '/v1/me/prefs', {
      token: admin.token,
      body: { ...me.json.prefs, share },
    });
    expect(
      (await call<MeResponse>(app, 'GET', '/v1/me', { token: admin.token })).json.prefs.share,
    ).toEqual(share);
    // v0.8.0 的 App 不认识 share，解析 /v1/me 时就丢了，写回来的偏好里没有它。
    const { share: _dropped, ...old } = me.json.prefs;
    const put = await call(app, 'PUT', '/v1/me/prefs', {
      token: admin.token,
      body: { ...old, feedReminder: false },
    });
    expect(put.status).toBe(200);
    const after = await call<MeResponse>(app, 'GET', '/v1/me', { token: admin.token });
    expect(after.json.prefs.feedReminder).toBe(false);
    expect(after.json.prefs.share).toEqual(share);
  });
});
