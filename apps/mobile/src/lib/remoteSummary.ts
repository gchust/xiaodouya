import { describeEvent, EventData, type ServerRecord, t, type Units } from '@xiaodouya/shared';

interface Member {
  userId: string;
  label: string;
}

const atOf = (record: ServerRecord) => (record.data as { at?: number }).at ?? 0;

/**
 * event 集合里还放着配置（疫苗本），以后的版本也可能写入这个版本不认识的类型，
 * 它们不是一条记录，算进来会提示“记录了 undefined”。
 */
function isRecord(record: ServerRecord): boolean {
  if (record.collection === 'moment') return true;
  return record.collection === 'event' && EventData.safeParse(record.data).success;
}

/**
 * 家人的记录只在打开 App 时提示（不做远程推送），所以一次同步可能带回离开期间的很多条。
 * 不限时间：离开三天回来也要知道家人记了什么。第一次拉取的历史由 SyncEngine 排除。
 * 最近一条按发生时间算：补记的旧记录也可能最后才同步过来。
 */
export function summarizeRemote(
  records: readonly ServerRecord[],
  context: { selfId: string | undefined; members: readonly Member[]; units: Units; now: number },
): { initial: string; message: string } | null {
  const { selfId, members, units, now } = context;
  const relevant = records.filter((r) => !r.deleted && isRecord(r) && r.createdBy !== selfId);
  const authorOf = (record: ServerRecord) =>
    members.find((m) => m.userId === record.createdBy)?.label ??
    (record.data as { byName?: string }).byName ??
    t().ui.familyMember;
  const latest = relevant.reduce<ServerRecord | null>(
    (found, r) => (!found || atOf(r) >= atOf(found) ? r : found),
    null,
  );
  if (!latest) return null;
  const text =
    latest.collection === 'event'
      ? describeEvent(latest.data as EventData, now, units)
      : (latest.data as { title?: string }).title || t().ui.newMoment;
  const author = authorOf(latest);
  if (relevant.length === 1) {
    return { initial: author.slice(0, 1), message: t().ui.remoteOne(author, text) };
  }
  if (new Set(relevant.map(authorOf)).size === 1) {
    return {
      initial: author.slice(0, 1),
      message: t().ui.remoteMany(author, relevant.length, text),
    };
  }
  return {
    initial: t().ui.familyInitial,
    message: t().ui.remoteFamily(relevant.length, author, text),
  };
}
