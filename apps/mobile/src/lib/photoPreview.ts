import type { MediaKind, MediaRef, MediaScope } from '@xiaodouya/shared';
import type { UploadJob } from '../data/uploadQueue';

/** 长边。手机全屏放大两三倍还看得清，一张通常一两 MB。 */
export const PREVIEW_MAX_SIDE = 2048;
export const PREVIEW_QUALITY = 0.8;
/**
 * Android 画不了超过 100 MB 的位图（RecordingCanvas 直接抛错，App 闪退），2400 万像素是 96 MB。
 * 再大的原图只能按屏幕大小解码，放大时不会比预览清楚，下载到的文件还是完整的。
 */
const FULL_DECODE_MAX_PIXELS = 24_000_000;

/**
 * 只有回忆里的照片才做预览。证件要看清小字，也不值得多存一份副本；头像用不到这么大。
 * GIF 变成 JPEG 就不动了，而且通常不大，直接看原图。
 */
export function wantsPreview(file: { kind: MediaKind; mime: string }, scope: MediaScope): boolean {
  return file.kind === 'image' && scope === 'memory' && file.mime.toLowerCase() !== 'image/gif';
}

/** 原图能不能不缩小直接解码。尺寸是记录里写的，不知道时按最坏情况算。 */
export function canDecodeFull(media: Pick<Partial<MediaRef>, 'width' | 'height'>): boolean {
  if (!media.width || !media.height) return false;
  return media.width * media.height <= FULL_DECODE_MAX_PIXELS;
}

/**
 * 一个文件要传哪些变体，顺序就是想要的上传顺序（队列按 variantRank 再保证一次）。
 * 缩略图和预览不在这里生成：解码原图很慢也很占内存，交给队列一张一张做，不让用户等。
 */
export function mediaJobs(options: {
  id: string;
  file: { kind: MediaKind; mime: string; size: number; name?: string };
  scope: MediaScope;
  wifiOnly: boolean;
  uris: { original: string; thumb: string; preview: string };
}): Omit<UploadJob, 'key' | 'attempts'>[] {
  const { id, file, scope, wifiOnly, uris } = options;
  const jobs: Omit<UploadJob, 'key' | 'attempts'>[] = [];
  const generated = {
    id,
    scope,
    mime: 'image/jpeg',
    size: 0,
    wifiOnly: false,
    mediaKind: file.kind,
  };
  if (file.kind === 'image' || file.kind === 'video') {
    jobs.push({
      ...generated,
      variant: 'thumb',
      localUri: uris.thumb,
      thumbSource: { uri: uris.original, kind: file.kind },
    });
  }
  if (wantsPreview(file, scope)) {
    jobs.push({
      ...generated,
      variant: 'preview',
      localUri: uris.preview,
      thumbSource: { uri: uris.original, kind: 'image' },
    });
  }
  jobs.push({
    id,
    variant: 'original',
    scope,
    localUri: uris.original,
    mime: file.mime,
    size: file.size,
    filename: file.name,
    wifiOnly,
    mediaKind: file.kind,
  });
  return jobs;
}

export interface PhotoFacts {
  /** 服务端回答过了。离线或还没问到时什么都不知道，不能说“没传完”。 */
  answered: boolean;
  /** 本机有原图：上传队列的副本，或看过之后留在缓存里的。 */
  localOriginal: boolean;
  /** 本机或服务端有预览。 */
  preview: boolean;
  /** 服务端的原图传完了。 */
  original: boolean;
  wantOriginal: boolean;
  originalLoaded: boolean;
  originalFailed: boolean;
}

/**
 * - view：可以点，显示原图大小
 * - loading、shown、failed：点过之后的状态。failed 可以再点一次
 * - uploading：原图还没传完，不可用
 * - none：还不知道，不显示
 */
export type OriginalControl = 'view' | 'loading' | 'shown' | 'failed' | 'uploading' | 'none';

export interface PhotoPlan {
  /** 铺在下面的一层。thumb 表示只有缩略图能看。 */
  base: 'original' | 'preview' | 'thumb';
  /** 用户点了查看原图：盖在预览上加载，好了才看得出变化，加载中和失败时预览一直都在。 */
  overlayOriginal: boolean;
  control: OriginalControl;
}

export function photoPlan(facts: PhotoFacts): PhotoPlan {
  if (facts.localOriginal) return { base: 'original', overlayOriginal: false, control: 'shown' };
  if (!facts.answered) {
    return { base: facts.preview ? 'preview' : 'thumb', overlayOriginal: false, control: 'none' };
  }
  if (!facts.preview) {
    // 没有预览的旧照片，或者预览做失败了：原图传完了就看原图。
    return facts.original
      ? { base: 'original', overlayOriginal: false, control: 'shown' }
      : { base: 'thumb', overlayOriginal: false, control: 'uploading' };
  }
  if (!facts.original) return { base: 'preview', overlayOriginal: false, control: 'uploading' };
  if (!facts.wantOriginal) return { base: 'preview', overlayOriginal: false, control: 'view' };
  if (facts.originalFailed) return { base: 'preview', overlayOriginal: false, control: 'failed' };
  return {
    base: 'preview',
    overlayOriginal: true,
    control: facts.originalLoaded ? 'shown' : 'loading',
  };
}
