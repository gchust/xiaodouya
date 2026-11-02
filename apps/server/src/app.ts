import { Buffer } from 'node:buffer';
import {
  AcceptInviteRequest,
  type ApiError,
  type AuthResponse,
  accountDeletionOutcome,
  type BabyData,
  CompleteUploadRequest,
  CreateFamilyRequest,
  CreateInviteRequest,
  CreateShareRequest,
  type CreateShareResponse,
  canReadCollection,
  canReadMediaScope,
  canWriteCollection,
  collections,
  DeleteAccountRequest,
  defaultPrefs,
  describeEvent,
  EMAIL_CODE_COOLDOWN_SECONDS,
  type EventData,
  effectiveUnits,
  type FamilyExport,
  type FamilyMember,
  ForgotPasswordRequest,
  formatBytes,
  isAllowedMime,
  isFormulaData,
  isVaccinePlanData,
  type Locale,
  LoginRequest,
  localeFromAcceptLanguage,
  MAX_ACTIVE_SHARES,
  MediaUrlsRequest,
  type MediaUrlsResponse,
  type MeResponse,
  mediaCategory,
  type PendingInvite,
  Prefs,
  type PublicConfig,
  PublicShareRequest,
  type PublicShareResponse,
  PushTokenRequest,
  parseCollectionData,
  RegisterRequest,
  ResetPasswordRequest,
  type Role,
  type SendEmailCodeResponse,
  type ServerRecord,
  type ShareListResponse,
  StorageConfigInput,
  type StorageConfigView,
  type StorageUsage,
  SYNC_PAGE_SIZE,
  SyncRequest,
  type SyncResponse,
  UpdateMemberRequest,
  UploadUrlRequest,
  type UploadUrlResponse,
  VerifyEmailRequest,
} from '@xiaodouya/shared';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import type { z } from 'zod';
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
import type { Mailer } from './mailer';
import { resetPasswordMail, verifyEmailMail } from './mailTemplates';
import { isQuietHour, type Notifier, noopNotifier, type PushMessage } from './notifier';
import { enqueueFamilyObjects, processPendingDeletions } from './objectDeletions';
import { countedBytes, familyQuotaBytes, liveReferences, platformUsage, uuidsIn } from './quota';
import { buildPublicShare, findActiveShare, type ShareRow, shareInclude } from './share';
import {
  activeStorage,
  assertEndpointAllowed,
  deleteObject,
  endpointForProvider,
  headObject,
  presignDownload,
  presignUpload,
  type ResolvedStorage,
  resolvedFromInput,
  type StorageRow,
  storageById,
  testStorage,
} from './storage';

const PUBLIC_SHARE_PATH = '/v1/public/share';
const SESSION_DAYS = 365;
const INVITE_DAYS = 7;
const UPLOAD_URL_TTL = 3600;
const MEMORY_URL_TTL = 3600;
/** AGENTS.md 硬性要求：证件链接不超过 10 分钟。 */
const DOCUMENT_URL_TTL = 600;
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
  status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 503,
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

