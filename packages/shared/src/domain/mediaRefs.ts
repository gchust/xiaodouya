import type { Collection, MediaRef } from '../schemas';

/**
 * 记录里的文件引用只有这三处：回忆的 media、证件的 files、宝宝的头像。
 * 取消上传时要把引用拿掉，否则别的设备上会一直是个打不开的占位。
 */
export function mediaRefsIn(collection: Collection, data: unknown): MediaRef[] {
  const d = data as { media?: MediaRef[]; files?: MediaRef[]; avatar?: MediaRef };
  if (collection === 'moment') return d.media ?? [];
  if (collection === 'document') return d.files ?? [];
  if (collection === 'baby') return d.avatar ? [d.avatar] : [];
  return [];
}

/**
 * 去掉这些文件的引用，其余内容原样保留，包括当前版本不认识的字段（新版本写的）。
 * 没有变化时返回 null，调用方就不用写一次记录。
 */
export function withoutMedia<D>(
  collection: Collection,
  data: D,
  ids: ReadonlySet<string>,
): D | null {
  if (!mediaRefsIn(collection, data).some((ref) => ids.has(ref.id))) return null;
  const record = data as Record<string, unknown>;
  if (collection === 'moment') {
    const media = (record.media as MediaRef[]).filter((ref) => !ids.has(ref.id));
    return { ...record, media } as D;
  }
  if (collection === 'document') {
    const files = (record.files as MediaRef[]).filter((ref) => !ids.has(ref.id));
    return { ...record, files } as D;
  }
  const { avatar: _avatar, ...rest } = record;
  return rest as D;
}
