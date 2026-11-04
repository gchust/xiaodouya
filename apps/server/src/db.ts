import postgres from 'postgres';
import type { DbConfig } from './config';

export type Sql = postgres.Sql;
export type Tx = postgres.TransactionSql;

/** 迁移只增不改：已发布的条目不能修改，需要变更就追加新的一条。 */
export const migrations: readonly string[] = [
  `
  CREATE TABLE users (
    id UUID PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL,
    prefs JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX sessions_user ON sessions(user_id);
  CREATE TABLE families (
    id UUID PRIMARY KEY,
    name TEXT NOT NULL,
    seq BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE memberships (
    family_id UUID NOT NULL REFERENCES families(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('admin', 'caregiver', 'viewer')),
    label TEXT NOT NULL,
    last_seen_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (family_id, user_id)
  );
  -- 第一版每个账号只属于一个家庭，将来放开时删掉这个索引即可。
  CREATE UNIQUE INDEX memberships_one_family ON memberships(user_id);
  CREATE TABLE invites (
    id UUID PRIMARY KEY,
    family_id UUID NOT NULL REFERENCES families(id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL CHECK (role IN ('admin', 'caregiver', 'viewer')),
    label TEXT NOT NULL,
    created_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    used_by UUID REFERENCES users(id) ON DELETE SET NULL,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE records (
    id UUID PRIMARY KEY,
    family_id UUID NOT NULL REFERENCES families(id) ON DELETE CASCADE,
    collection TEXT NOT NULL,
    data JSONB NOT NULL,
    deleted BOOLEAN NOT NULL DEFAULT false,
    updated_at_client BIGINT NOT NULL,
    seq BIGINT NOT NULL,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX records_family_seq ON records(family_id, seq);
  CREATE TABLE storage_configs (
    id UUID PRIMARY KEY,
    family_id UUID NOT NULL REFERENCES families(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    account_id TEXT,
    endpoint TEXT,
    region TEXT,
    bucket TEXT NOT NULL,
    access_key_id TEXT NOT NULL,
    secret_encrypted TEXT NOT NULL,
    public_base_url TEXT,
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX storage_configs_one_active ON storage_configs(family_id) WHERE active;
  -- 记录每个文件存在哪份配置里：换存储后，旧文件仍能从原来的位置读取。
  CREATE TABLE media (
    id UUID NOT NULL,
    variant TEXT NOT NULL CHECK (variant IN ('original', 'thumb')),
    family_id UUID NOT NULL REFERENCES families(id) ON DELETE CASCADE,
    scope TEXT NOT NULL CHECK (scope IN ('memory', 'document', 'avatar')),
    mime TEXT NOT NULL,
    size BIGINT NOT NULL,
    filename TEXT,
    object_key TEXT NOT NULL,
    storage_config_id UUID REFERENCES storage_configs(id),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready')),
    uploaded_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (id, variant)
  );
  CREATE INDEX media_family ON media(family_id, status);
  CREATE TABLE push_tokens (
    device_id TEXT PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX push_tokens_user ON push_tokens(user_id);
  `,
  // 限流计数：Edge Function 的 isolate 之间不共享内存。
  `
  CREATE TABLE rate_limits (
    key_hash TEXT PRIMARY KEY,
    count INT NOT NULL,
    reset_at TIMESTAMPTZ NOT NULL
  );
  `,
  // Supabase 的 Data API 把 public 里的表暴露给 anon 角色，而 anon key 本来就是公开的。
  // 这里只有服务端自己访问数据库：开 RLS 不写策略，表的所有者（服务端的连接）不受影响，其他角色一律读不到。
  // 以后新增表也要开 RLS，portable.test.ts 会检查。自建 Postgres 没有这些角色，只是多开了 RLS，没有副作用。
  `
  ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY;
  ALTER TABLE users ENABLE ROW LEVEL SECURITY;
  ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
  ALTER TABLE families ENABLE ROW LEVEL SECURITY;
  ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
  ALTER TABLE invites ENABLE ROW LEVEL SECURITY;
  ALTER TABLE records ENABLE ROW LEVEL SECURITY;
  ALTER TABLE storage_configs ENABLE ROW LEVEL SECURITY;
  ALTER TABLE media ENABLE ROW LEVEL SECURITY;
  ALTER TABLE push_tokens ENABLE ROW LEVEL SECURITY;
  ALTER TABLE rate_limits ENABLE ROW LEVEL SECURITY;
  DO $$
  DECLARE
    api_role TEXT;
  BEGIN
    FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
        EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', api_role);
        EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', api_role);
        EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', api_role);
        EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', api_role);
      END IF;
    END LOOP;
  END $$;
  `,
  // 配额和文件清理。
  // reserved_at：created_at 不会随重新申请链接更新，用它判断预留过期，重传中的文件会被当成放弃。
  // unreferenced_at：所在记录被删或文件被换下的时间，宽限期从这里算。
  // attached：有过记录引用。没有的文件才需要定时核对，否则每次清理都要扫全部文件。
  // sync_*：和 last_seen_at 写在同一行同一条语句里，同步限流不增加写入。
  // record_bytes：防止一个账号把数据库写满，和 seq 一起更新。
  `
  ALTER TABLE families ADD COLUMN quota_mb BIGINT, ADD COLUMN record_bytes BIGINT NOT NULL DEFAULT 0;
  ALTER TABLE media
    ADD COLUMN reserved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ADD COLUMN unreferenced_at TIMESTAMPTZ,
    ADD COLUMN attached BOOLEAN NOT NULL DEFAULT false;
  ALTER TABLE memberships ADD COLUMN sync_window_at TIMESTAMPTZ, ADD COLUMN sync_count INT NOT NULL DEFAULT 0;
  CREATE INDEX media_trash ON media(unreferenced_at) WHERE unreferenced_at IS NOT NULL;
  CREATE INDEX media_abandoned ON media(reserved_at) WHERE status = 'pending';
  CREATE INDEX media_unattached ON media(created_at) WHERE status = 'ready' AND NOT attached AND unreferenced_at IS NULL;
  UPDATE families f SET record_bytes = COALESCE(
    (SELECT SUM(octet_length(r.data::text)) FROM records r WHERE r.family_id = f.id), 0);
  UPDATE media m SET attached = true WHERE EXISTS (
    SELECT 1 FROM records r
    WHERE r.family_id = m.family_id AND NOT r.deleted AND position(m.id::text IN lower(r.data::text)) > 0);
  UPDATE media m SET unreferenced_at = now() WHERE m.status = 'ready' AND NOT m.attached AND EXISTS (
    SELECT 1 FROM records r
    WHERE r.family_id = m.family_id AND r.deleted AND position(m.id::text IN lower(r.data::text)) > 0);
  `,
  // 邮箱验证和找回密码。每人每种用途只有一个有效验证码：发新的就覆盖旧的，用过就删。
  // 老账号不回填 email_verified_at：他们确实没验证过。服务端不因此拒绝任何操作：
  // 线上的 v0.1.0 APK 不认识验证这一步，拒绝就等于把人锁在外面。验证由新版 App 引导。
  `
  ALTER TABLE users ADD COLUMN email_verified_at TIMESTAMPTZ;
  CREATE TABLE email_codes (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    purpose TEXT NOT NULL CHECK (purpose IN ('verify_email', 'reset_password')),
    code_hash TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    attempts INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, purpose)
  );
  ALTER TABLE email_codes ENABLE ROW LEVEL SECURITY;
  `,
  // 账号删除后还没从存储里删掉的文件，见 objectDeletions.ts。storage 是存储配置的快照（Secret 仍是加密的），
  // 因为配置已经随家庭删除了；所以不引用 families，家庭没了这里的记录还要在。
  `
  CREATE TABLE pending_object_deletions (
    id UUID PRIMARY KEY,
    object_key TEXT NOT NULL,
    storage JSONB,
    attempts INT NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX pending_object_deletions_due ON pending_object_deletions(next_attempt_at);
  ALTER TABLE pending_object_deletions ENABLE ROW LEVEL SECURITY;
  `,
  // 分享一天的公开链接。令牌只存哈希。from_at、to_at 是分享者手机算好的当地一天，timezone 是那个时区：
  // 打开页面的人可能在别的时区，日期和钟点要按记录的人那边显示。units 是分享者选的显示单位。
  `
  CREATE TABLE shares (
    id UUID PRIMARY KEY,
    family_id UUID NOT NULL REFERENCES families(id) ON DELETE CASCADE,
    created_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    from_at BIGINT NOT NULL,
    to_at BIGINT NOT NULL,
    timezone TEXT NOT NULL,
    include_moments BOOLEAN NOT NULL,
    include_daily BOOLEAN NOT NULL,
    include_health BOOLEAN NOT NULL,
    units JSONB NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX shares_family ON shares(family_id, expires_at) WHERE revoked_at IS NULL;
  CREATE INDEX shares_expires ON shares(expires_at);
  CREATE INDEX shares_revoked ON shares(revoked_at) WHERE revoked_at IS NOT NULL;
  ALTER TABLE shares ENABLE ROW LEVEL SECURITY;
  `,
  // 分片上传。片的大小记下来：常量以后可能变，没传完的文件还要按当初的大小算。
  // 待删除队列也带上 upload_id：对象还没合并时，只删对象删不掉已传的分片。
  `
  ALTER TABLE media ADD COLUMN upload_id TEXT;
  ALTER TABLE media ADD COLUMN upload_part_size INT;
  ALTER TABLE pending_object_deletions ADD COLUMN upload_id TEXT;
  `,
  // 照片预览。只放开取值，旧行都符合新约束。
  `
  ALTER TABLE media DROP CONSTRAINT media_variant_check;
  ALTER TABLE media ADD CONSTRAINT media_variant_check CHECK (variant IN ('original', 'thumb', 'preview'));
  `,
  // 用户反馈。账号级，不属于家庭，所以附件不进 media 表、不算家庭配额（每人限流和附件上限兜底）。
  // 先存库再建 issue：GitHub 不可用时停在 queued，按 next_attempt_at 退避重试，和待删除队列一样用租约防重复。
  // attachment_count：附件过了保留期会删掉，列表和 cli 还要知道当初有几个。
  `
  CREATE TABLE feedback (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    diagnostics JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'queued', 'sent')),
    attachment_count INT NOT NULL DEFAULT 0,
    attempts INT NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_error TEXT,
    issue_number INT,
    issue_url TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    submitted_at TIMESTAMPTZ,
    sent_at TIMESTAMPTZ
  );
  CREATE INDEX feedback_user ON feedback(user_id, created_at);
  CREATE INDEX feedback_due ON feedback(next_attempt_at) WHERE status = 'queued';
  CREATE INDEX feedback_drafts ON feedback(updated_at) WHERE status = 'draft';
  CREATE TABLE feedback_attachments (
    id UUID PRIMARY KEY,
    feedback_id UUID NOT NULL REFERENCES feedback(id) ON DELETE CASCADE,
    mime TEXT NOT NULL,
    size BIGINT NOT NULL,
    object_key TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX feedback_attachments_feedback ON feedback_attachments(feedback_id);
  ALTER TABLE feedback ENABLE ROW LEVEL SECURITY;
  ALTER TABLE feedback_attachments ENABLE ROW LEVEL SECURITY;
  `,
  // 反馈附件公开（F-126）。public_attachments：这一条的附件放进了公开的 issue。默认 false，
  // 改版前的反馈（当时承诺不公开）都是 false，也就不会有令牌。
  // public_token 存明文，不像分享链接只存哈希：issue 正文在建 issue 时才生成，可能是几天后的重试，
  // 那时还要拼出同一个链接；它也只能打开已经放在公开 issue 里的那个文件。
  `
  ALTER TABLE feedback ADD COLUMN public_attachments BOOLEAN NOT NULL DEFAULT false;
  ALTER TABLE feedback_attachments ADD COLUMN public_token TEXT;
  CREATE UNIQUE INDEX feedback_attachments_public_token ON feedback_attachments(public_token)
    WHERE public_token IS NOT NULL;
  `,
];

