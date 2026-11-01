import { EventEmitter } from 'node:events';
import {
  AcceptInviteRequest,
  type ApiError,
  type AuthResponse,
  CompleteUploadRequest,
  CreateFamilyRequest,
  CreateInviteRequest,
  canReadCollection,
  canReadMediaScope,
  canWriteCollection,
  collections,
  defaultPrefs,
  describeEvent,
  type EventData,
  type FamilyMember,
  isAllowedMime,
  LoginRequest,
  MediaUrlsRequest,
  type MediaUrlsResponse,
  type MeResponse,
  type PendingInvite,
  Prefs,
  PushTokenRequest,
  parseCollectionData,
  RegisterRequest,
  type Role,
  type ServerRecord,
  StorageConfigInput,
  type StorageConfigView,
  type StorageUsage,
  SYNC_PAGE_SIZE,
  SyncRequest,
  type SyncResponse,
  UpdateMemberRequest,
  UploadUrlRequest,
  type UploadUrlResponse,
} from '@xiaodouya/shared';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import type { z } from 'zod';
import type { Config } from './config';
import {
  encryptSecret,
  hashPassword,
  newInviteCode,
  newToken,
  sha256,
  verifyPassword,
} from './crypto';
import type { Sql } from './db';
import { isQuietHour, type Notifier, noopNotifier, type PushMessage } from './notifier';
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

const SESSION_DAYS = 365;
const INVITE_DAYS = 7;
const UPLOAD_URL_TTL = 3600;
const MEMORY_URL_TTL = 3600;
/** AGENTS.md 硬性要求：证件链接不超过 10 分钟。 */
const DOCUMENT_URL_TTL = 600;
const LONG_POLL_MS = 25_000;

interface AppContext {
  sql: Sql;
  config: Config;
  notifier?: Notifier;
}

