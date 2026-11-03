import { randomUUID } from 'node:crypto';
import type {
  CreateFeedbackResponse,
  FeedbackListResponse,
  MeResponse,
  PublicConfig,
} from '@xiaodouya/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { type Config, loadConfig } from '../src/config';
import { feedbackDetails } from '../src/feedback';
import { runMaintenance } from '../src/maintenance';
import { processPendingDeletions } from '../src/objectDeletions';
import { headObject, type ResolvedStorage, storageById } from '../src/storage';
import { type FakeGithub, startFakeGithub } from './fake-github';
import {
  type App,
  backgroundTasks,
  call,
  join,
  newFamily,
  newUser,
  openTestDb,
  PASSWORD,
  type TestDb,
  testEnv,
} from './harness';

const TOKEN = 'github_pat_FICTIONAL_0123456789abcdef';
const REPO = 'fictional-owner/fictional-repo';

let db: TestDb;
let github: FakeGithub;
let bg: ReturnType<typeof backgroundTasks>;
let config: Config;
let app: App;
let storage: ResolvedStorage;

function feedbackConfig(env: Record<string, string> = {}): Config {
  return loadConfig({
    ...testEnv(),
    FEEDBACK_GITHUB_REPO: REPO,
    FEEDBACK_GITHUB_TOKEN: TOKEN,
    FEEDBACK_GITHUB_API_URL: github.url,
    ...env,
  });
}

function makeApp(c: Config) {
  return createApp({ sql: db.sql, config: c, background: bg.background });
}

beforeAll(async () => {
  db = await openTestDb('feedback');
  github = await startFakeGithub(TOKEN);
  storage = (await storageById(db.sql, db.config, '', null))!;
});
afterAll(async () => {
  await github.close();
  await db.close();
});
beforeEach(async () => {
  await db.sql`DELETE FROM rate_limits`;
  await db.sql`DELETE FROM pending_object_deletions`;
  github.issues.length = 0;
  github.attempts = 0;
  github.delayMs = 0;
  github.failNext(0);
  bg = backgroundTasks();
  config = feedbackConfig();
  app = makeApp(config);
});
afterEach(() => {
  vi.restoreAllMocks();
});

const diagnostics = {
  appVersion: '0.3.3',
  os: 'android',
  osVersion: '15',
  locale: 'zh',
  region: 'SG',
};
const IMAGE = Buffer.from('xiaodouya-fictional-feedback-screenshot');

type Failure = { error: { code: string; message: string; params?: Record<string, unknown> } };

const create = (token: string, body: Record<string, unknown> = {}, target: App = app) =>
  call<CreateFeedbackResponse & Failure>(target, 'POST', '/v1/feedback', {
    token,
    body: {
      id: randomUUID(),
      text: '保存照片时闪退了',
      diagnostics,
      attachments: [],
      ...body,
    },
  });

const submit = (token: string, id: string, target: App = app) =>
  call<{ id: string; status: string } & Failure>(target, 'POST', `/v1/feedback/${id}/submit`, {
    token,
  });

const list = (token: string) => call<FeedbackListResponse>(app, 'GET', '/v1/feedback', { token });

async function put(target: { url: string; headers: Record<string, string> }, bytes = IMAGE) {
  const response = await fetch(target.url, { method: 'PUT', headers: target.headers, body: bytes });
  expect(response.status).toBe(200);
}

/** 走完整的流程：建草稿、传附件、提交。 */
async function sendFeedback(token: string, text = '保存照片时闪退了', attachments = 1) {
  const id = randomUUID();
  const files = Array.from({ length: attachments }, () => ({
    id: randomUUID(),
    mime: 'image/jpeg',
    size: IMAGE.length,
  }));
  const created = await create(token, { id, text, attachments: files });
  expect(created.status).toBe(201);
  for (const target of created.json.uploads) await put(target);
  const submitted = await submit(token, id);
  expect(submitted.status).toBe(200);
  return { id, files, status: submitted.json.status };
}

