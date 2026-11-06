import { randomUUID } from 'node:crypto';
import type {
  CreateShareResponse,
  FamilyExport,
  MediaUrlsResponse,
  MeResponse,
  PublicTimelineResponse,
  ServerRecord,
  SyncResponse,
} from '@xiaodouya/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { processPendingDeletions } from '../src/objectDeletions';
import { headObject, type ResolvedStorage, storageById } from '../src/storage';
import {
  type App,
  backgroundTasks,
  call,
  join,
  newFamily,
  OBJECT_BYTES,
  openTestDb,
  PASSWORD,
  type TestDb,
  upload,
} from './harness';

/**
 * 家人自己的证件夹（F-137，issue #89）。安全上最要紧的是：没被选中的家人从任何接口都拿不到别人的证件。
 * 旧版 App（v0.7.0 及以前）不认识 owner、sharedWith，它和新版走同一个 `/v1/sync`、从游标 0 拉全家的记录，
 * 所以这里的“拉取”就是旧版的路径：不带任何新参数，过滤只能在服务端。
 * 真实的 Postgres 和 S3 兼容服务，所有名字和号码都是虚构的。
 */

let db: TestDb;
let app: App;
let bg: ReturnType<typeof backgroundTasks>;
let envStorage: ResolvedStorage;
const logged: string[] = [];

beforeAll(async () => {
  db = await openTestDb('personal_docs');
  envStorage = (await storageById(db.sql, db.config, randomUUID(), null))!;
});
afterAll(async () => {
  await db.close();
});
beforeEach(() => {
  bg = backgroundTasks();
  app = createApp({ sql: db.sql, config: db.config, background: bg.background });
  logged.length = 0;
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '));
    });
  }
});
afterEach(() => {
  vi.restoreAllMocks();
});

const NUMBER = 'S0000000Z';
const PRIVATE_NUMBER = 'T1111111Q';

const change = (
  collection: string,
  data: unknown,
  id: string = randomUUID(),
  extra: { deleted?: boolean; updatedAt?: number } = {},
) => ({
  id,
  collection,
  data,
  deleted: extra.deleted ?? false,
  updatedAt: extra.updatedAt ?? Date.now(),
});

async function push(token: string, changes: ReturnType<typeof change>[]) {
  const result = await call<SyncResponse>(app, 'POST', '/v1/sync', {
    token,
    body: { cursor: 0, changes },
  });
  expect(result.status).toBe(200);
  return result.json;
}

/** 和 App（新旧都一样）一样翻页拉到底。 */
async function pull(token: string, cursor = 0) {
  const records = new Map<string, ServerRecord>();
  const raw: string[] = [];
  let next = cursor;
  for (;;) {
    const result = await call<SyncResponse>(app, 'POST', '/v1/sync', {
      token,
      body: { cursor: next, changes: [] },
    });
    expect(result.status).toBe(200);
    raw.push(result.text);
    for (const r of result.json.records) records.set(r.id, r);
    next = result.json.cursor;
    if (!result.json.hasMore) break;
  }
  return { records, cursor: next, text: raw.join('\n') };
}

const fileRef = (id: string, name = 'id-card.jpg') => ({
  id,
  kind: 'image',
  mime: 'image/jpeg',
  size: OBJECT_BYTES.length,
  name,
});

const personalDoc = (owner: string, sharedWith: string[], extra: Record<string, unknown> = {}) => ({
  name: '身份证',
  number: NUMBER,
  files: [],
  owner,
  sharedWith,
  ...extra,
});

async function urlsFor(token: string, ids: string[]) {
  const result = await call<MediaUrlsResponse>(app, 'POST', '/v1/media/urls', {
    token,
    body: {
      items: ids.flatMap((id) => [
        { id, variant: 'original' },
        { id, variant: 'thumb' },
      ]),
    },
  });
  expect(result.status).toBe(200);
  return result.json.urls;
}

