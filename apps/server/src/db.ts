import postgres from 'postgres';

export type Sql = postgres.Sql;

/** 迁移只增不改：已发布的条目不能修改，需要变更就追加新的一条。 */
const migrations: readonly string[] = [
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
];

export function connect(databaseUrl: string): Sql {
  return postgres(databaseUrl, { max: 10, onnotice: () => {} });
}

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
