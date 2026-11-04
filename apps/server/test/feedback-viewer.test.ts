import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import type {
  CreateFeedbackResponse,
  FeedbackAttachmentUrlResponse,
  FeedbackInboxItem,
  FeedbackInboxResponse,
  FeedbackListResponse,
  MeResponse,
} from '@xiaodouya/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { type Config, loadConfig } from '../src/config';
import { downloadFeedbackAttachments } from '../src/feedback';
import { runMaintenance } from '../src/maintenance';
import { type FakeGithub, startFakeGithub } from './fake-github';
import {
  type App,
  backgroundTasks,
  call,
  FakeMailer,
  join,
  newFamily,
  newUser,
  openTestDb,
  type TestDb,
  testEnv,
} from './harness';

/**
 * 维护者在 App 里看收到的反馈（F-125）。附件仍然不进公开的 issue，只有 FEEDBACK_VIEWER_EMAILS 里的账号
 * 能通过接口拿到 10 分钟的签名链接。
 */

const TOKEN = 'github_pat_FICTIONAL_viewer_0123456789';
const REPO = 'fictional-owner/fictional-repo';

let db: TestDb;
let github: FakeGithub;
let bg: ReturnType<typeof backgroundTasks>;

function viewerConfig(env: Record<string, string> = {}): Config {
  return loadConfig({
    ...testEnv(),
    FEEDBACK_GITHUB_REPO: REPO,
    FEEDBACK_GITHUB_TOKEN: TOKEN,
    FEEDBACK_GITHUB_API_URL: github.url,
    ...env,
  });
}

const makeApp = (config: Config, mailer: FakeMailer | null = null) =>
  createApp({ sql: db.sql, config, mailer, background: bg.background });