const canFetch = async (token: string, id: string) =>
  (await urlsFor(token, [id])).some((u) => u.url !== null);

async function uploadPersonal(token: string, scope = 'personal') {
  const id = randomUUID();
  await upload(app, token, { id, scope });
  await upload(app, token, { id, scope, variant: 'thumb' });
  return id;
}

/** 爸爸（管理员）、妈妈和阿姨（一起记录）、外公（只看回忆）。妈妈有两份证件：一份给爸爸看，一份谁都不给。 */
async function setup() {
  const { admin, family } = await newFamily(app, '爸爸');
  const mom = await join(app, admin.token, 'caregiver', '妈妈');
  const aunt = await join(app, admin.token, 'caregiver', '阿姨');
  const grandpa = await join(app, admin.token, 'viewer', '外公');
  await push(admin.token, [
    change('baby', { name: '测试豆', birthAt: Date.UTC(2026, 5, 1) }, family.id),
  ]);
  const babyDoc = randomUUID();
  await push(admin.token, [change('document', { name: '出生证明', files: [] }, babyDoc)]);
  const sharedFile = await uploadPersonal(mom.token);
  const privateFile = await uploadPersonal(mom.token);
  const shared = randomUUID();
  const hidden = randomUUID();
  const pushed = await push(mom.token, [
    change(
      'document',
      personalDoc(mom.user.id, [admin.user.id], { files: [fileRef(sharedFile)] }),
      shared,
    ),
    change(
      'document',
      personalDoc(mom.user.id, [], {
        name: '医保卡',
        number: PRIVATE_NUMBER,
        files: [fileRef(privateFile, 'insurance.jpg')],
      }),
      hidden,
    ),
  ]);
  expect(pushed.rejected).toEqual([]);
  return { admin, family, mom, aunt, grandpa, babyDoc, shared, hidden, sharedFile, privateFile };
}

const isStub = (r: ServerRecord | undefined) =>
  r?.deleted === true && r.data === null && r.createdBy === null;

