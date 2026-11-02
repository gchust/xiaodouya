import type { Config } from './config';
import type { Sql } from './db';
import { processPendingDeletions } from './objectDeletions';
import { liveReferences } from './quota';
import { abortMultipart, deleteObject, type ResolvedStorage, storageById } from './storage';

/** 比预留期（6 小时）和链接有效期（1 小时）长得多，不会删到还在传的文件。 */
const ABANDONED_HOURS = 24;
/**
 * 传完却没有任何记录引用的文件（比如上传途中删了那条回忆）。
 * 记录和文件是分开同步的，新传的文件可能暂时没有记录，所以要等很久。
 */
const UNATTACHED_DAYS = 30;
/** 处理一批时持有家庭锁，那个家庭的同步要等它。批次要小。 */
const BATCH = 50;

export interface MaintenanceReport {
  /** 放弃的上传：记录和可能传了一半的对象都删了。 */
  pendingRemoved: number;
  /** 过了宽限期、已彻底删除的文件。 */
  trashPurged: number;
  /** 从没有记录引用、已彻底删除的文件。 */
  unattachedPurged: number;
  /** 标着待清理、但其实还有记录在用的文件。不应该发生，非 0 说明同步时的标记有 Bug。 */
  rescued: number;
  /** 存储删除失败的文件。记录保留，下次再试。 */
  failed: number;
  rateLimitsRemoved: number;
  /** 账号删除留下的文件（pending_object_deletions），删掉了多少。 */
  deletionsDone: number;
  deletionsFailed: number;
  /** 队列里还剩多少，包括还没到重试时间的和下面这种。 */
  deletionsRemaining: number;
  /** 在家庭自带的存储里、因为没有 APP_SECRET 这次没处理的。不算失败。 */
  deletionsWaitingForSecret: number;
}

interface MediaRow {
  id: string;
  variant: string;
  family_id: string;
  object_key: string;
}

/**
 * 定时任务调用（`cli maintenance`）。可以重复执行，中途失败下次接着来。
 *
 * 只处理这个项目自己知道的对象（media 表里有记录的），不列举 Bucket。
 * 还在用的家庭只清理平台存储：用户自己的 Bucket 不花平台的钱，那里的文件由他们自己决定，密钥也可能早就失效了。
 * 超过配额的家庭不会因此丢任何东西，这里不看配额。
 *
 * 账号删除的待删除队列（pending_object_deletions）也在这里处理，部署只需要配一个定时任务。
 * 那些文件的主人要求删除，所以自带存储的也要删。这要解密快照里的密钥：
 * customStorage 为 false 表示没有真实的 APP_SECRET，自带存储的留在队列里，平台存储的照常处理。
 */
export async function runMaintenance(
  sql: Sql,
  config: Config,
  { customStorage = true }: { customStorage?: boolean } = {},
): Promise<MaintenanceReport> {
  const report: MaintenanceReport = {
    pendingRemoved: 0,
    trashPurged: 0,
    unattachedPurged: 0,
    rescued: 0,
    failed: 0,
    rateLimitsRemoved: 0,
    deletionsDone: 0,
    deletionsFailed: 0,
    deletionsRemaining: 0,
    deletionsWaitingForSecret: 0,
  };
  const storage = await storageById(sql, config, '', null);
  if (storage) report.failed = await purgeObjects(sql, storage, config.mediaTrashDays, report);
  const queue = await processPendingDeletions(sql, config, {
    customStorage,
    maxMs: Number.POSITIVE_INFINITY,
  });
  report.deletionsDone = queue.deleted;
  report.deletionsFailed = queue.failed;
  report.deletionsRemaining = queue.remaining;
  report.deletionsWaitingForSecret = queue.waitingForSecret;
  const removed = await sql`DELETE FROM rate_limits WHERE reset_at < now()`;
  report.rateLimitsRemoved = removed.count;
  return report;
}