beforeAll(async () => {
  db = await openTestDb('fbviewer');
  github = await startFakeGithub(TOKEN);
});
afterAll(async () => {
  await github.close();
  await db.close();
});
beforeEach(async () => {
  await db.sql`DELETE FROM rate_limits`;
  github.issues.length = 0;
  github.failNext(0);
  bg = backgroundTasks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

const diagnostics = {
  appVersion: '0.4.0',
  os: 'android',
  osVersion: '15',
  locale: 'zh',
  region: 'SG',
};
const IMAGE = Buffer.from('xiaodouya-fictional-feedback-photo');

type Failure = { error: { code: string; message: string; params?: Record<string, unknown> } };

/** 走完整的提交流程：建草稿、传附件、提交。 */
async function sendFeedback(app: App, token: string, text: string, attachments = 1) {
  const id = randomUUID();
  const files = Array.from({ length: attachments }, () => ({
    id: randomUUID(),
    mime: 'image/jpeg',
    size: IMAGE.length,
  }));
  const created = await call<CreateFeedbackResponse>(app, 'POST', '/v1/feedback', {
    token,
    body: { id, text, diagnostics, attachments: files },
  });
  expect(created.status).toBe(201);
  for (const target of created.json.uploads) {
    const put = await fetch(target.url, { method: 'PUT', headers: target.headers, body: IMAGE });
    expect(put.status).toBe(200);
  }
  const submitted = await call<{ status: string }>(app, 'POST', `/v1/feedback/${id}/submit`, {
    token,
  });
  expect(submitted.status).toBe(200);
  return { id, files };
}

const inbox = (app: App, token: string, query = '') =>
  call<FeedbackInboxResponse & Failure>(app, 'GET', `/v1/feedback-inbox${query}`, { token });
const detail = (app: App, token: string, id: string) =>
  call<FeedbackInboxItem & Failure>(app, 'GET', `/v1/feedback-inbox/${id}`, { token });
const attachmentUrl = (app: App, token: string, id: string, attachmentId: string) =>
  call<FeedbackAttachmentUrlResponse & Failure>(
    app,
    'GET',
    `/v1/feedback-inbox/${id}/attachments/${attachmentId}`,
    { token },
  );
const me = (app: App, token: string) => call<MeResponse>(app, 'GET', '/v1/me', { token });

/** 名单里的邮箱写成大写、前后带空格，测试注册时用小写（服务端注册时统一小写）。 */
async function maintainerSetup(env: Record<string, string> = {}) {
  const email = `maintainer-${randomUUID().slice(0, 8)}@example.test`;
  const config = viewerConfig({
    FEEDBACK_VIEWER_EMAILS: `  someone-else@example.test ,  ${email.toUpperCase()}  ,`,
    ...env,
  });
  const app = makeApp(config);
  const { json } = await call<{ token: string; user: { id: string } }>(
    app,
    'POST',
    '/v1/auth/register',
    { body: { email, password: 'correct horse', displayName: '维护者' } },
  );
  return { app, config, maintainer: { token: json.token, email, id: json.user.id } };
}

describe('没有配置 FEEDBACK_VIEWER_EMAILS 时', () => {
  it('功能完全关闭：谁都不能看，/v1/me 说不能看', async () => {
    const app = makeApp(viewerConfig());
    const { admin } = await newFamily(app);
    const { id, files } = await sendFeedback(app, admin.token, '没有配置时');
    expect((await me(app, admin.token)).json.canViewFeedback).toBe(false);
    const list = await inbox(app, admin.token);
    expect(list.status).toBe(403);
    expect(list.json.error.code).toBe('forbidden');
    expect((await detail(app, admin.token, id)).status).toBe(403);
    expect((await attachmentUrl(app, admin.token, id, files[0]!.id)).status).toBe(403);
  });

  it('空字符串和只有逗号空格也当作没配置', async () => {
    for (const value of ['', ' , ,  ']) {
      const app = makeApp(viewerConfig({ FEEDBACK_VIEWER_EMAILS: value }));
      const user = await newUser(app);
      expect((await me(app, user.token)).json.canViewFeedback).toBe(false);
      expect((await inbox(app, user.token)).status).toBe(403);
    }
  });

  it('名单里有不是邮箱的东西时拒绝启动', () => {
    expect(() =>
      viewerConfig({ FEEDBACK_VIEWER_EMAILS: 'maintainer@example.test, not an email' }),
    ).toThrow(/FEEDBACK_VIEWER_EMAILS/);
  });
});

describe('名单里的账号', () => {
  it('大小写和空格不影响：/v1/me 说能看，名单本身不下发', async () => {
    const { app, maintainer } = await maintainerSetup();
    const response = await me(app, maintainer.token);
    expect(response.json.canViewFeedback).toBe(true);
    expect(response.text).not.toContain('someone-else');
  });

  it('列表有文字、诊断、附件的个数类型大小和 issue 地址，没有提交者的邮箱、账号和家庭', async () => {
    const { app, maintainer } = await maintainerSetup();
    const { admin, family } = await newFamily(app, '爸爸');
    const { id, files } = await sendFeedback(app, admin.token, '保存照片时闪退了');
    // 草稿还没提交，不在列表里。
    const draftId = randomUUID();
    await call(app, 'POST', '/v1/feedback', {
      token: admin.token,
      body: { id: draftId, text: '还没写完的草稿', diagnostics, attachments: [] },
    });

    const list = await inbox(app, maintainer.token);
    expect(list.status).toBe(200);
    const item = list.json.items.find((i) => i.id === id);
    expect(item).toMatchObject({
      id,
      status: 'sent',
      text: '保存照片时闪退了',
      diagnostics,
      attachmentCount: 1,
      attachments: [{ id: files[0]!.id, mime: 'image/jpeg', size: IMAGE.length, kind: 'image' }],
      lastError: null,
    });
    expect(item!.issueUrl).toContain('/issues/');
    expect(item!.issueNumber).toBeGreaterThan(0);
    expect(item!.createdAt).toBeGreaterThan(Date.now() - 60_000);
    expect(item!.attachmentsDeleteAt).toBeGreaterThan(Date.now() + 89 * 86_400_000);
    expect(list.json.items.some((i) => i.id === draftId)).toBe(false);
    expect(list.text).not.toContain('还没写完的草稿');

    for (const leaked of [
      admin.email,
      admin.user.id,
      family.id,
      family.name,
      '爸爸',
      'feedback/',
    ]) {
      expect(list.text).not.toContain(leaked);
    }
    const one = await detail(app, maintainer.token, id);
    expect(one.status).toBe(200);
    expect(one.json).toEqual(item);
    for (const leaked of [admin.email, admin.user.id, family.id, 'feedback/', 'user']) {
      expect(one.text).not.toContain(leaked);
    }
    expect((await detail(app, maintainer.token, draftId)).status).toBe(404);
    expect((await detail(app, maintainer.token, randomUUID())).status).toBe(404);
    expect((await detail(app, maintainer.token, 'not-a-uuid')).status).toBe(404);
  });

  it('按时间倒序翻页，游标不漏不重', async () => {
    const { app, maintainer } = await maintainerSetup();
    const user = await newUser(app);
    const ids: string[] = [];
    for (const n of [1, 2, 3, 4, 5])
      ids.push((await sendFeedback(app, user.token, `第 ${n} 条`, 0)).id);
    // 同一个时间点的几条：只按毫秒翻页会漏掉或重复。
    await db.sql`UPDATE feedback SET created_at = '2026-01-01T00:00:00.123456Z'
                 WHERE id = ANY(${ids.slice(1, 4)}::uuid[])`;
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await inbox(
        app,
        maintainer.token,
        `?limit=2${cursor ? `&before=${encodeURIComponent(cursor)}` : ''}`,
      );
      expect(page.status).toBe(200);
      expect(page.json.items.length).toBeLessThanOrEqual(2);
      seen.push(...page.json.items.map((i) => i.id));
      cursor = page.json.next;
      pages += 1;
    } while (cursor && pages < 50);
    const mine = seen.filter((id) => ids.includes(id));
    expect(new Set(seen).size).toBe(seen.length);
    expect(mine.sort()).toEqual([...ids].sort());
    // 最新的一条在最前面。
    expect(seen[0]).toBe(ids[4]);
    expect((await inbox(app, maintainer.token, '?before=garbage')).status).toBe(400);
    expect((await inbox(app, maintainer.token, '?limit=500')).status).toBe(400);
  });

  it('附件的签名链接不超过 10 分钟，内容能下载，日志里没有链接', async () => {
    const logs: string[] = [];
    for (const level of ['log', 'info', 'warn', 'error'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logs.push(args.map(String).join(' '));
      });
    }
    const { app, maintainer } = await maintainerSetup();
    const user = await newUser(app);
    const { id, files } = await sendFeedback(app, user.token, '附件能看吗');
    const response = await attachmentUrl(app, maintainer.token, id, files[0]!.id);
    expect(response.status).toBe(200);
    expect(response.json.expiresIn).toBeLessThanOrEqual(600);
    const url = new URL(response.json.url);
    expect(Number(url.searchParams.get('X-Amz-Expires'))).toBeLessThanOrEqual(600);
    const bytes = Buffer.from(await (await fetch(response.json.url)).arrayBuffer());
    expect(bytes.equals(IMAGE)).toBe(true);
    // 每次现取：第二次是新签的，也能用。
    const again = await attachmentUrl(app, maintainer.token, id, files[0]!.id);
    expect(again.status).toBe(200);
    // 别的反馈的附件 id 对不上。
    const other = await sendFeedback(app, user.token, '另一条');
    expect((await attachmentUrl(app, maintainer.token, id, other.files[0]!.id)).status).toBe(404);
    expect((await attachmentUrl(app, maintainer.token, id, 'nope')).status).toBe(404);
    const text = logs.join('\n');
    expect(text).not.toContain('X-Amz');
    expect(text).not.toContain(response.json.url);
  });

  it('过了保留期删掉的附件如实说明，反馈本身还在', async () => {
    const { app, config, maintainer } = await maintainerSetup();
    const user = await newUser(app);
    const { id, files } = await sendFeedback(app, user.token, '很久以前的反馈');
    await db.sql`UPDATE feedback SET sent_at = now() - interval '91 days' WHERE id = ${id}`;
    expect((await runMaintenance(db.sql, config)).feedbackAttachmentsExpired).toBe(1);
    const item = (await detail(app, maintainer.token, id)).json;
    expect(item.attachmentCount).toBe(1);
    expect(item.attachments).toEqual([]);
    const gone = await attachmentUrl(app, maintainer.token, id, files[0]!.id);
    expect(gone.status).toBe(410);
    expect(gone.json.error.code).toBe('feedback_attachment_gone');
  });

  it('存储里的对象不见了时也说已删除，不给打不开的链接', async () => {
    const { app, maintainer } = await maintainerSetup();
    const user = await newUser(app);
    const { id, files } = await sendFeedback(app, user.token, '对象被删了');
    const { deleteObject, storageById } = await import('../src/storage');
    const storage = (await storageById(db.sql, db.config, '', null))!;
    await deleteObject(storage, `feedback/${id}/${files[0]!.id}`);
    const gone = await attachmentUrl(app, maintainer.token, id, files[0]!.id);
    expect(gone.status).toBe(410);
    expect(gone.json.error.code).toBe('feedback_attachment_gone');
  });

  it('排队中的反馈也能看，带最后的失败原因', async () => {
    const { app, maintainer } = await maintainerSetup();
    const user = await newUser(app);
    github.failNext(1, 502);
    const { id } = await sendFeedback(app, user.token, 'GitHub 挂了', 0);
    const item = (await detail(app, maintainer.token, id)).json;
    expect(item.status).toBe('queued');
    expect(item.issueUrl).toBeNull();
    expect(item.attachmentsDeleteAt).toBeNull();
    expect(item.lastError).toBe('GitHub 返回 HTTP 502');
  });

  it('不需要 GitHub 的配置：只配了名单和存储也能看', async () => {
    const { app: sender } = await maintainerSetup();
    const user = await newUser(sender);
    const { id } = await sendFeedback(sender, user.token, '令牌过期以后');
    const email = `maintainer-${randomUUID().slice(0, 8)}@example.test`;
    const noGithub = makeApp(loadConfig({ ...testEnv(), FEEDBACK_VIEWER_EMAILS: email }));
    const { json } = await call<{ token: string }>(noGithub, 'POST', '/v1/auth/register', {
      body: { email, password: 'correct horse', displayName: '维护者' },
    });
    expect((await detail(noGithub, json.token, id)).status).toBe(200);
  });

  it('服务器开了邮件时，邮箱没验证过不能看：别人可能先用这个邮箱注册了', async () => {
    const mail = new FakeMailer();
    const email = `maintainer-${randomUUID().slice(0, 8)}@example.test`;
    const app = makeApp(viewerConfig({ FEEDBACK_VIEWER_EMAILS: email }), mail);
    const { json } = await call<{ token: string; user: { id: string } }>(
      app,
      'POST',
      '/v1/auth/register',
      { body: { email, password: 'correct horse', displayName: '维护者' } },
    );
    expect((await me(app, json.token)).json.canViewFeedback).toBe(false);
    expect((await inbox(app, json.token)).status).toBe(403);
    await db.sql`UPDATE users SET email_verified_at = now() WHERE id = ${json.user.id}`;
    expect((await me(app, json.token)).json.canViewFeedback).toBe(true);
    expect((await inbox(app, json.token)).status).toBe(200);
  });

  it('有限流：超过后列表和附件链接都是 429', async () => {
    const { app, maintainer } = await maintainerSetup({ RATE_FEEDBACK_VIEW_PER_HOUR: '3' });
    const user = await newUser(app);
    const { id, files } = await sendFeedback(app, user.token, '限流');
    expect((await inbox(app, maintainer.token)).status).toBe(200);
    expect((await detail(app, maintainer.token, id)).status).toBe(200);
    expect((await attachmentUrl(app, maintainer.token, id, files[0]!.id)).status).toBe(200);
    const limited = await inbox(app, maintainer.token);
    expect(limited.status).toBe(429);
    expect(limited.json.error.code).toBe('too_many_attempts');
    expect((await attachmentUrl(app, maintainer.token, id, files[0]!.id)).status).toBe(429);
  });
});

