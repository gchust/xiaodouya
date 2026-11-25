import type { BlobStore } from './blobs';
import type { Db } from './db';
import { ORPHAN_DELAY_MS } from './s3';

/**
 * 定时任务（每分钟一次）。Workers 免费版每次运行最多 50 个子请求、50 次 D1 查询，所以每轮只做一小份：
 * 合并最多 `appends` 段（每段读一块、写一段，两个子请求），删最多 `deletes` 个块。剩下的下一轮接着做。
 */
export interface MaintenanceLimits {
  appends: number;
  deletes: number;
}

export const FREE_PLAN_LIMITS: MaintenanceLimits = { appends: 15, deletes: 10 };

/** 放弃的分片上传多久后清掉。服务端 24 小时就会中止，这里是兜底，和存储的生命周期规则一样。 */
const STALE_UPLOAD_MS = 7 * 24 * 3600 * 1000;

export interface MaintenanceReport {
  deleted: number;
  deleteFailures: number;
  appended: number;
  compacted: number;
  staleUploads: number;
}

export async function runMaintenance(
  deps: { db: Db; blobs: BlobStore; now(): number },
  limits: MaintenanceLimits = FREE_PLAN_LIMITS,
): Promise<MaintenanceReport> {
  const report: MaintenanceReport = {
    deleted: 0,
    deleteFailures: 0,
    appended: 0,
    compacted: 0,
    staleUploads: 0,
  };
  await abortStaleUploads(deps, report);
  await compact(deps, limits.appends, report);
  await deleteOrphans(deps, limits.deletes, report);
  return report;
}

async function abortStaleUploads(deps: { db: Db; now(): number }, report: MaintenanceReport) {
  const { db } = deps;
  const now = deps.now();
  const cutoff = now - STALE_UPLOAD_MS;
  const { results } = await db
    .prepare('SELECT upload_id FROM uploads WHERE created_at < ? LIMIT 20')
    .bind(cutoff)
    .all<{ upload_id: string }>();
  if (results.length === 0) return;
  await db.batch(
    results.flatMap(({ upload_id }) => [
      db
        .prepare(
          'INSERT OR IGNORE INTO orphans (blob_id, delete_after) SELECT blob_id, ? FROM parts WHERE upload_id = ?',
        )
        .bind(now + ORPHAN_DELAY_MS, upload_id),
      db.prepare('DELETE FROM parts WHERE upload_id = ?').bind(upload_id),
      db.prepare('DELETE FROM uploads WHERE upload_id = ?').bind(upload_id),
    ]),
  );
  report.staleUploads += results.length;
}

async function deleteOrphans(
  deps: { db: Db; blobs: BlobStore; now(): number },
  limit: number,
  report: MaintenanceReport,
) {
  const { db, blobs } = deps;
  const now = deps.now();
  // 还被引用的不删：哪里写错了也只是多占一点空间，不会丢文件。
  const { results } = await db
    .prepare(
      `SELECT o.blob_id,
              EXISTS (SELECT 1 FROM chunks c WHERE c.blob_id = o.blob_id)
                OR EXISTS (SELECT 1 FROM parts p WHERE p.blob_id = o.blob_id) AS referenced
       FROM orphans o WHERE o.delete_after <= ? ORDER BY o.delete_after LIMIT ?`,
    )
    .bind(now, limit)
    .all<{ blob_id: string; referenced: number }>();
  if (results.length === 0) return;
  const done: string[] = [];
  const failed: string[] = [];
  for (const row of results) {
    if (row.referenced) {
      done.push(row.blob_id);
      continue;
    }
    try {
      await blobs.delete(row.blob_id);
      done.push(row.blob_id);
      report.deleted++;
    } catch {
      failed.push(row.blob_id);
      report.deleteFailures++;
    }
  }
  await db.batch([
    ...done.map((id) => db.prepare('DELETE FROM orphans WHERE blob_id = ?').bind(id)),
    // 失败的一小时后再试，次数越多等得越久，不挡住后面的。
    ...failed.map((id) =>
      db
        .prepare(
          'UPDATE orphans SET attempts = attempts + 1, delete_after = ? + 3600000 * (attempts + 1) WHERE blob_id = ?',
        )
        .bind(now, id),
    ),
  ]);
}

