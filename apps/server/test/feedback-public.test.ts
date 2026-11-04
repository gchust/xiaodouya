/**
 * 反馈附件公开（F-126，仓库所有者 2026-11-04 的决定）：新版 App 提交时说“已同意公开附件”，
 * issue 正文才嵌入附件的公开链接。旧版 App 不会说，它当时承诺过“照片和视频不公开”，
 * 这些反馈一律不生成令牌、正文里没有链接。
 */
import { randomUUID } from 'node:crypto';
import type {
  CreateFeedbackResponse,
  FeedbackInboxResponse,
  PublicConfig,
} from '@xiaodouya/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { type Config, loadConfig } from '../src/config';
import type { Sql } from '../src/db';
import { runMaintenance } from '../src/maintenance';
import { type FakeGithub, startFakeGithub } from './fake-github';
import {
  type App,
  backgroundTasks,
  call,
  newUser,
  openTestDb,
  PASSWORD,
  type TestDb,
  testEnv,
} from './harness';

const TOKEN = 'github_pat_FICTIONAL_public_0123456789';
const REPO = 'fictional-owner/fictional-repo';
const PUBLIC_URL = 'https://api.fictional.test/functions/v1/api';
const VIEWER = 'maintainer-public@example.test';
const FILE_PATH = '/v1/public/feedback-files/';

let db: TestDb;
let github: FakeGithub;
let bg: ReturnType<typeof backgroundTasks>;
let config: Config;
let app: App;

function feedbackConfig(env: Record<string, string> = {}): Config {
  return loadConfig({
    ...testEnv(),
    FEEDBACK_GITHUB_REPO: REPO,
    FEEDBACK_GITHUB_TOKEN: TOKEN,
    FEEDBACK_GITHUB_API_URL: github.url,
    FEEDBACK_VIEWER_EMAILS: VIEWER,
    PUBLIC_API_URL: PUBLIC_URL,
    ...env,
  });
}

const makeApp = (c: Config, sql: Sql = db.sql) =>
  createApp({ sql, config: c, background: bg.background });

beforeAll(async () => {
  db = await openTestDb('feedback_public');
  github = await startFakeGithub(TOKEN);
});
afterAll(async () => {
  await github.close();
  await db.close();
});
beforeEach(async () => {
  await db.sql`DELETE FROM rate_limits`;
  github.issues.length = 0;
  github.attempts = 0;
  github.failNext(0);
  bg = backgroundTasks();
  config = feedbackConfig();
  app = makeApp(config);
});
afterEach(() => {
  vi.restoreAllMocks();
});

const diagnostics = { appVersion: '0.4.0', os: 'android', osVersion: '15', locale: 'zh' };
// 不是真的 JPEG，只要字节能原样取回来。
const IMAGE = Buffer.from('xiaodouya-fictional-public-feedback-image');
const VIDEO = Buffer.from('xiaodouya-fictional-public-feedback-video');

type Failure = { error: { code: string } };

interface Sent {
  id: string;
  files: { id: string; mime: string; size: number }[];
  status: string;
}

/** 建草稿、传附件、提交。publicAttachments 不传就是旧版 App 的请求。 */
async function send(
  token: string,
  {
    publicAttachments,
    files = [{ mime: 'image/jpeg', bytes: IMAGE }],
    target = app,
  }: {
    publicAttachments?: boolean;
    files?: { mime: string; bytes: typeof IMAGE }[];
    target?: App;
  } = {},
): Promise<Sent> {
  const id = randomUUID();
  const attachments = files.map((f) => ({ id: randomUUID(), mime: f.mime, size: f.bytes.length }));
  const created = await call<CreateFeedbackResponse & Failure>(target, 'POST', '/v1/feedback', {
    token,
    body: {
      id,
      text: `截图里是闪退前的页面 ${id.slice(0, 4)}`,
      diagnostics,
      attachments,
      ...(publicAttachments === undefined ? {} : { publicAttachments }),
    },
  });
  expect(created.status).toBe(201);
  for (const upload of created.json.uploads) {
    const bytes = files[attachments.findIndex((a) => a.id === upload.id)]!.bytes;
    const put = await fetch(upload.url, { method: 'PUT', headers: upload.headers, body: bytes });
    expect(put.status).toBe(200);
  }
  const submitted = await call<{ status: string }>(target, 'POST', `/v1/feedback/${id}/submit`, {
    token,
  });
  expect(submitted.status).toBe(200);
  return { id, files: attachments, status: submitted.json.status };
}

const issueFor = (id: string) => github.issues.find((i) => i.body.includes(id));

