/**
 * 家人自己的证件夹（F-137）在服务端的部分。规则在 shared 的 personalDocuments.ts，这里只管查库。
 *
 * 私人证件和宝宝的证件在同一个 `document` 集合、同一条 seq 上。同步时看不到的人收到一个删除标记
 * （没有内容、没有创建者），不是直接跳过：
 * - 游标照常往前走，不需要按人维护 seq，也就不会因为过滤漏掉后面的记录；
 * - 本人撤销某人、删掉证件、离开家庭、删除账号时，对方手机上缓存的那份能被删掉；
 * - v0.7.0 及以前的 App 不认识 owner，它收到的删除标记和普通的删除一样处理。
 * 能看的范围变了（选人、撤销、离开、回来）都要给这些记录分配新的 seq，否则游标已经走过的人收不到变化。
 */
import { Buffer } from 'node:buffer';
import {
  canReadOwnedMedia,
  canSeeOwnedRecord,
  type MediaScope,
  type Role,
  type ServerRecord,
} from '@xiaodouya/shared';
import type { Sql, Tx } from './db';
import { uuidsIn } from './quota';

export interface OwnedRecordRow {
  id: string;
  collection: ServerRecord['collection'];
  data: unknown;
  deleted: boolean;
  updated_at_client: string;
  seq: string;
  created_by: string | null;
  owner_id: string | null;
  readers: string[] | null;
}

export interface Viewer {
  userId: string;
  role: Role;
}

/** 这个家庭现在的成员。私人证件只有本人还在家庭里时才给别人看。 */
export async function memberIds(db: Sql | Tx, familyId: string): Promise<Set<string>> {
  const rows = await db<{ user_id: string }[]>`
    SELECT user_id FROM memberships WHERE family_id = ${familyId}`;
  return new Set(rows.map((r) => r.user_id));
}

/** 看不到内容的人收到的样子：只有 id、集合、版本和 seq。 */
function stub(row: OwnedRecordRow): ServerRecord {
  return {
    id: row.id,
    collection: row.collection,
    data: null,
    deleted: true,
    updatedAt: Number(row.updated_at_client),
    seq: Number(row.seq),
    createdBy: null,
  };
}

/** 调用前已经按角色筛过集合。 */
export async function projectForViewer(
  db: Sql,
  familyId: string,
  viewer: Viewer,
  rows: readonly OwnedRecordRow[],
): Promise<ServerRecord[]> {
  const members = rows.some((r) => r.owner_id && r.owner_id !== viewer.userId)
    ? await memberIds(db, familyId)
    : new Set<string>();
  return rows.map((row) => {
    const visible = canSeeOwnedRecord(
      { ownerId: row.owner_id, readers: row.readers, deleted: row.deleted },
      viewer,
      row.owner_id ? members.has(row.owner_id) : true,
    );
    if (!visible) return stub(row);
    return {
      id: row.id,
      collection: row.collection,
      data: row.data,
      deleted: row.deleted,
      updatedAt: Number(row.updated_at_client),
      seq: Number(row.seq),
      createdBy: row.created_by,
    };
  });
}

/** 导出不需要删除标记：看不到的直接不导出。 */
export async function visibleForExport(
  db: Sql,
  familyId: string,
  viewer: Viewer,
  rows: readonly OwnedRecordRow[],
): Promise<OwnedRecordRow[]> {
  const members = await memberIds(db, familyId);
  return rows.filter((row) =>
    canSeeOwnedRecord(
      { ownerId: row.owner_id, readers: row.readers, deleted: row.deleted },
      viewer,
      row.owner_id ? members.has(row.owner_id) : true,
    ),
  );
}

export interface MediaAccessRow {
  id: string;
  scope: MediaScope;
  owner_id: string | null;
  uploaded_by: string | null;
}

/**
 * 证件类文件里，这位家人能取哪些。回忆和头像不经过这里。
 * 一个家庭的私人证件不多（每人几份到几十份），一次全取出来在内存里找引用，和同步写入时找引用一样按文本算。
 */