interface CompactionRow {
  key: string;
  etag: string;
  session: string | null;
}

/**
 * 把分片上传留下的多块合成一块。合并前下载一个 1 GB 的视频要读 128 个 Drive 文件，
 * 超过免费版的子请求上限；合并后只读一个。内容不变，ETag 也不变。
 */
async function compact(
  deps: { db: Db; blobs: BlobStore; now(): number },
  budget: number,
  report: MaintenanceReport,
) {
  const { db, blobs } = deps;
  let remaining = budget;
  while (remaining > 0) {
    const job = await db
      .prepare('SELECT key, etag, session FROM compactions ORDER BY updated_at LIMIT 1')
      .first<CompactionRow>();
    if (!job) return;
    const object = await db
      .prepare('SELECT size, etag FROM objects WHERE key = ?')
      .bind(job.key)
      .first<{ size: number; etag: string }>();
    if (!object || object.etag !== job.etag) {
      await db.prepare('DELETE FROM compactions WHERE key = ?').bind(job.key).run();
      continue;
    }
    const { results: chunks } = await db
      .prepare('SELECT blob_id, size FROM chunks WHERE key = ? ORDER BY idx')
      .bind(job.key)
      .all<{ blob_id: string; size: number }>();
    if (chunks.length <= 1) {
      await db.prepare('DELETE FROM compactions WHERE key = ?').bind(job.key).run();
      continue;
    }
    const total = object.size;
    let session = job.session;
    let offset = session ? await blobs.sessionOffset(session, total) : null;
    if (session === null || offset === null) {
      session = await blobs.startSession(total);
      offset = 0;
      remaining--;
    }
    await db
      .prepare('UPDATE compactions SET session = ?, updated_at = ? WHERE key = ?')
      .bind(session, deps.now(), job.key)
      .run();

    let newId: string | null = null;
    let start = 0;
    for (const chunk of chunks) {
      const end = start + chunk.size;
      if (offset < end && remaining >= 2) {
        const from = offset - start;
        const size = chunk.size - from;
        const body = await blobs.get(chunk.blob_id, from, chunk.size - 1);
        newId = await blobs.append(session, body, offset, size, total);
        offset += size;
        remaining -= 2;
        report.appended++;
      }
      start = end;
    }
    if (newId === null) return;
    await commitCompaction(deps, job, newId);
    report.compacted++;
  }
}

async function commitCompaction(
  deps: { db: Db; now(): number },
  job: CompactionRow,
  newId: string,
) {
  const { db } = deps;
  const now = deps.now();
  // 只有对象还是合并开始时那一份才替换：合并期间它可能被覆盖或删除了。
  const unchanged = 'EXISTS (SELECT 1 FROM objects WHERE key = ? AND etag = ?)';
  await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO orphans (blob_id, delete_after) SELECT blob_id, ? FROM chunks WHERE key = ? AND ${unchanged}`,
      )
      .bind(now + ORPHAN_DELAY_MS, job.key, job.key, job.etag),
    db
      .prepare(`DELETE FROM chunks WHERE key = ? AND ${unchanged}`)
      .bind(job.key, job.key, job.etag),
    db
      .prepare(
        `INSERT INTO chunks (key, idx, blob_id, size) SELECT ?, 0, ?, size FROM objects WHERE key = ? AND etag = ?`,
      )
      .bind(job.key, newId, job.key, job.etag),
    db.prepare('DELETE FROM compactions WHERE key = ?').bind(job.key),
  ]);
  const kept = await db
    .prepare('SELECT 1 AS ok FROM chunks WHERE key = ? AND blob_id = ?')
    .bind(job.key, newId)
    .first<{ ok: number }>();
  if (!kept) {
    await db
      .prepare('INSERT OR IGNORE INTO orphans (blob_id, delete_after) VALUES (?, ?)')
      .bind(newId, now + ORPHAN_DELAY_MS)
      .run();
  }
}