describe('名单外和别的接口', () => {
  it('名单外的账号 403：管理员、只看回忆的家人、没有家庭的人都一样', async () => {
    const { app } = await maintainerSetup();
    const { admin } = await newFamily(app);
    const viewer = await join(app, admin.token, 'viewer', '外公');
    const loner = await newUser(app);
    const { id, files } = await sendFeedback(app, loner.token, '名单外');
    for (const who of [admin, viewer, loner]) {
      expect((await me(app, who.token)).json.canViewFeedback).toBe(false);
      const list = await inbox(app, who.token);
      expect(list.status).toBe(403);
      expect(list.json.error.code).toBe('forbidden');
      expect((await detail(app, who.token, id)).status).toBe(403);
      expect((await attachmentUrl(app, who.token, id, files[0]!.id)).status).toBe(403);
    }
    // 没登录是 401。
    expect((await call(app, 'GET', '/v1/feedback-inbox')).status).toBe(401);
  });

  it('维护者的其他权限没有因此变多', async () => {
    const { app, maintainer } = await maintainerSetup();
    const { admin } = await newFamily(app);
    const draft = randomUUID();
    await call(app, 'POST', '/v1/feedback', {
      token: admin.token,
      body: { id: draft, text: '别人的草稿', diagnostics, attachments: [] },
    });
    await sendFeedback(app, admin.token, '别人的反馈', 0);
    // 自己提交过的列表还是只有自己的。
    const own = await call<FeedbackListResponse>(app, 'GET', '/v1/feedback', {
      token: maintainer.token,
    });
    expect(own.json.items).toEqual([]);
    // 别人的草稿不能提交、不能改。
    expect(
      (await call(app, 'POST', `/v1/feedback/${draft}/submit`, { token: maintainer.token })).status,
    ).toBe(404);
    expect(
      (
        await call(app, 'POST', '/v1/feedback', {
          token: maintainer.token,
          body: { id: draft, text: '改别人的', diagnostics, attachments: [] },
        })
      ).status,
    ).toBe(404);
    // 不在任何家庭里：家庭的数据一样读不到。
    const sync = await call<Failure>(app, 'POST', '/v1/sync', {
      token: maintainer.token,
      body: { cursor: 0, changes: [] },
    });
    expect(sync.status).toBe(403);
    expect(sync.json.error.code).toBe('no_family');
    expect((await call(app, 'GET', '/v1/family/export', { token: maintainer.token })).status).toBe(
      403,
    );
    // 公开配置里也没有名单。
    const config = await call(app, 'GET', '/v1/config');
    expect(config.text).not.toContain('maintainer-');
  });
});

