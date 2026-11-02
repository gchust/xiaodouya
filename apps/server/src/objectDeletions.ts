/**
 * 账号删除后，存储里的文件靠这个队列删掉。
 *
 * 家庭的数据在一个事务里删完，文件不行：文件可能很多，对象存储可能很慢或暂时不可用，
 * Edge Function 还有墙钟时限。所以事务里只把要删的文件写进队列，提交后再分批处理。
 * 进程中途被回收也不丢，下次接着做。谁都可以调用：请求结束后的后台任务、每天的 `cli maintenance`、
 * 手动的 `cli purge-objects`。
 *
 * 处理时不能开事务：连接池可能只有 1 个连接，等对象存储时占着它，别的请求就全卡住了。
 * 所以先用一条语句把一批记录的下次重试时间推后（相当于租约），提交后再连存储，成功了才删记录。
 * 进程死在中间的话，租约到期后别的进程会接手。
 */
import type { Config } from './config';
import type { Sql, Tx } from './db';
import {
  abortMultipart,
  assertEndpointAllowed,
  deleteObject,
  describeStorageError,
  type StorageRow,
  storageFromSnapshot,
} from './storage';

/**
 * 把这个家庭的文件写进队列。必须在删除家庭的事务里调用，并且在删除之前。
 *
 * 存储配置要跟着记下来（Secret 还是加密的）：它和家庭一起删除，之后就不知道文件在哪了。
 * NULL 表示服务端默认存储，处理时再读环境变量。
 *
 * 还没传完的文件要多记一条，等预签名链接过期后再删一次：手机上的上传可能在账号删除之后才到达。
 * 没合并的分片也跟着记下来，能中止就中止；万一失败，存储的生命周期规则是兜底（见 DEPLOYMENT）。
 */
export async function enqueueFamilyObjects(
  tx: Tx,
  familyId: string,
  uploadUrlTtlSeconds: number,
): Promise<void> {
  await enqueueObjects(tx, tx`m.family_id = ${familyId}`, uploadUrlTtlSeconds);
}

/** 用户取消上传。必须在删除 media 记录的事务里调用，并且在删除之前。只收还没传完的，传好的归记录引用管。 */
export async function enqueueCancelledUpload(
  tx: Tx,
  familyId: string,
  id: string,
  uploadUrlTtlSeconds: number,
): Promise<void> {
  await enqueueObjects(
    tx,
    tx`m.id = ${id}::uuid AND m.family_id = ${familyId} AND m.status = 'pending'`,
    uploadUrlTtlSeconds,
  );
}

async function enqueueObjects(
  tx: Tx,
  where: ReturnType<Tx>,
  uploadUrlTtlSeconds: number,
): Promise<void> {
  await tx`
    INSERT INTO pending_object_deletions (id, object_key, storage, upload_id, next_attempt_at)
    SELECT gen_random_uuid(), m.object_key, s.snapshot, m.upload_id, t.at
    FROM media m
    LEFT JOIN LATERAL (
      SELECT jsonb_build_object(
        'id', c.id, 'provider', c.provider, 'account_id', c.account_id, 'endpoint', c.endpoint,
        'region', c.region, 'bucket', c.bucket, 'access_key_id', c.access_key_id,
        'secret_encrypted', c.secret_encrypted, 'public_base_url', c.public_base_url
      ) AS snapshot
      FROM storage_configs c WHERE c.id = m.storage_config_id
    ) s ON true
    CROSS JOIN LATERAL (
      SELECT now() AS at
      UNION ALL
      SELECT now() + interval '1 second' * ${uploadUrlTtlSeconds + 300}
      WHERE m.status = 'pending'
    ) t
    WHERE ${where}`;
}

interface PendingRow {
  id: string;
  object_key: string;
  /** 还没合并的分片上传。只删对象删不掉它们。 */
  upload_id: string | null;
  storage: StorageRow | null;
}