interface RecordRow {
  id: string;
  collection: ServerRecord['collection'];
  data: unknown;
  deleted: boolean;
  updated_at_client: string;
  seq: string;
  created_by: string | null;
}

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

  app.onError((error, c) => {
    if (error instanceof HTTPException) {
      // 只记路径、状态和错误原因，不记请求体，原因文字里也不含用户填写的值。
      if (error.status !== 401)
        console.warn(`[${c.req.method} ${c.req.path}] ${error.status} ${error.message}`);
      return error.getResponse();
    }
    // 只记录错误名和信息：请求体里可能有证件号，不能进日志。
    console.error(
      `[${c.req.method} ${c.req.path}]`,
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

  app.get('/healthz', async (c) => {
    await sql`SELECT 1`;
    return c.json({ ok: true });
  });

  app.get('/v1/config', (c) =>
    c.json<PublicConfig>({
      allowCustomStorage: config.allowCustomStorage,
      passwordReset: Boolean(mailer),
      emailVerification: Boolean(mailer),
    }),
  );

  // ─── 分享页的公开接口 ──────────────────────────────────

  /**
   * 整个服务只有这一个接口开 CORS：分享页是别的域名上的静态页面。`*` 不带凭据，
   * 令牌在请求体里，App 用的登录接口都不受影响。注册在 v1 之前：v1 的中间件会要求登录，预检也过不去。
   */
  app.use(
    PUBLIC_SHARE_PATH,
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

  /** 不存在、格式不对、过期、撤销都是它，不透露是哪一种。不走 fail：那会把原因写进日志。 */
  const shareMiss = (c: Context) =>
    c.json<ApiError>(
      { error: { code: 'share_unavailable', message: '这个链接已失效或已撤销' } },
      404,
    );

  app.post(PUBLIC_SHARE_PATH, bodyLimit({ maxSize: 1024, onError: shareMiss }), async (c) => {
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
    const parsed = PublicShareRequest.safeParse(await c.req.json().catch(() => null));
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
    if (!share) return shareMiss(c);
    return c.json<PublicShareResponse>(await buildPublicShare(sql, config, share));
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
    };
  }

  v1.get('/me', async (c) => c.json(await buildMe(c.get('user'), c.get('membership'))));

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
    const records = await sql<RecordRow[]>`
      SELECT id, collection, data, deleted, updated_at_client, seq, created_by FROM records
      WHERE family_id = ${m.familyId} AND NOT deleted AND collection = ANY(${readable})
      ORDER BY seq`;
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
      }[]
    >`SELECT id, variant, scope, mime, size, filename, created_at FROM media
      WHERE family_id = ${m.familyId} AND status = 'ready' AND unreferenced_at IS NULL
      ORDER BY created_at, id, variant`;
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
      await tx`DELETE FROM memberships WHERE family_id = ${m.familyId} AND user_id = ${target}::uuid`;
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

  // ─── 分享一天 ───────────────────────────────────────────

  v1.post('/shares', async (c) => {
    const m = requireFamily(c);
    if (m.role === 'viewer') fail(403, 'forbidden', '你只能查看回忆和照片', { reason: 'viewer' });
    const body = await parseBody(c, CreateShareRequest);
    const id = crypto.randomUUID();
    const token = newToken();
    const expires = new Date(Date.now() + body.ttlDays * DAY_MS);
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
        INSERT INTO shares (id, family_id, created_by, token_hash, from_at, to_at, timezone,
                            include_moments, include_daily, include_health, units, expires_at)
        VALUES (${id}, ${m.familyId}, ${c.get('user').id}, ${sha256(token)}, ${body.fromAt}, ${body.toAt}, ${body.timezone},
                ${body.include.moments}, ${body.include.daily}, ${body.include.health}, ${tx.json(body.units)}, ${expires})`;
    });
    return c.json<CreateShareResponse>({ id, token, expiresAt: expires.getTime() }, 201);
  });

  v1.get('/shares', async (c) => {
    const m = requireFamily(c);
    if (m.role === 'viewer') fail(403, 'forbidden', '你只能查看回忆和照片', { reason: 'viewer' });
    const rows = await sql<(ShareRow & { label: string })[]>`
      SELECT s.id, s.family_id, s.created_by, s.from_at, s.to_at, s.timezone,
             s.include_moments, s.include_daily, s.include_health, s.units, s.expires_at, s.created_at,
             mem.label
      FROM shares s
      JOIN memberships mem ON mem.family_id = s.family_id AND mem.user_id = s.created_by
      WHERE s.family_id = ${m.familyId} AND s.revoked_at IS NULL AND s.expires_at > now()
      ORDER BY s.from_at DESC, s.created_at DESC`;
    const userId = c.get('user').id;
    return c.json<ShareListResponse>({
      shares: rows.map((row) => ({
        id: row.id,
        fromAt: Number(row.from_at),
        toAt: Number(row.to_at),
        timezone: row.timezone,
        include: shareInclude(row),
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
            }[]
          >`SELECT family_id, updated_at_client, collection, deleted, data FROM records WHERE id = ${change.id}`;
          if (
            existing &&
            (existing.family_id !== m.familyId || existing.collection !== change.collection)
          ) {
            // id 由客户端生成，不能让它覆盖别的家庭或别的集合的数据。
            rejected.push({ id: change.id, reason: 'forbidden' });
            continue;
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
            INSERT INTO records (id, family_id, collection, data, deleted, updated_at_client, seq, created_by, updated_by)
            VALUES (${change.id}, ${m.familyId}, ${change.collection}, ${json}, ${change.deleted}, ${change.updatedAt}, ${seq}, ${user.id}, ${user.id})
            ON CONFLICT (id) DO UPDATE SET
              data = EXCLUDED.data,
              deleted = EXCLUDED.deleted,
              updated_at_client = EXCLUDED.updated_at_client,
              seq = EXCLUDED.seq,
              updated_by = EXCLUDED.updated_by
            RETURNING id, collection, data, deleted, updated_at_client, seq, created_by`;
          if (row && !existing && !change.deleted) created.push(toServerRecord(row));
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
      SELECT id, collection, data, deleted, updated_at_client, seq, created_by FROM records
      WHERE family_id = ${m.familyId} AND seq > ${fromCursor} AND seq <= ${upperBound}
        AND collection = ANY(${readable})
      ORDER BY seq LIMIT ${SYNC_PAGE_SIZE + 1}`;
    const hasMore = rows.length > SYNC_PAGE_SIZE;
    const page = rows.slice(0, SYNC_PAGE_SIZE);
    const cursor = hasMore ? Number(page[page.length - 1]?.seq ?? fromCursor) : upperBound;
    const records = page.map(toServerRecord);
    if (conflicted.length > 0) {
      // 客户端手里的版本没有生效，而服务端版本可能已在游标之前，必须显式补发。
      // 一定要按可读集合过滤，否则 viewer 能用猜到的 id 读到证件。
      const seen = new Set(records.map((r) => r.id));
      const missing = conflicted.filter((id) => !seen.has(id));
      if (missing.length > 0) {
        const extra = await sql<RecordRow[]>`
          SELECT id, collection, data, deleted, updated_at_client, seq, created_by FROM records
          WHERE family_id = ${m.familyId} AND id = ANY(${missing}::uuid[])
            AND collection = ANY(${readable})`;
        records.push(...extra.map(toServerRecord));
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

  v1.post('/media/upload-url', async (c) => {
    const m = requireFamily(c);
    if (m.role === 'viewer') fail(403, 'forbidden', '你只能查看回忆和照片', { reason: 'viewer' });
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
    const body = await parseBody(c, UploadUrlRequest);
    if (!isAllowedMime(body.mime, body.scope)) fail(400, 'bad_type', '不支持这种文件类型');
    const maxBytes = Math.min(
      config.maxUploadBytes,
      config.maxFileBytes[mediaCategory(body.mime, body.scope)],
    );
    if (body.size > maxBytes) {
      fail(413, 'too_large', `文件太大了，这种文件最大 ${formatBytes(maxBytes)}`, { maxBytes });
    }
    const [existing] = await sql<
      { family_id: string; status: string; object_key: string; storage_config_id: string | null }[]
    >`SELECT family_id, status, object_key, storage_config_id FROM media WHERE id = ${body.id} AND variant = ${body.variant}`;
    if (existing && existing.family_id !== m.familyId) fail(403, 'forbidden', '没有权限');
    if (existing?.status === 'ready') fail(409, 'already_uploaded', '文件已经上传过了');

    const storage = await activeStorage(sql, config, m.familyId);
    if (!storage)
      fail(503, 'no_storage', '还没有配置存储，请管理员先在「家人 → 存储」里设置', {
        reason: 'notConfigured',
      });
    const key = objectKey(m.familyId, body.scope, body.id, body.variant);
    await sql.begin(async (tx) => {
      // 自己的存储不花平台的钱，不用配额。查询和预留要在同一把锁里，否则并行上传会一起通过检查。
      if (!storage.configId) {
        const [family] = await tx<{ quota_mb: string | null }[]>`
          SELECT quota_mb FROM families WHERE id = ${m.familyId} FOR UPDATE`;
        const quota = familyQuotaBytes(config, family?.quota_mb ?? null);
        if (quota !== null) {
          const usage = await platformUsage(tx, m.familyId, body);
          if (countedBytes(usage, quota) + body.size > quota) failOverQuota(quota);
        }
      }
      await tx`
        INSERT INTO media (id, variant, family_id, scope, mime, size, filename, object_key, storage_config_id, uploaded_by)
        VALUES (${body.id}, ${body.variant}, ${m.familyId}, ${body.scope}, ${body.mime}, ${body.size}, ${body.filename ?? null}, ${key}, ${storage.configId}, ${c.get('user').id})
        ON CONFLICT (id, variant) DO UPDATE SET
          mime = EXCLUDED.mime, size = EXCLUDED.size, filename = EXCLUDED.filename,
          object_key = EXCLUDED.object_key, storage_config_id = EXCLUDED.storage_config_id,
          reserved_at = now()`;
    });
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

  v1.post('/media/:id/complete', async (c) => {
    const m = requireFamily(c);
    if (m.role === 'viewer') fail(403, 'forbidden', '你只能查看回忆和照片', { reason: 'viewer' });
    const { variant } = await parseBody(c, CompleteUploadRequest);
    const id = c.req.param('id');
    const [row] = await sql<
      {
        family_id: string;
        size: string;
        object_key: string;
        storage_config_id: string | null;
        status: string;
      }[]
    >`SELECT family_id, size, object_key, storage_config_id, status FROM media WHERE id = ${id}::uuid AND variant = ${variant}`;
    if (!row || row.family_id !== m.familyId) fail(404, 'not_found', '找不到这个文件');
    if (row.status === 'ready') return c.json({ ok: true });
    const storage = await storageById(sql, config, m.familyId, row.storage_config_id);
    if (!storage) fail(503, 'no_storage', '存储配置不可用');
    if (storage.configId && storage.endpoint) {
      // 地址可能在保存之后改为解析到内网，连接前再查一次。
      try {
        await assertEndpointAllowed(storage.endpoint, config);
      } catch {
        fail(503, 'no_storage', '存储地址不可用');
      }
    }
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
      await tx`UPDATE media SET status = 'ready' WHERE id = ${id}::uuid AND variant = ${variant}`;
      return null;
    });
    // 在事务外抛错：事务里抛错会把上面的删除回滚。
    if (overQuota !== null) failOverQuota(overQuota);
    return c.json({ ok: true });
  });

  v1.post('/media/urls', async (c) => {
    const m = requireFamily(c);
    const body = await parseBody(c, MediaUrlsRequest);
    if (body.items.length === 0) return c.json<MediaUrlsResponse>({ urls: [] });
    const ids = [...new Set(body.items.map((i) => i.id))];
    const rows = await sql<
      {
        id: string;
        variant: 'original' | 'thumb';
        scope: 'memory' | 'document' | 'avatar';
        object_key: string;
        storage_config_id: string | null;
      }[]
    >`SELECT id, variant, scope, object_key, storage_config_id FROM media
      WHERE family_id = ${m.familyId} AND status = 'ready' AND id = ANY(${ids}::uuid[])`;
    const lookup = new Map(rows.map((r) => [`${r.id}/${r.variant}`, r]));
    const storages = new Map<string, ResolvedStorage | null>();
    const urls: MediaUrlsResponse['urls'] = [];
    for (const item of body.items) {
      const row = lookup.get(`${item.id}/${item.variant}`);
      if (!row || !canReadMediaScope(m.role, row.scope)) {
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
      if (row.scope !== 'document' && storage.publicBaseUrl) {
        // 只有回忆走 CDN；证件永远不走公开地址。
        urls.push({
          ...item,
          url: `${storage.publicBaseUrl.replace(/\/$/, '')}/${row.object_key}`,
          expiresIn: 24 * 3600,
        });
        continue;
      }
      const ttl = row.scope === 'document' ? DOCUMENT_URL_TTL : MEMORY_URL_TTL;
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
          WHEN scope = 'document' THEN 'document'
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