describe('cli feedback <id> --download', () => {
  it('附件存成“附件 id.扩展名”，不覆盖已有文件，过期的如实说明', async () => {
    const { app, config } = await maintainerSetup();
    const user = await newUser(app);
    const { id, files } = await sendFeedback(app, user.token, '想在电脑上看', 2);
    const dir = await mkdtemp(joinPath(tmpdir(), 'xiaodouya-feedback-'));
    try {
      const first = await downloadFeedbackAttachments(db.sql, config, id, dir);
      expect(first?.skipped).toEqual([]);
      expect((await readdir(dir)).sort()).toEqual(files.map((f) => `${f.id}.jpg`).sort());
      expect((await readFile(joinPath(dir, `${files[0]!.id}.jpg`))).equals(IMAGE)).toBe(true);
      // 再下一次：已有的文件不覆盖。
      const again = await downloadFeedbackAttachments(db.sql, config, id, dir);
      expect(again?.saved).toEqual([]);
      expect(again?.skipped).toHaveLength(2);

      await db.sql`UPDATE feedback SET sent_at = now() - interval '91 days' WHERE id = ${id}`;
      await runMaintenance(db.sql, config);
      const expired = await downloadFeedbackAttachments(db.sql, config, id, joinPath(dir, 'later'));
      expect(expired?.saved).toEqual([]);
      expect(expired?.skipped).toEqual([{ id: '-', reason: '2 个附件过了保留期，已经删除' }]);
      expect(await downloadFeedbackAttachments(db.sql, config, randomUUID(), dir)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
