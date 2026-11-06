import { Buffer } from 'node:buffer';
import {
  AcceptInviteRequest,
  type ApiError,
  AppUpdateQuery,
  type AppUpdateResponse,
  type AuthResponse,
  accountDeletionOutcome,
  type BabyData,
  CompleteUploadRequest,
  CreateFamilyRequest,
  CreateFeedbackRequest,
  type CreateFeedbackResponse,
  CreateInviteRequest,
  CreateMomentsShareRequest,
  CreateShareRequest,
  type CreateShareResponse,
  CreateTimelineShareRequest,
  canReadCollection,
  canReadMediaScope,
  canWriteCollection,
  canWriteDocument,
  cleanFeedbackText,
  collections,
  DeleteAccountRequest,
  type DocumentData,
  defaultPrefs,
  describeEvent,
  EMAIL_CODE_COOLDOWN_SECONDS,
  type EventData,
  effectiveUnits,
  type FamilyExport,
  type FamilyMember,
  FEEDBACK_INBOX_PAGE,
  FEEDBACK_PUBLIC_FILE_PATH,
  type FeedbackAttachmentUrlResponse,
  type FeedbackInboxItem,
  FeedbackInboxQuery,
  type FeedbackInboxResponse,
  type FeedbackListResponse,
  type FeedbackStatus,
  ForgotPasswordRequest,
  feedbackAttachmentLimit,
  formatBytes,
  isAllowedMime,
  isDocumentScope,
  isFormulaData,
  isMoneyData,
  isReleaseKey,
  isVaccinePlanData,
  type Locale,
  LoginRequest,
  localeFromAcceptLanguage,
  MAX_ACTIVE_SHARES,
  MediaUrlsRequest,
  type MediaUrlsResponse,
  type MediaVariant,
  type MeResponse,
  type MultipartPartsResponse,
  MultipartPartUrlsRequest,
  type MultipartPartUrlsResponse,
  MultipartRef,
  MultipartStartRequest,
  type MultipartStartResponse,
  mediaCategory,
  missingParts,
  multipartPartBytes,
  multipartPartCount,
  multipartPartSize,
  type PendingInvite,
  Prefs,
  type PublicConfig,
  PublicShareRequest,
  type PublicShareResponse,
  PublicTimelineMomentRequest,
  type PublicTimelineMomentResponse,
  PublicTimelineRequest,
  type PublicTimelineResponse,
  PushTokenRequest,
  parseCollectionData,
  RELEASE_MANIFEST_NAME,
  RegisterRequest,
  ReleaseManifest,
  ResetPasswordRequest,
  type Role,
  rawDocumentOwner,
  type SendEmailCodeResponse,
  type ServerRecord,
  SHARE_TIMELINE_MAX_AHEAD_MS,
  type ShareKind,
  type ShareListResponse,
  StorageConfigInput,
  type StorageConfigView,
  type StorageUsage,
  SYNC_PAGE_SIZE,
  SyncRequest,
  type SyncResponse,
  TIMELINE_SHARE_INCLUDE,
  UpdateMemberRequest,
  UploadUrlRequest,
  type UploadUrlResponse,
  updateDecision,
  VerifyEmailRequest,
  validParts,
} from '@xiaodouya/shared';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { clientIpFrom } from './client-ip';
import type { Config } from './config';
import {
  burnPasswordCheck,
  encryptSecret,
  hashPassword,
  newInviteCode,
  newToken,
  sha256,
  verifyPassword,
} from './crypto';
import type { Sql, Tx } from './db';
import {
  type CodePurpose,
  consumeEmailCode,
  emailCodeCooldown,
  issueEmailCode,
  matchEmailCode,
} from './emailCodes';
import {
  deliverDueFeedback,
  deliverInBackground,
  enqueueRemovedAttachments,
  enqueueUserFeedbackObjects,
  feedbackAttachmentUrl,
  feedbackInbox,
  feedbackInboxItem,
  feedbackObjectKey,
  publicFeedbackFile,
  publishAttachments,
} from './feedback';
import type { Mailer } from './mailer';
import { resetPasswordMail, verifyEmailMail } from './mailTemplates';
import { isQuietHour, type Notifier, noopNotifier, type PushMessage } from './notifier';
import {
  enqueueCancelledUpload,
  enqueueFamilyObjects,
  enqueueMediaObjects,
  processPendingDeletions,
} from './objectDeletions';
import {
  eraseOwnedDocuments,
  type MediaAccessRow,
  type OwnedRecordRow,
  projectForViewer,
  readableOwnedMedia,
  resequenceOwned,
  visibleForExport,
} from './personalDocuments';
import {
  countedBytes,
  familyQuotaBytes,
  liveReferences,
  platformUsage,
  RESERVATION_HOURS,
  uuidsIn,
} from './quota';
import {
  buildPublicShare,
  buildPublicTimeline,
  buildPublicTimelineMoment,
  findActiveShare,
  type ShareRow,
  shareInclude,
} from './share';
import {
  abortMultipart,
  activeStorage,
  assertEndpointAllowed,
  completeMultipart,
  createMultipart,
  deleteObject,
  endpointForProvider,
  headObject,
  isNoSuchUpload,
  listMultipartParts,
  multipartUnsupported,
  platformStorage,
  presignDownload,
  presignPart,
  presignUpload,
  type ResolvedStorage,
  readSmallObject,
  resolvedFromInput,
  type StorageRow,
  storageById,
  testStorage,
} from './storage';

const PUBLIC_SHARE_PATH = '/v1/public/share';
const PUBLIC_TIMELINE_PATH = '/v1/public/share/timeline';
const PUBLIC_TIMELINE_MOMENT_PATH = '/v1/public/share/timeline/moment';
const SESSION_DAYS = 365;
const INVITE_DAYS = 7;
const UPLOAD_URL_TTL = 3600;
const MEMORY_URL_TTL = 3600;
/** AGENTS.md 硬性要求：证件链接不超过 10 分钟。 */
const DOCUMENT_URL_TTL = 600;
/** 比证件的长一点：慢速网络上开始下载要一会儿。下载开始后链接过期不影响这次下载，断了重试时 App 会重新取。 */
const APP_UPDATE_URL_TTL = 900;
const LOGIN_WINDOW_MS = 15 * 60_000;
const INVITE_WINDOW_MS = 15 * 60_000;
const REGISTER_WINDOW_MS = 3_600_000;
const UPLOAD_URL_WINDOW_MS = 3_600_000;
/** 和 RATE_SYNC_PER_10MIN 对应，改了要一起改。 */
const SYNC_WINDOW_MINUTES = 10;
const SYNC_BODY_BYTES = 5 * 1024 * 1024;
/**
 * App 能产生的最大记录约 280 KB（2 万字占 60 KB，100 个带波形的文件引用约 220 KB），留点余量。
 * 请求体上限挡不住这个：校验用的是 looseObject，多余字段会原样入库，而数据库是最贵的资源。
 */
const MAX_RECORD_BYTES = 512 * 1024;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INVALID_CODE_MESSAGE = '验证码不正确或已过期';
const MAIL_DISABLED_MESSAGE = '这台服务器没有配置邮件，请联系部署它的人';
/** 每次检查只是一条很轻的查询，但每台前台手机都在轮询，不能再密了。 */
const DEFAULT_LONG_POLL = { intervalMs: 2_000, timeoutMs: 25_000 };

interface AppContext {
  sql: Sql;
  config: Config;
  notifier?: Notifier;
  /** null 表示这台服务器不发邮件：跳过邮箱验证，也不能自助找回密码。 */
  mailer?: Mailer | null;
  /** 路径前缀。Edge Function 收到的路径带函数名，比如 /api/v1/me。 */
  basePath?: string;
  longPoll?: { intervalMs: number; timeoutMs: number };
  /**
   * 托管响应之后还要继续的工作。Edge Function 返回响应后可能被回收，要交给 EdgeRuntime.waitUntil。
   * 传进来的任务已经处理过错误，不会拒绝。
   */
  background?: (task: Promise<void>) => void;
}

interface AuthedUser {
  id: string;
  email: string;
  displayName: string;
  prefs: Prefs;
  emailVerified: boolean;
}

interface Membership {
  familyId: string;
  role: Role;
  label: string;
}

type Env = { Variables: { user: AuthedUser; membership: Membership | null } };

function fail(
  status: 400 | 401 | 403 | 404 | 409 | 410 | 413 | 429 | 501 | 503,
  code: string,
  message: string,
  params?: Record<string, string | number>,
): never {
  throw new HTTPException(status, {
    message: `${code}: ${message}`,
    res: new Response(JSON.stringify({ error: { code, message, params } } satisfies ApiError), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    }),
  });
}

async function parseBody<T extends z.ZodType>(
  c: { req: { json(): Promise<unknown> } },
  schema: T,
): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    fail(400, 'invalid_json', '请求格式不正确');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    fail(
      400,
      'invalid_input',
      `输入有误：${issue?.path.join('.') || '请求'} ${issue?.message ?? ''}`.trim(),
      { field: issue?.path.join('.') || 'request', detail: issue?.message ?? '' },
    );
  }
  return parsed.data;
}

/**
 * 没存过时区的账号按新加坡算。v0.1.0 不会上报时区，这些用户一直是按新加坡判断夜间安静的，
 * 换成 UTC 会变成白天静音、半夜推送。新版 App 启动后马上写入手机的时区，不受这个值影响。
 */
const LEGACY_TIMEZONE = 'Asia/Singapore';

function mergePrefs(stored: unknown): Prefs {
  const parsed = Prefs.partial().safeParse(stored);
  return { ...defaultPrefs, timezone: LEGACY_TIMEZONE, ...(parsed.success ? parsed.data : {}) };
}

/** 家庭当前的地区。档案和记录一样是后写胜出，所以取最新的一条，和客户端的规则一致。 */
async function familyRegion(
  db: Pick<Sql, 'unsafe'>,
  familyId: string,
): Promise<string | undefined> {
  const rows = await db.unsafe<{ region: string | null }[]>(
    `SELECT data->>'region' AS region FROM records
     WHERE family_id = $1 AND collection = 'baby' AND deleted = false
     ORDER BY updated_at_client DESC LIMIT 1`,
    [familyId],
  );
  return rows[0]?.region ?? undefined;
}

function withRegion(baby: BabyData, region: string | undefined): BabyData {
  const { region: _ignored, ...rest } = baby;
  return region === undefined ? rest : { ...rest, region };
}

/** 等到时间到或客户端断开，两者都只是结束等待，不算错误。 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done);
  });
}

/**
 * 限流计数放数据库：Edge Function 的 isolate 随时被回收，又可能同时有多个，存在内存里等于没有限流。
 * 键里有邮箱，只存哈希。
 */
async function allowAttempt(sql: Sql, key: string, limit: number, windowMs: number) {
  // 过期的行由 upsert 原地复用，不用每次都扫表清理。没配定时任务的自建服务器也要偶尔清一下。
  if (Math.random() < 0.01) await sql`DELETE FROM rate_limits WHERE reset_at < now()`;
  const [row] = await sql<{ count: number }[]>`
    INSERT INTO rate_limits (key_hash, count, reset_at)
    VALUES (${sha256(key)}, 1, now() + interval '1 millisecond' * ${windowMs})
    ON CONFLICT (key_hash) DO UPDATE SET
      count = CASE WHEN rate_limits.reset_at < now() THEN 1 ELSE rate_limits.count + 1 END,
      reset_at = CASE WHEN rate_limits.reset_at < now() THEN EXCLUDED.reset_at ELSE rate_limits.reset_at END
    RETURNING count`;
  return (row?.count ?? 0) <= limit;
}

type RecordRow = OwnedRecordRow;

const toServerRecord = (r: RecordRow): ServerRecord => ({
  id: r.id,
  collection: r.collection,
  data: r.data,
  deleted: r.deleted,
  updatedAt: Number(r.updated_at_client),
  seq: Number(r.seq),
  createdBy: r.created_by,
});

