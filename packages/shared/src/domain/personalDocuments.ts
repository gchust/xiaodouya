import { z } from 'zod';
import type { DocumentData, FamilyMember, MediaScope, Role } from '../schemas';

/**
 * 家人自己的证件夹（F-137，issue #89）。
 *
 * 宝宝的证件全家共用（只看回忆的家人除外）。家人自己的证件也放在 `document` 集合，多两个字段：
 * `owner` 是本人的账号 id，`sharedWith` 是本人选的、能看的家人。只有本人能改、能删、能改谁能看。
 * 服务端按这两个字段决定同步时发给谁，规则都在这里，服务端和 App 用同一份。见 docs/ARCHITECTURE.md 的“家人自己的证件”。
 */

export type DocumentKind = 'family' | 'mine' | 'shared';

/** 这份证件对当前账号来说是哪一种：宝宝的（全家的）、自己的、别的家人给我看的。 */
export function documentKind(
  data: Pick<DocumentData, 'owner'>,
  userId: string | null,
): DocumentKind {
  if (!data.owner) return 'family';
  return data.owner === userId ? 'mine' : 'shared';
}

/** 只有宝宝的证件全家能改；家人自己的证件只有本人能改。 */
export function canEditDocument(data: Pick<DocumentData, 'owner'>, userId: string | null): boolean {
  return documentKind(data, userId) !== 'shared';
}

/**
 * 从客户端发来的原始数据里读 `owner`，不经过集合的校验：删除时服务端不校验内容，
 * 可是删掉的私人证件同样不能当成全家的发给别人。
 * 字段不存在是宝宝的证件；存在但不是 UUID 一律不收，不能猜。
 */
export function rawDocumentOwner(
  data: unknown,
): { ok: true; owner: string | null } | { ok: false } {
  if (data === null || typeof data !== 'object' || !('owner' in data)) {
    return { ok: true, owner: null };
  }
  const owner = (data as { owner: unknown }).owner;
  if (owner === undefined) return { ok: true, owner: null };
  const parsed = z.uuid().safeParse(owner);
  return parsed.success ? { ok: true, owner: parsed.data } : { ok: false };
}

/**
 * 能不能写这条证件。`existingOwner` 为 undefined 表示服务端还没有这条记录。
 * - 新建：`owner` 只能写自己，不能替别人建。
 * - 宝宝的证件不能变成谁的私人证件，否则一位家人就能把全家的证件藏起来。
 * - 私人证件只有本人能写（包括删除），`owner` 不能改也不能去掉：去掉就成了全家的。
 */
export function canWriteDocument(
  existingOwner: string | null | undefined,
  incomingOwner: string | null,
  userId: string,
): boolean {
  if (existingOwner === undefined) return incomingOwner === null || incomingOwner === userId;
  if (existingOwner === null) return incomingOwner === null;
  return existingOwner === userId && incomingOwner === existingOwner;
}

export interface OwnedRecord {
  ownerId: string | null;
  readers: readonly string[] | null;
  deleted: boolean;
}

/**
 * 这位家人能不能看到这条私人证件的内容。调用前已经按角色筛过集合（只看回忆的家人读不到证件）。
 * - 本人永远能看自己的，删掉的也能（撤销要用）。
 * - 别人要在 `sharedWith` 里，记录没删，并且本人现在还是这个家庭的成员：被移出家庭的人的证件谁都看不到。
 */
export function canSeeOwnedRecord(
  record: OwnedRecord,
  viewer: { userId: string; role: Role },
  ownerIsMember: boolean,
): boolean {
  if (!record.ownerId) return true;
  if (viewer.role === 'viewer') return false;
  if (record.ownerId === viewer.userId) return true;
  if (record.deleted || !ownerIsMember) return false;
  return (record.readers ?? []).includes(viewer.userId);
}

/**
 * 私人证件里的文件能不能取链接。以文件为准，再看现在引用它的私人证件：
 * - `personal` 的文件属于上传它的人（`ownerId`）。本人能取；别人要能看到一条“同一个人的、引用了这个文件的”证件。
 *   要求同一个人：否则看过 A 证件的 B 把文件 id 写进自己的证件再分享给 C，C 就拿到了 A 的文件。
 * - `document` 的文件本来是宝宝的。可是旧版 App 往自己的私人证件里加文件时只会写 `document`，
 *   所以被上传者自己的私人证件引用了的，按私人证件处理。别人写进去的不算，不能借此让全家看不到宝宝的证件。
 */
export function canReadOwnedMedia(
  media: { scope: MediaScope; ownerId: string | null; uploadedBy: string | null },
  referencedBy: readonly (OwnedRecord & { ownerIsMember: boolean })[],
  viewer: { userId: string; role: Role },
): boolean {
  if (viewer.role === 'viewer') return false;
  if (media.scope === 'personal') {
    if (!media.ownerId) return false;
    if (media.ownerId === viewer.userId) return true;
    return referencedBy.some(
      (r) => r.ownerId === media.ownerId && canSeeOwnedRecord(r, viewer, r.ownerIsMember),
    );
  }
  if (media.scope !== 'document') return true;
  const governing = referencedBy.filter((r) => r.ownerId && r.ownerId === media.uploadedBy);
  if (governing.length === 0) return true;
  return governing.some((r) => canSeeOwnedRecord(r, viewer, r.ownerIsMember));
}

/** “谁能看”里能选的家人：不含自己，也不含只看回忆的家人（他们读不到证件，选了也没用）。 */
export function documentReaderChoices(
  members: readonly FamilyMember[],
  userId: string | null,
): FamilyMember[] {
  return members.filter((m) => m.userId !== userId && m.role !== 'viewer');
}

/**
 * 现在真的能看的家人。`sharedWith` 里可能还留着已经离开家庭、或者改成只看回忆的人，
 * 他们看不到，界面上也不该写他们能看。
 */
export function effectiveReaders(
  data: Pick<DocumentData, 'sharedWith'>,
  members: readonly FamilyMember[],
  userId: string | null,
): FamilyMember[] {
  const ids = new Set(data.sharedWith ?? []);
  return documentReaderChoices(members, userId).filter((m) => ids.has(m.userId));
}