export interface PurgeResult {
  deleted: number;
  failed: number;
  /** 队列里还剩多少条，包括还没到重试时间的。 */
  remaining: number;
  /** 在家庭自带的存储里、因为没有 APP_SECRET 这次没有处理的。已经计入 remaining。 */
  waitingForSecret: number;
}

const withTimeout = <T>(task: Promise<T>, ms: number): Promise<T> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('存储长时间没有响应')), ms);
    task.then(resolve, reject).finally(() => clearTimeout(timer));
  });

async function removeObject(row: PendingRow, config: Config, timeoutMs: number): Promise<void> {
  const storage = storageFromSnapshot(row.storage, config);
  if (!storage) throw new Error('存储配置不可用');
  // 地址可能在保存之后改为解析到内网，连接前再查一次。
  if (storage.configId && storage.endpoint) await assertEndpointAllowed(storage.endpoint, config);
  try {
    if (row.upload_id) {
      await withTimeout(abortMultipart(storage, row.object_key, row.upload_id), timeoutMs);
    }
    await withTimeout(deleteObject(storage, row.object_key), timeoutMs);
  } catch (error) {
    // 文件或 Bucket 已经不在了，目的已经达到。
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status !== 404) throw error;
  }
}

/** 只存翻译过的原因，不存原始错误：里面可能有地址和请求信息。 */
function describeFailure(error: unknown): string {
  if (error instanceof Error && !('$metadata' in error) && !('code' in error)) {
    return error.message.slice(0, 200);
  }
  return describeStorageError(error);
}

export async function processPendingDeletions(
  sql: Sql,
  config: Config,
  {
    batchSize = 20,
    maxMs = 20_000,
    objectTimeoutMs = 15_000,
    customStorage = true,
  }: {
    batchSize?: number;
    maxMs?: number;
    objectTimeoutMs?: number;
    /**
     * false 表示手里没有真实的 APP_SECRET，解不开家庭自带存储的快照。
     * 这些记录这次不认领，不计入重试次数：等有密钥的进程来处理，不是失败。
     */
    customStorage?: boolean;
  } = {},
): Promise<PurgeResult> {
  const deadline = Date.now() + maxMs;
  let deleted = 0;
  let failed = 0;
  do {
    // 退避从 1 分钟开始翻倍，最多约 17 小时。指数要封顶，否则次数多了 interval 会溢出报错。
    const rows = await sql<PendingRow[]>`
      UPDATE pending_object_deletions SET
        attempts = attempts + 1,
        next_attempt_at = now() + interval '1 minute' * power(2, LEAST(attempts, 10))
      WHERE id IN (
        SELECT id FROM pending_object_deletions
        WHERE next_attempt_at <= now() AND (${customStorage}::boolean OR storage IS NULL)
        ORDER BY next_attempt_at LIMIT ${batchSize} FOR UPDATE SKIP LOCKED
      )
      RETURNING id, object_key, storage, upload_id`;
    if (rows.length === 0) break;
    const results = await Promise.allSettled(
      rows.map((row) => removeObject(row, config, objectTimeoutMs)),
    );
    const done: string[] = [];
    for (const [index, result] of results.entries()) {
      const row = rows[index];
      if (!row) continue;
      if (result.status === 'fulfilled') {
        done.push(row.id);
        continue;
      }
      failed += 1;
      await sql`UPDATE pending_object_deletions SET last_error = ${describeFailure(result.reason)}
        WHERE id = ${row.id}`;
    }
    if (done.length > 0) {
      await sql`DELETE FROM pending_object_deletions WHERE id = ANY(${done}::uuid[])`;
      deleted += done.length;
    }
  } while (Date.now() < deadline);
  const [left] = await sql<{ total: string; custom: string }[]>`
    SELECT count(*) AS total, count(storage) AS custom FROM pending_object_deletions`;
  return {
    deleted,
    failed,
    remaining: Number(left?.total ?? 0),
    waitingForSecret: customStorage ? 0 : Number(left?.custom ?? 0),
  };
}