export interface ConnectOptions extends Partial<DbConfig> {
  /** 空闲多少秒后断开。Edge Function 的 isolate 不用时要尽快还回连接。 */
  idleTimeout?: number;
}

export function connect(databaseUrl: string, options: ConnectOptions = {}): Sql {
  const { poolMax = 10, prepare = true, ssl = false, idleTimeout } = options;
  return postgres(databaseUrl, {
    max: poolMax,
    // 事务模式的连接池不支持命名预处理语句，语句可能落到另一条服务端连接上。
    prepare,
    onnotice: () => {},
    // 这两项不能传默认值：显式传了就会盖掉连接串里的 sslmode。
    ...(ssl ? { ssl } : {}),
    ...(idleTimeout === undefined ? {} : { idle_timeout: idleTimeout }),
  });
}

/**
 * 迁移的唯一入口。Node 服务启动时调用；Edge Function 不调用，部署时用 `cli migrate` 执行。
 * 在事务里完成并且记录版本，重复执行没有副作用。
 */
export async function migrate(sql: Sql): Promise<void> {
  // 多实例同时启动时用咨询锁排队，避免重复执行迁移。
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(727001)`;
    await tx`CREATE TABLE IF NOT EXISTS schema_migrations (version INT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
    const rows = await tx<{ version: number }[]>`SELECT version FROM schema_migrations`;
    const applied = new Set(rows.map((r) => r.version));
    for (const [index, statement] of migrations.entries()) {
      if (applied.has(index)) continue;
      await tx.unsafe(statement);
      await tx`INSERT INTO schema_migrations (version) VALUES (${index})`;
    }
  });
}