describe('同步：旧版和新版走同一条路，过滤在服务端', () => {
  it('没被选中的家人只收到一个删除标记，内容、号码、文件 id 一个字都没有', async () => {
    const s = await setup();
    const aunt = await pull(s.aunt.token);
    expect(aunt.records.get(s.babyDoc)?.data).toMatchObject({ name: '出生证明' });
    expect(isStub(aunt.records.get(s.shared))).toBe(true);
    expect(isStub(aunt.records.get(s.hidden))).toBe(true);
    for (const secret of [NUMBER, PRIVATE_NUMBER, '医保卡', s.sharedFile, s.privateFile]) {
      expect(aunt.text).not.toContain(secret);
    }
    expect(aunt.text).not.toContain('身份证');
  });

  it('被选中的家人收到完整内容；没选他的那份同样只是删除标记', async () => {
    const s = await setup();
    const dad = await pull(s.admin.token);
    expect(dad.records.get(s.shared)?.data).toMatchObject({
      name: '身份证',
      number: NUMBER,
      owner: s.mom.user.id,
    });
    expect(isStub(dad.records.get(s.hidden))).toBe(true);
    expect(dad.text).not.toContain(PRIVATE_NUMBER);
  });

  it('本人收到自己的全部', async () => {
    const s = await setup();
    const mom = await pull(s.mom.token);
    expect(mom.records.get(s.hidden)?.data).toMatchObject({ number: PRIVATE_NUMBER });
    expect(mom.records.get(s.shared)?.data).toMatchObject({ number: NUMBER });
  });

  it('只看回忆的家人就算被选中也收不到，连删除标记都没有', async () => {
    const s = await setup();
    await push(s.mom.token, [
      change(
        'document',
        personalDoc(s.mom.user.id, [s.admin.user.id, s.grandpa.user.id]),
        s.shared,
      ),
    ]);
    const grandpa = await pull(s.grandpa.token);
    expect(grandpa.records.has(s.shared)).toBe(false);
    expect(grandpa.records.has(s.babyDoc)).toBe(false);
    expect(grandpa.text).not.toContain(NUMBER);
  });

  it('翻页时也一样：分好几页拉，游标照常走到底', async () => {
    const s = await setup();
    const many = Array.from({ length: 250 }, () =>
      change('event', { type: 'diaper', at: Date.now(), kind: 'wee' }),
    );
    await push(s.admin.token, many.slice(0, 200));
    await push(s.admin.token, many.slice(200));
    await push(s.mom.token, [
      change('document', personalDoc(s.mom.user.id, [], { number: 'LATE-0001' })),
    ]);
    const aunt = await pull(s.aunt.token);
    expect(aunt.text).not.toContain('LATE-0001');
    const [family] = await db.sql<
      { seq: string }[]
    >`SELECT seq FROM families WHERE id = ${s.family.id}`;
    expect(aunt.cursor).toBe(Number(family?.seq));
  });

  it('猜到 id 写一条：被拒绝，补发的也只是删除标记', async () => {
    const s = await setup();
    const result = await push(s.aunt.token, [
      change('document', { name: '我改的', files: [] }, s.hidden),
    ]);
    expect(result.rejected).toEqual([{ id: s.hidden, reason: 'forbidden' }]);
    const back = result.records.find((r) => r.id === s.hidden);
    expect(isStub(back)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(PRIVATE_NUMBER);
  });
});

describe('谁能写', () => {
  it('被选中的家人（哪怕是管理员、用旧版 App）改不了、删不了，补发回来的是原来的', async () => {
    const s = await setup();
    const edit = await push(s.admin.token, [
      change('document', personalDoc(s.mom.user.id, [s.admin.user.id], { number: 'X' }), s.shared),
    ]);
    expect(edit.rejected).toEqual([{ id: s.shared, reason: 'forbidden' }]);
    expect(edit.records.find((r) => r.id === s.shared)?.data).toMatchObject({ number: NUMBER });
    const remove = await push(s.admin.token, [
      change('document', personalDoc(s.mom.user.id, [s.admin.user.id]), s.shared, {
        deleted: true,
      }),
    ]);
    expect(remove.rejected).toEqual([{ id: s.shared, reason: 'forbidden' }]);
    const mom = await pull(s.mom.token);
    expect(mom.records.get(s.shared)?.deleted).toBe(false);
  });

  it('不能替别人建证件，也不能把宝宝的证件变成自己的', async () => {
    const s = await setup();
    const forged = randomUUID();
    const result = await push(s.aunt.token, [
      change('document', personalDoc(s.mom.user.id, [s.aunt.user.id]), forged),
      change('document', personalDoc(s.aunt.user.id, []), s.babyDoc),
    ]);
    expect(result.rejected).toEqual([
      { id: forged, reason: 'forbidden' },
      { id: s.babyDoc, reason: 'forbidden' },
    ]);
    const dad = await pull(s.admin.token);
    expect(dad.records.get(s.babyDoc)?.data).toMatchObject({ name: '出生证明' });
    expect(dad.records.has(forged)).toBe(false);
  });

  it('本人也不能去掉 owner：去掉就成了全家的', async () => {
    const s = await setup();
    const result = await push(s.mom.token, [
      change('document', { name: '身份证', number: NUMBER, files: [] }, s.hidden),
    ]);
    expect(result.rejected).toEqual([{ id: s.hidden, reason: 'forbidden' }]);
    expect(isStub((await pull(s.aunt.token)).records.get(s.hidden))).toBe(true);
  });

  it('owner 不是 UUID 的整条不收', async () => {
    const s = await setup();
    const id = randomUUID();
    const result = await push(s.aunt.token, [
      change('document', { name: '身份证', files: [], owner: 'me' }, id),
    ]);
    expect(result.rejected).toEqual([{ id, reason: 'invalid' }]);
  });

  it('离线建好又删掉才同步上来：删除标记里带着内容，也只发给本人', async () => {
    const s = await setup();
    const id = randomUUID();
    const result = await push(s.mom.token, [
      change('document', personalDoc(s.mom.user.id, [], { number: 'GONE-0001' }), id, {
        deleted: true,
      }),
    ]);
    expect(result.rejected).toEqual([]);
    const aunt = await pull(s.aunt.token);
    expect(isStub(aunt.records.get(id))).toBe(true);
    expect(aunt.text).not.toContain('GONE-0001');
  });

  it('只看回忆的家人建不了自己的证件，也传不了证件文件', async () => {
    const s = await setup();
    const id = randomUUID();
    const result = await push(s.grandpa.token, [
      change('document', personalDoc(s.grandpa.user.id, []), id),
    ]);
    expect(result.rejected).toEqual([{ id, reason: 'forbidden' }]);
    const url = await call(app, 'POST', '/v1/media/upload-url', {
      token: s.grandpa.token,
      body: {
        id: randomUUID(),
        scope: 'personal',
        variant: 'original',
        mime: 'image/jpeg',
        size: 10,
      },
    });
    expect(url.status).toBe(403);
  });
});

describe('文件的签名链接', () => {
  it('本人和被选中的家人拿得到，有效期不超过 10 分钟；其他人、只看回忆的拿不到', async () => {
    const s = await setup();
    const mine = await urlsFor(s.mom.token, [s.sharedFile, s.privateFile]);
    expect(mine.every((u) => u.url !== null && u.expiresIn > 0 && u.expiresIn <= 600)).toBe(true);
    // 不只看服务端自己报的数字：签进链接里的有效期也不超过 10 分钟。
    for (const u of mine) {
      expect(Number(new URL(u.url ?? '').searchParams.get('X-Amz-Expires'))).toBeLessThanOrEqual(
        600,
      );
    }
    const dad = await urlsFor(s.admin.token, [s.sharedFile, s.privateFile]);
    expect(dad.filter((u) => u.id === s.sharedFile).every((u) => u.url !== null)).toBe(true);
    expect(dad.filter((u) => u.id === s.privateFile).every((u) => u.url === null)).toBe(true);
    expect(dad.every((u) => u.expiresIn <= 600)).toBe(true);
    for (const token of [s.aunt.token, s.grandpa.token]) {
      const urls = await urlsFor(token, [s.sharedFile, s.privateFile]);
      expect(urls.every((u) => u.url === null)).toBe(true);
    }
  });

  it('看过的人把文件 id 写进自己的证件再分享给别人，别人拿不到', async () => {
    const s = await setup();
    await push(s.admin.token, [
      change(
        'document',
        personalDoc(s.admin.user.id, [s.aunt.user.id], { files: [fileRef(s.sharedFile)] }),
      ),
      change('document', { name: '出生证明副本', files: [fileRef(s.sharedFile)] }),
    ]);
    expect(await canFetch(s.aunt.token, s.sharedFile)).toBe(false);
  });

  it('旧版 App 往自己的证件里加的文件（document）按私人证件处理', async () => {
    const s = await setup();
    const legacy = await uploadPersonal(s.mom.token, 'document');
    await push(s.mom.token, [
      change(
        'document',
        personalDoc(s.mom.user.id, [s.admin.user.id], {
          files: [fileRef(s.sharedFile), fileRef(legacy, 'old-app.jpg')],
        }),
        s.shared,
      ),
    ]);
    expect(await canFetch(s.mom.token, legacy)).toBe(true);
    expect(await canFetch(s.admin.token, legacy)).toBe(true);
    expect(await canFetch(s.aunt.token, legacy)).toBe(false);
  });

  it('别人不能用同一个文件 id 去占私人文件，也传不进去', async () => {
    const s = await setup();
    const result = await call(app, 'POST', '/v1/media/upload-url', {
      token: s.aunt.token,
      body: {
        id: s.privateFile,
        scope: 'personal',
        variant: 'preview',
        mime: 'image/jpeg',
        size: 10,
      },
    });
    expect(result.status).toBe(403);
  });
});

describe('撤销和改动', () => {
  it('撤销后马上拿不到新链接；对方下次同步收到删除标记，游标不用回退', async () => {
    const s = await setup();
    const before = await pull(s.admin.token);
    expect(await canFetch(s.admin.token, s.sharedFile)).toBe(true);
    await push(s.mom.token, [
      change(
        'document',
        personalDoc(s.mom.user.id, [], { files: [fileRef(s.sharedFile)] }),
        s.shared,
      ),
    ]);
    expect(await canFetch(s.admin.token, s.sharedFile)).toBe(false);
    const after = await pull(s.admin.token, before.cursor);
    expect(isStub(after.records.get(s.shared))).toBe(true);
    expect(after.text).not.toContain(NUMBER);
  });

  it('后来才选中的家人从自己的游标往后拉就能收到，不会漏', async () => {
    const s = await setup();
    const before = await pull(s.aunt.token);
    expect(isStub(before.records.get(s.hidden))).toBe(true);
    await push(s.mom.token, [
      change(
        'document',
        personalDoc(s.mom.user.id, [s.aunt.user.id], {
          name: '医保卡',
          number: PRIVATE_NUMBER,
          files: [fileRef(s.privateFile, 'insurance.jpg')],
        }),
        s.hidden,
      ),
    ]);
    const after = await pull(s.aunt.token, before.cursor);
    expect(after.records.get(s.hidden)?.data).toMatchObject({ number: PRIVATE_NUMBER });
    expect(await canFetch(s.aunt.token, s.privateFile)).toBe(true);
  });

  it('本人删掉后别人拿不到，撤销删除后又能拿到', async () => {
    const s = await setup();
    const data = personalDoc(s.mom.user.id, [s.admin.user.id], {
      files: [fileRef(s.sharedFile)],
    });
    await push(s.mom.token, [change('document', data, s.shared, { deleted: true })]);
    expect(isStub((await pull(s.admin.token)).records.get(s.shared))).toBe(true);
    expect(await canFetch(s.admin.token, s.sharedFile)).toBe(false);
    expect((await pull(s.mom.token)).records.get(s.shared)?.data).toMatchObject({ number: NUMBER });
    await push(s.mom.token, [change('document', data, s.shared)]);
    expect(await canFetch(s.admin.token, s.sharedFile)).toBe(true);
  });

  it('被选中的家人改成只看回忆就看不到；改回来后从头拉又能看到', async () => {
    const s = await setup();
    const uncle = await join(app, s.admin.token, 'admin', '舅舅');
    await call(app, 'PATCH', `/v1/family/members/${s.admin.user.id}`, {
      token: uncle.token,
      body: { role: 'viewer' },
    });
    expect(await canFetch(s.admin.token, s.sharedFile)).toBe(false);
    expect((await pull(s.admin.token)).records.has(s.shared)).toBe(false);
    await call(app, 'PATCH', `/v1/family/members/${s.admin.user.id}`, {
      token: uncle.token,
      body: { role: 'caregiver' },
    });
    expect((await pull(s.admin.token)).records.get(s.shared)?.data).toMatchObject({
      number: NUMBER,
    });
  });
});

describe('其他接口', () => {
  it('公开配置说明服务端认识家人自己的证件：旧服务端没有这一项，App 不让新建', async () => {
    const result = await call<{ personalDocuments?: boolean }>(app, 'GET', '/v1/config');
    expect(result.json.personalDocuments).toBe(true);
  });

  it('导出：只有本人和被选中的家人导出得到，文件的元数据也一样', async () => {
    const s = await setup();
    const exported = async (token: string) => {
      const result = await call<FamilyExport>(app, 'GET', '/v1/family/export', { token });
      expect(result.status).toBe(200);
      return result;
    };
    const aunt = await exported(s.aunt.token);
    for (const secret of [NUMBER, PRIVATE_NUMBER, s.sharedFile, s.privateFile, 'insurance.jpg']) {
      expect(aunt.text).not.toContain(secret);
    }
    expect(aunt.json.records.some((r) => r.id === s.babyDoc)).toBe(true);
    const dad = await exported(s.admin.token);
    expect(dad.json.records.some((r) => r.id === s.shared)).toBe(true);
    expect(dad.json.media.some((m) => m.id === s.sharedFile)).toBe(true);
    expect(dad.text).not.toContain(PRIVATE_NUMBER);
    expect(dad.json.media.some((m) => m.id === s.privateFile)).toBe(false);
    const mom = await exported(s.mom.token);
    expect(mom.json.records.some((r) => r.id === s.hidden)).toBe(true);
    expect(mom.json.media.some((m) => m.id === s.privateFile)).toBe(true);
  });

  it('分享链接：把证件 id 当成回忆分享出去，公开页上什么都没有', async () => {
    const s = await setup();
    const created = await call<CreateShareResponse>(app, 'POST', '/v1/shares/moments', {
      token: s.admin.token,
      body: {
        momentIds: [s.shared, s.hidden],
        fromAt: Date.UTC(2026, 5, 1),
        toAt: Date.UTC(2026, 5, 2),
        timezone: 'Asia/Singapore',
      },
    });
    expect(created.status).toBe(201);
    const page = await call<PublicTimelineResponse>(app, 'POST', '/v1/public/share/timeline', {
      body: { token: created.json.token },
    });
    expect(page.text).not.toContain(NUMBER);
    expect(page.text).not.toContain(s.sharedFile);
  });

  it('日志里没有证件号、签名链接和令牌', async () => {
    const s = await setup();
    await pull(s.admin.token);
    await urlsFor(s.admin.token, [s.sharedFile]);
    const all = logged.join('\n');
    for (const secret of [NUMBER, PRIVATE_NUMBER, 'X-Amz-Signature', s.mom.token, s.admin.token]) {
      expect(all).not.toContain(secret);
    }
  });
});

describe('离开家庭、删除账号', () => {
  it('本人被移出家庭：别人马上看不到也拿不到文件；回到家庭后自己的证件回来了', async () => {
    const s = await setup();
    const before = await pull(s.admin.token);
    expect(before.records.get(s.shared)?.deleted).toBe(false);
    const removed = await call(app, 'DELETE', `/v1/family/members/${s.mom.user.id}`, {
      token: s.admin.token,
    });
    expect(removed.status).toBe(200);
    expect(await canFetch(s.admin.token, s.sharedFile)).toBe(false);
    const after = await pull(s.admin.token, before.cursor);
    expect(isStub(after.records.get(s.shared))).toBe(true);
    // 记录和文件都留着，不是删除：本人回到家庭后接着用。
    const invite = await call<{ code: string }>(app, 'POST', '/v1/invites', {
      token: s.admin.token,
      body: { role: 'caregiver', label: '妈妈' },
    });
    const login = await call<{ token: string }>(app, 'POST', '/v1/auth/login', {
      body: { email: s.mom.email, password: PASSWORD },
    });
    const accepted = await call<MeResponse>(app, 'POST', '/v1/invites/accept', {
      token: login.json.token,
      body: { code: invite.json.code },
    });
    expect(accepted.status).toBe(200);
    const mom = await pull(login.json.token);
    expect(mom.records.get(s.hidden)?.data).toMatchObject({ number: PRIVATE_NUMBER });
    expect(await canFetch(login.json.token, s.privateFile)).toBe(true);
    // 之前选过的人照样能看（妈妈在“谁能看”里看得到），从自己的游标往后拉就收到。
    const back = await pull(s.admin.token, after.cursor);
    expect(back.records.get(s.shared)?.data).toMatchObject({ number: NUMBER });
  });

  it('被选中的家人被移出家庭：什么都拿不到了', async () => {
    const s = await setup();
    await push(s.mom.token, [
      change('document', personalDoc(s.mom.user.id, [s.aunt.user.id]), s.shared),
    ]);
    await call(app, 'DELETE', `/v1/family/members/${s.aunt.user.id}`, { token: s.admin.token });
    const sync = await call(app, 'POST', '/v1/sync', {
      token: s.aunt.token,
      body: { cursor: 0, changes: [] },
    });
    expect(sync.status).toBe(401);
    const urls = await call(app, 'POST', '/v1/media/urls', {
      token: s.aunt.token,
      body: { items: [{ id: s.sharedFile, variant: 'original' }] },
    });
    expect(urls.status).toBe(401);
  });

  it('本人删除账号：证件的内容和文件立即删除，别人收到删除标记；宝宝的证件和别人的照样在', async () => {
    const s = await setup();
    const babyFile = await uploadPersonal(s.mom.token, 'document');
    await push(s.mom.token, [
      change('document', { name: '疫苗本', files: [fileRef(babyFile, 'vaccine.jpg')] }),
    ]);
    const before = await pull(s.admin.token);
    const keys = await db.sql<{ object_key: string }[]>`
      SELECT object_key FROM media WHERE id = ANY(${[s.sharedFile, s.privateFile]}::uuid[])`;
    expect(keys.length).toBe(4);
    const deleted = await call(app, 'POST', '/v1/me/delete', {
      token: s.mom.token,
      body: { password: PASSWORD },
    });
    expect(deleted.status).toBe(200);
    // 内容立即没了：库里只剩删除标记，用来告诉别人的手机删掉。
    const rows = await db.sql<{ data: unknown; deleted: boolean }[]>`
      SELECT data, deleted FROM records WHERE id = ANY(${[s.shared, s.hidden]}::uuid[])`;
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(row.deleted).toBe(true);
      expect(JSON.stringify(row.data)).not.toContain(NUMBER);
      expect(JSON.stringify(row.data)).not.toContain(PRIVATE_NUMBER);
      expect(JSON.stringify(row.data)).not.toContain(s.sharedFile);
    }
    const media =
      await db.sql`SELECT 1 FROM media WHERE id = ANY(${[s.sharedFile, s.privateFile]}::uuid[])`;
    expect(media.length).toBe(0);
    await bg.flush();
    await processPendingDeletions(db.sql, db.config);
    for (const { object_key } of keys) expect(await headObject(envStorage, object_key)).toBeNull();
    const after = await pull(s.admin.token, before.cursor);
    expect(isStub(after.records.get(s.shared))).toBe(true);
    expect(await canFetch(s.admin.token, babyFile)).toBe(true);
    expect(await canFetch(s.aunt.token, babyFile)).toBe(true);
    expect((await pull(s.admin.token)).records.get(s.babyDoc)?.deleted).toBe(false);
  });

  it('先被移出家庭再删除账号：原来那个家庭里的证件也删掉', async () => {
    const s = await setup();
    await call(app, 'DELETE', `/v1/family/members/${s.mom.user.id}`, { token: s.admin.token });
    const login = await call<{ token: string }>(app, 'POST', '/v1/auth/login', {
      body: { email: s.mom.email, password: PASSWORD },
    });
    const deleted = await call(app, 'POST', '/v1/me/delete', {
      token: login.json.token,
      body: { password: PASSWORD },
    });
    expect(deleted.status).toBe(200);
    const rows = await db.sql<{ data: unknown }[]>`
      SELECT data FROM records WHERE id = ANY(${[s.shared, s.hidden]}::uuid[])`;
    for (const row of rows) expect(JSON.stringify(row.data)).not.toContain(NUMBER);
    const media =
      await db.sql`SELECT 1 FROM media WHERE id = ANY(${[s.sharedFile, s.privateFile]}::uuid[])`;
    expect(media.length).toBe(0);
  });
});
