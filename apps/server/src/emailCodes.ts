import type { Buffer } from 'node:buffer';
import { EMAIL_CODE_COOLDOWN_SECONDS, EMAIL_CODE_TTL_MINUTES } from '@xiaodouya/shared';
import { hashEmailCode, newEmailCode, safeEqualHex } from './crypto';
import type { Sql, Tx } from './db';

export type CodePurpose = 'verify_email' | 'reset_password';

/** 六位数字，每个验证码最多猜 5 次，换验证码还受发送上限和 app.ts 里的总次数限制。 */
const MAX_CODE_ATTEMPTS = 5;
const NO_USER = 'no-user';

const scopeFor = (purpose: CodePurpose, userId: string) => `${purpose}:${userId}`;

/**
 * 发一个新验证码，旧的同时作废。还在冷却就返回 null。
 * 冷却写在同一条语句里：同时来两个请求也只有一个能拿到验证码。
 */
export async function issueEmailCode(
  sql: Sql,
  secret: Buffer,
  userId: string,
  purpose: CodePurpose,
): Promise<string | null> {
  const code = newEmailCode();
  const hash = hashEmailCode(secret, scopeFor(purpose, userId), code);
  const rows = await sql`
    INSERT INTO email_codes (user_id, purpose, code_hash, expires_at)
    VALUES (${userId}, ${purpose}, ${hash}, now() + interval '1 minute' * ${EMAIL_CODE_TTL_MINUTES})
    ON CONFLICT (user_id, purpose) DO UPDATE SET
      code_hash = EXCLUDED.code_hash,
      expires_at = EXCLUDED.expires_at,
      attempts = 0,
      created_at = now()
    WHERE email_codes.created_at <= now() - interval '1 second' * ${EMAIL_CODE_COOLDOWN_SECONDS}
    RETURNING user_id`;
  return rows.length > 0 ? code : null;
}

/** 还要等多少秒才能再发。 */
export async function emailCodeCooldown(
  sql: Sql,
  userId: string,
  purpose: CodePurpose,
): Promise<number> {
  const [row] = await sql<{ seconds: number }[]>`
    SELECT ceil(extract(epoch FROM
      created_at + interval '1 second' * ${EMAIL_CODE_COOLDOWN_SECONDS} - now()))::int AS seconds
    FROM email_codes WHERE user_id = ${userId} AND purpose = ${purpose}`;
  return Math.max(0, row?.seconds ?? 0);
}

export interface MatchedCode {
  userId: string;
  codeHash: string;
}

/**
 * 核对验证码，每次调用都消耗一次尝试。匹配了也还没有用掉，调用方要在事务里用 consumeEmailCode。
 * 账号不存在、没申请过、过期、次数用完、验证码不对，走的都是一条语句加一次哈希比较，结果也都是 null。
 */
export async function matchEmailCode(
  sql: Sql,
  secret: Buffer,
  email: string,
  purpose: CodePurpose,
  code: string,
): Promise<MatchedCode | null> {
  // 次数检查和递增在同一条语句里，同时猜也不会超过上限。
  const [row] = await sql<{ user_id: string; code_hash: string }[]>`
    UPDATE email_codes SET attempts = attempts + 1
    WHERE user_id = (SELECT id FROM users WHERE email = ${email})
      AND purpose = ${purpose} AND expires_at > now() AND attempts < ${MAX_CODE_ATTEMPTS}
    RETURNING user_id, code_hash`;
  const candidate = hashEmailCode(secret, scopeFor(purpose, row?.user_id ?? NO_USER), code);
  const expected = row?.code_hash ?? hashEmailCode(secret, scopeFor(purpose, NO_USER), '');
  if (!safeEqualHex(candidate, expected) || !row) return null;
  return { userId: row.user_id, codeHash: row.code_hash };
}

/** 真正用掉验证码。返回 false 说明已经被另一个请求抢先用掉，或者发了新的。 */
export async function consumeEmailCode(
  tx: Tx,
  purpose: CodePurpose,
  matched: MatchedCode,
): Promise<boolean> {
  const rows = await tx`
    DELETE FROM email_codes
    WHERE user_id = ${matched.userId} AND purpose = ${purpose} AND code_hash = ${matched.codeHash}
    RETURNING user_id`;
  return rows.length > 0;
}