const attachmentKeys = async (feedbackId: string) =>
  (
    await db.sql<{ object_key: string }[]>`
      SELECT object_key FROM feedback_attachments WHERE feedback_id = ${feedbackId}`
  ).map((r) => r.object_key);

describe('没有配置时', () => {
  it('公开配置说不可用，接口返回明确的错误码', async () => {
    const plain = createApp({ sql: db.sql, config: db.config, background: bg.background });
    const configResponse = await call<PublicConfig>(plain, 'GET', '/v1/config');
    expect(configResponse.json.feedback).toEqual({
      enabled: false,
      public: true,
      attachments: false,
      attachmentDays: null,
    });
    const user = await newUser(plain);
    const response = await create(user.token, {}, plain);
    expect(response.status).toBe(503);
    expect(response.json.error.code).toBe('feedback_disabled');
    expect(github.attempts).toBe(0);
  });

  it('只配了仓库或只配了令牌时拒绝启动', () => {
    expect(() => loadConfig({ ...testEnv(), FEEDBACK_GITHUB_REPO: REPO })).toThrow(
      /FEEDBACK_GITHUB_TOKEN/,
    );
    expect(() => loadConfig({ ...testEnv(), FEEDBACK_GITHUB_TOKEN: TOKEN })).toThrow(
      /FEEDBACK_GITHUB_REPO/,
    );
    expect(() =>
      loadConfig({
        ...testEnv(),
        FEEDBACK_GITHUB_REPO: 'not a repo',
        FEEDBACK_GITHUB_TOKEN: TOKEN,
      }),
    ).toThrow(/FEEDBACK_GITHUB_REPO/);
  });

  it('公开配置里只有能力，没有仓库名和令牌', async () => {
    const response = await call<PublicConfig>(app, 'GET', '/v1/config');
    expect(response.json.feedback).toEqual({
      enabled: true,
      public: true,
      attachments: true,
      attachmentDays: 90,
    });
    expect(response.text).not.toContain(TOKEN);
    expect(response.text).not.toContain('fictional-repo');
  });

  it('部署者说仓库是私有的，App 就不提示公开', async () => {
    const response = await call<PublicConfig>(
      makeApp(feedbackConfig({ FEEDBACK_REPO_PUBLIC: 'false', FEEDBACK_ATTACHMENT_DAYS: '0' })),
      'GET',
      '/v1/config',
    );
    expect(response.json.feedback?.public).toBe(false);
    expect(response.json.feedback?.attachmentDays).toBeNull();
  });
});