interface AuthedUser {
  id: string;
  email: string;
  displayName: string;
  prefs: Prefs;
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
): never {
  throw new HTTPException(status, {
    message: `${code}: ${message}`,
    res: new Response(JSON.stringify({ error: { code, message } } satisfies ApiError), {
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
    );
  }
  return parsed.data;
}

function mergePrefs(stored: unknown): Prefs {
  const parsed = Prefs.partial().safeParse(stored);
  return { ...defaultPrefs, ...(parsed.success ? parsed.data : {}) };
}

/** 简单的内存限流，防止暴力猜密码。单实例部署足够。 */
class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();
  constructor(
    private limit: number,
    private windowMs: number,
  ) {}
  check(key: string): boolean {
    const now = Date.now();
    if (this.hits.size > 10_000) {
      for (const [k, v] of this.hits) if (v.resetAt < now) this.hits.delete(k);
    }
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt < now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    entry.count += 1;
    return entry.count <= this.limit;
  }
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

export function createApp({ sql, config, notifier = noopNotifier }: AppContext) {
  const app = new Hono<Env>();
  const changes = new EventEmitter();
  changes.setMaxListeners(0);
  const loginLimiter = new RateLimiter(10, 15 * 60_000);
  const inviteLimiter = new RateLimiter(20, 15 * 60_000);

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

  // ─── 账号 ─────────────────────────────────────────────

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

  const clientKey = (c: { req: { header(name: string): string | undefined } }) =>
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local';

  app.post('/v1/auth/register', bodyLimit({ maxSize: 64 * 1024 }), async (c) => {
    const body = await parseBody(c, RegisterRequest);
    if (!config.allowSignup) {
      if (!body.inviteCode) fail(403, 'signup_closed', '这台服务器不开放注册，需要家人的邀请码');
      if (!(await findValidInvite(body.inviteCode)))
        fail(403, 'invalid_invite', '邀请码无效或已过期');
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
    return c.json<AuthResponse>({ token, user: { id, email, displayName: body.displayName } }, 201);
  });

  app.post('/v1/auth/login', bodyLimit({ maxSize: 64 * 1024 }), async (c) => {
    const body = await parseBody(c, LoginRequest);
    const email = normalizeEmail(body.email);
    if (!loginLimiter.check(`${clientKey(c)}:${email}`)) {
      fail(429, 'too_many_attempts', '尝试次数太多了，请 15 分钟后再试');
    }
    const [user] = await sql<
      { id: string; password_hash: string; display_name: string }[]
    >`SELECT id, password_hash, display_name FROM users WHERE email = ${email}`;
    const valid = user ? await verifyPassword(body.password, user.password_hash) : false;
    if (!user || !valid) fail(401, 'bad_credentials', '邮箱或密码不正确');
    const token = await createSession(user.id);
    return c.json<AuthResponse>({
      token,
      user: { id: user.id, email, displayName: user.display_name },
    });
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
        family_id: string | null;
        role: Role | null;
        label: string | null;
      }[]
    >`SELECT u.id, u.email, u.display_name, u.prefs, m.family_id, m.role, m.label
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      LEFT JOIN memberships m ON m.user_id = u.id
      WHERE s.token_hash = ${sha256(token)} AND s.expires_at > now()`;
    if (!row) fail(401, 'unauthenticated', '登录已过期，请重新登录');
    // 常用的手机不应该到期被踢：剩余不足一半时续期（不是每次都写库）。
    await sql`UPDATE sessions SET expires_at = now() + interval '1 day' * ${SESSION_DAYS}
      WHERE token_hash = ${sha256(token)} AND expires_at < now() + interval '1 day' * ${SESSION_DAYS / 2}`;
    c.set('user', {
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      prefs: mergePrefs(row.prefs),
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
    if (m.role !== 'admin') fail(403, 'forbidden', '只有管理员可以这样做');
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
      family,
      role: m?.role ?? null,
      label: m?.label ?? null,
      members,
      invites,
      prefs: user.prefs,
    };
  }

  v1.get('/me', async (c) => c.json(await buildMe(c.get('user'), c.get('membership'))));

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

  // ─── 家庭和邀请 ─────────────────────────────────────────

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
    if (!inviteLimiter.check(`${clientKey(c)}:${user.id}`)) {
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
    await sql`
      UPDATE memberships SET
        role = COALESCE(${body.role ?? null}, role),
        label = COALESCE(${body.label ?? null}, label)
      WHERE family_id = ${m.familyId} AND user_id = ${target}::uuid`;
    return c.json({ ok: true });
  });

  v1.delete('/family/members/:userId', async (c) => {
    const m = requireAdmin(c);
    const target = c.req.param('userId');
    await assertNotLastAdmin(m.familyId, target);
    await sql`DELETE FROM memberships WHERE family_id = ${m.familyId} AND user_id = ${target}::uuid`;
    // 移除后立刻让对方的登录失效，避免继续读取家庭数据的缓存链接。
    await sql`DELETE FROM sessions WHERE user_id = ${target}::uuid`;
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

  v1.post('/sync', bodyLimit({ maxSize: 5 * 1024 * 1024 }), async (c) => {
    const m = requireFamily(c);
    const user = c.get('user');
    const body = await parseBody(c, SyncRequest);
    const rejected: SyncResponse['rejected'] = [];
    const created: ServerRecord[] = [];
    const conflicted: string[] = [];

    if (body.changes.length > 0) {
      await sql.begin(async (tx) => {
        // 按家庭串行写入，才能保证 seq 严格递增且提交顺序一致。否则游标可能跳过尚未提交的记录。
        await tx`SELECT seq FROM families WHERE id = ${m.familyId} FOR UPDATE`;
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
            { family_id: string; updated_at_client: string; collection: string }[]
          >`SELECT family_id, updated_at_client, collection FROM records WHERE id = ${change.id}`;
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
          const [{ seq } = { seq: '0' }] = await tx<{ seq: string }[]>`
            UPDATE families SET seq = seq + 1 WHERE id = ${m.familyId} RETURNING seq`;
          const json = tx.json(data as never);
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
        }
      });
      if (created.length > 0 || body.changes.length > rejected.length + conflicted.length) {
        changes.emit(m.familyId);
      }
      if (created.length > 0) {
        void notifyFamily(m, user.id, created).catch((error: unknown) => {
          console.error('推送失败', error instanceof Error ? error.message : 'unknown');
        });
      }
    }

    const readable = collections.filter((name) => canReadCollection(m.role, name));
    // 顺序不能换：先定上界 S，再查 seq <= S。写入在持有家庭行锁时提交，所以 S 之前的记录一定可见。
    // 如果先查记录再读 seq，中间提交的记录会被游标直接跳过，再也同步不到。
    const [family] = await sql<
      { seq: string }[]
    >`SELECT seq FROM families WHERE id = ${m.familyId}`;
    const upperBound = Number(family?.seq ?? body.cursor);
    const rows = await sql<RecordRow[]>`
      SELECT id, collection, data, deleted, updated_at_client, seq, created_by FROM records
      WHERE family_id = ${m.familyId} AND seq > ${body.cursor} AND seq <= ${upperBound}
        AND collection = ANY(${readable})
      ORDER BY seq LIMIT ${SYNC_PAGE_SIZE + 1}`;
    const hasMore = rows.length > SYNC_PAGE_SIZE;
    const page = rows.slice(0, SYNC_PAGE_SIZE);
    const cursor = hasMore
      ? Number(page[page.length - 1]?.seq ?? body.cursor)
      : Math.max(upperBound, body.cursor);
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
    await sql`UPDATE memberships SET last_seen_at = now() WHERE family_id = ${m.familyId} AND user_id = ${user.id}`;
    return c.json<SyncResponse>({ cursor, hasMore, records, rejected, role: m.role });
  });

  /** 长轮询：比 WebSocket 简单，反向代理不用特殊配置。App 在前台时循环调用。 */
  v1.get('/sync/wait', async (c) => {
    const m = requireFamily(c);
    const cursor = Number(c.req.query('cursor') ?? 0);
    const latest = async () => {
      const [row] = await sql<{ seq: string }[]>`SELECT seq FROM families WHERE id = ${m.familyId}`;
      return Number(row?.seq ?? 0);
    };
    const current = await latest();
    if (current > cursor) return c.json({ changed: true });
    const changed = await new Promise<boolean>((resolve) => {
      const done = (value: boolean) => {
        clearTimeout(timer);
        changes.off(m.familyId, onChange);
        c.req.raw.signal.removeEventListener('abort', onAbort);
        resolve(value);
      };
      const onChange = () => done(true);
      const onAbort = () => done(false);
      const timer = setTimeout(() => done(false), LONG_POLL_MS);
      changes.on(m.familyId, onChange);
      c.req.raw.signal.addEventListener('abort', onAbort);
    });
    return c.json({ changed });
  });

  async function notifyFamily(m: Membership, authorId: string, created: ServerRecord[]) {
    const now = Date.now();
    const recent = created.filter((r) => {
      if (r.collection === 'moment') return true;
      if (r.collection !== 'event') return false;
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
    const messages: PushMessage[] = [];
    for (const target of targets) {
      const prefs = mergePrefs(target.prefs);
      if (!prefs.familyNotify) continue;
      if (prefs.quietNight && isQuietHour(now, prefs.timezone)) continue;
      for (const record of recent) {
        if (!canReadCollection(target.role, record.collection)) continue;
        const body =
          record.collection === 'event'
            ? describeEvent(record.data as EventData, now)
            : (record.data as { title?: string }).title || '记下了新的一刻';
        messages.push({ token: target.token, title: `${m.label} 刚刚记录了`, body });
      }
    }
    if (messages.length > 0) await notifier.send(messages);
  }

  // ─── 文件 ─────────────────────────────────────────────

  const objectKey = (familyId: string, scope: string, id: string, variant: string) =>
    `families/${familyId}/${scope}/${id}/${variant}`;

  v1.post('/media/upload-url', async (c) => {
    const m = requireFamily(c);
    if (m.role === 'viewer') fail(403, 'forbidden', '你只能查看回忆和照片');
    const body = await parseBody(c, UploadUrlRequest);
    if (!isAllowedMime(body.mime, body.scope)) fail(400, 'bad_type', '不支持这种文件类型');
    if (body.size > config.maxUploadBytes) {
      fail(
        413,
        'too_large',
        `文件太大了，最大 ${Math.round(config.maxUploadBytes / 1024 / 1024)} MB`,
      );
    }
    const [existing] = await sql<
      { family_id: string; status: string; object_key: string; storage_config_id: string | null }[]
    >`SELECT family_id, status, object_key, storage_config_id FROM media WHERE id = ${body.id} AND variant = ${body.variant}`;
    if (existing && existing.family_id !== m.familyId) fail(403, 'forbidden', '没有权限');
    if (existing?.status === 'ready') fail(409, 'already_uploaded', '文件已经上传过了');

    const storage = await activeStorage(sql, config, m.familyId);
    if (!storage) fail(503, 'no_storage', '还没有配置存储，请管理员先在「家人 → 存储」里设置');
    const key = objectKey(m.familyId, body.scope, body.id, body.variant);
    await sql`
      INSERT INTO media (id, variant, family_id, scope, mime, size, filename, object_key, storage_config_id, uploaded_by)
      VALUES (${body.id}, ${body.variant}, ${m.familyId}, ${body.scope}, ${body.mime}, ${body.size}, ${body.filename ?? null}, ${key}, ${storage.configId}, ${c.get('user').id})
      ON CONFLICT (id, variant) DO UPDATE SET
        mime = EXCLUDED.mime, size = EXCLUDED.size, filename = EXCLUDED.filename,
        object_key = EXCLUDED.object_key, storage_config_id = EXCLUDED.storage_config_id`;
    const url = await presignUpload(storage, key, body.mime, UPLOAD_URL_TTL);
    return c.json<UploadUrlResponse>({
      url,
      headers: { 'Content-Type': body.mime },
      expiresIn: UPLOAD_URL_TTL,
    });
  });

  v1.post('/media/:id/complete', async (c) => {
    const m = requireFamily(c);
    if (m.role === 'viewer') fail(403, 'forbidden', '你只能查看回忆和照片');
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
    await sql`UPDATE media SET status = 'ready' WHERE id = ${id}::uuid AND variant = ${variant}`;
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

  async function validateStorageInput(input: StorageConfigInput) {
    if (!config.allowCustomStorage)
      fail(403, 'custom_storage_disabled', '这台服务器不允许自定义存储');
    if (input.provider === 'r2' && !input.accountId)
      fail(400, 'invalid_input', '请填写 Account ID');
    if (input.provider === 'other' && !input.endpoint)
      fail(400, 'invalid_input', '请填写 Endpoint');
    if (input.accountId && !/^[a-zA-Z0-9-]+$/.test(input.accountId)) {
      // Account ID 会拼进主机名，只允许安全字符。
      fail(400, 'invalid_input', 'Account ID 格式不正确');
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
      fail(400, 'invalid_input', '自定义域名必须使用 https');
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
    fail(400, 'invalid_input', '请填写 Secret Access Key');
  }

  v1.post('/storage/test', async (c) => {
    const m = requireAdmin(c);
    const input = await parseBody(c, StorageConfigInput);
    await validateStorageInput(input);
    const secret = await secretFor(m.familyId, input);
    return c.json(await testStorage(resolvedFromInput(input, secret)));
  });

  v1.put('/storage', async (c) => {
    const m = requireAdmin(c);
    const input = await parseBody(c, StorageConfigInput);
    await validateStorageInput(input);
    const secret = await secretFor(m.familyId, input);
    const result = await testStorage(resolvedFromInput(input, secret));
    if (!result.ok) fail(400, 'storage_test_failed', result.message);
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
    const m = requireAdmin(c);
    const rows = await sql<{ category: string; total: string }[]>`
      SELECT CASE
          WHEN scope = 'document' THEN 'document'
          WHEN mime LIKE 'video/%' THEN 'video'
          WHEN mime LIKE 'audio/%' THEN 'audio'
          ELSE 'image' END AS category,
        COALESCE(SUM(size), 0) AS total
      FROM media WHERE family_id = ${m.familyId} AND status = 'ready'
      GROUP BY 1`;
    const usage: StorageUsage = { image: 0, video: 0, audio: 0, document: 0, total: 0 };
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
