import { type Collection, type CollectionData, mediaRefsIn, withoutMedia } from '@xiaodouya/shared';
import type { Entry, Snapshot } from './store';
import type { UploadQueue } from './uploadQueue';

/**
 * 上传队列是全家的，不分宝宝（issue #106）：回忆、证件按全部宝宝的算，头像是每个宝宝的。
 * 只按当前宝宝查的话，另一个宝宝的文件会被当成“记录已经删了”。
 */
export interface UploadRecords {
  moments: Snapshot['moments'];
  documents: Snapshot['documents'];
  babies: readonly Entry<'baby'>[];
}

export function uploadRecordsOf(snapshot: Snapshot): UploadRecords {
  return {
    moments: snapshot.all.moments,
    documents: snapshot.all.documents,
    babies: snapshot.babies,
  };
}

type OwnedEntry = { collection: Collection; id: string; data: unknown };

function entries(records: UploadRecords): OwnedEntry[] {
  return [
    ...records.moments.map((m) => ({ collection: 'moment' as const, id: m.id, data: m.data })),
    ...records.documents.map((d) => ({ collection: 'document' as const, id: d.id, data: d.data })),
    ...records.babies.map((b) => ({ collection: 'baby' as const, id: b.id, data: b.data })),
  ];
}

export type UploadOwner =
  | { kind: 'moment'; title: string; at: number }
  | { kind: 'document'; title: string }
  | { kind: 'avatar' };

/**
 * 这个文件属于哪条记录。任务里不记记录 id：入队发生在写记录之前，升级前的任务也没有，
 * 而且记录在上传途中可能被改，所以每次按文件 id 从记录反查。查不到（比如记录已经删了）返回 null。
 */
export function uploadOwners(records: UploadRecords): Map<string, UploadOwner> {
  const owners = new Map<string, UploadOwner>();
  for (const m of records.moments) {
    for (const ref of m.data.media) {
      owners.set(ref.id, { kind: 'moment', title: m.data.title, at: m.data.at });
    }
  }
  for (const d of records.documents) {
    for (const ref of d.data.files) owners.set(ref.id, { kind: 'document', title: d.data.name });
  }
  for (const baby of records.babies) {
    const avatar = baby.data.avatar;
    if (avatar) owners.set(avatar.id, { kind: 'avatar' });
  }
  return owners;
}

/** 取消这些文件后，有多少条回忆会变成既没文字也没文件。确认时要说清楚，它们不会被删掉。 */
export function momentsLeftEmpty(records: UploadRecords, ids: ReadonlySet<string>): number {
  return records.moments.filter((m) => {
    const next = withoutMedia('moment', m.data, ids);
    return next !== null && next.media.length === 0 && !m.data.text.trim() && !m.data.title.trim();
  }).length;
}

/**
 * 取消上传。这是用户明确要求的删除：文件的引用从记录里去掉（走正常的同步告诉家人，否则别的设备上
 * 一直是个打不开的占位），本地副本和任务一起清掉。回忆的文字和其他文件都保留；只剩空壳的回忆也不删，
 * 因为时间、标记（比如里程碑）还在，用户自己决定要不要留。
 *
 * 先写记录再取消任务：中途被杀的话，最多是一个没人引用的文件传了上去，由服务端的清理收走；
 * 反过来就会留下一个永远打不开的占位。一条记录只写一次，一条回忆可能有 100 个文件。
 */
export async function cancelUploads(
  ids: readonly string[],
  deps: {
    records: UploadRecords;
    write: <C extends Collection>(
      collection: C,
      data: CollectionData[C],
      id: string,
    ) => Promise<unknown>;
    queue: Pick<UploadQueue, 'cancel'>;
  },
): Promise<void> {
  const wanted = new Set(ids);
  for (const entry of entries(deps.records)) {
    if (!mediaRefsIn(entry.collection, entry.data).some((ref) => wanted.has(ref.id))) continue;
    const next = withoutMedia(entry.collection, entry.data, wanted);
    if (next !== null) {
      await deps.write(entry.collection, next as CollectionData[typeof entry.collection], entry.id);
    }
  }
  await deps.queue.cancel(ids);
}