/** 正文里的公开链接，按出现的顺序。 */
const linksIn = (body: string) =>
  [...body.matchAll(/\((https?:\/\/[^)\s]+\/v1\/public\/feedback-files\/([^)\s]+))\)/g)].map(
    (m) => ({ url: m[1]!, token: m[2]! }),
  );

const tokenRows = (feedbackId: string) =>
  db.sql<{ id: string; mime: string; public_token: string | null }[]>`
    SELECT id, mime, public_token FROM feedback_attachments WHERE feedback_id = ${feedbackId}`;

/** 同一个事务里插入的附件 created_at 一样，顺序不定，按类型排好再比。 */
const tokensOf = async (feedbackId: string) =>
  (await tokenRows(feedbackId))
    .sort((a, b) => a.mime.localeCompare(b.mime))
    .map((r) => r.public_token);

/** 打开公开链接：不跟随跳转，看服务端自己的响应。 */
const open = (token: string, target: App = app, headers: Record<string, string> = {}) =>
  target.request(`${FILE_PATH}${token}`, { method: 'GET', redirect: 'manual', headers });

describe('公开配置', () => {
  it('配了 PUBLIC_API_URL 和平台存储才说附件会公开', async () => {
    const on = await call<PublicConfig>(app, 'GET', '/v1/config');
    expect(on.json.feedback?.publicAttachments).toBe(true);
    const off = await call<PublicConfig>(
      makeApp(feedbackConfig({ PUBLIC_API_URL: '' })),
      'GET',
      '/v1/config',
    );
    expect(off.json.feedback?.publicAttachments).toBe(false);
    expect(off.text).not.toContain('fictional.test');
  });

  it('PUBLIC_API_URL 不是 http(s) 地址时拒绝启动', () => {
    expect(() => feedbackConfig({ PUBLIC_API_URL: 'api.fictional.test' })).toThrow(
      /PUBLIC_API_URL/,
    );
    expect(() => feedbackConfig({ PUBLIC_API_URL: 'ftp://api.fictional.test' })).toThrow(
      /PUBLIC_API_URL/,
    );
  });
});

