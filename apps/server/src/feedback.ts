/**
 * 用户反馈：先存库，再在配置的 GitHub 仓库建 issue。
 *
 * 附件放平台存储（`feedback/` 前缀）。仓库通常是公开的，截图可能拍到别人家的孩子：改版前（F-121）
 * App 承诺过附件不公开，那些反馈的正文里只有个数。仓库所有者 2026-11-04 决定公开附件（F-126）：
 * 新版 App 提交时说用户看过“会公开”的提示（public_attachments），提交时给每个附件一个随机令牌，
 * 正文嵌入 `PUBLIC_API_URL/v1/public/feedback-files/<令牌>`，打开时 302 到 10 分钟的签名链接。
 * 删除账号或过了保留期，附件的行没了，链接就是 404。维护者在 App 的「收到的反馈」
 * （FEEDBACK_VIEWER_EMAILS 里的账号）或用 `cli feedback <id>` 取短时效的链接。
 *
 * 建 issue 的重试和待删除队列（objectDeletions.ts）是同一个写法：一条语句把要处理的行的下次重试时间推后
 * （租约），提交后再调 GitHub。Edge Function 可能同时有好几个实例，不这样会建出重复的 issue。
 * 触发点有三个：提交时当场一次、之后任何人提交时顺手补发到期的、每天的 `cli maintenance`。
 */
import { Buffer } from 'node:buffer';
import {
  expiredAttachmentCount,
  FEEDBACK_PUBLIC_FILE_PATH,
  FEEDBACK_PUBLIC_TOKEN,
  type FeedbackDiagnostics,
  type FeedbackInboxItem,
  type FeedbackInboxResponse,
  feedbackAttachmentFileName,
  feedbackAttachmentKind,
  publicFeedbackMime,
  renderFeedbackIssue,
} from '@xiaodouya/shared';
import type { Config, FeedbackServerConfig } from './config';
import { newToken } from './crypto';
import type { Sql, Tx } from './db';
import { headObject, presignDownload, storageById } from './storage';

/** 维护者看附件的链接，和证件一样不超过 10 分钟。 */
const DETAILS_URL_TTL = 600;
/** 没提交的草稿留一天：手机可能在慢慢传附件。之后连附件一起删。 */
const DRAFT_HOURS = 24;

export const feedbackObjectKey = (feedbackId: string, attachmentId: string) =>
  `feedback/${feedbackId}/${attachmentId}`;

/** 公开链接跳到的签名链接，和证件一样不超过 10 分钟。GitHub 的图片代理每次来取都会现签一个。 */
const PUBLIC_URL_TTL = 600;

const publicFileUrl = (base: string, token: string) =>
  `${base}${FEEDBACK_PUBLIC_FILE_PATH}/${token}`;

/**
 * 提交时调用，在把草稿改成 queued 的同一个事务里。用户同意了、这台服务器也能给公开链接，
 * 才给附件发令牌；否则把 public_attachments 改回 false，它表示的是“附件真的公开了”。
 * 类型不在白名单里的附件不发令牌（见 publicFeedbackMime）。
 */
export async function publishAttachments(
  tx: Tx,
  config: Config,
  feedbackId: string,
): Promise<void> {
  const [row] = await tx<{ public_attachments: boolean }[]>`
    SELECT public_attachments FROM feedback WHERE id = ${feedbackId} FOR UPDATE`;
  if (!row?.public_attachments) return;
  let published = 0;
  if (config.publicApiUrl) {
    const files = await tx<{ id: string; mime: string }[]>`
      SELECT id, mime FROM feedback_attachments WHERE feedback_id = ${feedbackId}`;
    for (const f of files) {
      if (!publicFeedbackMime(f.mime)) continue;
      await tx`UPDATE feedback_attachments SET public_token = ${newToken()} WHERE id = ${f.id}`;
      published += 1;
    }
  }
  // 一个都没公开（没有附件、都不在白名单里、这台服务器给不了链接）就记成没公开：
  // 没有 PUBLIC_API_URL 的维护任务按它决定能不能发这一条。
  if (published === 0) {
    await tx`UPDATE feedback SET public_attachments = false WHERE id = ${feedbackId}`;
  }
}