/** 返回删除失败的文件数。 */
async function purgeObjects(
  sql: Sql,
  storage: ResolvedStorage,
  graceDays: number,
  report: MaintenanceReport,
): Promise<number> {
  const failed = new Set<string>();

  // ─── 放弃的上传 ─────────────────────────────────────────
  for (;;) {
    const rows = await sql<(MediaRow & { upload_id: string | null })[]>`
      SELECT id, variant, family_id, object_key, upload_id FROM media
      WHERE status = 'pending' AND storage_config_id IS NULL
        AND reserved_at < now() - interval '1 hour' * ${ABANDONED_HOURS}
      ORDER BY reserved_at LIMIT ${BATCH + failed.size}`;
    const todo = rows.filter((r) => !failed.has(`${r.id}/${r.variant}`));
    if (todo.length === 0) break;
    for (const row of todo) {
      try {
        // 拿着行锁删对象：这时重新申请链接要排队，不会刚拿到链接文件就被删掉。
        await sql.begin(async (tx) => {
          const [locked] = await tx`
            SELECT 1 AS ok FROM media
            WHERE id = ${row.id} AND variant = ${row.variant} AND status = 'pending'
              AND reserved_at < now() - interval '1 hour' * ${ABANDONED_HOURS}
            FOR UPDATE SKIP LOCKED`;
          if (!locked) return;
          if (row.upload_id) {
            // 中止失败不能挡住这条记录的清理：转进待删除队列慢慢重试，那边有退避。
            await abortMultipart(storage, row.object_key, row.upload_id).catch(async () => {
              await tx`
                INSERT INTO pending_object_deletions (id, object_key, upload_id, next_attempt_at)
                VALUES (gen_random_uuid(), ${row.object_key}, ${row.upload_id}, now() + interval '1 hour')`;
            });
          }
          await deleteObject(storage, row.object_key);
          await tx`DELETE FROM media WHERE id = ${row.id} AND variant = ${row.variant}`;
          report.pendingRemoved += 1;
        });
      } catch {
        failed.add(`${row.id}/${row.variant}`);
      }
    }
  }

  // ─── 已删除和没有引用的文件 ───────────────────────────────
  const families = await sql<{ family_id: string }[]>`
    SELECT DISTINCT family_id FROM media
    WHERE status = 'ready' AND storage_config_id IS NULL AND (
      unreferenced_at < now() - interval '1 day' * ${graceDays}
      OR (unreferenced_at IS NULL AND NOT attached
          AND created_at < now() - interval '1 day' * ${UNATTACHED_DAYS}))`;
  for (const { family_id: familyId } of families) {
    for (;;) {
      const progress = await sql.begin(async (tx) => {
        // 和同步用同一把锁：核对引用之后、删除之前，不会有新的记录引用这个文件。
        await tx`SELECT 1 FROM families WHERE id = ${familyId} FOR UPDATE`;
        const rows = await tx<(MediaRow & { unreferenced_at: Date | null })[]>`
          SELECT id, variant, family_id, object_key, unreferenced_at FROM media
          WHERE family_id = ${familyId} AND status = 'ready' AND storage_config_id IS NULL AND (
            unreferenced_at < now() - interval '1 day' * ${graceDays}
            OR (unreferenced_at IS NULL AND NOT attached
                AND created_at < now() - interval '1 day' * ${UNATTACHED_DAYS}))
          LIMIT ${BATCH + failed.size}`;
        const todo = rows.filter((r) => !failed.has(`${r.id}/${r.variant}`));
        if (todo.length === 0) return 0;
        // 不信任标记，以记录为准：这是“还在用的文件绝不删除”的最后一道保证。
        const live = await liveReferences(tx, familyId);
        for (const row of todo) {
          if (live.has(row.id)) {
            await tx`UPDATE media SET attached = true, unreferenced_at = NULL
                     WHERE id = ${row.id} AND variant = ${row.variant}`;
            if (row.unreferenced_at) report.rescued += 1;
            continue;
          }
          try {
            // 先删对象再删记录。中途崩溃时记录还在，下次重试，DELETE 对不存在的对象也成功。
            await deleteObject(storage, row.object_key);
          } catch {
            failed.add(`${row.id}/${row.variant}`);
            continue;
          }
          await tx`DELETE FROM media WHERE id = ${row.id} AND variant = ${row.variant}`;
          if (row.unreferenced_at) report.trashPurged += 1;
          else report.unattachedPurged += 1;
        }
        return todo.length;
      });
      if (progress === 0) break;
    }
  }

  return failed.size;
}