describe('新版 App 同意公开附件', () => {
  it('issue 正文嵌入图片、视频写成链接，打开后跳到 10 分钟的签名链接，能取到文件', async () => {
    const user = await newUser(app);
    const sent = await send(user.token, {
      publicAttachments: true,
      files: [
        { mime: 'image/jpeg', bytes: IMAGE },
        { mime: 'video/mp4', bytes: VIDEO },
      ],
    });
    expect(sent.status).toBe('sent');
    const body = issueFor(sent.id)!.body;
    const links = linksIn(body);
    expect(links).toHaveLength(2);
    const rows = await tokenRows(sent.id);
    const tokenFor = (mime: string) => rows.find((r) => r.mime === mime)!.public_token!;
    const urlFor = (mime: string) => `${PUBLIC_URL}${FILE_PATH}${tokenFor(mime)}`;
    // 图片用 ![]() 嵌入，视频是普通链接（GitHub 不会把外链视频放进播放器）。
    expect(body).toMatch(
      new RegExp(`!\\[图片 1（[^\\]]*）\\]\\(${escapeRegExp(urlFor('image/jpeg'))}\\)`),
    );
    expect(body).toMatch(
      new RegExp(`(^|[^!])\\[视频 1（[^\\]]*）\\]\\(${escapeRegExp(urlFor('video/mp4'))}\\)`, 'm'),
    );
    expect(links.map((l) => l.token).sort()).toEqual(rows.map((r) => r.public_token).sort());

    for (const mime of ['image/jpeg', 'video/mp4']) {
      const link = { token: tokenFor(mime) };
      const response = await open(link.token);
      expect(response.status).toBe(302);
      expect(response.headers.get('cache-control')).toContain('no-store');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
      const location = response.headers.get('location')!;
      expect(Number(new URL(location).searchParams.get('X-Amz-Expires'))).toBeLessThanOrEqual(600);
      const file = await fetch(location);
      expect(file.status).toBe(200);
      // GitHub 的图片代理只转发 image/* 的响应。
      expect(file.headers.get('content-type')).toBe(mime);
      const bytes = Buffer.from(await file.arrayBuffer());
      expect(bytes.equals(mime === 'image/jpeg' ? IMAGE : VIDEO)).toBe(true);
    }

    // 正文里仍然没有附件 id、对象路径和签名。
    const everything = `${issueFor(sent.id)!.title}\n${body}`;
    for (const secret of [
      ...sent.files.map((f) => f.id),
      user.email,
      user.user.id,
      `feedback/${sent.id}`,
      'X-Amz',
      'localhost:59000',
    ]) {
      expect(everything).not.toContain(secret);
    }
  });

  it('令牌足够长，和反馈 id、附件 id、对象路径没有关系，每个附件不一样', async () => {
    const user = await newUser(app);
    const sent = await send(user.token, {
      publicAttachments: true,
      files: [
        { mime: 'image/jpeg', bytes: IMAGE },
        { mime: 'image/jpeg', bytes: IMAGE },
      ],
    });
    const tokens = (await tokensOf(sent.id)) as string[];
    expect(new Set(tokens).size).toBe(2);
    for (const token of tokens) {
      // 32 字节随机数的 base64url：256 位，远超 128 位。
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const hexish = token.toLowerCase().replace(/[^0-9a-f]/g, '');
      for (const id of [sent.id, ...sent.files.map((f) => f.id)]) {
        expect(token).not.toContain(id);
        expect(hexish).not.toContain(id.replace(/-/g, '').slice(0, 8));
      }
    }
  });

  it('GitHub 失败后重试，正文里还是同一批链接', async () => {
    const user = await newUser(app);
    github.failNext(1, 502);
    const sent = await send(user.token, { publicAttachments: true });
    expect(sent.status).toBe('queued');
    const [before] = await tokensOf(sent.id);
    expect(before).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await db.sql`UPDATE feedback SET next_attempt_at = now() WHERE id = ${sent.id}`;
    expect((await runMaintenance(db.sql, config)).feedbackSent).toBeGreaterThanOrEqual(1);
    expect(linksIn(issueFor(sent.id)!.body).map((l) => l.token)).toEqual([before]);
  });

  it('没有 PUBLIC_API_URL 的维护任务不发带公开附件的反馈，等配好的进程来发', async () => {
    const user = await newUser(app);
    github.failNext(1, 502);
    const sent = await send(user.token, { publicAttachments: true });
    expect(sent.status).toBe('queued');
    await db.sql`UPDATE feedback SET next_attempt_at = now() WHERE id = ${sent.id}`;
    const withoutUrl = feedbackConfig({ PUBLIC_API_URL: '' });
    await runMaintenance(db.sql, withoutUrl);
    expect(issueFor(sent.id)).toBeUndefined();
    const [row] = await db.sql<
      { status: string }[]
    >`SELECT status FROM feedback WHERE id = ${sent.id}`;
    expect(row?.status).toBe('queued');
    await db.sql`UPDATE feedback SET next_attempt_at = now() WHERE id = ${sent.id}`;
    await runMaintenance(db.sql, config);
    expect(linksIn(issueFor(sent.id)!.body)).toHaveLength(1);
  });

  it('草稿还没提交时没有令牌', async () => {
    const user = await newUser(app);
    const id = randomUUID();
    await call(app, 'POST', '/v1/feedback', {
      token: user.token,
      body: {
        id,
        text: '还在写',
        diagnostics,
        attachments: [{ id: randomUUID(), mime: 'image/jpeg', size: IMAGE.length }],
        publicAttachments: true,
      },
    });
    expect(await tokensOf(id)).toEqual([null]);
  });

  it('不是常见图片和视频格式的附件不公开（比如 SVG），其余照常公开', async () => {
    const user = await newUser(app);
    const sent = await send(user.token, {
      publicAttachments: true,
      files: [
        { mime: 'image/svg+xml', bytes: IMAGE },
        { mime: 'image/png', bytes: IMAGE },
      ],
    });
    const rows = await tokenRows(sent.id);
    expect(rows.find((r) => r.mime === 'image/svg+xml')?.public_token).toBeNull();
    expect(rows.find((r) => r.mime === 'image/png')?.public_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const body = issueFor(sent.id)!.body;
    expect(linksIn(body)).toHaveLength(1);
    expect(body).toContain('1 个不公开');
  });

  it('维护者在 App 里能看出这一条的附件是公开的', async () => {
    const user = await newUser(app);
    const sent = await send(user.token, { publicAttachments: true });
    const legacy = await send(user.token);
    const maintainer = await newUser(app);
    await db.sql`UPDATE users SET email = ${VIEWER} WHERE id = ${maintainer.user.id}`;
    const inbox = await call<FeedbackInboxResponse>(app, 'GET', '/v1/feedback-inbox?limit=50', {
      token: maintainer.token,
    });
    const flag = (id: string) => inbox.json.items.find((i) => i.id === id)?.publicAttachments;
    expect(flag(sent.id)).toBe(true);
    expect(flag(legacy.id)).toBe(false);
    expect(JSON.stringify(inbox.json)).not.toContain(FILE_PATH);
  });
});

describe('之前提交的反馈不公开', () => {
  it('旧版 App 不说同意：没有令牌，正文没有任何链接，还写着不公开', async () => {
    const user = await newUser(app);
    const sent = await send(user.token);
    expect(sent.status).toBe('sent');
    expect(await tokensOf(sent.id)).toEqual([null]);
    const body = issueFor(sent.id)!.body;
    expect(linksIn(body)).toEqual([]);
    expect(body).not.toContain('http://');
    expect(body).not.toContain('https://');
    expect(body).toContain('不公开');
  });

  it('明确说不同意也一样', async () => {
    const user = await newUser(app);
    const sent = await send(user.token, { publicAttachments: false });
    expect(await tokensOf(sent.id)).toEqual([null]);
    expect(linksIn(issueFor(sent.id)!.body)).toEqual([]);
  });

  it('改版前排在队列里的反馈，改版后补发时也不生成令牌', async () => {
    const user = await newUser(app);
    github.failNext(1, 502);
    const sent = await send(user.token);
    expect(sent.status).toBe('queued');
    // 模拟改版前存下的行：列是迁移加的默认值。
    const [row] = await db.sql<{ public_attachments: boolean }[]>`
      SELECT public_attachments FROM feedback WHERE id = ${sent.id}`;
    expect(row?.public_attachments).toBe(false);
    await db.sql`UPDATE feedback SET next_attempt_at = now() WHERE id = ${sent.id}`;
    await runMaintenance(db.sql, config);
    expect(linksIn(issueFor(sent.id)!.body)).toEqual([]);
    expect(await tokensOf(sent.id)).toEqual([null]);
  });

  it('草稿先说同意、最后一次保存没说（换回了旧版 App），按最后一次算', async () => {
    const user = await newUser(app);
    const id = randomUUID();
    const file = { id: randomUUID(), mime: 'image/jpeg', size: IMAGE.length };
    const body = { id, text: '同一份草稿', diagnostics, attachments: [file] };
    const first = await call<CreateFeedbackResponse>(app, 'POST', '/v1/feedback', {
      token: user.token,
      body: { ...body, publicAttachments: true },
    });
    const put = await fetch(first.json.uploads[0]!.url, {
      method: 'PUT',
      headers: first.json.uploads[0]!.headers,
      body: IMAGE,
    });
    expect(put.status).toBe(200);
    await call(app, 'POST', '/v1/feedback', { token: user.token, body });
    await call(app, 'POST', `/v1/feedback/${id}/submit`, { token: user.token });
    expect(await tokensOf(id)).toEqual([null]);
    expect(linksIn(issueFor(id)!.body)).toEqual([]);
  });

  it('已经提交的反馈，再用同一个 id 说同意也改不了', async () => {
    const user = await newUser(app);
    const sent = await send(user.token);
    await call(app, 'POST', '/v1/feedback', {
      token: user.token,
      body: {
        id: sent.id,
        text: 'x',
        diagnostics,
        attachments: sent.files,
        publicAttachments: true,
      },
    });
    const [row] = await db.sql<{ public_attachments: boolean }[]>`
      SELECT public_attachments FROM feedback WHERE id = ${sent.id}`;
    expect(row?.public_attachments).toBe(false);
    expect(await tokensOf(sent.id)).toEqual([null]);
  });

  it('服务器没有 PUBLIC_API_URL 时同意了也不生成令牌', async () => {
    const plain = makeApp(feedbackConfig({ PUBLIC_API_URL: '' }));
    const user = await newUser(plain);
    const sent = await send(user.token, { publicAttachments: true, target: plain });
    expect(sent.status).toBe('sent');
    expect(await tokensOf(sent.id)).toEqual([null]);
    expect(linksIn(issueFor(sent.id)!.body)).toEqual([]);
  });
});

describe('公开链接', () => {
  it('错的令牌、格式不对、拿反馈 id 和附件 id 去试都是同一个 404', async () => {
    const user = await newUser(app);
    const sent = await send(user.token, { publicAttachments: true });
    const [real] = (await tokensOf(sent.id)) as string[];
    const flipped = `${real!.slice(0, -1)}${real!.endsWith('A') ? 'B' : 'A'}`;
    const bodies = new Set<string>();
    for (const guess of [
      flipped,
      'A'.repeat(43),
      sent.id,
      sent.files[0]!.id,
      `feedback%2F${sent.id}%2F${sent.files[0]!.id}`,
      'short',
      `${real}x`,
    ]) {
      const response = await open(guess);
      expect(response.status).toBe(404);
      expect(response.headers.get('location')).toBeNull();
      expect(response.headers.get('cache-control')).toContain('no-store');
      bodies.add(await response.text());
    }
    expect(bodies.size).toBe(1);
    expect((await open(real!)).status).toBe(302);
  });

  it('不用登录：带了别人的登录令牌也不影响', async () => {
    const user = await newUser(app);
    const sent = await send(user.token, { publicAttachments: true });
    const [token] = (await tokensOf(sent.id)) as string[];
    expect((await open(token!)).status).toBe(302);
    const other = await newUser(app);
    expect((await open(token!, app, { authorization: `Bearer ${other.token}` })).status).toBe(302);
  });

  it('过了保留期删掉附件后 404', async () => {
    const user = await newUser(app);
    const sent = await send(user.token, { publicAttachments: true });
    const [token] = (await tokensOf(sent.id)) as string[];
    expect((await open(token!)).status).toBe(302);
    await db.sql`UPDATE feedback SET sent_at = now() - interval '91 days' WHERE id = ${sent.id}`;
    expect((await runMaintenance(db.sql, config)).feedbackAttachmentsExpired).toBe(1);
    expect((await open(token!)).status).toBe(404);
  });

  it('删除账号后 404', async () => {
    const user = await newUser(app);
    const sent = await send(user.token, { publicAttachments: true });
    const [token] = (await tokensOf(sent.id)) as string[];
    expect((await open(token!)).status).toBe(302);
    const deleted = await call(app, 'POST', '/v1/me/delete', {
      token: user.token,
      body: { password: PASSWORD },
    });
    expect(deleted.status).toBe(200);
    await bg.flush();
    expect((await open(token!)).status).toBe(404);
  });

  it('按令牌限流：不存在的令牌也一样计数，从 429 看不出它存不存在', async () => {
    const limited = makeApp(feedbackConfig({ RATE_PUBLIC_FEEDBACK_FILE_PER_TOKEN_HOUR: '2' }));
    const user = await newUser(limited);
    const sent = await send(user.token, { publicAttachments: true, target: limited });
    const [token] = (await tokensOf(sent.id)) as string[];
    expect((await open(token!, limited)).status).toBe(302);
    expect((await open(token!, limited)).status).toBe(302);
    const third = await open(token!, limited);
    expect(third.status).toBe(429);
    expect(third.headers.get('location')).toBeNull();
    const missing = 'B'.repeat(43);
    expect((await open(missing, limited)).status).toBe(404);
    expect((await open(missing, limited)).status).toBe(404);
    expect((await open(missing, limited)).status).toBe(429);
  });

  it('按来源限流：换令牌绕不过', async () => {
    const limited = makeApp(feedbackConfig({ RATE_PUBLIC_FEEDBACK_FILE_PER_IP_15MIN: '3' }));
    const ip = { 'x-forwarded-for': '203.0.113.7' };
    for (let i = 0; i < 3; i++) {
      expect((await open(`${'C'.repeat(42)}${i}`, limited, ip)).status).toBe(404);
    }
    expect((await open(`${'C'.repeat(42)}9`, limited, ip)).status).toBe(429);
    expect(
      (await open(`${'C'.repeat(42)}9`, limited, { 'x-forwarded-for': '203.0.113.8' })).status,
    ).toBe(404);
  });

  it('日志里没有令牌和签名链接：正常打开、打不开、数据库出错时都是', async () => {
    const logs: string[] = [];
    for (const level of ['log', 'info', 'warn', 'error'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logs.push(args.map(String).join(' '));
      });
    }
    const user = await newUser(app);
    const sent = await send(user.token, { publicAttachments: true });
    const [token] = (await tokensOf(sent.id)) as string[];
    expect((await open(token!)).status).toBe(302);
    expect((await open(`${token!.slice(0, 42)}Z`)).status).toBe(404);
    // 数据库挂了：请求里的路径带着令牌，出错时不能把路径写进日志。
    const broken = (() => {
      throw new Error(`连接失败 ${token}`);
    }) as unknown as Sql;
    const down = await open(token!, makeApp(config, broken));
    expect([404, 503]).toContain(down.status);
    expect(down.headers.get('location')).toBeNull();
    const text = logs.join('\n');
    expect(text).not.toContain(token);
    expect(text).not.toContain(token!.slice(0, 20));
    expect(text).not.toContain('X-Amz');
  });
});

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