/**
 * 建一个 issue。报错只带状态码：GitHub 的错误响应会回显请求的一部分，错误信息会进日志和数据库。
 * 令牌只在请求头里，不在任何错误信息里。
 */
export async function createGithubIssue(
  cfg: FeedbackServerConfig,
  issue: { title: string; body: string },
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<{ number: number | null; url: string | null }> {
  let response: Response;
  try {
    response = await fetchImpl(`${cfg.apiUrl}/repos/${cfg.repo}/issues`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${cfg.token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'content-type': 'application/json',
        'user-agent': 'xiaodouya-server',
      },
      // 不加 labels 和 assignees：标签不存在、令牌没有权限时 GitHub 的处理不一致，可能整个请求失败。
      body: JSON.stringify({ title: issue.title, body: issue.body }),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
  } catch {
    throw new Error('GitHub 没有响应');
  }
  if (response.status !== 201) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`GitHub 返回 HTTP ${response.status}`);
  }
  // 201 就是建好了。响应读不出来也算成功，否则重试会多建一个。
  const json = (await response.json().catch(() => null)) as {
    number?: unknown;
    html_url?: unknown;
  } | null;
  return {
    number: typeof json?.number === 'number' ? json.number : null,
    url: typeof json?.html_url === 'string' ? json.html_url : null,
  };
}

export interface DeliveryResult {
  sent: number;
  failed: number;
}

interface DueRow {
  id: string;
  text: string;
  diagnostics: FeedbackDiagnostics;
}

/**
 * 把到期的 queued 反馈发到 GitHub。只给 id 时只处理那一条，用于提交时当场发送。
 * 没有配置 GitHub 时什么都不做：反馈留在队列里，等有配置的进程来发。
 */