export async function readableOwnedMedia(
  db: Sql,
  familyId: string,
  viewer: Viewer,
  media: readonly MediaAccessRow[],
): Promise<Set<string>> {
  const allowed = new Set<string>();
  const relevant = media.filter((m) => m.scope === 'personal' || m.scope === 'document');
  if (relevant.length === 0) return allowed;
  const owned = await db<
    { owner_id: string; readers: string[] | null; deleted: boolean; data: unknown }[]
  >`SELECT owner_id, readers, deleted, data FROM records
    WHERE family_id = ${familyId} AND owner_id IS NOT NULL`;
  const members = await memberIds(db, familyId);
  const refs = owned.map((r) => ({
    ownerId: r.owner_id,
    readers: r.readers,
    deleted: r.deleted,
    ownerIsMember: members.has(r.owner_id),
    ids: new Set(uuidsIn(JSON.stringify(r.data))),
  }));
  for (const m of relevant) {
    const referencedBy = refs.filter((r) => r.ids.has(m.id.toLowerCase()));
    if (
      canReadOwnedMedia(
        { scope: m.scope, ownerId: m.owner_id, uploadedBy: m.uploaded_by },
        referencedBy,
        viewer,
      )
    ) {
      allowed.add(m.id);
    }
  }
  return allowed;
}

/**
 * 给这个人的私人证件分配新的 seq，让家人的手机重新收到一次（看得到的收到内容，看不到的收到删除标记）。
 * 必须在持有家庭行锁的事务里调用，和同步写入一样。
 */
export async function resequenceOwned(tx: Tx, familyId: string, ownerId: string): Promise<void> {
  const rows = await tx<{ id: string }[]>`
    SELECT id FROM records WHERE family_id = ${familyId} AND owner_id = ${ownerId}::uuid
    ORDER BY seq`;
  for (const row of rows) {
    const [{ seq } = { seq: '0' }] = await tx<{ seq: string }[]>`
      UPDATE families SET seq = seq + 1 WHERE id = ${familyId} RETURNING seq`;
    await tx`UPDATE records SET seq = ${seq} WHERE id = ${row.id}`;
  }
}

/**
 * 删除账号时立即删掉这个人的私人证件（AGENTS.md 第 1 节：只属于这个账号的数据立即删除），不管他现在在不在那个家庭。
 * 记录留一个没有内容的删除标记并分配新的 seq：家人手机上缓存的那份要靠它删掉。owner_id 留着，标记仍然只给本人看全。
 * 文件：personal 的、以及旧版 App 传成 document 却只被他自己的私人证件引用的，进待删除队列后删掉 media 行。
 * 要在删除 users 之前、同一个事务里调用。返回要删的文件 id，调用方用它们入队。
 */
export async function eraseOwnedDocuments(tx: Tx, userId: string): Promise<string[]> {
  const records = await tx<{ id: string; family_id: string; data: unknown }[]>`
    SELECT id, family_id, data FROM records WHERE owner_id = ${userId}::uuid ORDER BY family_id, seq`;
  const referenced = new Set<string>();
  for (const r of records) for (const id of uuidsIn(JSON.stringify(r.data))) referenced.add(id);
  const families = [...new Set(records.map((r) => r.family_id))];
  for (const familyId of families) {
    await tx`SELECT id FROM families WHERE id = ${familyId} FOR UPDATE`;
    for (const r of records.filter((x) => x.family_id === familyId)) {
      const before = Buffer.byteLength(JSON.stringify(r.data));
      const [{ seq } = { seq: '0' }] = await tx<{ seq: string }[]>`
        UPDATE families SET seq = seq + 1, record_bytes = GREATEST(0, record_bytes - ${before} + 2)
        WHERE id = ${familyId} RETURNING seq`;
      await tx`UPDATE records SET data = '{}'::jsonb, deleted = true, readers = NULL, seq = ${seq},
                 updated_at_client = GREATEST(updated_at_client + 1, ${Date.now()})
               WHERE id = ${r.id}`;
    }
  }
  const legacy = referenced.size
    ? await tx<{ id: string }[]>`
        SELECT DISTINCT m.id FROM media m
        WHERE m.scope = 'document' AND m.uploaded_by = ${userId}::uuid AND m.id = ANY(${[...referenced]}::uuid[])
          AND NOT EXISTS (
            SELECT 1 FROM records r
            WHERE r.family_id = m.family_id AND NOT r.deleted
              AND (r.owner_id IS NULL OR r.owner_id <> ${userId}::uuid)
              AND position(m.id::text IN lower(r.data::text)) > 0)`
    : [];
  const personal = await tx<{ id: string }[]>`
    SELECT DISTINCT id FROM media WHERE owner_id = ${userId}::uuid`;
  return [...new Set([...personal, ...legacy].map((r) => r.id))];
}
