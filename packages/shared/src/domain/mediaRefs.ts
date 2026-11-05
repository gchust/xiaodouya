import type { Collection, MediaRef, MediaScope } from '../schemas';

/**
 * 证件缩略图的长边。资料页不在证件夹的指纹锁后面，详情页的证件号也默认打码，
 * 缩略图要小到认得出是哪张证件，却看不清号码：一张贴满画面的身份证（85.6 mm 宽），
 * 号码在 256 px 里约 8 px 高，再经过 JPEG 压缩和卡片里的放大，已经很难辨认；A4 和护照页上的小字只有两三个像素。
 */
export const DOCUMENT_THUMB_MAX_SIDE = 256;

/**
 * 缩略图怎么生成：maxSide 是解码时限制的长边（比它小的不放大），width 是再缩放到的宽度。
 * 回忆和头像的缩略图要在时间线上铺满一行，证件的只放在卡片上，而且不能看清小字。
 */
export function thumbnailSize(scope: MediaScope): { maxSide: number; width?: number } {
  if (scope === 'document') return { maxSide: DOCUMENT_THUMB_MAX_SIDE };
  return { maxSide: 1440, width: 720 };
}

/**
 * 证件卡片上显示什么：第一张有缩略图的照片，没有就是第一个文件的类型标记。
 * 没有缩略图的照片不退回原图：原图是证件的全尺寸照片，不该为了卡片上的一小块下载到手机上。
 */
export function documentCover(
  files: readonly MediaRef[],
): { kind: 'thumb' | 'badge'; media: MediaRef } | null {
  const photo = files.find((f) => f.kind === 'image' && f.hasThumb === true);
  if (photo) return { kind: 'thumb', media: photo };
  const first = files[0];
  return first ? { kind: 'badge', media: first } : null;
}

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

/** 回忆里能当封面、能全屏翻看的文件：照片和视频，顺序和记录里一样。 */
export function visualMedia(media: readonly MediaRef[]): MediaRef[] {
  return media.filter((m) => m.kind === 'image' || m.kind === 'video');
}

/**
 * 时间线上这条回忆的封面。`index` 是它在照片和视频里的位置，全屏查看从这一张开始。
 * 设置的封面被移除了、找不到或者不是照片和视频时，回到第一个：封面只是显示偏好，不能让回忆没有图。
 */
export function momentCover(
  media: readonly MediaRef[],
  coverMediaId?: string,
): { media: MediaRef; index: number; count: number } | null {
  const visual = visualMedia(media);
  const chosen = coverMediaId ? visual.findIndex((m) => m.id === coverMediaId) : -1;
  const index = Math.max(0, chosen);
  const cover = visual[index];
  return cover ? { media: cover, index, count: visual.length } : null;
}