describe('提交反馈', () => {
  it('文字加图片：建 issue，附件进私有存储，正文没有账号、家庭和附件地址', async () => {
    const { admin, family } = await newFamily(app, '爸爸');
    const { id, files, status } = await sendFeedback(admin.token);
    expect(status).toBe('sent');
    expect(github.issues).toHaveLength(1);
    const issue = github.issues[0]!;
    expect(issue.repo).toBe(REPO);
    expect(issue.authorization).toBe(`Bearer ${TOKEN}`);
    expect(issue.headers['x-github-api-version']).toBe('2022-11-28');
    // 不加标签、不指派：不存在的标签和没有权限的指派在 GitHub 上表现不一致。
    expect(issue.extra).toEqual([]);
    expect(issue.body).toContain('保存照片时闪退了');
    expect(issue.body).toContain(id);
    expect(issue.body).toContain('1 个（图片');
    const everything = `${issue.title}\n${issue.body}`;
    for (const secret of [
      admin.email,
      admin.user.id,
      family.id,
      '爸爸',
      '虚构',
      files[0]!.id,
      'feedback/',
      'X-Amz',
      'http://',
      'https://',
      TOKEN,
    ]) {
      expect(everything).not.toContain(secret);
    }

    // 附件真的在私有存储里，大小对得上。
    const [key] = await attachmentKeys(id);
    expect(key).toMatch(/^feedback\//);
    expect(key).not.toContain(admin.user.id);
    expect((await headObject(storage, key!))?.size).toBe(IMAGE.length);

    const mine = await list(admin.token);
    expect(mine.json.items).toEqual([
      expect.objectContaining({ id, status: 'sent', attachments: 1, excerpt: '保存照片时闪退了' }),
    ]);
  });

  it('用户写的 @提及、#引用、图片和反引号都在代码块里', async () => {
    const user = await newUser(app);
    const text = '```\n@octocat 看看 #1\n```\n![x](https://evil.example/a.png) <img src=x>';
    await sendFeedback(user.token, text, 0);
    const body = github.issues[0]!.body;
    const lines = body.split('\n');
    const open = lines.findIndex((l) => /^`{4,}text$/.test(l));
    expect(open).toBeGreaterThan(-1);
    const fence = lines[open]!.replace('text', '');
    const close = lines.indexOf(fence, open + 1);
    expect(close).toBeGreaterThan(open);
    // 中间没有一行能关掉代码块。
    for (const line of lines.slice(open + 1, close)) {
      expect(/^ {0,3}`+\s*$/.test(line) && line.trim().length >= fence.length).toBe(false);
    }
    const outside = [...lines.slice(0, open), ...lines.slice(close + 1)].join('\n');
    expect(outside).not.toMatch(/@octocat|#1\b|evil\.example|<img/);
  });

  it('没有家庭、只看回忆的家人都能提交：反馈是账号的事，不读写家庭数据', async () => {
    const { admin } = await newFamily(app);
    const viewer = await join(app, admin.token, 'viewer', '外公');
    const loner = await newUser(app);
    expect((await sendFeedback(viewer.token)).status).toBe('sent');
    expect((await sendFeedback(loner.token, '没有家庭也能反馈', 0)).status).toBe('sent');
    expect(github.issues).toHaveLength(2);
    expect(github.issues.map((i) => i.body).join()).not.toContain('外公');
  });

  it('未登录不行', async () => {
    const response = await call(app, 'POST', '/v1/feedback', {
      body: { id: randomUUID(), text: 'x', diagnostics, attachments: [] },
    });
    expect(response.status).toBe(401);
    expect(github.attempts).toBe(0);
  });

  it('同一个 id 重试是幂等的：不会多一条反馈，也不会多一个 issue', async () => {
    const user = await newUser(app);
    const { id } = await sendFeedback(user.token, '重试', 0);
    const again = await create(user.token, { id, text: '重试' });
    expect(again.json.status).toBe('sent');
    expect(again.json.uploads).toEqual([]);
    expect((await submit(user.token, id)).json.status).toBe('sent');
    expect(github.issues).toHaveLength(1);
    expect((await list(user.token)).json.items).toHaveLength(1);
  });

  it('同时提交两次也只建一个 issue', async () => {
    const user = await newUser(app);
    const id = randomUUID();
    await create(user.token, { id });
    github.delayMs = 300;
    const [a, b] = await Promise.all([submit(user.token, id), submit(user.token, id)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    await bg.flush();
    expect(github.issues).toHaveLength(1);
  });

  it('别人的反馈看不到也提交不了', async () => {
    const owner = await newUser(app);
    const other = await newUser(app);
    const id = randomUUID();
    await create(owner.token, { id });
    expect((await submit(other.token, id)).status).toBe(404);
    expect((await create(other.token, { id })).status).toBe(404);
    expect((await list(other.token)).json.items).toEqual([]);
  });

  it('草稿可以改文字和附件，去掉的附件进待删除队列', async () => {
    const user = await newUser(app);
    const id = randomUUID();
    const first = { id: randomUUID(), mime: 'image/png', size: IMAGE.length };
    const second = { id: randomUUID(), mime: 'image/png', size: IMAGE.length };
    const created = await create(user.token, { id, attachments: [first, second] });
    expect(created.json.uploads.map((u) => u.id).sort()).toEqual([first.id, second.id].sort());
    await put(created.json.uploads.find((u) => u.id === first.id)!);
    const edited = await create(user.token, { id, text: '改过的文字', attachments: [first] });
    expect(edited.status).toBe(200);
    // 提交时才核对附件，在那之前都给链接：手机自己记得哪些传过了。
    expect(edited.json.uploads.map((u) => u.id)).toEqual([first.id]);
    // 没传完的会记两条（链接过期后再删一次），按对象去重。
    const queued = await db.sql`SELECT DISTINCT object_key FROM pending_object_deletions`;
    expect(queued.map((r) => r.object_key)).toEqual([`feedback/${id}/${second.id}`]);
    expect((await submit(user.token, id)).json.status).toBe('sent');
    expect(github.issues[0]!.body).toContain('改过的文字');
    expect(github.issues[0]!.body).toContain('1 个（图片');
  });
});

describe('上限和限流', () => {
  it('文字太长、附件太多、类型不对、文件太大都拒绝', async () => {
    const user = await newUser(app);
    const attachment = (mime: string, size: number) => ({ id: randomUUID(), mime, size });
    const tooLong = await create(user.token, { text: 'x'.repeat(4001) });
    expect(tooLong.status).toBe(400);
    const empty = await create(user.token, { text: '   \n  ' });
    expect(empty.status).toBe(400);
    const tooMany = await create(user.token, {
      attachments: Array.from({ length: 6 }, () => attachment('image/png', 10)),
    });
    expect(tooMany.status).toBe(400);
    const pdf = await create(user.token, { attachments: [attachment('application/pdf', 10)] });
    expect(pdf.status).toBe(400);
    expect(pdf.json.error.code).toBe('bad_type');
    const bigImage = await create(user.token, {
      attachments: [attachment('image/jpeg', 20 * 1024 * 1024 + 1)],
    });
    expect(bigImage.status).toBe(413);
    expect(bigImage.json.error.code).toBe('too_large');
    expect(bigImage.json.error.params?.maxBytes).toBe(20 * 1024 * 1024);
    const bigVideo = await create(user.token, {
      attachments: [attachment('video/mp4', 100 * 1024 * 1024 + 1)],
    });
    expect(bigVideo.status).toBe(413);
    const badDiagnostics = await create(user.token, {
      diagnostics: { ...diagnostics, osVersion: 'me@example.test' },
    });
    expect(badDiagnostics.status).toBe(400);
    expect(github.attempts).toBe(0);
  });

  it('附件没传完或大小不对时不能提交', async () => {
    const user = await newUser(app);
    const id = randomUUID();
    const file = { id: randomUUID(), mime: 'image/jpeg', size: IMAGE.length };
    const created = await create(user.token, { id, attachments: [file] });
    const early = await submit(user.token, id);
    expect(early.status).toBe(409);
    expect(early.json.error.code).toBe('not_uploaded');
    // 不把大小签进链接时才传得上去不一样大的文件，模拟这种存储。
    const loose = makeApp(feedbackConfig({ S3_BIND_UPLOAD_SIZE: 'false' }));
    const looseCreated = await create(user.token, { id, attachments: [file] }, loose);
    const target = looseCreated.json.uploads[0]!;
    await fetch(target.url, {
      method: 'PUT',
      headers: target.headers,
      body: Buffer.concat([IMAGE, IMAGE]),
    });
    const mismatch = await submit(user.token, id);
    expect(mismatch.status).toBe(409);
    expect(mismatch.json.error.code).toBe('size_mismatch');
    expect(github.attempts).toBe(0);
    void created;
  });

  it('每个账号每天的条数有上限，重试同一条不算', async () => {
    const limited = makeApp(feedbackConfig({ RATE_FEEDBACK_PER_DAY: '2' }));
    const user = await newUser(limited);
    const firstId = randomUUID();
    expect((await create(user.token, { id: firstId }, limited)).status).toBe(201);
    expect((await create(user.token, { id: firstId }, limited)).status).toBe(200);
    expect((await create(user.token, {}, limited)).status).toBe(201);
    const third = await create(user.token, {}, limited);
    expect(third.status).toBe(429);
    expect(third.json.error.code).toBe('too_many_attempts');
    expect(third.json.error.params?.reason).toBe('feedback');
    // 别人不受影响。
    const other = await newUser(limited);
    expect((await create(other.token, {}, limited)).status).toBe(201);
  });

  it('全站每小时也有上限，保护 GitHub 令牌不被刷', async () => {
    const limited = makeApp(feedbackConfig({ RATE_FEEDBACK_GLOBAL_HOUR: '2' }));
    const users = [await newUser(limited), await newUser(limited), await newUser(limited)];
    expect((await create(users[0]!.token, {}, limited)).status).toBe(201);
    expect((await create(users[1]!.token, {}, limited)).status).toBe(201);
    expect((await create(users[2]!.token, {}, limited)).status).toBe(429);
  });

  it('服务器没有平台存储时只收文字', async () => {
    const env = testEnv();
    const noStorage = loadConfig({
      ...env,
      S3_BUCKET: '',
      FEEDBACK_GITHUB_REPO: REPO,
      FEEDBACK_GITHUB_TOKEN: TOKEN,
      FEEDBACK_GITHUB_API_URL: github.url,
    });
    const textOnly = makeApp(noStorage);
    const configResponse = await call<PublicConfig>(textOnly, 'GET', '/v1/config');
    expect(configResponse.json.feedback?.attachments).toBe(false);
    const user = await newUser(textOnly);
    const withFile = await create(
      user.token,
      { attachments: [{ id: randomUUID(), mime: 'image/png', size: 10 }] },
      textOnly,
    );
    expect(withFile.status).toBe(503);
    expect(withFile.json.error.code).toBe('feedback_attachments_unavailable');
    const id = randomUUID();
    expect((await create(user.token, { id }, textOnly)).status).toBe(201);
    expect((await submit(user.token, id, textOnly)).json.status).toBe('sent');
  });
});

describe('GitHub 不可用时不丢反馈', () => {
  it('先存库：失败时停在 queued，维护任务补发，日志里没有令牌', async () => {
    const logs: string[] = [];
    for (const level of ['log', 'warn', 'error'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logs.push(args.map(String).join(' '));
      });
    }
    const user = await newUser(app);
    github.failNext(1, 502);
    const { id, status } = await sendFeedback(user.token, 'GitHub 挂了的时候');
    expect(status).toBe('queued');
    expect(github.issues).toHaveLength(0);
    expect((await list(user.token)).json.items[0]?.status).toBe('queued');
    const [row] = await db.sql<{ last_error: string; attempts: number }[]>`
      SELECT last_error, attempts FROM feedback WHERE id = ${id}`;
    expect(row?.last_error).toBe('GitHub 返回 HTTP 502');
    expect(row?.attempts).toBe(1);

    // 还没到重试时间，维护任务不碰它。
    let report = await runMaintenance(db.sql, config);
    expect(report.feedbackSent).toBe(0);
    await db.sql`UPDATE feedback SET next_attempt_at = now() WHERE id = ${id}`;
    report = await runMaintenance(db.sql, config);
    expect(report.feedbackSent).toBe(1);
    expect(report.feedbackFailed).toBe(0);
    expect(github.issues).toHaveLength(1);
    expect((await list(user.token)).json.items[0]?.status).toBe('sent');

    const text = logs.join('\n');
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain('fake failure echo');
  });

  it('令牌失效（401）、限流（403、429）、超时都留在队列里重试', async () => {
    const user = await newUser(app);
    for (const failure of [401, 403, 429]) {
      github.failNext(1, failure);
      expect((await sendFeedback(user.token, `状态 ${failure}`, 0)).status).toBe('queued');
    }
    const slow = makeApp(feedbackConfig({ FEEDBACK_GITHUB_TIMEOUT_MS: '100' }));
    github.delayMs = 500;
    const id = randomUUID();
    await create(user.token, { id }, slow);
    expect((await submit(user.token, id, slow)).json.status).toBe('queued');
    const [row] = await db.sql<
      { last_error: string }[]
    >`SELECT last_error FROM feedback WHERE id = ${id}`;
    expect(row?.last_error).toBe('GitHub 没有响应');
    github.delayMs = 0;
    await new Promise((r) => setTimeout(r, 600));
    const before = github.issues.length;

    await db.sql`UPDATE feedback SET next_attempt_at = now() WHERE user_id = ${user.user.id}`;
    const report = await runMaintenance(db.sql, config);
    expect(report.feedbackSent).toBe(4);
    expect(github.issues.length - before).toBe(4);
  });

  it('下次有人提交时顺手补发到期的', async () => {
    const someone = await newUser(app);
    github.failNext(1, 500);
    const { id } = await sendFeedback(someone.token, '第一条', 0);
    await db.sql`UPDATE feedback SET next_attempt_at = now() WHERE id = ${id}`;
    const other = await newUser(app);
    await sendFeedback(other.token, '第二条', 0);
    await bg.flush();
    expect(github.issues.map((i) => i.body).join()).toContain('第一条');
    expect((await list(someone.token)).json.items[0]?.status).toBe('sent');
  });

  it('维护任务没有配 GitHub 时不动队列，也不算失败', async () => {
    const user = await newUser(app);
    github.failNext(1, 500);
    const { id } = await sendFeedback(user.token, '等配置', 0);
    await db.sql`UPDATE feedback SET next_attempt_at = now() WHERE id = ${id}`;
    const [queued] = await db.sql<{ count: string }[]>`
      SELECT count(*) AS count FROM feedback WHERE status = 'queued'`;
    const report = await runMaintenance(db.sql, db.config);
    expect(report.feedbackSent).toBe(0);
    expect(report.feedbackFailed).toBe(0);
    expect(report.feedbackWaitingForConfig).toBe(Number(queued?.count));
    expect(report.feedbackWaitingForConfig).toBeGreaterThanOrEqual(1);
    const [row] = await db.sql<{ status: string }[]>`SELECT status FROM feedback WHERE id = ${id}`;
    expect(row?.status).toBe('queued');
  });
});

describe('维护者查看和清理', () => {
  it('cli feedback 给附件的签名链接不超过 10 分钟，内容能下载', async () => {
    const user = await newUser(app);
    const { id } = await sendFeedback(user.token);
    const details = await feedbackDetails(db.sql, config, id);
    expect(details?.status).toBe('sent');
    expect(details?.issueUrl).toContain('/issues/');
    expect(details?.attachments).toHaveLength(1);
    const url = details!.attachments[0]!.url!;
    expect(Number(new URL(url).searchParams.get('X-Amz-Expires'))).toBeLessThanOrEqual(600);
    expect(Buffer.from(await (await fetch(url)).arrayBuffer()).equals(IMAGE)).toBe(true);
    expect(JSON.stringify(details)).not.toContain(user.email);
    expect(await feedbackDetails(db.sql, config, randomUUID())).toBeNull();
  });

  it('放弃的草稿一天后连附件一起清掉', async () => {
    const user = await newUser(app);
    const id = randomUUID();
    const created = await create(user.token, {
      id,
      attachments: [{ id: randomUUID(), mime: 'image/jpeg', size: IMAGE.length }],
    });
    await put(created.json.uploads[0]!);
    const [key] = await attachmentKeys(id);
    await db.sql`UPDATE feedback SET updated_at = now() - interval '25 hours' WHERE id = ${id}`;
    const report = await runMaintenance(db.sql, config);
    expect(report.feedbackDraftsRemoved).toBe(1);
    expect(await headObject(storage, key!)).toBeNull();
    expect((await list(user.token)).json.items).toEqual([]);
  });

  it('一直在改的草稿不算放弃：按最后一次修改算一天', async () => {
    const user = await newUser(app);
    const id = randomUUID();
    await create(user.token, { id });
    await db.sql`UPDATE feedback SET created_at = now() - interval '3 days',
                 updated_at = now() - interval '3 days' WHERE id = ${id}`;
    await create(user.token, { id, text: '昨天写到一半，今天接着写' });
    const report = await runMaintenance(db.sql, config);
    expect(report.feedbackDraftsRemoved).toBe(0);
    expect((await submit(user.token, id)).json.status).toBe('sent');
  });

  it('草稿被清掉后用同一个 id 回来重传，队列里延后的那次删除不会删掉新传的附件', async () => {
    const user = await newUser(app);
    const id = randomUUID();
    const file = { id: randomUUID(), mime: 'image/jpeg', size: IMAGE.length };
    // 附件还没传完（pending）时草稿被清掉：队列里有一条现在删、一条一小时后再删。
    await create(user.token, { id, attachments: [file] });
    await db.sql`UPDATE feedback SET updated_at = now() - interval '25 hours' WHERE id = ${id}`;
    expect((await runMaintenance(db.sql, config)).feedbackDraftsRemoved).toBe(1);
    const key = `feedback/${id}/${file.id}`;
    const queued = await db.sql`SELECT 1 FROM pending_object_deletions WHERE object_key = ${key}`;
    expect(queued.length).toBeGreaterThan(0);

    // 手机上的草稿还在，过一会儿用同一个 id 重新发。
    const again = await create(user.token, { id, attachments: [file] });
    expect(again.status).toBe(201);
    await put(again.json.uploads[0]!);
    expect((await submit(user.token, id)).json.status).toBe('sent');

    // 延后的那次删除到期了。
    await db.sql`UPDATE pending_object_deletions SET next_attempt_at = now()`;
    await processPendingDeletions(db.sql, config);
    expect((await headObject(storage, key))?.size).toBe(IMAGE.length);
  });

  it('issue 建好后过了保留期，附件删掉，反馈还在', async () => {
    const user = await newUser(app);
    const { id } = await sendFeedback(user.token);
    const [key] = await attachmentKeys(id);
    await db.sql`UPDATE feedback SET sent_at = now() - interval '89 days' WHERE id = ${id}`;
    expect((await runMaintenance(db.sql, config)).feedbackAttachmentsExpired).toBe(0);
    await db.sql`UPDATE feedback SET sent_at = now() - interval '91 days' WHERE id = ${id}`;
    expect((await runMaintenance(db.sql, config)).feedbackAttachmentsExpired).toBe(1);
    expect(await headObject(storage, key!)).toBeNull();
    expect((await list(user.token)).json.items[0]).toEqual(
      expect.objectContaining({ id, status: 'sent', attachments: 1 }),
    );
  });

  it('删除账号时反馈和附件立即删掉', async () => {
    const user = await newUser(app);
    const { id } = await sendFeedback(user.token);
    const [key] = await attachmentKeys(id);
    const deleted = await call(app, 'POST', '/v1/me/delete', {
      token: user.token,
      body: { password: PASSWORD },
    });
    expect(deleted.status).toBe(200);
    await bg.flush();
    expect(await headObject(storage, key!)).toBeNull();
    const rows = await db.sql`SELECT 1 FROM feedback WHERE id = ${id}`;
    expect(rows).toHaveLength(0);
  });

  it('家庭里的成员删除账号不影响家庭', async () => {
    const { admin } = await newFamily(app);
    const caregiver = await join(app, admin.token, 'caregiver', '妈妈');
    await sendFeedback(caregiver.token);
    const deleted = await call(app, 'POST', '/v1/me/delete', {
      token: caregiver.token,
      body: { password: PASSWORD },
    });
    expect(deleted.status).toBe(200);
    const me = await call<MeResponse>(app, 'GET', '/v1/me', { token: admin.token });
    expect(me.json.members).toHaveLength(1);
  });
});
