import type { Config } from './config';
import type { Sql } from './db';
import { liveReferences } from './quota';
import { assertEndpointAllowed, deleteObject, type ResolvedStorage, storageById } from './storage';

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
}

interface MediaRow {
  id: string;
  variant: string;
  family_id: string;
  object_key: string;
  storage_config_id: string | null;
}

/**
 * 定时任务调用（`cli maintenance`）。可以重复执行，中途失败下次接着来。
 *
 * 只处理这个项目自己知道的对象（media 表里有记录的），不列举 Bucket。
 * 账号删除有自己的待删除队列（pending_object_deletions），将来可以合并。
 */
export async function runMaintenance(sql: Sql, config: Config): Promise<MaintenanceReport> {
  const report: MaintenanceReport = {
    pendingRemoved: 0,
    trashPurged: 0,
    unattachedPurged: 0,
    rescued: 0,
    failed: 0,
    rateLimitsRemoved: 0,
  };
  const failed = new Set<string>();

  // 必须在事务外解析：连接池可能只有 1 个连接，事务里再用 sql 会死锁。
  const storages = new Map<string, ResolvedStorage | null>();
  async function resolve(familyId: string, configId: string | null) {
    const key = configId ?? 'env';
    if (storages.has(key)) return storages.get(key) ?? null;
    let storage: ResolvedStorage | null = null;
    try {
      storage = await storageById(sql, config, familyId, configId);
      // 自定义地址可能在保存之后改为解析到内网，连接前再查一次。
      if (storage?.configId && storage.endpoint) {
        await assertEndpointAllowed(storage.endpoint, config);
      }
    } catch {
      storage = null;
    }
    storages.set(key, storage);
    return storage;
  }

  // ─── 放弃的上传 ─────────────────────────────────────────
  for (;;) {
    const rows = await sql<MediaRow[]>`
      SELECT id, variant, family_id, object_key, storage_config_id FROM media
      WHERE status = 'pending' AND reserved_at < now() - interval '1 hour' * ${ABANDONED_HOURS}
      ORDER BY reserved_at LIMIT ${BATCH + failed.size}`;
    const todo = rows.filter((r) => !failed.has(`${r.id}/${r.variant}`));
    if (todo.length === 0) break;
    for (const row of todo) {
      const storage = await resolve(row.family_id, row.storage_config_id);
      try {
        if (!storage) throw new Error('存储不可用');
        // 拿着行锁删对象：这时重新申请链接要排队，不会刚拿到链接文件就被删掉。
        await sql.begin(async (tx) => {
          const [locked] = await tx`
            SELECT 1 AS ok FROM media
            WHERE id = ${row.id} AND variant = ${row.variant} AND status = 'pending'
              AND reserved_at < now() - interval '1 hour' * ${ABANDONED_HOURS}
            FOR UPDATE SKIP LOCKED`;
          if (!locked) return;
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
  const graceDays = config.mediaTrashDays;
  const families = await sql<{ family_id: string }[]>`
    SELECT DISTINCT family_id FROM media
    WHERE status = 'ready' AND (
      unreferenced_at < now() - interval '1 day' * ${graceDays}
      OR (unreferenced_at IS NULL AND NOT attached
          AND created_at < now() - interval '1 day' * ${UNATTACHED_DAYS}))`;
  for (const { family_id: familyId } of families) {
    const configs = await sql<{ storage_config_id: string | null }[]>`
      SELECT DISTINCT storage_config_id FROM media WHERE family_id = ${familyId}`;
    for (const { storage_config_id: configId } of configs) await resolve(familyId, configId);

    for (;;) {
      const progress = await sql.begin(async (tx) => {
        // 和同步用同一把锁：核对引用之后、删除之前，不会有新的记录引用这个文件。
        await tx`SELECT 1 FROM families WHERE id = ${familyId} FOR UPDATE`;
        const rows = await tx<(MediaRow & { unreferenced_at: Date | null })[]>`
          SELECT id, variant, family_id, object_key, storage_config_id, unreferenced_at FROM media
          WHERE family_id = ${familyId} AND status = 'ready' AND (
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
          const storage = storages.get(row.storage_config_id ?? 'env');
          try {
            if (!storage) throw new Error('存储不可用');
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

  report.failed = failed.size;
  const removed = await sql`DELETE FROM rate_limits WHERE reset_at < now()`;
  report.rateLimitsRemoved = removed.count;
  return report;
}