export function createApp({
  sql,
  config,
  notifier = noopNotifier,
  mailer = null,
  basePath = '/',
  longPoll = DEFAULT_LONG_POLL,
  background = () => {},
}: AppContext) {
  const app = new Hono<Env>().basePath(basePath);

  /** 日志里的路径。反馈附件的公开链接整个路径就是令牌，只记前缀。 */
  const loggedPath = (path: string) => {
    const at = path.indexOf(`${FEEDBACK_PUBLIC_FILE_PATH}/`);
    return at < 0 ? path : `${path.slice(0, at)}${FEEDBACK_PUBLIC_FILE_PATH}/…`;
  };

  app.onError((error, c) => {
    if (error instanceof HTTPException) {
      // 只记路径、状态和错误原因，不记请求体，原因文字里也不含用户填写的值。
      if (error.status !== 401)
        console.warn(
          `[${c.req.method} ${loggedPath(c.req.path)}] ${error.status} ${error.message}`,
        );
      return error.getResponse();
    }
    // 只记录错误名和信息：请求体里可能有证件号，不能进日志。
    console.error(
      `[${c.req.method} ${loggedPath(c.req.path)}]`,
      error instanceof Error ? error.message : 'unknown',
    );
    return c.json<ApiError>(
      { error: { code: 'internal', message: '服务器出错了，请稍后再试' } },
      500,
    );
  });
  app.notFound((c) =>
    c.json<ApiError>({ error: { code: 'not_found', message: '接口不存在' } }, 404),
  );

  // 每个响应都禁止缓存（F-135）。Android 上 RN 的 fetch 走 OkHttp，自带 `cache/http-cache`，
  // 没有这个头的 GET 响应（`/v1/me` 里有邮箱、家庭名和成员）会原样写进手机，退出登录后还在。
  // 放在 next() 之后：抛出的错误在 next() 里已经变成响应，401、404、500 也带上。
  app.use('*', async (c, next) => {
    await next();
    c.header('cache-control', 'no-store');
  });

  app.get('/healthz', async (c) => {
    await sql`SELECT 1`;
    return c.json({ ok: true });
  });

  app.get('/v1/config', (c) =>
    c.json<PublicConfig>({
      allowCustomStorage: config.allowCustomStorage,
      passwordReset: Boolean(mailer),
      emailVerification: Boolean(mailer),
      // 只说能不能用，仓库名和令牌都不出现在这里。
      feedback: {
        enabled: Boolean(config.feedback),
        public: config.feedback?.public ?? true,
        attachments: Boolean(config.feedback && config.serverStorage),
        attachmentDays: config.feedback ? config.feedbackAttachmentDays : null,
        publicAttachments: Boolean(config.feedback && config.serverStorage && config.publicApiUrl),
      },
      personalDocuments: true,
    }),
  );

  // ─── 分享页的公开接口 ──────────────────────────────────

  /**
   * 整个服务只有分享页的这三个接口开 CORS：分享页是别的域名上的静态页面。`*` 不带凭据，
   * 令牌在请求体里，App 用的登录接口都不受影响。注册在 v1 之前：v1 的中间件会要求登录，预检也过不去。
   */
  for (const path of [PUBLIC_SHARE_PATH, PUBLIC_TIMELINE_PATH, PUBLIC_TIMELINE_MOMENT_PATH]) {
    app.use(
      path,
      cors({
        origin: '*',
        allowMethods: ['POST', 'OPTIONS'],
        allowHeaders: ['content-type', 'x-region'],
        maxAge: 86_400,
      }),
      async (c, next) => {
        await next();
        c.header('cache-control', 'no-store');
      },
    );
  }

  /** 不存在、格式不对、过期、撤销都是它，不透露是哪一种。不走 fail：那会把原因写进日志。 */
  const shareMiss = (c: Context) =>
    c.json<ApiError>(
      { error: { code: 'share_unavailable', message: '这个链接已失效或已撤销' } },
      404,
    );

  /**
   * 三个公开接口共用的门：按来源和按令牌限流都在查库之前，链接的类型对不上和失效是同一个回答
   * （一天的令牌打不开时间线，反过来也一样）。一个链接的翻页、点开和打开算同一个计数。
   */
  function publicShareRoute<T extends { token: string }>(
    path: string,
    schema: z.ZodType<T>,
    kinds: readonly ShareKind[],
    respond: (c: Context, share: ShareRow, body: T) => Promise<Response>,
  ) {
    app.post(path, bodyLimit({ maxSize: 1024, onError: shareMiss }), async (c) => {
      const { sharePublicPerIp, sharePublicPerToken } = config.limits;
      const tooMany = () =>
        c.json<ApiError>(
          { error: { code: 'rate_limited', message: '打开的次数有点多，等一会儿再试' } },
          429,
        );
      const ip = clientIp(c);
      if (
        ip &&
        sharePublicPerIp > 0 &&
        !(await allowAttempt(sql, `share-ip:${ip}`, sharePublicPerIp, 15 * 60_000))
      ) {
        return tooMany();
      }
      const parsed = schema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return shareMiss(c);
      const { token } = parsed.data;
      // 查之前就计数：链接不存在时也一样，不能靠 429 判断它存不存在。allowAttempt 只存键的哈希。
      if (
        sharePublicPerToken > 0 &&
        !(await allowAttempt(sql, `share-token:${token}`, sharePublicPerToken, HOUR_MS))
      ) {
        return tooMany();
      }
      const share = await findActiveShare(sql, token);
      if (!share || !kinds.includes(share.kind)) return shareMiss(c);
      return respond(c, share, parsed.data);
    });
  }

  /** 选中回忆的链接（F-136）和时间线用同一个页面、同样两个接口，只是按选中的 id 查。 */
  const TIMELINE_KINDS: readonly ShareKind[] = ['timeline', 'moments'];

  publicShareRoute(PUBLIC_SHARE_PATH, PublicShareRequest, ['day'], async (c, share) =>
    c.json<PublicShareResponse>(await buildPublicShare(sql, config, share)),
  );

  publicShareRoute(
    PUBLIC_TIMELINE_PATH,
    PublicTimelineRequest,
    TIMELINE_KINDS,
    async (c, share, body) =>
      c.json<PublicTimelineResponse>(await buildPublicTimeline(sql, config, share, body.cursor)),
  );

  publicShareRoute(
    PUBLIC_TIMELINE_MOMENT_PATH,
    PublicTimelineMomentRequest,
    TIMELINE_KINDS,
    async (c, share, body) => {
      const moment = await buildPublicTimelineMoment(sql, config, share, body.momentId);
      return moment ? c.json<PublicTimelineMomentResponse>(moment) : shareMiss(c);
    },
  );

  // ─── 反馈附件的公开链接 ─────────────────────────────────
  // issue 正文里嵌的就是它（F-126）。不用登录，GitHub 的图片代理和看 issue 的人直接打开。
  // 和分享页一样注册在 v1 之前，限流在查库之前。路径就是令牌：这里不调 fail()、不往外抛，
  // 出错也不进 onError 的日志；也不打任何带路径的日志。

  app.use(`${FEEDBACK_PUBLIC_FILE_PATH}/*`, async (c, next) => {
    await next();
    c.header('cache-control', 'no-store');
    c.header('referrer-policy', 'no-referrer');
    c.header('x-content-type-options', 'nosniff');
  });

  const fileMiss = (c: Context) =>
    c.json<ApiError>({ error: { code: 'not_found', message: '这个附件已删除或链接不对' } }, 404);

  app.get(`${FEEDBACK_PUBLIC_FILE_PATH}/:token`, async (c) => {
    try {
      const { feedbackFilePerIp, feedbackFilePerToken } = config.limits;
      const tooMany = () =>
        c.json<ApiError>(
          { error: { code: 'rate_limited', message: '打开的次数有点多，等一会儿再试' } },
          429,
        );
      const ip = clientIp(c);
      if (
        ip &&
        feedbackFilePerIp > 0 &&
        !(await allowAttempt(sql, `feedback-file-ip:${ip}`, feedbackFilePerIp, 15 * 60_000))
      ) {
        return tooMany();
      }
      const token = c.req.param('token');
      // 先计数再查库：不存在的令牌也一样，从 429 看不出它存不存在。allowAttempt 只存键的哈希。
      if (
        feedbackFilePerToken > 0 &&
        !(await allowAttempt(sql, `feedback-file:${token}`, feedbackFilePerToken, HOUR_MS))
      ) {
        return tooMany();
      }
      const found = await publicFeedbackFile(sql, config, token);
      if (found.kind !== 'ok') return fileMiss(c);
      return c.redirect(found.url, 302);
    } catch {
      return c.json<ApiError>(
        { error: { code: 'unavailable', message: '暂时打不开，请稍后再试' } },
        503,
      );
    }
  });

  // ─── 账号 ─────────────────────────────────────────────

  /**
   * 生成验证码和发信都在响应之后做：查账号、写库、调邮件 API 都会花时间，
   * 放在响应之前的话，从响应时间就能看出邮箱有没有注册。
   */
  function sendCodeLater(
    purpose: CodePurpose,
    target: () => Promise<{ id: string; email: string; locale?: Locale } | undefined>,
    requestLocale: Locale | null,
  ) {
    if (!mailer) return;
    const task = async () => {
      const user = await target();
      if (!user) return;
      const code = await issueEmailCode(sql, config.appSecret, user.id, purpose);
      if (!code) return;
      // 收件人的语言优先，其次是这次请求的语言。两者都没有时是 v0.1.0 或者旧客户端，用中文。
      const locale = user.locale ?? requestLocale ?? 'zh';
      await mailer.send(
        purpose === 'verify_email'
          ? verifyEmailMail(user.email, code, locale)
          : resetPasswordMail(user.email, code, locale),
      );
    };
    background(
      task().catch((error: unknown) => {
        // 只记错误原因，不记收件人和验证码。
        console.error('验证码邮件发送失败', error instanceof Error ? error.message : 'unknown');
      }),
    );
  }

  async function createSession(userId: string): Promise<string> {
    const token = newToken();
    const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000);
    await sql`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (${sha256(token)}, ${userId}, ${expires})`;
    return token;
  }

  const normalizeEmail = (email: string) => email.trim().toLowerCase();
  const normalizeCode = (code: string) => code.trim().toUpperCase().replace(/[\s-]/g, '');

  async function findValidInvite(code: string) {
    const [invite] = await sql<
      { id: string; family_id: string; role: Role; label: string }[]
    >`SELECT id, family_id, role, label FROM invites
      WHERE code_hash = ${sha256(normalizeCode(code))} AND used_at IS NULL AND expires_at > now()`;
    return invite ?? null;
  }

  const clientIp = (c: { req: { header(name: string): string | undefined } }) =>
    clientIpFrom((name) => c.req.header(name), config.clientIp);
  /** 带着邮箱，拿不到来源时共用 unknown 也只影响这一个邮箱。找回密码后要清除同一个键。 */
  const loginIpKey = (c: Parameters<typeof clientIp>[0], email: string) =>
    `login:${clientIp(c) ?? 'unknown'}:${email}`;

  app.post('/v1/auth/register', bodyLimit({ maxSize: 64 * 1024 }), async (c) => {
    const body = await parseBody(c, RegisterRequest);
    if (!config.allowSignup) {
      if (!body.inviteCode) fail(403, 'signup_closed', '这台服务器不开放注册，需要家人的邀请码');
      if (!(await findValidInvite(body.inviteCode)))
        fail(403, 'invalid_invite', '邀请码无效或已过期');
    }
    // 放在算哈希之前：scrypt 是这个接口最贵的一步。
    // 拿不到来源时不按来源限制，否则所有人共用一个计数；总量限制不看来源，换地址绕不过。
    const ip = clientIp(c);
    const { registerPerIpHour, registerGlobalHour } = config.limits;
    if (
      (ip &&
        registerPerIpHour > 0 &&
        !(await allowAttempt(sql, `register:${ip}`, registerPerIpHour, REGISTER_WINDOW_MS))) ||
      (registerGlobalHour > 0 &&
        !(await allowAttempt(sql, 'register', registerGlobalHour, REGISTER_WINDOW_MS)))
    ) {
      fail(429, 'too_many_attempts', '注册的人太多了，请过一会儿再试', { reason: 'signup' });
    }
    const email = normalizeEmail(body.email);
    const id = crypto.randomUUID();
    const passwordHash = await hashPassword(body.password);
    const inserted = await sql`
      INSERT INTO users (id, email, password_hash, display_name)
      VALUES (${id}, ${email}, ${passwordHash}, ${body.displayName})
      ON CONFLICT (email) DO NOTHING RETURNING id`;
    if (inserted.length === 0) fail(409, 'email_taken', '这个邮箱已经注册过了，可以直接登录');
    const token = await createSession(id);
    // 超过上限只是不发信，注册本身成功，App 的验证页可以重发。否则注册接口就成了给陌生邮箱群发的工具。
    // 拿不到来源时跳过这一条，只剩上面不看来源的注册总量限制。
    if (mailer && (!ip || (await allowAttempt(sql, `register-mail:${ip}`, 20, HOUR_MS)))) {
      sendCodeLater(
        'verify_email',
        async () => ({ id, email }),
        localeFromAcceptLanguage(c.req.header('accept-language')),
      );
    }
    return c.json<AuthResponse>({ token, user: { id, email, displayName: body.displayName } }, 201);
  });

  app.post('/v1/auth/login', bodyLimit({ maxSize: 64 * 1024 }), async (c) => {
    const body = await parseBody(c, LoginRequest);
    const email = normalizeEmail(body.email);
    // 第二条不看来源：部署配错时来源可能是客户端自己填的，换着填就能绕过第一条。
    // 代价是有人能让某个邮箱 15 分钟内登录不了，已登录的设备不受影响。
    const allowed =
      (await allowAttempt(sql, loginIpKey(c, email), 10, LOGIN_WINDOW_MS)) &&
      (await allowAttempt(sql, `login:${email}`, 50, LOGIN_WINDOW_MS));
    if (!allowed)
      fail(429, 'too_many_attempts', '尝试次数太多了，请 15 分钟后再试', { minutes: 15 });
    const [user] = await sql<
      { id: string; password_hash: string; display_name: string }[]
    >`SELECT id, password_hash, display_name FROM users WHERE email = ${email}`;
    if (!user) await burnPasswordCheck(body.password);
    const valid = user ? await verifyPassword(body.password, user.password_hash) : false;
    if (!user || !valid) fail(401, 'bad_credentials', '邮箱或密码不正确');
    const token = await createSession(user.id);
    return c.json<AuthResponse>({
      token,
      user: { id: user.id, email, displayName: user.display_name },
    });
  });

  // 找回密码的两个接口，响应都不能泄露邮箱是否存在：限流只看来源和邮箱字符串，真假邮箱计数相同。
  app.post('/v1/auth/password/forgot', bodyLimit({ maxSize: 64 * 1024 }), async (c) => {
    const body = await parseBody(c, ForgotPasswordRequest);
    if (!mailer) fail(503, 'mail_disabled', MAIL_DISABLED_MESSAGE);
    const email = normalizeEmail(body.email);
    // 拿不到来源时跳过这一条：所有人共用一个计数的话，一个人就能挡住全部用户找回密码。
    const ip = clientIp(c);
    if (ip && !(await allowAttempt(sql, `forgot:${ip}`, 20, LOGIN_WINDOW_MS))) {
      fail(429, 'too_many_attempts', '尝试次数太多了，请稍后再试');
    }
    // 超过发送上限只是不发信，响应不变：这条限制防的是轰炸别人的邮箱，也限制了换验证码继续猜的次数。
    const allowed =
      (await allowAttempt(sql, `forgot-hour:${email}`, 5, HOUR_MS)) &&
      (await allowAttempt(sql, `forgot-day:${email}`, 10, 24 * HOUR_MS));
    if (allowed) {
      sendCodeLater(
        'reset_password',
        async () => {
          const [user] = await sql<
            { id: string; prefs: unknown }[]
          >`SELECT id, prefs FROM users WHERE email = ${email}`;
          return user ? { id: user.id, email, locale: mergePrefs(user.prefs).locale } : undefined;
        },
        localeFromAcceptLanguage(c.req.header('accept-language')),
      );
    }
    return c.json({ ok: true });
  });

  app.post('/v1/auth/password/reset', bodyLimit({ maxSize: 64 * 1024 }), async (c) => {
    const body = await parseBody(c, ResetPasswordRequest);
    if (!mailer) fail(503, 'mail_disabled', MAIL_DISABLED_MESSAGE);
    const email = normalizeEmail(body.email);
    const allowed =
      (await allowAttempt(sql, `reset:${clientIp(c) ?? 'unknown'}:${email}`, 20, HOUR_MS)) &&
      (await allowAttempt(sql, `reset:${email}`, 20, HOUR_MS));
    if (!allowed) fail(429, 'too_many_attempts', '尝试次数太多了，请稍后再试');
    const matched = await matchEmailCode(sql, config.appSecret, email, 'reset_password', body.code);
    if (!matched) fail(400, 'invalid_code', INVALID_CODE_MESSAGE);
    // 哈希放在事务外：scrypt 很慢，连接池可能只有 1 个连接。
    const passwordHash = await hashPassword(body.newPassword);
    const changed = await sql.begin(async (tx) => {
      if (!(await consumeEmailCode(tx, 'reset_password', matched))) return false;
      await tx`UPDATE users SET
          password_hash = ${passwordHash},
          email_verified_at = COALESCE(email_verified_at, now())
        WHERE id = ${matched.userId}`;
      // 和命令行重置一样：旧设备上的登录全部失效，防止遗失的手机继续访问。
      await tx`DELETE FROM sessions WHERE user_id = ${matched.userId}`;
      await tx`DELETE FROM email_codes WHERE user_id = ${matched.userId}`;
      // 本人往往是猜错太多次才来改密码的，不解除的话改完还是登录不了。
      await tx`DELETE FROM rate_limits WHERE key_hash = ANY(${[
        sha256(loginIpKey(c, email)),
        sha256(`login:${email}`),
      ]})`;
      return true;
    });
    if (!changed) fail(400, 'invalid_code', INVALID_CODE_MESSAGE);
    return c.json({ ok: true });
  });

  // ─── 需要登录 ──────────────────────────────────────────

  const v1 = new Hono<Env>();
  v1.use('*', async (c, next) => {
    const header = c.req.header('authorization');
    const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) fail(401, 'unauthenticated', '请先登录');
    const [row] = await sql<
      {
        id: string;
        email: string;
        display_name: string;
        prefs: unknown;
        email_verified_at: Date | null;
        family_id: string | null;
        role: Role | null;
        label: string | null;
      }[]
    >`SELECT u.id, u.email, u.display_name, u.prefs, u.email_verified_at, m.family_id, m.role, m.label
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      LEFT JOIN memberships m ON m.user_id = u.id
      WHERE s.token_hash = ${sha256(token)} AND s.expires_at > now()`;
    if (!row) fail(401, 'unauthenticated', '登录已过期，请重新登录', { reason: 'expired' });
    // 常用的手机不应该到期被踢：剩余不足一半时续期（不是每次都写库）。
    await sql`UPDATE sessions SET expires_at = now() + interval '1 day' * ${SESSION_DAYS}
      WHERE token_hash = ${sha256(token)} AND expires_at < now() + interval '1 day' * ${SESSION_DAYS / 2}`;
    c.set('user', {
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      prefs: mergePrefs(row.prefs),
      emailVerified: row.email_verified_at !== null,
    });
    c.set(
      'membership',
      row.family_id && row.role && row.label
        ? { familyId: row.family_id, role: row.role, label: row.label }
        : null,
    );
    await next();
  });

  const requireFamily = (c: { get(key: 'membership'): Membership | null }): Membership => {
    const m = c.get('membership');
    if (!m) fail(403, 'no_family', '还没有加入家庭');
    return m;
  };
  const requireAdmin = (c: { get(key: 'membership'): Membership | null }): Membership => {
    const m = requireFamily(c);
    if (m.role !== 'admin') fail(403, 'forbidden', '只有管理员可以这样做', { reason: 'admin' });
    return m;
  };

  v1.post('/auth/logout', async (c) => {
    const token = c.req.header('authorization')!.slice(7);
    await sql`DELETE FROM sessions WHERE token_hash = ${sha256(token)}`;
    return c.json({ ok: true });
  });

  /**
   * 能不能看收到的反馈：邮箱在 FEEDBACK_VIEWER_EMAILS 里。服务器发邮件时还要验证过邮箱，
   * 否则维护者还没注册时，别人先用这个邮箱注册就能看到所有反馈的附件。不发邮件的服务器验证不了，
   * 维护者要先注册好再把邮箱写进名单（见 DEPLOYMENT）。
   */
  const canViewFeedback = (user: AuthedUser) =>
    Boolean(config.feedbackViewers?.has(user.email)) && (user.emailVerified || !mailer);

  async function buildMe(user: AuthedUser, m: Membership | null): Promise<MeResponse> {
    let family: MeResponse['family'] = null;
    let members: FamilyMember[] = [];
    let invites: PendingInvite[] = [];
    if (m) {
      await sql`UPDATE memberships SET last_seen_at = now() WHERE family_id = ${m.familyId} AND user_id = ${user.id}`;
      const [f] = await sql<
        { id: string; name: string }[]
      >`SELECT id, name FROM families WHERE id = ${m.familyId}`;
      family = f ?? null;
      const rows = await sql<
        { user_id: string; label: string; role: Role; last_seen_at: Date | null }[]
      >`SELECT user_id, label, role, last_seen_at FROM memberships WHERE family_id = ${m.familyId} ORDER BY created_at`;
      members = rows.map((r) => ({
        userId: r.user_id,
        label: r.label,
        role: r.role,
        lastSeenAt: r.last_seen_at?.getTime() ?? null,
      }));
      if (m.role === 'admin') {
        const inviteRows = await sql<
          { id: string; label: string; role: Role; expires_at: Date }[]
        >`SELECT id, label, role, expires_at FROM invites
          WHERE family_id = ${m.familyId} AND used_at IS NULL AND expires_at > now() ORDER BY created_at`;
        invites = inviteRows.map((r) => ({
          id: r.id,
          label: r.label,
          role: r.role,
          expiresAt: r.expires_at.getTime(),
        }));
      }
    }
    return {
      user: { id: user.id, email: user.email, displayName: user.displayName },
      emailVerified: user.emailVerified || !mailer,
      family,
      role: m?.role ?? null,
      label: m?.label ?? null,
      members,
      invites,
      prefs: user.prefs,
      canViewFeedback: canViewFeedback(user),
    };
  }

  v1.get('/me', async (c) => c.json(await buildMe(c.get('user'), c.get('membership'))));

  // ─── 应用内更新 ────────────────────────────────────────

  /**
   * 清单由发布流程写进默认存储（scripts/publish-apk.sh）。Bucket 是私有的，这里只签一个短时效的下载链接。
   * 要登录：链接是 Bucket 的流量，不给陌生人随便取。不要求家庭，换手机后还没加入家庭的人也能更新。
   */
  v1.get('/app/update', async (c) => {
    const query = AppUpdateQuery.safeParse(c.req.query());
    if (!query.success) {
      fail(400, 'invalid_input', '输入有误：platform 或 versionCode 不对', {
        field: 'query',
        detail: query.error.issues[0]?.message ?? '',
      });
    }
    const storage = platformStorage(config);
    if (!storage) return c.json<AppUpdateResponse>({ update: null });
    const unavailable = (): never =>
      fail(503, 'update_unavailable', '暂时查不到新版本，请稍后再试');
    let text: string | null;
    try {
      text = await readSmallObject(
        storage,
        `${config.releasePrefix}${RELEASE_MANIFEST_NAME}`,
        64 * 1024,
      );
    } catch (error) {
      console.warn('读取发布清单失败', error instanceof Error ? error.name : 'unknown');
      return unavailable();
    }
    if (text === null) return c.json<AppUpdateResponse>({ update: null });
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      raw = null;
    }
    const parsed = ReleaseManifest.safeParse(raw);
    if (!parsed.success || !isReleaseKey(parsed.data.apk.key, config.releasePrefix)) {
      // 清单只有发布流程会写。坏了要让人知道，不能当成“已经是最新”。
      console.warn('发布清单格式不对');
      return unavailable();
    }
    const manifest = parsed.data;
    const decision = updateDecision(manifest, query.data.versionCode);
    if (!decision.available) return c.json<AppUpdateResponse>({ update: null });
    // 签名链接不进日志。
    const url = await presignDownload(storage, manifest.apk.key, APP_UPDATE_URL_TTL);
    return c.json<AppUpdateResponse>({
      update: {
        versionCode: manifest.versionCode,
        versionName: manifest.versionName,
        size: manifest.apk.size,
        sha256: manifest.apk.sha256,
        url,
        expiresIn: APP_UPDATE_URL_TTL,
        required: decision.required,
        notes: manifest.notes ?? null,
      },
    });
  });

  v1.post('/me/email/send-code', async (c) => {
    const user = c.get('user');
    if (!mailer) fail(503, 'mail_disabled', MAIL_DISABLED_MESSAGE);
    if (user.emailVerified) {
      return c.json<SendEmailCodeResponse>({ emailVerified: true, retryAfterSeconds: 0 });
    }
    const wait = await emailCodeCooldown(sql, user.id, 'verify_email');
    if (wait > 0) {
      return c.json<SendEmailCodeResponse>({ emailVerified: false, retryAfterSeconds: wait });
    }
    if (!(await allowAttempt(sql, `verify-send:${user.id}`, 5, HOUR_MS))) {
      fail(429, 'too_many_attempts', '发送次数太多了，请稍后再试', { reason: 'send' });
    }
    sendCodeLater(
      'verify_email',
      async () => ({ id: user.id, email: user.email, locale: user.prefs.locale }),
      localeFromAcceptLanguage(c.req.header('accept-language')),
    );
    return c.json<SendEmailCodeResponse>({
      emailVerified: false,
      retryAfterSeconds: EMAIL_CODE_COOLDOWN_SECONDS,
    });
  });

  v1.post('/me/email/verify', async (c) => {
    const user = c.get('user');
    const membership = c.get('membership');
    if (!mailer) fail(503, 'mail_disabled', MAIL_DISABLED_MESSAGE);
    const body = await parseBody(c, VerifyEmailRequest);
    if (user.emailVerified) return c.json(await buildMe(user, membership));
    if (!(await allowAttempt(sql, `verify:${user.id}`, 20, HOUR_MS))) {
      fail(429, 'too_many_attempts', '尝试次数太多了，请稍后再试');
    }
    const matched = await matchEmailCode(
      sql,
      config.appSecret,
      user.email,
      'verify_email',
      body.code,
    );
    if (!matched) fail(400, 'invalid_code', INVALID_CODE_MESSAGE);
    const verified = await sql.begin(async (tx) => {
      if (!(await consumeEmailCode(tx, 'verify_email', matched))) return false;
      await tx`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`;
      return true;
    });
    if (!verified) fail(400, 'invalid_code', INVALID_CODE_MESSAGE);
    return c.json(await buildMe({ ...user, emailVerified: true }, membership));
  });

  v1.put('/me/prefs', async (c) => {
    const prefs = await parseBody(c, Prefs);
    await sql`UPDATE users SET prefs = ${sql.json(prefs)} WHERE id = ${c.get('user').id}`;
    return c.json(prefs);
  });

  v1.post('/me/push-token', async (c) => {
    const body = await parseBody(c, PushTokenRequest);
    await sql`
      INSERT INTO push_tokens (device_id, user_id, token) VALUES (${body.deviceId}, ${c.get('user').id}, ${body.token})
      ON CONFLICT (device_id) DO UPDATE SET user_id = EXCLUDED.user_id, token = EXCLUDED.token, updated_at = now()`;
    return c.json({ ok: true });
  });

  v1.delete('/me/push-token/:deviceId', async (c) => {
    await sql`DELETE FROM push_tokens WHERE device_id = ${c.req.param('deviceId')} AND user_id = ${c.get('user').id}`;
    return c.json({ ok: true });
  });

  // 用 POST 而不是带请求体的 DELETE：有些代理和客户端会丢掉 DELETE 的请求体。
  v1.post('/me/delete', bodyLimit({ maxSize: 64 * 1024 }), async (c) => {
    const user = c.get('user');
    const body = await parseBody(c, DeleteAccountRequest);
    if (!(await allowAttempt(sql, `delete-account:${user.id}`, 10, LOGIN_WINDOW_MS))) {
      fail(429, 'too_many_attempts', '尝试次数太多了，请 15 分钟后再试', { minutes: 15 });
    }
    const [row] = await sql<
      { password_hash: string }[]
    >`SELECT password_hash FROM users WHERE id = ${user.id}`;
    // 不能用 401：App 收到 unauthenticated 会回到登录页。
    if (!row || !(await verifyPassword(body.password, row.password_hash))) {
      fail(403, 'wrong_password', '密码不正确');
    }
    const outcome = await sql.begin(async (tx) => {
      const [mine] = await tx<
        { family_id: string }[]
      >`SELECT family_id FROM memberships WHERE user_id = ${user.id}`;
      if (mine) {
        await tx`SELECT id FROM families WHERE id = ${mine.family_id} FOR UPDATE`;
        const members = await tx<{ user_id: string; role: Role }[]>`
          SELECT user_id, role FROM memberships WHERE family_id = ${mine.family_id}`;
        if (
          accountDeletionOutcome(
            user.id,
            members.map((m) => ({ userId: m.user_id, role: m.role })),
          ) === 'blocked_only_admin'
        ) {
          return 'blocked_only_admin' as const;
        }
      }
      // 自己的证件（F-137）只属于这个账号，不留给家庭：内容立即删掉，文件进待删除队列。
      // 被移出过的家庭里的也算。要在删除家庭之前：家庭删了就不知道这些文件是谁的了。
      const ownFiles = await eraseOwnedDocuments(tx, user.id);
      await enqueueMediaObjects(tx, ownFiles, UPLOAD_URL_TTL);
      if (ownFiles.length > 0) await tx`DELETE FROM media WHERE id = ANY(${ownFiles}::uuid[])`;
      if (mine) {
        // 锁住家庭再看成员：两个人同时删除时，不锁的话都以为对方还在，
        // 会留下没有管理员的家庭，或者没有成员、文件再也删不掉的家庭。
        await tx`SELECT id FROM families WHERE id = ${mine.family_id} FOR UPDATE`;
        const members = await tx<{ user_id: string; role: Role }[]>`
          SELECT user_id, role FROM memberships WHERE family_id = ${mine.family_id}`;
        const decision = accountDeletionOutcome(
          user.id,
          members.map((m) => ({ userId: m.user_id, role: m.role })),
        );
        if (decision === 'blocked_only_admin') return decision;
        if (decision === 'delete_family') {
          // 顺序不能换：记录、文件记录、存储配置都随家庭级联删除，之后就不知道文件在哪了。
          await enqueueFamilyObjects(tx, mine.family_id, UPLOAD_URL_TTL);
          await tx`DELETE FROM families WHERE id = ${mine.family_id}`;
        }
      }
      // 反馈随账号级联删除，附件要先进队列。已经发到 GitHub 的文字留在那里，提交时说明过会公开。
      await enqueueUserFeedbackObjects(tx, user.id, UPLOAD_URL_TTL);
      // 登录、推送令牌、成员关系、验证码随账号级联删除，记录的 created_by 置空后留给家庭。
      await tx`DELETE FROM users WHERE id = ${user.id}`;
      return 'deleted' as const;
    });
    if (outcome === 'blocked_only_admin') {
      fail(
        409,
        'only_admin',
        '你是这个家庭唯一的管理员。请先把另一位家人设为管理员，或者把其他家人都移出家庭，再删除账号。',
      );
    }
    // 也会顺带处理之前失败的。没做完的留在队列里，由每天的 cli maintenance 兜底。
    background(
      processPendingDeletions(sql, config)
        .then(() => {})
        .catch((error: unknown) => {
          console.error('清理文件失败', error instanceof Error ? error.message : 'unknown');
        }),
    );
    return c.json({ ok: true });
  });

  // ─── 反馈 ─────────────────────────────────────────────
  // 账号级的：没有家庭、只看回忆的家人都能提交。不读写任何家庭数据，所以不用家庭权限。

  const requireFeedback = () => {
    if (!config.feedback) fail(503, 'feedback_disabled', '这台服务器没有开启反馈');
    return config.feedback;
  };
  const feedbackIdParam = (c: Context<Env>): string => {
    const parsed = z.uuid().safeParse(c.req.param('id'));
    if (!parsed.success) fail(404, 'not_found', '找不到这条反馈');
    return parsed.data;
  };
  /** 附件只放平台存储，永远不写进家庭自带的 Bucket：反馈不属于家庭，维护者也读不了那里。 */
  const feedbackStorage = async () => {
    const storage = await storageById(sql, config, '', null);
    if (!storage) {
      fail(503, 'feedback_attachments_unavailable', '这台服务器不能收附件，只能发文字');
    }
    return storage;
  };
  const retryOtherFeedback = () => background(deliverInBackground(sql, config));

  v1.post('/feedback', bodyLimit({ maxSize: 64 * 1024 }), async (c) => {
    const user = c.get('user');
    const settings = requireFeedback();
    const body = await parseBody(c, CreateFeedbackRequest);
    const ids = body.attachments.map((a) => a.id);
    if (new Set(ids).size !== ids.length) {
      fail(400, 'invalid_input', '输入有误：attachments 有重复', {
        field: 'attachments',
        detail: 'duplicate',
      });
    }
    for (const a of body.attachments) {
      const limit = feedbackAttachmentLimit(a.mime);
      if (limit === null) fail(400, 'bad_type', '不支持这种文件类型');
      if (a.size > limit) {
        fail(413, 'too_large', `文件太大了，这种文件最大 ${formatBytes(limit)}`, {
          maxBytes: limit,
        });
      }
    }
    const storage = body.attachments.length > 0 ? await feedbackStorage() : null;
    const [existing] = await sql<{ user_id: string; status: FeedbackStatus }[]>`
      SELECT user_id, status FROM feedback WHERE id = ${body.id}`;
    // 别人的 id 和不存在一样处理，不透露它存在。
    if (existing && existing.user_id !== user.id) fail(404, 'not_found', '找不到这条反馈');
    if (existing && existing.status !== 'draft') {
      return c.json<CreateFeedbackResponse>({ id: body.id, status: existing.status, uploads: [] });
    }
    if (!existing) {
      // 每人每天、全站每小时：令牌是部署者的，被刷爆了所有人都发不出去。重试同一条不算。
      if (
        (settings.perUserDay > 0 &&
          !(await allowAttempt(sql, `feedback:${user.id}`, settings.perUserDay, DAY_MS))) ||
        (settings.globalHour > 0 &&
          !(await allowAttempt(sql, 'feedback', settings.globalHour, HOUR_MS)))
      ) {
        fail(429, 'too_many_attempts', '反馈有点多了，请稍后再试', { reason: 'feedback' });
      }
    } else if (!(await allowAttempt(sql, `feedback-edit:${user.id}`, 100, DAY_MS))) {
      fail(429, 'too_many_attempts', '反馈有点多了，请稍后再试', { reason: 'feedback' });
    }
    const text = cleanFeedbackText(body.text);
    const saved = await sql.begin(async (tx) => {
      const [row] = await tx<{ inserted: boolean }[]>`
        INSERT INTO feedback (id, user_id, text, diagnostics, public_attachments)
        VALUES (${body.id}, ${user.id}, ${text}, ${tx.json(body.diagnostics)},
                ${body.publicAttachments === true})
        ON CONFLICT (id) DO UPDATE SET text = EXCLUDED.text, diagnostics = EXCLUDED.diagnostics,
          public_attachments = EXCLUDED.public_attachments, updated_at = now()
          WHERE feedback.user_id = EXCLUDED.user_id AND feedback.status = 'draft'
        RETURNING (xmax = 0) AS inserted`;
      // 同时有别的请求把它提交了，或者 id 被别人抢先用了。
      if (!row) return null;
      await enqueueRemovedAttachments(tx, body.id, ids, UPLOAD_URL_TTL);
      await tx`DELETE FROM feedback_attachments
               WHERE feedback_id = ${body.id} AND NOT (id = ANY(${ids}::uuid[]))`;
      const pending: { id: string; mime: string; size: number }[] = [];
      for (const a of body.attachments) {
        const [att] = await tx<{ status: string }[]>`
          INSERT INTO feedback_attachments (id, feedback_id, mime, size, object_key)
          VALUES (${a.id}, ${body.id}, ${a.mime}, ${a.size}, ${feedbackObjectKey(body.id, a.id)})
          ON CONFLICT (id) DO UPDATE SET
            mime = EXCLUDED.mime,
            size = EXCLUDED.size,
            status = CASE
              WHEN feedback_attachments.mime = EXCLUDED.mime AND feedback_attachments.size = EXCLUDED.size
              THEN feedback_attachments.status ELSE 'pending' END
            WHERE feedback_attachments.feedback_id = EXCLUDED.feedback_id
          RETURNING status`;
        if (!att) fail(409, 'already_uploaded', '文件已经上传过了');
        if (att.status === 'pending') pending.push(a);
      }
      // 同一个 key 以前可能进过待删除队列（草稿被清理后又用同一个 id 回来）。没传完的对象在队列里
      // 还有一条一小时后才删的，不撤掉的话会把这次新传的删掉。key 由这个人的反馈 id 拼成，碰不到别人的。
      if (ids.length > 0) {
        await tx`DELETE FROM pending_object_deletions WHERE storage IS NULL
                 AND object_key = ANY(${ids.map((a) => feedbackObjectKey(body.id, a))})`;
      }
      return { inserted: row.inserted, pending };
    });
    if (!saved) {
      const [now] = await sql<{ user_id: string; status: FeedbackStatus }[]>`
        SELECT user_id, status FROM feedback WHERE id = ${body.id}`;
      if (!now || now.user_id !== user.id) fail(404, 'not_found', '找不到这条反馈');
      return c.json<CreateFeedbackResponse>({ id: body.id, status: now.status, uploads: [] });
    }
    const uploads = storage
      ? await Promise.all(
          saved.pending.map(async (a) => ({
            id: a.id,
            url: await presignUpload(
              storage,
              feedbackObjectKey(body.id, a.id),
              a.mime,
              a.size,
              UPLOAD_URL_TTL,
              config.bindUploadSize,
            ),
            headers: { 'Content-Type': a.mime },
            expiresIn: UPLOAD_URL_TTL,
          })),
        )
      : [];
    retryOtherFeedback();
    return c.json<CreateFeedbackResponse>(
      { id: body.id, status: 'draft', uploads },
      saved.inserted ? 201 : 200,
    );
  });

  v1.post('/feedback/:id/submit', async (c) => {
    const user = c.get('user');
    requireFeedback();
    const id = feedbackIdParam(c);
    const [row] = await sql<{ user_id: string; status: FeedbackStatus }[]>`
      SELECT user_id, status FROM feedback WHERE id = ${id}`;
    if (!row || row.user_id !== user.id) fail(404, 'not_found', '找不到这条反馈');
    if (row.status === 'draft') {
      const files = await sql<{ id: string; size: string; object_key: string; status: string }[]>`
        SELECT id, size, object_key, status FROM feedback_attachments WHERE feedback_id = ${id}`;
      const pending = files.filter((f) => f.status === 'pending');
      if (pending.length > 0) {
        const storage = await feedbackStorage();
        for (const f of pending) {
          const head = await headObject(storage, f.object_key);
          if (!head) fail(409, 'not_uploaded', '文件还没有上传完成');
          if (head.size !== Number(f.size)) {
            await deleteObject(storage, f.object_key);
            fail(409, 'size_mismatch', '文件大小不一致，请重新上传');
          }
        }
      }
      await sql.begin(async (tx) => {
        await tx`UPDATE feedback_attachments SET status = 'ready'
                 WHERE feedback_id = ${id} AND id = ANY(${pending.map((f) => f.id)}::uuid[])`;
        const moved =
          await tx`UPDATE feedback SET status = 'queued', submitted_at = now(), next_attempt_at = now(),
                   attachment_count = ${files.length}
                 WHERE id = ${id} AND status = 'draft'`;
        // 同时提交两次时只有改成 queued 的那一次发令牌。
        if (moved.count > 0) await publishAttachments(tx, config, id);
      });
    }
    // 当场发一次。失败也是 200：反馈已经存下了，之后会自动重试。
    await deliverDueFeedback(sql, config, { id });
    retryOtherFeedback();
    const [after] = await sql<{ status: FeedbackStatus }[]>`
      SELECT status FROM feedback WHERE id = ${id}`;
    return c.json({ id, status: after?.status ?? row.status });
  });

  v1.get('/feedback', async (c) => {
    const rows = await sql<
      {
        id: string;
        status: FeedbackStatus;
        created_at: Date;
        text: string;
        attachments: number;
      }[]
    >`SELECT f.id, f.status, f.created_at, f.text,
             GREATEST(f.attachment_count,
               (SELECT count(*) FROM feedback_attachments a WHERE a.feedback_id = f.id))::int AS attachments
      FROM feedback f WHERE f.user_id = ${c.get('user').id}
      ORDER BY f.created_at DESC LIMIT 20`;
    return c.json<FeedbackListResponse>({
      items: rows.map((r) => ({
        id: r.id,
        status: r.status,
        createdAt: r.created_at.getTime(),
        excerpt: r.text.slice(0, 80),
        attachments: r.attachments,
      })),
    });
  });

  // ─── 维护者看收到的反馈 ─────────────────────────────────
  // 只有 FEEDBACK_VIEWER_EMAILS 里的账号。和家庭权限无关：维护者不用在任何家庭里，名单里的人也不会因此
  // 多读到任何家庭数据。没配置和不在名单里是同一个 403，从外面分不出这台服务器有没有开这个功能。
  // 返回的内容不带提交者的邮箱、账号和家庭（feedback.ts 里的查询根本不读这些列）。

  const requireFeedbackViewer = async (c: Context<Env>) => {
    const user = c.get('user');
    if (!canViewFeedback(user)) {
      fail(403, 'forbidden', '这个账号不能查看收到的反馈', { reason: 'feedbackViewer' });
    }
    if (
      config.feedbackViewPerHour > 0 &&
      !(await allowAttempt(sql, `feedback-view:${user.id}`, config.feedbackViewPerHour, HOUR_MS))
    ) {
      fail(429, 'too_many_attempts', '看得太频繁了，请稍后再试', { reason: 'feedbackView' });
    }
  };

  v1.get('/feedback-inbox', async (c) => {
    await requireFeedbackViewer(c);
    const query = FeedbackInboxQuery.safeParse(c.req.query());
    if (!query.success) {
      fail(400, 'invalid_input', '输入有误：before 或 limit 不对', {
        field: 'query',
        detail: query.error.issues[0]?.message ?? '',
      });
    }
    return c.json<FeedbackInboxResponse>(
      await feedbackInbox(sql, config, {
        before: query.data.before,
        limit: query.data.limit ?? FEEDBACK_INBOX_PAGE,
      }),
    );
  });

  v1.get('/feedback-inbox/:id', async (c) => {
    await requireFeedbackViewer(c);
    const item = await feedbackInboxItem(sql, config, feedbackIdParam(c));
    if (!item) fail(404, 'not_found', '找不到这条反馈');
    return c.json<FeedbackInboxItem>(item);
  });

  /** 每次打开时现取。链接只在响应体里，不进日志（onError 只记路径，路径里没有链接）。 */
  v1.get('/feedback-inbox/:id/attachments/:attachmentId', async (c) => {
    await requireFeedbackViewer(c);
    const id = feedbackIdParam(c);
    const attachmentId = z.uuid().safeParse(c.req.param('attachmentId'));
    if (!attachmentId.success) fail(404, 'not_found', '找不到这个附件');
    const result = await feedbackAttachmentUrl(sql, config, id, attachmentId.data);
    if (result.kind === 'not_found') fail(404, 'not_found', '找不到这个附件');
    if (result.kind === 'gone') {
      fail(410, 'feedback_attachment_gone', '这个附件已经删除，多半是过了保留期');
    }
    if (result.kind === 'no_storage') {
      fail(503, 'storage_unavailable', '存储暂时不可用，请稍后再试');
    }
    return c.json<FeedbackAttachmentUrlResponse>({ url: result.url, expiresIn: result.expiresIn });
  });

  // ─── 家庭和邀请 ─────────────────────────────────────────

  v1.get('/family/export', async (c) => {
    const m = requireFamily(c);
    const user = c.get('user');
    if (!(await allowAttempt(sql, `export:${user.id}`, 10, HOUR_MS))) {
      fail(429, 'too_many_attempts', '导出太频繁了，请稍后再试', { reason: 'export' });
    }
    const readable = collections.filter((name) => canReadCollection(m.role, name));
    const [family] = await sql<
      { id: string; name: string }[]
    >`SELECT id, name FROM families WHERE id = ${m.familyId}`;
    const members = await sql<{ user_id: string; label: string; role: Role }[]>`
      SELECT user_id, label, role FROM memberships WHERE family_id = ${m.familyId} ORDER BY created_at`;
    const records = await visibleForExport(
      sql,
      m.familyId,
      { userId: user.id, role: m.role },
      await sql<RecordRow[]>`
        SELECT id, collection, data, deleted, updated_at_client, seq, created_by, owner_id, readers
        FROM records
        WHERE family_id = ${m.familyId} AND NOT deleted AND collection = ANY(${readable})
        ORDER BY seq`,
    );
    // 字段逐个列出，不用 SELECT *：object_key 和存储配置不能出现在导出文件里。
    const media = await sql<
      {
        id: string;
        variant: FamilyExport['media'][number]['variant'];
        scope: FamilyExport['media'][number]['scope'];
        mime: string;
        size: string;
        filename: string | null;
        created_at: Date;
        owner_id: string | null;
        uploaded_by: string | null;
      }[]
    >`SELECT id, variant, scope, mime, size, filename, created_at, owner_id, uploaded_by FROM media
      WHERE family_id = ${m.familyId} AND status = 'ready' AND unreferenced_at IS NULL
      ORDER BY created_at, id, variant`;
    const ownedMedia = await readableOwnedMedia(
      sql,
      m.familyId,
      { userId: user.id, role: m.role },
      media,
    );
    const now = new Date();
    const stamp = now.toISOString().slice(0, 10).replaceAll('-', '');
    c.header('content-disposition', `attachment; filename="xiaodouya-export-${stamp}.json"`);
    c.header('cache-control', 'no-store');
    return c.json<FamilyExport>({
      format: 'xiaodouya-export',
      version: 1,
      exportedAt: now.getTime(),
      account: { id: user.id, email: user.email, displayName: user.displayName },
      family: { id: m.familyId, name: family?.name ?? '' },
      role: m.role,
      members: members.map((r) => ({ userId: r.user_id, label: r.label, role: r.role })),
      records: records.map((r) => ({
        id: r.id,
        collection: r.collection,
        data: r.data,
        updatedAt: Number(r.updated_at_client),
        createdBy: r.created_by,
      })),
      media: media
        .filter((r) => canReadMediaScope(m.role, r.scope))
        .filter((r) => !isDocumentScope(r.scope) || ownedMedia.has(r.id))
        .map((r) => ({
          id: r.id,
          variant: r.variant,
          scope: r.scope,
          mime: r.mime,
          size: Number(r.size),
          filename: r.filename,
          createdAt: r.created_at.getTime(),
        })),
    });
  });

  v1.post('/families', async (c) => {
    const user = c.get('user');
    if (c.get('membership')) fail(409, 'already_in_family', '你已经在一个家庭里了');
    const body = await parseBody(c, CreateFamilyRequest);
    const id = crypto.randomUUID();
    await sql.begin(async (tx) => {
      await tx`INSERT INTO families (id, name) VALUES (${id}, ${body.name})`;
      await tx`INSERT INTO memberships (family_id, user_id, role, label, last_seen_at) VALUES (${id}, ${user.id}, 'admin', ${body.label}, now())`;
    });
    return c.json(await buildMe(user, { familyId: id, role: 'admin', label: body.label }), 201);
  });

  v1.post('/invites', async (c) => {
    const m = requireAdmin(c);
    const body = await parseBody(c, CreateInviteRequest);
    const code = newInviteCode();
    const id = crypto.randomUUID();
    const expires = new Date(Date.now() + INVITE_DAYS * 86_400_000);
    await sql`
      INSERT INTO invites (id, family_id, code_hash, role, label, created_by, expires_at)
      VALUES (${id}, ${m.familyId}, ${sha256(code)}, ${body.role}, ${body.label}, ${c.get('user').id}, ${expires})`;
    return c.json({ id, code, expiresAt: expires.getTime() }, 201);
  });

  v1.delete('/invites/:id', async (c) => {
    const m = requireAdmin(c);
    await sql`DELETE FROM invites WHERE id = ${c.req.param('id')}::uuid AND family_id = ${m.familyId} AND used_at IS NULL`;
    return c.json({ ok: true });
  });

  v1.post('/invites/accept', async (c) => {
    const user = c.get('user');
    if (c.get('membership')) fail(409, 'already_in_family', '你已经在一个家庭里了');
    const body = await parseBody(c, AcceptInviteRequest);
    if (!(await allowAttempt(sql, `invite:${user.id}`, 20, INVITE_WINDOW_MS))) {
      fail(429, 'too_many_attempts', '尝试次数太多了，请稍后再试');
    }
    const hash = sha256(normalizeCode(body.code));
    const joined = await sql.begin(async (tx) => {
      // 用条件更新保证邀请码只能被使用一次，即使两人同时提交。
      const [invite] = await tx<{ family_id: string; role: Role; label: string }[]>`
        UPDATE invites SET used_by = ${user.id}, used_at = now()
        WHERE code_hash = ${hash} AND used_at IS NULL AND expires_at > now()
        RETURNING family_id, role, label`;
      if (!invite) return null;
      await tx`INSERT INTO memberships (family_id, user_id, role, label, last_seen_at)
               VALUES (${invite.family_id}, ${user.id}, ${invite.role}, ${invite.label}, now())`;
      // 回到原来的家庭：自己的证件（F-137）离开时对别人藏起来了，现在重新发给选过的家人。
      await tx`SELECT id FROM families WHERE id = ${invite.family_id} FOR UPDATE`;
      await resequenceOwned(tx, invite.family_id, user.id);
      return invite;
    });
    if (!joined) fail(404, 'invalid_invite', '邀请码无效或已过期');
    return c.json(
      await buildMe(user, { familyId: joined.family_id, role: joined.role, label: joined.label }),
    );
  });

  v1.patch('/family/members/:userId', async (c) => {
    const m = requireAdmin(c);
    const body = await parseBody(c, UpdateMemberRequest);
    const target = c.req.param('userId');
    if (body.role && body.role !== 'admin') await assertNotLastAdmin(m.familyId, target);
    await sql.begin(async (tx) => {
      await tx`
        UPDATE memberships SET
          role = COALESCE(${body.role ?? null}, role),
          label = COALESCE(${body.label ?? null}, label)
        WHERE family_id = ${m.familyId} AND user_id = ${target}::uuid`;
      // 只看回忆的家人读不到记录，他之前发出去的链接也不该还能读。
      if (body.role === 'viewer') await revokeSharesBy(tx, m.familyId, target);
    });
    return c.json({ ok: true });
  });

  v1.delete('/family/members/:userId', async (c) => {
    const m = requireAdmin(c);
    const target = c.req.param('userId');
    await assertNotLastAdmin(m.familyId, target);
    await sql.begin(async (tx) => {
      await revokeSharesBy(tx, m.familyId, target);
      await tx`SELECT id FROM families WHERE id = ${m.familyId} FOR UPDATE`;
      await tx`DELETE FROM memberships WHERE family_id = ${m.familyId} AND user_id = ${target}::uuid`;
      // 离开家庭的人的证件（F-137）谁都看不到了，记录和文件留着（回来后接着用，删除账号时才删）。
      // 换新的 seq，家人的手机收到删除标记，把缓存的那份删掉。
      await resequenceOwned(tx, m.familyId, target);
      // 移除后立刻让对方的登录失效，避免继续读取家庭数据的缓存链接。
      await tx`DELETE FROM sessions WHERE user_id = ${target}::uuid`;
    });
    return c.json({ ok: true });
  });

  /** 写 revoked_at，不只靠公开接口核对成员：否则这个人再被加回来，旧链接会复活。 */
  async function revokeSharesBy(tx: Tx, familyId: string, userId: string) {
    await tx`UPDATE shares SET revoked_at = now()
             WHERE family_id = ${familyId} AND created_by = ${userId}::uuid AND revoked_at IS NULL`;
  }

  // ─── 分享一天、分享时间线 ───────────────────────────────

  /** 一天和时间线共用：同样的角色要求、同样的家庭上限、同样的令牌。 */
  async function createShare(
    c: Context<Env>,
    share: {
      kind: ShareKind;
      fromAt: number;
      toAt: number;
      timezone: string;
      include: { moments: boolean; daily: boolean; health: boolean };
      units: Record<string, string>;
      ttlDays: number;
      momentIds?: string[];
    },
  ) {
    const m = requireFamily(c);
    const id = crypto.randomUUID();
    const token = newToken();
    const expires = new Date(Date.now() + share.ttlDays * DAY_MS);
    await sql.begin(async (tx) => {
      // 数和写要在同一把锁里，否则并行创建会一起通过检查。
      await tx`SELECT 1 FROM families WHERE id = ${m.familyId} FOR UPDATE`;
      const [{ count } = { count: '0' }] = await tx<{ count: string }[]>`
        SELECT count(*) AS count FROM shares
        WHERE family_id = ${m.familyId} AND revoked_at IS NULL AND expires_at > now()`;
      if (Number(count) >= MAX_ACTIVE_SHARES) {
        fail(409, 'share_limit', `这个家庭已经有 ${MAX_ACTIVE_SHARES} 个有效的链接，先撤销不用的`, {
          max: MAX_ACTIVE_SHARES,
        });
      }
      await tx`
        INSERT INTO shares (id, family_id, created_by, token_hash, kind, from_at, to_at, timezone,
                            include_moments, include_daily, include_health, units, moment_ids,
                            expires_at)
        VALUES (${id}, ${m.familyId}, ${c.get('user').id}, ${sha256(token)}, ${share.kind},
                ${share.fromAt}, ${share.toAt}, ${share.timezone},
                ${share.include.moments}, ${share.include.daily}, ${share.include.health},
                ${tx.json(share.units)}, ${share.momentIds ?? null}::uuid[], ${expires})`;
    });
    return c.json<CreateShareResponse>({ id, token, expiresAt: expires.getTime() }, 201);
  }

  v1.post('/shares', async (c) => {
    const m = requireFamily(c);
    if (m.role === 'viewer') fail(403, 'forbidden', '你只能查看回忆和照片', { reason: 'viewer' });
    const body = await parseBody(c, CreateShareRequest);
    return createShare(c, { ...body, kind: 'day' });
  });

  v1.post('/shares/timeline', async (c) => {
    const m = requireFamily(c);
    if (m.role === 'viewer') fail(403, 'forbidden', '你只能查看回忆和照片', { reason: 'viewer' });
    const body = await parseBody(c, CreateTimelineShareRequest);
    // 结束定在创建这天：链接不会一直跟着往后看，之后新记的回忆不会自己跑进已经发出去的链接。
    if (body.toAt > Date.now() + SHARE_TIMELINE_MAX_AHEAD_MS) {
      fail(400, 'invalid_input', '输入有误：toAt 不能晚于明天', {
        field: 'toAt',
        detail: 'too far ahead',
      });
    }
    return createShare(c, {
      ...body,
      kind: 'timeline',
      include: TIMELINE_SHARE_INCLUDE,
      units: {},
    });
  });

  // 选中的回忆（F-136）。不核对这些 id 现在在不在服务器上：刚记的可能还没传上来，
  // 公开接口每次现查，只认这个家庭、没删的回忆，写成信、证件或别家的 id 也查不出来。
  v1.post('/shares/moments', async (c) => {
    const m = requireFamily(c);
    if (m.role === 'viewer') fail(403, 'forbidden', '你只能查看回忆和照片', { reason: 'viewer' });
    const body = await parseBody(c, CreateMomentsShareRequest);
    return createShare(c, {
      ...body,
      kind: 'moments',
      include: TIMELINE_SHARE_INCLUDE,
      units: {},
    });
  });

  v1.get('/shares', async (c) => {
    const m = requireFamily(c);
    if (m.role === 'viewer') fail(403, 'forbidden', '你只能查看回忆和照片', { reason: 'viewer' });
    const rows = await sql<(ShareRow & { label: string })[]>`
      SELECT s.id, s.family_id, s.created_by, s.kind, s.from_at, s.to_at, s.timezone,
             s.include_moments, s.include_daily, s.include_health, s.units, s.moment_ids,
             s.expires_at, s.created_at, mem.label
      FROM shares s
      JOIN memberships mem ON mem.family_id = s.family_id AND mem.user_id = s.created_by
      WHERE s.family_id = ${m.familyId} AND s.revoked_at IS NULL AND s.expires_at > now()
      ORDER BY s.from_at DESC, s.created_at DESC`;
    const userId = c.get('user').id;
    return c.json<ShareListResponse>({
      shares: rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        fromAt: Number(row.from_at),
        toAt: Number(row.to_at),
        timezone: row.timezone,
        include: shareInclude(row),
        ...(row.moment_ids ? { momentIds: row.moment_ids } : {}),
        expiresAt: row.expires_at.getTime(),
        createdAt: row.created_at.getTime(),
        byLabel: row.label,
        canRevoke: m.role === 'admin' || row.created_by === userId,
      })),
    });
  });

  v1.delete('/shares/:id', async (c) => {
    const m = requireFamily(c);
    const id = c.req.param('id');
    if (!UUID_PATTERN.test(id)) fail(404, 'not_found', '找不到这个链接');
    const [row] = await sql<{ created_by: string }[]>`
      SELECT created_by FROM shares WHERE id = ${id} AND family_id = ${m.familyId}`;
    if (!row) fail(404, 'not_found', '找不到这个链接');
    if (m.role !== 'admin' && row.created_by !== c.get('user').id) {
      fail(403, 'forbidden', '只有创建者或管理员可以撤销');
    }
    await sql`UPDATE shares SET revoked_at = now() WHERE id = ${id} AND revoked_at IS NULL`;
    return c.json({ ok: true });
  });

  async function assertNotLastAdmin(familyId: string, userId: string) {
    const admins = await sql<{ user_id: string }[]>`
      SELECT user_id FROM memberships WHERE family_id = ${familyId} AND role = 'admin'`;
    if (admins.length === 1 && admins[0]?.user_id === userId) {
      fail(409, 'last_admin', '家庭至少要有一位管理员');
    }
  }

  // ─── 同步 ─────────────────────────────────────────────

  const syncBodyLimit = bodyLimit({
    maxSize: SYNC_BODY_BYTES,
    onError: () => fail(413, 'too_large', '这次同步的内容太多了'),
  });

  v1.post('/sync', syncBodyLimit, async (c) => {
    const m = requireFamily(c);
    const user = c.get('user');
    // 同步是高频接口，再写一行 rate_limits 不划算。这里本来就要更新 last_seen_at，计数放进同一条语句，
    // 不多一次写入，也不多一次往返，而且跨 isolate 准确。
    const [counter] = await sql<{ sync_count: number }[]>`
      UPDATE memberships SET
        last_seen_at = now(),
        sync_count = CASE
          WHEN sync_window_at IS NULL OR sync_window_at < now() - interval '1 minute' * ${SYNC_WINDOW_MINUTES}
          THEN 1 ELSE sync_count + 1 END,
        sync_window_at = CASE
          WHEN sync_window_at IS NULL OR sync_window_at < now() - interval '1 minute' * ${SYNC_WINDOW_MINUTES}
          THEN now() ELSE sync_window_at END
      WHERE family_id = ${m.familyId} AND user_id = ${user.id}
      RETURNING sync_count`;
    const { syncPerWindow } = config.limits;
    if (syncPerWindow > 0 && (counter?.sync_count ?? 0) > syncPerWindow) {
      fail(429, 'rate_limited', '同步太频繁了，稍后会自动重试');
    }
    const body = await parseBody(c, SyncRequest);
    const rejected: SyncResponse['rejected'] = [];
    const created: ServerRecord[] = [];
    const conflicted: string[] = [];

    if (body.changes.length > 0) {
      await sql.begin(async (tx) => {
        // 按家庭串行写入，才能保证 seq 严格递增且提交顺序一致。否则游标可能跳过尚未提交的记录。
        const [locked] = await tx<{ record_bytes: string }[]>`
          SELECT record_bytes FROM families WHERE id = ${m.familyId} FOR UPDATE`;
        let recordBytes = Number(locked?.record_bytes ?? 0);
        const referenced = new Set<string>();
        const unlinked = new Set<string>();
        for (const change of body.changes) {
          if (!canWriteCollection(m.role, change.collection)) {
            rejected.push({ id: change.id, reason: 'forbidden' });
            conflicted.push(change.id);
            continue;
          }
          const data = change.deleted
            ? change.data
            : parseCollectionData(change.collection, change.data);
          if (data === null || data === undefined) {
            rejected.push({ id: change.id, reason: 'invalid' });
            conflicted.push(change.id);
            continue;
          }
          const [existing] = await tx<
            {
              family_id: string;
              updated_at_client: string;
              collection: string;
              deleted: boolean;
              data: unknown;
              owner_id: string | null;
            }[]
          >`SELECT family_id, updated_at_client, collection, deleted, data, owner_id FROM records WHERE id = ${change.id}`;
          if (
            existing &&
            (existing.family_id !== m.familyId || existing.collection !== change.collection)
          ) {
            // id 由客户端生成，不能让它覆盖别的家庭或别的集合的数据。
            rejected.push({ id: change.id, reason: 'forbidden' });
            continue;
          }
          // 家人自己的证件（F-137）。删除时也要看：删除不校验内容，带着 owner 的删除标记不能当成全家的。
          let ownerId: string | null = null;
          let readers: string[] | null = null;
          if (change.collection === 'document') {
            const incoming = rawDocumentOwner(data);
            if (!incoming.ok) {
              rejected.push({ id: change.id, reason: 'invalid' });
              conflicted.push(change.id);
              continue;
            }
            if (
              !canWriteDocument(existing ? existing.owner_id : undefined, incoming.owner, user.id)
            ) {
              rejected.push({ id: change.id, reason: 'forbidden' });
              conflicted.push(change.id);
              continue;
            }
            ownerId = incoming.owner;
            if (ownerId && !change.deleted) readers = (data as DocumentData).sharedWith ?? [];
          }
          // 时间相同视为同一版本（离线重试），保持幂等。
          if (existing && change.updatedAt <= Number(existing.updated_at_client)) {
            conflicted.push(change.id);
            continue;
          }
          // 地区只有管理员能改。其他家人保存档案（换头像、改名）不能算错，所以不拒绝，
          // 只把地区换回当前的值。这样拿着旧版本保存也不会把管理员刚改的地区覆盖掉。
          const payload =
            change.collection === 'baby' && !change.deleted && m.role !== 'admin'
              ? withRegion(data as BabyData, await familyRegion(tx, m.familyId))
              : data;
          // 大小和引用都按真正入库的内容算，不是客户端发来的内容。
          const payloadJson = JSON.stringify(payload);
          const payloadBytes = Buffer.byteLength(payloadJson);
          if (payloadBytes > MAX_RECORD_BYTES) {
            rejected.push({ id: change.id, reason: 'too_large' });
            conflicted.push(change.id);
            continue;
          }
          const existingJson = existing ? JSON.stringify(existing.data) : '';
          const growth = payloadBytes - Buffer.byteLength(existingJson);
          // 只拦让数据变多的写入：满了之后删除和改小还要能用。正常家庭一辈子也到不了，见 docs/CAPACITY.md。
          if (
            growth > 0 &&
            config.familyRecordsBytes !== null &&
            recordBytes >= config.familyRecordsBytes
          ) {
            rejected.push({ id: change.id, reason: 'family_data_full' });
            conflicted.push(change.id);
            continue;
          }
          recordBytes += growth;
          const [{ seq } = { seq: '0' }] = await tx<{ seq: string }[]>`
            UPDATE families SET seq = seq + 1, record_bytes = GREATEST(0, record_bytes + ${growth})
            WHERE id = ${m.familyId} RETURNING seq`;
          const json = tx.json(payload as never);
          const [row] = await tx<RecordRow[]>`
            INSERT INTO records (id, family_id, collection, data, deleted, updated_at_client, seq, created_by, updated_by, owner_id, readers)
            VALUES (${change.id}, ${m.familyId}, ${change.collection}, ${json}, ${change.deleted}, ${change.updatedAt}, ${seq}, ${user.id}, ${user.id}, ${ownerId}, ${readers}::uuid[])
            ON CONFLICT (id) DO UPDATE SET
              data = EXCLUDED.data,
              deleted = EXCLUDED.deleted,
              updated_at_client = EXCLUDED.updated_at_client,
              seq = EXCLUDED.seq,
              updated_by = EXCLUDED.updated_by,
              owner_id = EXCLUDED.owner_id,
              readers = EXCLUDED.readers
            RETURNING id, collection, data, deleted, updated_at_client, seq, created_by, owner_id, readers`;
          if (row && !existing && !change.deleted && !row.owner_id)
            created.push(toServerRecord(row));
          const nowUsing = change.deleted ? [] : uuidsIn(payloadJson);
          for (const id of nowUsing) referenced.add(id);
          if (existing && !existing.deleted) {
            const kept = new Set(nowUsing);
            for (const id of uuidsIn(existingJson)) if (!kept.has(id)) unlinked.add(id);
          }
        }
        if (referenced.size > 0) {
          await tx`UPDATE media SET attached = true, unreferenced_at = NULL
            WHERE family_id = ${m.familyId} AND id = ANY(${[...referenced]}::uuid[])
              AND (NOT attached OR unreferenced_at IS NOT NULL)`;
        }
        if (unlinked.size > 0) {
          // 要等这批全部写完再核对：同一批里可能有别的记录在引用它。
          const live = await liveReferences(tx, m.familyId);
          const gone = [...unlinked].filter((id) => !live.has(id));
          await tx`UPDATE media SET unreferenced_at = now()
            WHERE family_id = ${m.familyId} AND id = ANY(${gone}::uuid[]) AND unreferenced_at IS NULL`;
        }
      });
      if (created.length > 0) {
        background(
          notifyFamily(m, user.id, created).catch((error: unknown) => {
            console.error('推送失败', error instanceof Error ? error.message : 'unknown');
          }),
        );
      }
    }

    const readable = collections.filter((name) => canReadCollection(m.role, name));
    // 顺序不能换：先定上界 S，再查 seq <= S。写入在持有家庭行锁时提交，所以 S 之前的记录一定可见。
    // 如果先查记录再读 seq，中间提交的记录会被游标直接跳过，再也同步不到。
    const [family] = await sql<
      { seq: string }[]
    >`SELECT seq FROM families WHERE id = ${m.familyId}`;
    const upperBound = Number(family?.seq ?? body.cursor);
    // 游标比服务端还新，只可能是从旧备份恢复过：seq 退回去了。从头发一遍，否则这台手机会漏掉之后的记录。
    const fromCursor = body.cursor > upperBound ? 0 : body.cursor;
    const rows = await sql<RecordRow[]>`
      SELECT id, collection, data, deleted, updated_at_client, seq, created_by, owner_id, readers
      FROM records
      WHERE family_id = ${m.familyId} AND seq > ${fromCursor} AND seq <= ${upperBound}
        AND collection = ANY(${readable})
      ORDER BY seq LIMIT ${SYNC_PAGE_SIZE + 1}`;
    const hasMore = rows.length > SYNC_PAGE_SIZE;
    const page = rows.slice(0, SYNC_PAGE_SIZE);
    const cursor = hasMore ? Number(page[page.length - 1]?.seq ?? fromCursor) : upperBound;
    // 别人的私人证件（F-137）看不到的只发删除标记，见 personalDocuments.ts。旧版 App 也走这里。
    const viewer = { userId: user.id, role: m.role };
    const records = await projectForViewer(sql, m.familyId, viewer, page);
    if (conflicted.length > 0) {
      // 客户端手里的版本没有生效，而服务端版本可能已在游标之前，必须显式补发。
      // 一定要按可读集合过滤，否则 viewer 能用猜到的 id 读到证件。
      const seen = new Set(records.map((r) => r.id));
      const missing = conflicted.filter((id) => !seen.has(id));
      if (missing.length > 0) {
        const extra = await sql<RecordRow[]>`
          SELECT id, collection, data, deleted, updated_at_client, seq, created_by, owner_id, readers
          FROM records
          WHERE family_id = ${m.familyId} AND id = ANY(${missing}::uuid[])
            AND collection = ANY(${readable})`;
        records.push(...(await projectForViewer(sql, m.familyId, viewer, extra)));
      }
    }
    return c.json<SyncResponse>({ cursor, hasMore, records, rejected, role: m.role });
  });

  /**
   * 长轮询：比 WebSocket 简单，反向代理不用特殊配置。App 在前台时循环调用。
   * 写入可能发生在别的进程或 isolate，所以查数据库而不是等进程内事件。
   * 两次检查之间不占连接：连接池可能只有 1 个连接，占住了别的请求就都卡住了。
   */
  v1.get('/sync/wait', async (c) => {
    const m = requireFamily(c);
    const cursor = Number(c.req.query('cursor') ?? 0);
    const signal = c.req.raw.signal;
    const latest = async () => {
      const [row] = await sql<{ seq: string }[]>`SELECT seq FROM families WHERE id = ${m.familyId}`;
      return Number(row?.seq ?? 0);
    };
    const initial = await latest();
    if (initial > cursor) return c.json({ changed: true });
    const deadline = Date.now() + longPoll.timeoutMs;
    while (!signal.aborted) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await sleep(Math.min(longPoll.intervalMs, remaining), signal);
      if (signal.aborted) break;
      // 和开始等待时比，不和游标比：从旧备份恢复后游标比 seq 大，新写入也要能唤醒。
      if ((await latest()) !== initial) return c.json({ changed: true });
    }
    return c.json({ changed: false });
  });

  async function notifyFamily(m: Membership, authorId: string, created: ServerRecord[]) {
    const now = Date.now();
    const recent = created.filter((r) => {
      if (r.collection === 'moment') return true;
      if (r.collection !== 'event') return false;
      // 配置奶粉不是一条记录，不通知。
      if (isFormulaData(r.data)) return false;
      // 配置疫苗本不是一条记录，不通知。
      if (isVaccinePlanData(r.data)) return false;
      // 小金库记的是钱，不是照护记录，也没有 at；就算以后的版本带上 at 也不通知。
      if (isMoneyData(r.data)) return false;
      // 补记很久以前的记录不打扰家人。
      return now - (r.data as EventData).at < 3_600_000;
    });
    if (recent.length === 0) return;
    const targets = await sql<
      { user_id: string; role: Role; prefs: unknown; token: string }[]
    >`SELECT mb.user_id, mb.role, u.prefs, p.token
      FROM memberships mb
      JOIN users u ON u.id = mb.user_id
      JOIN push_tokens p ON p.user_id = mb.user_id
      WHERE mb.family_id = ${m.familyId} AND mb.user_id <> ${authorId}`;
    if (targets.length === 0) return;
    const region = await familyRegion(sql, m.familyId);
    const messages: PushMessage[] = [];
    for (const target of targets) {
      const prefs = mergePrefs(target.prefs);
      if (!prefs.familyNotify) continue;
      if (prefs.quietNight && isQuietHour(now, prefs.timezone)) continue;
      const units = effectiveUnits(prefs.units, region);
      for (const record of recent) {
        if (!canReadCollection(target.role, record.collection)) continue;
        const body =
          record.collection === 'event'
            ? describeEvent(record.data as EventData, now, units)
            : (record.data as { title?: string }).title || '记下了新的一刻';
        messages.push({ token: target.token, title: `${m.label} 刚刚记录了`, body });
      }
    }
    if (messages.length > 0) await notifier.send(messages);
  }

  // ─── 文件 ─────────────────────────────────────────────

  const objectKey = (familyId: string, scope: string, id: string, variant: string) =>
    `families/${familyId}/${scope}/${id}/${variant}`;

  /** 用 4xx：上传队列把它当成永久失败，直接显示这句话，用户腾出空间后点重试。 */
  const failOverQuota = (quota: number): never =>
    fail(
      413,
      'quota_exceeded',
      `存储空间已满（共 ${formatBytes(quota)}），删除一些回忆或证件后可以重试`,
      { quota },
    );

  const requireUploader = (c: Context<Env>) => {
    const m = requireFamily(c);
    if (m.role === 'viewer') fail(403, 'forbidden', '你只能查看回忆和照片', { reason: 'viewer' });
    return m;
  };

  const limitUploadUrls = async (c: Context<Env>) => {
    const { uploadUrlPerWindow } = config.limits;
    if (
      uploadUrlPerWindow > 0 &&
      !(await allowAttempt(
        sql,
        `upload-url:${c.get('user').id}`,
        uploadUrlPerWindow,
        UPLOAD_URL_WINDOW_MS,
      ))
    ) {
      fail(429, 'rate_limited', '上传太频繁了，稍后会自动重试');
    }
  };

  /** 单个 PUT 和分片上传共用的准入检查。 */
  const admitUpload = async (m: { familyId: string }, userId: string, body: UploadUrlRequest) => {
    if (!isAllowedMime(body.mime, body.scope)) fail(400, 'bad_type', '不支持这种文件类型');
    // 分享页拿预览顶替原图发给陌生人，它只能是图片。
    if (body.variant === 'preview' && !body.mime.toLowerCase().startsWith('image/')) {
      fail(400, 'bad_type', '不支持这种文件类型');
    }
    const maxBytes = Math.min(
      config.maxUploadBytes,
      config.maxFileBytes[mediaCategory(body.mime, body.scope)],
    );
    if (body.size > maxBytes) {
      fail(413, 'too_large', `文件太大了，这种文件最大 ${formatBytes(maxBytes)}`, { maxBytes });
    }
    // 同一个 id 的几个变体要属于同一个人：别人不能往私人证件的文件 id 下面传东西，也不能抢先占用。
    const siblings = await sql<
      {
        variant: string;
        family_id: string;
        status: string;
        owner_id: string | null;
        scope: string;
      }[]
    >`SELECT variant, family_id, status, owner_id, scope FROM media WHERE id = ${body.id}`;
    const existing = siblings.find((r) => r.variant === body.variant);
    if (existing && existing.family_id !== m.familyId) fail(403, 'forbidden', '没有权限');
    const owner = body.scope === 'personal' ? userId : null;
    if (siblings.some((r) => r.owner_id !== owner || (r.owner_id && r.scope !== body.scope))) {
      fail(403, 'forbidden', '没有权限');
    }
    if (existing?.status === 'ready') fail(409, 'already_uploaded', '文件已经上传过了');

    const storage = await activeStorage(sql, config, m.familyId);
    if (!storage)
      fail(503, 'no_storage', '还没有配置存储，请管理员先在「家人 → 存储」里设置', {
        reason: 'notConfigured',
      });
    return { storage, key: objectKey(m.familyId, body.scope, body.id, body.variant) };
  };

  /**
   * 查询和预留要在同一把锁里，否则并行上传会一起通过检查。自己的存储不花平台的钱，不用配额。
   * 文件大小和存储都没变时才接着用原来的 uploadId，其余情况旧的分片作废，由调用方在事务外中止：
   * 连接池可能只有 1 个连接，等对象存储时不能占着它。
   */
  const reserveUpload = (
    m: { familyId: string },
    userId: string,
    body: UploadUrlRequest,
    storage: ResolvedStorage,
    key: string,
    { keepMultipart }: { keepMultipart: boolean },
  ) =>
    sql.begin(async (tx) => {
      if (!storage.configId) {
        const [family] = await tx<{ quota_mb: string | null }[]>`
          SELECT quota_mb FROM families WHERE id = ${m.familyId} FOR UPDATE`;
        const quota = familyQuotaBytes(config, family?.quota_mb ?? null);
        if (quota !== null) {
          const usage = await platformUsage(tx, m.familyId, body);
          if (countedBytes(usage, quota) + body.size > quota) failOverQuota(quota);
        }
      }
      const [previous] = await tx<
        {
          size: string;
          object_key: string;
          storage_config_id: string | null;
          upload_id: string | null;
          upload_part_size: number | null;
        }[]
      >`SELECT size, object_key, storage_config_id, upload_id, upload_part_size FROM media
        WHERE id = ${body.id} AND variant = ${body.variant} FOR UPDATE`;
      const reusable =
        keepMultipart &&
        previous?.upload_id &&
        Number(previous.size) === body.size &&
        previous.storage_config_id === storage.configId;
      const uploadId = reusable ? previous.upload_id : null;
      const partSize = reusable ? previous.upload_part_size : null;
      await tx`
        INSERT INTO media (id, variant, family_id, scope, mime, size, filename, object_key, storage_config_id, uploaded_by, upload_id, upload_part_size, owner_id)
        VALUES (${body.id}, ${body.variant}, ${m.familyId}, ${body.scope}, ${body.mime}, ${body.size}, ${body.filename ?? null}, ${key}, ${storage.configId}, ${userId}, ${uploadId}, ${partSize}, ${body.scope === 'personal' ? userId : null})
        ON CONFLICT (id, variant) DO UPDATE SET
          mime = EXCLUDED.mime, size = EXCLUDED.size, filename = EXCLUDED.filename,
          object_key = EXCLUDED.object_key, storage_config_id = EXCLUDED.storage_config_id,
          upload_id = EXCLUDED.upload_id, upload_part_size = EXCLUDED.upload_part_size,
          reserved_at = now()`;
      const stale =
        previous?.upload_id && !reusable
          ? {
              uploadId: previous.upload_id,
              key: previous.object_key,
              storageConfigId: previous.storage_config_id,
            }
          : null;
      return { uploadId, partSize, stale };
    });

  /** 地址可能在保存之后改为解析到内网，服务端连接前再查一次。 */
  const assertReachable = async (storage: ResolvedStorage) => {
    if (!storage.configId || !storage.endpoint) return;
    try {
      await assertEndpointAllowed(storage.endpoint, config);
    } catch {
      fail(503, 'no_storage', '存储地址不可用');
    }
  };

  const reachableStorage = async (familyId: string, configId: string | null) => {
    const storage = await storageById(sql, config, familyId, configId);
    if (!storage) fail(503, 'no_storage', '存储配置不可用');
    await assertReachable(storage);
    return storage;
  };

  /** 作废的分片尽力中止。失败不影响这次请求，存储的生命周期规则兜底，见 DEPLOYMENT。 */
  const abortStaleUpload = async (
    familyId: string,
    stale: { uploadId: string; key: string; storageConfigId: string | null } | null,
  ) => {
    if (!stale) return;
    try {
      const storage = await reachableStorage(familyId, stale.storageConfigId);
      await abortMultipart(storage, stale.key, stale.uploadId);
    } catch (error) {
      console.warn('中止作废的分片失败', error instanceof Error ? error.name : 'unknown');
    }
  };

  v1.post('/media/upload-url', async (c) => {
    const m = requireUploader(c);
    await limitUploadUrls(c);
    const body = await parseBody(c, UploadUrlRequest);
    const { storage, key } = await admitUpload(m, c.get('user').id, body);
    const { stale } = await reserveUpload(m, c.get('user').id, body, storage, key, {
      keepMultipart: false,
    });
    // App 从分片退回单个 PUT 时走到这里，已传的分片用不上了。
    await abortStaleUpload(m.familyId, stale);
    const url = await presignUpload(
      storage,
      key,
      body.mime,
      body.size,
      UPLOAD_URL_TTL,
      config.bindUploadSize,
    );
    return c.json<UploadUrlResponse>({
      url,
      headers: { 'Content-Type': body.mime },
      expiresIn: UPLOAD_URL_TTL,
    });
  });

  /** HEAD 校验大小、复查配额、标记 ready。单个 PUT 和分片上传的最后一步相同。 */
  const finalizeUpload = async (
    c: Context<Env>,
    m: { familyId: string },
    id: string,
    variant: string,
    row: { size: string; object_key: string; storage_config_id: string | null },
    storage: ResolvedStorage,
  ) => {
    const head = await headObject(storage, row.object_key);
    if (!head) fail(409, 'not_uploaded', '文件还没有上传完成');
    // 预签名链接不限制大小，这里补上校验，防止绕过上传大小限制。
    if (head.size !== Number(row.size)) {
      await deleteObject(storage, row.object_key);
      fail(409, 'size_mismatch', '文件大小不一致，请重新上传');
    }
    // 预留可能已经过期被别的文件占了，或者配额被调低了，所以这里要再查一次。
    const overQuota = await sql.begin(async (tx) => {
      if (!row.storage_config_id) {
        const [family] = await tx<{ quota_mb: string | null }[]>`
          SELECT quota_mb FROM families WHERE id = ${m.familyId} FOR UPDATE`;
        const quota = familyQuotaBytes(config, family?.quota_mb ?? null);
        if (quota !== null) {
          const usage = await platformUsage(tx, m.familyId, { id, variant });
          if (countedBytes(usage, quota) + head.size > quota) {
            await deleteObject(storage, row.object_key);
            await tx`DELETE FROM media WHERE id = ${id}::uuid AND variant = ${variant}`;
            return quota;
          }
        }
      }
      await tx`UPDATE media SET status = 'ready', upload_id = NULL, upload_part_size = NULL
               WHERE id = ${id}::uuid AND variant = ${variant}`;
      return null;
    });
    // 在事务外抛错：事务里抛错会把上面的删除回滚。
    if (overQuota !== null) failOverQuota(overQuota);
    return c.json({ ok: true });
  };

  v1.post('/media/:id/complete', async (c) => {
    const m = requireUploader(c);
    const { variant } = await parseBody(c, CompleteUploadRequest);
    const id = c.req.param('id');
    const [row] = await sql<
      {
        family_id: string;
        size: string;
        object_key: string;
        storage_config_id: string | null;
        status: string;
        owner_id: string | null;
      }[]
    >`SELECT family_id, size, object_key, storage_config_id, status, owner_id FROM media WHERE id = ${id}::uuid AND variant = ${variant}`;
    if (!row || row.family_id !== m.familyId) fail(404, 'not_found', '找不到这个文件');
    if (row.owner_id && row.owner_id !== c.get('user').id) fail(403, 'forbidden', '没有权限');
    if (row.status === 'ready') return c.json({ ok: true });
    const storage = await reachableStorage(m.familyId, row.storage_config_id);
    return finalizeUpload(c, m, id, variant, row, storage);
  });

  // ─── 分片上传 ─────────────────────────────────────────
  // 服务端不记账：哪些片传了、ETag 是多少，都当场问存储。手机只管传，不碰 ETag。

  const uploadGone = (): never => fail(404, 'upload_gone', '这次上传已经失效，需要重新开始');

  const mediaIdParam = (c: Context<Env>): string => {
    const parsed = z.uuid().safeParse(c.req.param('id'));
    if (!parsed.success) fail(404, 'not_found', '找不到这个文件');
    return parsed.data;
  };

  /** 新版接口对别的家庭返回 403，和 upload-url 一致。没有这一行时返回 null。 */
  const multipartRow = async (
    m: { familyId: string; userId: string },
    id: string,
    variant: string,
  ) => {
    const [row] = await sql<
      {
        family_id: string;
        size: string;
        object_key: string;
        storage_config_id: string | null;
        status: string;
        upload_id: string | null;
        upload_part_size: number | null;
        reservation_expired: boolean;
        owner_id: string | null;
      }[]
    >`SELECT family_id, size, object_key, storage_config_id, status, upload_id, upload_part_size,
        reserved_at < now() - interval '1 hour' * ${RESERVATION_HOURS} AS reservation_expired, owner_id
      FROM media WHERE id = ${id}::uuid AND variant = ${variant}`;
    if (row && row.family_id !== m.familyId) fail(403, 'forbidden', '没有权限');
    // 私人证件的文件只有本人能接着传。
    if (row?.owner_id && row.owner_id !== m.userId) fail(403, 'forbidden', '没有权限');
    return row ?? null;
  };

  const forgetUpload = (id: string, variant: string, uploadId: string) =>
    sql`UPDATE media SET upload_id = NULL, upload_part_size = NULL
        WHERE id = ${id}::uuid AND variant = ${variant} AND upload_id = ${uploadId}`;

  v1.post('/media/multipart', async (c) => {
    const m = requireUploader(c);
    await limitUploadUrls(c);
    const body = await parseBody(c, MultipartStartRequest);
    const { storage, key } = await admitUpload(m, c.get('user').id, body);
    if (!config.multipartEnabled) fail(501, 'multipart_unsupported', '这个存储不支持分片上传');
    const reserved = await reserveUpload(m, c.get('user').id, body, storage, key, {
      keepMultipart: true,
    });
    await abortStaleUpload(m.familyId, reserved.stale);
    if (reserved.uploadId && reserved.partSize) {
      return c.json<MultipartStartResponse>({
        uploadId: reserved.uploadId,
        partSize: reserved.partSize,
      });
    }
    await assertReachable(storage);
    const partSize = multipartPartSize(body.size);
    let uploadId: string;
    try {
      uploadId = await createMultipart(storage, key, body.mime);
    } catch (error) {
      if (multipartUnsupported(error)) {
        fail(501, 'multipart_unsupported', '这个存储不支持分片上传');
      }
      fail(503, 'storage_unavailable', '存储暂时没有响应，稍后会自动重试');
    }
    // 两个请求同时走到这里时只留先写入的，另一个中止。
    const [claimed] = await sql<{ upload_id: string }[]>`
      UPDATE media SET upload_id = ${uploadId}, upload_part_size = ${partSize}
      WHERE id = ${body.id} AND variant = ${body.variant} AND status = 'pending' AND upload_id IS NULL
      RETURNING upload_id`;
    if (claimed) return c.json<MultipartStartResponse>({ uploadId, partSize });
    await abortMultipart(storage, key, uploadId).catch(() => {});
    const winner = await multipartRow(
      { familyId: m.familyId, userId: c.get('user').id },
      body.id,
      body.variant,
    );
    if (!winner?.upload_id || !winner.upload_part_size) return uploadGone();
    return c.json<MultipartStartResponse>({
      uploadId: winner.upload_id,
      partSize: winner.upload_part_size,
    });
  });

  v1.post('/media/:id/multipart/parts', async (c) => {
    const m = requireUploader(c);
    const id = mediaIdParam(c);
    const { variant, uploadId } = await parseBody(c, MultipartRef);
    const row = await multipartRow({ familyId: m.familyId, userId: c.get('user').id }, id, variant);
    if (!row) return uploadGone();
    if (row.status === 'ready')
      return c.json<MultipartPartsResponse>({ parts: [], complete: true });
    if (row.upload_id !== uploadId) return uploadGone();
    const storage = await reachableStorage(m.familyId, row.storage_config_id);
    try {
      const parts = await listMultipartParts(storage, row.object_key, uploadId);
      return c.json<MultipartPartsResponse>({
        parts: parts.map(({ partNumber, size }) => ({ partNumber, size })),
        complete: false,
      });
    } catch (error) {
      if (!isNoSuchUpload(error)) {
        fail(503, 'storage_unavailable', '存储暂时没有响应，稍后会自动重试');
      }
    }
    // 分片没了：可能已经合并好了（上次没收到响应），也可能真的过期了。
    const head = await headObject(storage, row.object_key);
    if (head?.size === Number(row.size)) {
      return c.json<MultipartPartsResponse>({ parts: [], complete: true });
    }
    await forgetUpload(id, variant, uploadId);
    return uploadGone();
  });

  v1.post('/media/:id/multipart/part-urls', async (c) => {
    const m = requireUploader(c);
    const id = mediaIdParam(c);
    const { variant, uploadId, partNumbers } = await parseBody(c, MultipartPartUrlsRequest);
    const row = await multipartRow({ familyId: m.familyId, userId: c.get('user').id }, id, variant);
    if (!row) return uploadGone();
    if (row.status === 'ready') fail(409, 'already_uploaded', '文件已经上传过了');
    if (row.upload_id !== uploadId || !row.upload_part_size) return uploadGone();
    const size = Number(row.size);
    const partSize = row.upload_part_size;
    if (partNumbers.some((n) => n > multipartPartCount(size, partSize))) {
      fail(400, 'bad_part', '分片序号超出范围');
    }
    await limitUploadUrls(c);
    await sql.begin(async (tx) => {
      // 预留过期后可能已经被别的文件占了。没过期的不用排队，这里每传几片就走一次。
      if (row.reservation_expired && !row.storage_config_id) {
        const [family] = await tx<{ quota_mb: string | null }[]>`
          SELECT quota_mb FROM families WHERE id = ${m.familyId} FOR UPDATE`;
        const quota = familyQuotaBytes(config, family?.quota_mb ?? null);
        if (quota !== null) {
          const usage = await platformUsage(tx, m.familyId, { id, variant });
          if (countedBytes(usage, quota) + size > quota) failOverQuota(quota);
        }
      }
      // 慢网传大视频可以传很久，每取一批链接就续一次，不算放弃。
      await tx`UPDATE media SET reserved_at = now() WHERE id = ${id}::uuid AND variant = ${variant}`;
    });
    const storage = await storageById(sql, config, m.familyId, row.storage_config_id);
    if (!storage) fail(503, 'no_storage', '存储配置不可用');
    const urls = await Promise.all(
      partNumbers.map(async (partNumber) => {
        const bytes = multipartPartBytes(partNumber, size, partSize);
        return {
          partNumber,
          size: bytes,
          url: await presignPart(
            storage,
            row.object_key,
            uploadId,
            partNumber,
            bytes,
            UPLOAD_URL_TTL,
            config.bindUploadSize,
          ),
        };
      }),
    );
    return c.json<MultipartPartUrlsResponse>({ urls, expiresIn: UPLOAD_URL_TTL });
  });

  v1.post('/media/:id/multipart/complete', async (c) => {
    const m = requireUploader(c);
    const id = mediaIdParam(c);
    const { variant, uploadId } = await parseBody(c, MultipartRef);
    const row = await multipartRow({ familyId: m.familyId, userId: c.get('user').id }, id, variant);
    if (!row) return uploadGone();
    if (row.status === 'ready') return c.json({ ok: true });
    if (row.upload_id !== uploadId || !row.upload_part_size) return uploadGone();
    const storage = await reachableStorage(m.familyId, row.storage_config_id);
    const size = Number(row.size);
    const partSize = row.upload_part_size;
    try {
      const stored = await listMultipartParts(storage, row.object_key, uploadId);
      if (missingParts(stored, size, partSize).length > 0) {
        fail(409, 'parts_incomplete', '文件还有部分没有传完');
      }
      const valid = new Set(validParts(stored, size, partSize).map((p) => p.partNumber));
      await completeMultipart(
        storage,
        row.object_key,
        uploadId,
        stored.filter((p) => valid.has(p.partNumber)),
      );
    } catch (error) {
      if (error instanceof HTTPException) throw error;
      if (!isNoSuchUpload(error)) {
        // 合并被存储拒绝时重传也许能好，交给客户端的上限；其余是暂时的。
        if (multipartUnsupported(error)) fail(409, 'parts_incomplete', '文件还有部分没有传完');
        fail(503, 'storage_unavailable', '存储暂时没有响应，稍后会自动重试');
      }
      // 分片没了：上次可能已经合并成功，只是没来得及标记。下面的 HEAD 会核对。
      const head = await headObject(storage, row.object_key);
      if (head?.size !== size) {
        await forgetUpload(id, variant, uploadId);
        return uploadGone();
      }
    }
    return finalizeUpload(c, m, id, variant, row, storage);
  });

  /**
   * 取消上传：只处理还没传完的。已经 ready 的变体不动，记录去掉引用后由 unreferenced_at 那条链路清理，撤销也还能用。
   * 存储的清理放进待删除队列，这里不等：手机可能离线后才补发这个请求，对象存储也可能很慢。
   */
  v1.post('/media/:id/cancel', async (c) => {
    const m = requireUploader(c);
    const id = mediaIdParam(c);
    const rows = await sql<
      { family_id: string; owner_id: string | null }[]
    >`SELECT family_id, owner_id FROM media WHERE id = ${id}::uuid`;
    if (rows.some((r) => r.family_id !== m.familyId)) fail(403, 'forbidden', '没有权限');
    if (rows.some((r) => r.owner_id && r.owner_id !== c.get('user').id)) {
      fail(403, 'forbidden', '没有权限');
    }
    const removed = await sql.begin(async (tx) => {
      await enqueueCancelledUpload(tx, m.familyId, id, UPLOAD_URL_TTL);
      const deleted = await tx`
        DELETE FROM media WHERE id = ${id}::uuid AND family_id = ${m.familyId} AND status = 'pending'`;
      return deleted.count;
    });
    if (removed > 0) {
      background(
        processPendingDeletions(sql, config)
          .then(() => {})
          .catch((error: unknown) => {
            console.error('清理文件失败', error instanceof Error ? error.message : 'unknown');
          }),
      );
    }
    return c.json({ ok: true });
  });

  v1.post('/media/urls', async (c) => {
    const m = requireFamily(c);
    const body = await parseBody(c, MediaUrlsRequest);
    if (body.items.length === 0) return c.json<MediaUrlsResponse>({ urls: [] });
    const ids = [...new Set(body.items.map((i) => i.id))];
    const rows = await sql<
      (MediaAccessRow & {
        variant: MediaVariant;
        object_key: string;
        storage_config_id: string | null;
      })[]
    >`SELECT id, variant, scope, object_key, storage_config_id, owner_id, uploaded_by FROM media
      WHERE family_id = ${m.familyId} AND status = 'ready' AND id = ANY(${ids}::uuid[])`;
    const lookup = new Map(rows.map((r) => [`${r.id}/${r.variant}`, r]));
    // 证件类的文件还要看私人证件（F-137）的设置：每次现查，撤销后马上拿不到新链接。
    const owned = await readableOwnedMedia(
      sql,
      m.familyId,
      { userId: c.get('user').id, role: m.role },
      rows,
    );
    const storages = new Map<string, ResolvedStorage | null>();
    const urls: MediaUrlsResponse['urls'] = [];
    for (const item of body.items) {
      const row = lookup.get(`${item.id}/${item.variant}`);
      if (
        !row ||
        !canReadMediaScope(m.role, row.scope) ||
        (isDocumentScope(row.scope) && !owned.has(row.id))
      ) {
        urls.push({ ...item, url: null, expiresIn: 0 });
        continue;
      }
      const storageKey = row.storage_config_id ?? 'env';
      if (!storages.has(storageKey)) {
        storages.set(storageKey, await storageById(sql, config, m.familyId, row.storage_config_id));
      }
      const storage = storages.get(storageKey);
      if (!storage) {
        urls.push({ ...item, url: null, expiresIn: 0 });
        continue;
      }
      if (!isDocumentScope(row.scope) && storage.publicBaseUrl) {
        // 只有回忆走 CDN；证件永远不走公开地址。
        urls.push({
          ...item,
          url: `${storage.publicBaseUrl.replace(/\/$/, '')}/${row.object_key}`,
          expiresIn: 24 * 3600,
        });
        continue;
      }
      const ttl = isDocumentScope(row.scope) ? DOCUMENT_URL_TTL : MEMORY_URL_TTL;
      urls.push({
        ...item,
        url: await presignDownload(storage, row.object_key, ttl),
        expiresIn: ttl,
      });
    }
    return c.json<MediaUrlsResponse>({ urls });
  });

  // ─── 存储设置（仅管理员）──────────────────────────────

  const viewFromRow = (row: StorageRow): StorageConfigView => ({
    source: 'family',
    provider: row.provider as StorageConfigView['provider'],
    accountId: row.account_id,
    endpoint: row.endpoint,
    region: row.region,
    bucket: row.bucket,
    accessKeyId: row.access_key_id,
    hasSecret: true,
    publicBaseUrl: row.public_base_url,
  });

  v1.get('/storage', async (c) => {
    const m = requireAdmin(c);
    const [row] = await sql<
      StorageRow[]
    >`SELECT * FROM storage_configs WHERE family_id = ${m.familyId} AND active`;
    if (row) return c.json(viewFromRow(row));
    const hasServer = Boolean(config.serverStorage);
    return c.json<StorageConfigView>({
      source: hasServer ? 'server' : 'none',
      provider: null,
      accountId: null,
      endpoint: null,
      region: null,
      bucket: null,
      accessKeyId: null,
      hasSecret: hasServer,
      publicBaseUrl: null,
    });
  });

  async function validateStorageInput(familyId: string, input: StorageConfigInput) {
    if (!config.allowCustomStorage) {
      // 已经在用自己存储的家庭继续可以改：关闭之前存进去的文件还在那里，密钥过期不能把他们锁死。
      const [active] = await sql`
        SELECT 1 AS ok FROM storage_configs WHERE family_id = ${familyId} AND active`;
      if (!active) fail(403, 'custom_storage_disabled', '这台服务器不允许自定义存储');
    }
    if (input.provider === 'r2' && !input.accountId)
      fail(400, 'invalid_input', '请填写 Account ID', { reason: 'accountIdMissing' });
    if (input.provider === 'other' && !input.endpoint)
      fail(400, 'invalid_input', '请填写 Endpoint', { reason: 'endpointMissing' });
    if (input.accountId && !/^[a-zA-Z0-9-]+$/.test(input.accountId)) {
      // Account ID 会拼进主机名，只允许安全字符。
      fail(400, 'invalid_input', 'Account ID 格式不正确', { reason: 'accountIdBad' });
    }
    const endpoint = endpointForProvider(input.provider, input);
    if (endpoint) {
      try {
        await assertEndpointAllowed(endpoint, config);
      } catch (error) {
        fail(400, 'bad_endpoint', error instanceof Error ? error.message : '存储地址不可用');
      }
    }
    if (input.publicBaseUrl && !input.publicBaseUrl.startsWith('https://')) {
      fail(400, 'invalid_input', '自定义域名必须使用 https', { reason: 'customDomainHttps' });
    }
  }

  async function secretFor(familyId: string, input: StorageConfigInput): Promise<string> {
    if (input.secretAccessKey) return input.secretAccessKey;
    const [active] = await sql<
      StorageRow[]
    >`SELECT * FROM storage_configs WHERE family_id = ${familyId} AND active`;
    // 沿用旧 Secret 时必须是同一个 Access Key。否则改掉 Endpoint 就能把 Secret 发给任意地址。
    if (active && active.access_key_id === input.accessKeyId) {
      const resolved = await storageById(sql, config, familyId, active.id);
      const sameTarget =
        endpointForProvider(input.provider, input) ===
        endpointForProvider(active.provider as StorageConfigInput['provider'], {
          accountId: active.account_id,
          endpoint: active.endpoint,
        });
      if (resolved && sameTarget) return resolved.secretAccessKey;
    }
    fail(400, 'invalid_input', '请填写 Secret Access Key', { reason: 'secretMissing' });
  }

  v1.post('/storage/test', async (c) => {
    const m = requireAdmin(c);
    const input = await parseBody(c, StorageConfigInput);
    await validateStorageInput(m.familyId, input);
    const secret = await secretFor(m.familyId, input);
    return c.json(await testStorage(resolvedFromInput(input, secret)));
  });

  v1.put('/storage', async (c) => {
    const m = requireAdmin(c);
    const input = await parseBody(c, StorageConfigInput);
    await validateStorageInput(m.familyId, input);
    const secret = await secretFor(m.familyId, input);
    const result = await testStorage(resolvedFromInput(input, secret));
    if (!result.ok)
      fail(400, 'storage_test_failed', result.message, { reason: result.reason ?? 'unknown' });
    const encrypted = encryptSecret(secret, config.appSecret);
    const id = crypto.randomUUID();
    await sql.begin(async (tx) => {
      // 旧配置保留，只是停用：已上传到旧存储的文件还要靠它读取。
      await tx`UPDATE storage_configs SET active = false WHERE family_id = ${m.familyId} AND active`;
      await tx`
        INSERT INTO storage_configs (id, family_id, provider, account_id, endpoint, region, bucket, access_key_id, secret_encrypted, public_base_url)
        VALUES (${id}, ${m.familyId}, ${input.provider}, ${input.accountId ?? null}, ${input.endpoint ?? null}, ${input.region ?? null}, ${input.bucket}, ${input.accessKeyId}, ${encrypted}, ${input.publicBaseUrl ?? null})`;
    });
    const [row] = await sql<StorageRow[]>`SELECT * FROM storage_configs WHERE id = ${id}`;
    return c.json(viewFromRow(row!));
  });

  v1.get('/storage/usage', async (c) => {
    const m = requireFamily(c);
    if (m.role === 'viewer') fail(403, 'forbidden', '你只能查看回忆和照片', { reason: 'viewer' });
    const rows = await sql<{ category: string; total: string }[]>`
      SELECT CASE
          WHEN scope IN ('document', 'personal') THEN 'document'
          WHEN mime LIKE 'video/%' THEN 'video'
          WHEN mime LIKE 'audio/%' THEN 'audio'
          ELSE 'image' END AS category,
        COALESCE(SUM(size), 0) AS total
      FROM media WHERE family_id = ${m.familyId} AND status = 'ready'
        -- 平台存储上已删除的文件会被清理；用户自己存储上的不清理，还占着他们的 Bucket。
        AND (unreferenced_at IS NULL OR storage_config_id IS NOT NULL)
      GROUP BY 1`;
    const [family] = await sql<{ quota_mb: string | null; custom: boolean }[]>`
      SELECT quota_mb, EXISTS (
        SELECT 1 FROM storage_configs s WHERE s.family_id = families.id AND s.active
      ) AS custom FROM families WHERE id = ${m.familyId}`;
    const quota =
      family?.custom || !config.serverStorage
        ? null
        : familyQuotaBytes(config, family?.quota_mb ?? null);
    const platform = await platformUsage(sql, m.familyId);
    const usage: StorageUsage = {
      image: 0,
      video: 0,
      audio: 0,
      document: 0,
      total: 0,
      quota,
      quotaUsed: countedBytes(platform, quota ?? Number.MAX_SAFE_INTEGER),
      pending: platform.pending,
      trash: platform.trash,
      trashDays: config.mediaTrashDays,
    };
    for (const row of rows) {
      const value = Number(row.total);
      usage[row.category as 'image' | 'video' | 'audio' | 'document'] = value;
      usage.total += value;
    }
    return c.json(usage);
  });

  app.route('/v1', v1);
  return app;
}
