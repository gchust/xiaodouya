/**
 * 用户反馈：先存库，再在配置的 GitHub 仓库建 issue。
 *
 * 仓库通常是公开的，而反馈的截图可能拍到别人家的孩子，所以附件只放平台存储（`feedback/` 前缀），
 * issue 正文只有用户写的文字和诊断信息（`renderFeedbackIssue`），维护者用 `cli feedback <id>` 取短时效的链接。
 *
 * 建 issue 的重试和待删除队列（objectDeletions.ts）是同一个写法：一条语句把要处理的行的下次重试时间推后
 * （租约），提交后再调 GitHub。Edge Function 可能同时有好几个实例，不这样会建出重复的 issue。
 * 触发点有三个：提交时当场一次、之后任何人提交时顺手补发到期的、每天的 `cli maintenance`。
 */
import { type FeedbackDiagnostics, renderFeedbackIssue } from '@xiaodouya/shared';
import type { Config, FeedbackServerConfig } from './config';
import type { Sql, Tx } from './db';
import { presignDownload, storageById } from './storage';

/** 维护者看附件的链接，和证件一样不超过 10 分钟。 */
const DETAILS_URL_TTL = 600;
/** 没提交的草稿留一天：手机可能在慢慢传附件。之后连附件一起删。 */
const DRAFT_HOURS = 24;

export const feedbackObjectKey = (feedbackId: string, attachmentId: string) =>
  `feedback/${feedbackId}/${attachmentId}`;

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
    const rows = await sql<DueRow[]>`
      UPDATE feedback SET
        attempts = attempts + 1,
        next_attempt_at = now() + interval '1 minute' * power(2, LEAST(attempts, 10))
      WHERE id IN (
        SELECT id FROM feedback
        WHERE status = 'queued' AND next_attempt_at <= now()
          AND (${id ?? null}::uuid IS NULL OR id = ${id ?? null}::uuid)
        ORDER BY next_attempt_at LIMIT ${batchSize} FOR UPDATE SKIP LOCKED
      )
      RETURNING id, text, diagnostics`;
    if (rows.length === 0) break;
    const attachments = await sql<{ feedback_id: string; mime: string; size: string }[]>`
      SELECT feedback_id, mime, size FROM feedback_attachments
      WHERE feedback_id = ANY(${rows.map((r) => r.id)}::uuid[]) ORDER BY created_at, id`;
    // 一个一个发：GitHub 对连续建内容有次级限流，并发只会更快被限。
    for (const row of rows) {
      const issue = renderFeedbackIssue({
        id: row.id,
        text: row.text,
        diagnostics: row.diagnostics,
        attachments: attachments
          .filter((a) => a.feedback_id === row.id)
          .map((a) => ({ mime: a.mime, size: Number(a.size) })),
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