export async function deliverDueFeedback(
  sql: Sql,
  config: Config,
  {
    id,
    batchSize = 10,
    maxMs = 20_000,
    fetchImpl,
  }: { id?: string; batchSize?: number; maxMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<DeliveryResult> {
  const cfg = config.feedback;
  const result: DeliveryResult = { sent: 0, failed: 0 };
  if (!cfg) return result;
  const deadline = Date.now() + maxMs;
  do {
    // 退避从 1 分钟开始翻倍，最多约 17 小时。租约要比一次请求的超时长得多。
    // 有公开附件的反馈要拼链接：这个进程没有 PUBLIC_API_URL（比如维护任务没设）就不碰它，
    // 否则会建出一个没有附件的 issue 并且标成已发送。
    const base = config.publicApiUrl;
    const rows = await sql<DueRow[]>`
      UPDATE feedback SET
        attempts = attempts + 1,
        next_attempt_at = now() + interval '1 minute' * power(2, LEAST(attempts, 10))
      WHERE id IN (
        SELECT id FROM feedback
        WHERE status = 'queued' AND next_attempt_at <= now()
          AND (${id ?? null}::uuid IS NULL OR id = ${id ?? null}::uuid)
          AND (${base !== null} OR NOT public_attachments)
        ORDER BY next_attempt_at LIMIT ${batchSize} FOR UPDATE SKIP LOCKED
      )
      RETURNING id, text, diagnostics`;
    if (rows.length === 0) break;
    const attachments = await sql<
      { feedback_id: string; mime: string; size: string; public_token: string | null }[]
    >`
      SELECT feedback_id, mime, size, public_token FROM feedback_attachments
      WHERE feedback_id = ANY(${rows.map((r) => r.id)}::uuid[]) ORDER BY created_at, id`;
    // 一个一个发：GitHub 对连续建内容有次级限流，并发只会更快被限。
    for (const row of rows) {
      const issue = renderFeedbackIssue({
        id: row.id,
        text: row.text,
        diagnostics: row.diagnostics,
        attachments: attachments
          .filter((a) => a.feedback_id === row.id)
          .map((a) => ({
            mime: a.mime,
            size: Number(a.size),
            url: a.public_token && base ? publicFileUrl(base, a.public_token) : null,
          })),
        attachmentDays: config.feedbackAttachmentDays,
      });
      try {
        const created = await createGithubIssue(cfg, issue, fetchImpl);
        await sql`
          UPDATE feedback SET status = 'sent', issue_number = ${created.number}, issue_url = ${created.url},
            sent_at = now(), last_error = NULL
          WHERE id = ${row.id} AND status = 'queued'`;
        result.sent += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'unknown';
        await sql`UPDATE feedback SET last_error = ${message.slice(0, 200)} WHERE id = ${row.id}`;
        console.warn(`反馈 ${row.id} 没能建 issue，稍后重试：${message}`);
        result.failed += 1;
      }
    }
  } while (!id && Date.now() < deadline);
  return result;
}

/** 处理到期反馈的后台任务。错误已经处理过，不会拒绝。 */
export const deliverInBackground = (sql: Sql, config: Config): Promise<void> =>
  deliverDueFeedback(sql, config, { batchSize: 5, maxMs: 0 })
    .then(() => {})
    .catch((error: unknown) => {
      console.error('补发反馈失败', error instanceof Error ? error.message : 'unknown');
    });

/**
 * 把附件写进待删除队列（平台存储，storage 为空）。必须在删除这些行的事务里、删除之前调用。
 * 还没传完的多记一条，等上传链接过期后再删一次：手机上的上传可能晚到。
 */
async function enqueueAttachments(
  tx: Tx,
  where: ReturnType<Tx>,
  uploadUrlTtlSeconds: number,
): Promise<number> {
  const rows = await tx<{ id: string }[]>`
    SELECT a.id FROM feedback_attachments a JOIN feedback f ON f.id = a.feedback_id WHERE ${where}`;
  if (rows.length === 0) return 0;
  await tx`
    INSERT INTO pending_object_deletions (id, object_key, storage, next_attempt_at)
    SELECT gen_random_uuid(), a.object_key, NULL, t.at
    FROM feedback_attachments a
    CROSS JOIN LATERAL (
      SELECT now() AS at
      UNION ALL
      SELECT now() + interval '1 second' * ${uploadUrlTtlSeconds + 300} WHERE a.status = 'pending'
    ) t
    WHERE a.id = ANY(${rows.map((r) => r.id)}::uuid[])`;
  return rows.length;
}

/** 账号删除：这个人的反馈随账号级联删除，附件在这里进队列。 */
export function enqueueUserFeedbackObjects(tx: Tx, userId: string, uploadUrlTtlSeconds: number) {
  return enqueueAttachments(tx, tx`f.user_id = ${userId}`, uploadUrlTtlSeconds);
}

/** 草稿去掉了某些附件。 */
export function enqueueRemovedAttachments(
  tx: Tx,
  feedbackId: string,
  keep: readonly string[],
  uploadUrlTtlSeconds: number,
) {
  return enqueueAttachments(
    tx,
    tx`f.id = ${feedbackId} AND NOT (a.id = ANY(${keep}::uuid[]))`,
    uploadUrlTtlSeconds,
  );
}

export interface FeedbackCleanup {
  draftsRemoved: number;
  attachmentsExpired: number;
}

/** 维护任务：放弃的草稿、过了保留期的附件。对象进待删除队列，由同一次维护任务删掉。 */
export async function cleanupFeedback(
  sql: Sql,
  config: Config,
  uploadUrlTtlSeconds: number,
): Promise<FeedbackCleanup> {
  const draftsRemoved = await sql.begin(async (tx) => {
    const drafts = await tx<{ id: string }[]>`
      SELECT id FROM feedback
      WHERE status = 'draft' AND updated_at < now() - interval '1 hour' * ${DRAFT_HOURS}
      FOR UPDATE SKIP LOCKED`;
    if (drafts.length === 0) return 0;
    const ids = drafts.map((d) => d.id);
    await enqueueAttachments(tx, tx`f.id = ANY(${ids}::uuid[])`, uploadUrlTtlSeconds);
    await tx`DELETE FROM feedback WHERE id = ANY(${ids}::uuid[])`;
    return ids.length;
  });
  const keepDays = config.feedbackAttachmentDays;
  let attachmentsExpired = 0;
  if (keepDays !== null) {
    attachmentsExpired = await sql.begin(async (tx) => {
      const where: ReturnType<Tx> = tx`f.status = 'sent' AND f.sent_at < now() - interval '1 day' * ${keepDays}`;
      const count = await enqueueAttachments(tx, where, uploadUrlTtlSeconds);
      if (count > 0) {
        await tx`DELETE FROM feedback_attachments a USING feedback f
                 WHERE f.id = a.feedback_id AND ${where}`;
      }
      return count;
    });
  }
  return { draftsRemoved, attachmentsExpired };
}

export interface FeedbackDetails {
  id: string;
  status: string;
  createdAt: Date;
  submittedAt: Date | null;
  sentAt: Date | null;
  attempts: number;
  nextAttemptAt: Date;
  lastError: string | null;
  issueNumber: number | null;
  issueUrl: string | null;
  diagnostics: FeedbackDiagnostics;
  text: string;
  attachmentCount: number;
  /** url 是 10 分钟的签名链接。没有平台存储时为 null。 */
  attachments: { id: string; mime: string; size: number; status: string; url: string | null }[];
}

/** `cli feedback <id>`。不带账号信息：反馈和账号的对应关系只留在数据库里。 */
export async function feedbackDetails(
  sql: Sql,
  config: Config,
  id: string,
): Promise<FeedbackDetails | null> {
  const [row] = await sql<
    {
      id: string;
      status: string;
      created_at: Date;
      submitted_at: Date | null;
      sent_at: Date | null;
      attempts: number;
      next_attempt_at: Date;
      last_error: string | null;
      issue_number: number | null;
      issue_url: string | null;
      diagnostics: FeedbackDiagnostics;
      text: string;
      attachment_count: number;
    }[]
  >`SELECT id, status, created_at, submitted_at, sent_at, attempts, next_attempt_at, last_error,
           issue_number, issue_url, diagnostics, text, attachment_count
    FROM feedback WHERE id = ${id}`;
  if (!row) return null;
  const files = await sql<
    { id: string; mime: string; size: string; status: string; object_key: string }[]
  >`SELECT id, mime, size, status, object_key FROM feedback_attachments
    WHERE feedback_id = ${id} ORDER BY created_at, id`;
  const storage = files.length > 0 ? await storageById(sql, config, '', null) : null;
  const attachments = await Promise.all(
    files.map(async (f) => ({
      id: f.id,
      mime: f.mime,
      size: Number(f.size),
      status: f.status,
      url:
        storage && f.status === 'ready'
          ? await presignDownload(storage, f.object_key, DETAILS_URL_TTL)
          : null,
    })),
  );
  return {
    id: row.id,
    status: row.status,
    createdAt: row.created_at,
    submittedAt: row.submitted_at,
    sentAt: row.sent_at,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error,
    issueNumber: row.issue_number,
    issueUrl: row.issue_url,
    diagnostics: row.diagnostics,
    text: row.text,
    attachmentCount: row.attachment_count,
    attachments,
  };
}

// ─── 维护者在 App 里看反馈（/v1/feedback-inbox） ─────────────────
// 名单的判断在 app.ts。这里查出来的东西只有反馈本身：不 JOIN users、memberships，user_id 不进 SELECT，
// 提交者是谁、在哪个家庭从这里拿不到。

interface InboxRow {
  id: string;
  status: 'queued' | 'sent';
  created_at: Date;
  submitted_at: Date | null;
  sent_at: Date | null;
  text: string;
  diagnostics: FeedbackDiagnostics;
  issue_number: number | null;
  issue_url: string | null;
  attachment_count: number;
  last_error: string | null;
  public_attachments: boolean;
  /** created_at 的微秒数。Date 只到毫秒，按它翻页会漏掉或重复同一毫秒的几条。 */
  cursor_us: string;
}

async function toInboxItems(
  sql: Sql,
  config: Config,
  rows: InboxRow[],
): Promise<FeedbackInboxItem[]> {
  if (rows.length === 0) return [];
  const files = await sql<{ id: string; feedback_id: string; mime: string; size: string }[]>`
    SELECT id, feedback_id, mime, size FROM feedback_attachments
    WHERE feedback_id = ANY(${rows.map((r) => r.id)}::uuid[]) AND status = 'ready'
    ORDER BY created_at, id`;
  const days = config.feedbackAttachmentDays;
  return rows.map((r) => {
    const attachments = files
      .filter((f) => f.feedback_id === r.id)
      .map((f) => ({
        id: f.id,
        mime: f.mime,
        size: Number(f.size),
        kind: feedbackAttachmentKind(f.mime),
      }));
    return {
      id: r.id,
      status: r.status,
      createdAt: r.created_at.getTime(),
      submittedAt: r.submitted_at?.getTime() ?? null,
      sentAt: r.sent_at?.getTime() ?? null,
      text: r.text,
      diagnostics: r.diagnostics,
      issueNumber: r.issue_number,
      issueUrl: r.issue_url,
      attachmentCount: r.attachment_count,
      publicAttachments: r.public_attachments,
      attachments,
      attachmentsDeleteAt:
        days !== null && r.sent_at && attachments.length > 0
          ? r.sent_at.getTime() + days * 86_400_000
          : null,
      lastError: r.last_error,
    };
  });
}

/** 按创建时间倒序，草稿不算。before 是上一页的 next。 */
export async function feedbackInbox(
  sql: Sql,
  config: Config,
  { before, limit }: { before?: string; limit: number },
): Promise<FeedbackInboxResponse> {
  const [us, afterId] = before ? before.split('_') : [null, null];
  const rows = await sql<InboxRow[]>`
    SELECT id, status, created_at, submitted_at, sent_at, text, diagnostics, issue_number, issue_url,
           attachment_count, last_error, public_attachments,
           floor(extract(epoch FROM created_at) * 1000000)::bigint::text AS cursor_us
    FROM feedback
    WHERE status <> 'draft'
      AND (${us}::bigint IS NULL OR (created_at, id) <
           (timestamptz 'epoch' + ${us}::bigint * interval '1 microsecond', ${afterId}::uuid))
    ORDER BY created_at DESC, id DESC
    LIMIT ${limit + 1}`;
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: await toInboxItems(sql, config, page),
    next: rows.length > limit && last ? `${last.cursor_us}_${last.id}` : null,
  };
}

export async function feedbackInboxItem(
  sql: Sql,
  config: Config,
  id: string,
): Promise<FeedbackInboxItem | null> {
  const rows = await sql<InboxRow[]>`
    SELECT id, status, created_at, submitted_at, sent_at, text, diagnostics, issue_number, issue_url,
           attachment_count, last_error, public_attachments, '' AS cursor_us
    FROM feedback WHERE id = ${id} AND status <> 'draft'`;
  const [item] = await toInboxItems(sql, config, rows);
  return item ?? null;
}

export type AttachmentUrlResult =
  | { kind: 'ok'; url: string; expiresIn: number }
  | { kind: 'not_found' }
  /** 过了保留期删掉了，或者存储里已经没有这个对象。 */
  | { kind: 'gone' }
  | { kind: 'no_storage' };

/** 一个附件的签名链接，每次现签。先 HEAD 一次：对象已经不在时如实说，不给一个打开就 404 的链接。 */
export async function feedbackAttachmentUrl(
  sql: Sql,
  config: Config,
  feedbackId: string,
  attachmentId: string,
): Promise<AttachmentUrlResult> {
  const [row] = await sql<
    { attachment_count: number; remaining: number; object_key: string | null }[]
  >`SELECT f.attachment_count,
           (SELECT count(*) FROM feedback_attachments x WHERE x.feedback_id = f.id)::int AS remaining,
           a.object_key
    FROM feedback f
    LEFT JOIN feedback_attachments a ON a.feedback_id = f.id AND a.id = ${attachmentId} AND a.status = 'ready'
    WHERE f.id = ${feedbackId} AND f.status <> 'draft'`;
  if (!row) return { kind: 'not_found' };
  if (!row.object_key) {
    // 行没了：少掉的那几个是维护任务按保留期删的。附件一个都没少，就是 id 不对。
    return row.remaining < row.attachment_count ? { kind: 'gone' } : { kind: 'not_found' };
  }
  const storage = await storageById(sql, config, '', null);
  if (!storage) return { kind: 'no_storage' };
  if (!(await headObject(storage, row.object_key))) return { kind: 'gone' };
  return {
    kind: 'ok',
    url: await presignDownload(storage, row.object_key, DETAILS_URL_TTL),
    expiresIn: DETAILS_URL_TTL,
  };
}

/**
 * `cli feedback <id> --download <目录>`：把附件存到本机，文件名是附件 id 加扩展名。
 * 不打印签名链接。已经存在的同名文件不覆盖，返回写下的路径。
 */
export async function downloadFeedbackAttachments(
  sql: Sql,
  config: Config,
  feedbackId: string,
  dir: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<{ saved: string[]; skipped: { id: string; reason: string }[] } | null> {
  const item = await feedbackInboxItem(sql, config, feedbackId);
  if (!item) return null;
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  await mkdir(dir, { recursive: true });
  const saved: string[] = [];
  const skipped: { id: string; reason: string }[] = [];
  for (const a of item.attachments) {
    const result = await feedbackAttachmentUrl(sql, config, feedbackId, a.id);
    if (result.kind !== 'ok') {
      skipped.push({ id: a.id, reason: result.kind === 'gone' ? '已经删除' : '没有平台存储' });
      continue;
    }
    const response = await fetchImpl(result.url);
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      skipped.push({ id: a.id, reason: `存储返回 HTTP ${response.status}` });
      continue;
    }
    const path = join(dir, feedbackAttachmentFileName(a.id, a.mime));
    try {
      // wx：不覆盖已有的文件，重复下载同一条不会把别的东西冲掉。
      await writeFile(path, Buffer.from(await response.arrayBuffer()), { flag: 'wx' });
      saved.push(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      skipped.push({ id: a.id, reason: `${path} 已经存在` });
    }
  }
  const expired = expiredAttachmentCount(item);
  if (expired > 0) skipped.push({ id: '-', reason: `${expired} 个附件过了保留期，已经删除` });
  return { saved, skipped };
}

export type PublicFileResult = { kind: 'ok'; url: string } | { kind: 'not_found' };

/**
 * 公开链接对应的签名链接。令牌格式不对、不存在、附件删了、反馈被删、没有平台存储，都是 not_found，
 * 不区分：从外面分不出一个令牌是不是曾经有效。不先 HEAD：行在对象就在（删除时先删行再删对象）。
 * Content-Type 按白名单覆盖，GitHub 的图片代理只转发 image/*，也不让存储按上传时报的类型返回别的东西。
 */
export async function publicFeedbackFile(
  sql: Sql,
  config: Config,
  token: string,
): Promise<PublicFileResult> {
  if (!FEEDBACK_PUBLIC_TOKEN.test(token)) return { kind: 'not_found' };
  const [row] = await sql<{ object_key: string; mime: string }[]>`
    SELECT a.object_key, a.mime FROM feedback_attachments a JOIN feedback f ON f.id = a.feedback_id
    WHERE a.public_token = ${token} AND a.status = 'ready' AND f.status <> 'draft'
      AND f.public_attachments`;
  const mime = row ? publicFeedbackMime(row.mime) : null;
  if (!row || !mime) return { kind: 'not_found' };
  const storage = await storageById(sql, config, '', null);
  if (!storage) return { kind: 'not_found' };
  return {
    kind: 'ok',
    url: await presignDownload(storage, row.object_key, PUBLIC_URL_TTL, mime),
  };
}

/** `cli feedback` 不带 id：最近的反馈和状态，看有没有卡在队列里的。 */
export async function recentFeedback(sql: Sql, limit = 20) {
  return sql<
    {
      id: string;
      status: string;
      created_at: Date;
      attempts: number;
      last_error: string | null;
      issue_url: string | null;
      attachment_count: number;
    }[]
  >`SELECT id, status, created_at, attempts, last_error, issue_url, attachment_count
    FROM feedback ORDER BY created_at DESC LIMIT ${limit}`;
}
