import type { MediaKind, MediaRef, MediaScope, MediaVariant } from '@xiaodouya/shared';
import { MULTIPART_PARALLEL, t, thumbnailSize } from '@xiaodouya/shared';
import * as Crypto from 'expo-crypto';
import * as DocumentPicker from 'expo-document-picker';
import { Directory, File, FileMode, Paths, UploadType } from 'expo-file-system';
import { Image } from 'expo-image';
import { ImageManipulator, type ImageRef, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import * as IntentLauncher from 'expo-intent-launcher';
import * as Sharing from 'expo-sharing';
import * as VideoThumbnails from 'expo-video-thumbnails';
import { Platform } from 'react-native';
import {
  kindFromMime,
  UploadHttpError,
  type UploadJob,
  type UploadPartTarget,
  type UploadQueue,
  type UploadTransport,
} from '../data/uploadQueue';
import { isPersonalCacheDirectory } from './accountLogic';
import { type Api, ApiFailure } from './api';
import { IS_E2E } from './config';
import { e2eBulkMoment, e2ePickFiles } from './e2eFixtures';
import { firstFound, importEach, isRecentPick, pickDurationMs } from './mediaUtils';
import { mediaJobs, PREVIEW_MAX_SIDE, PREVIEW_QUALITY } from './photoPreview';

export interface PickedFile {
  uri: string;
  kind: MediaKind;
  mime: string;
  size: number;
  name?: string;
  durationMs?: number;
  width?: number;
  height?: number;
  peaks?: number[];
}

/** 编辑时要把图解码进内存，手机原图可能有上亿像素，不限制的话旋转时会内存不足。头像用不到更高的清晰度。 */
const EDIT_MAX_SIDE = 3000;

function uploadsDir(): Directory {
  const dir = new Directory(Paths.document, 'uploads');
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  return dir;
}

function localFile(id: string, variant: MediaVariant): File {
  return new File(uploadsDir(), `${id}-${variant}`);
}

/** 上传中或刚选好的文件，优先从本地显示，不用等网络。 */
export function localUriFor(id: string, variant: MediaVariant): string | null {
  try {
    const file = localFile(id, variant);
    return file.exists ? file.uri : null;
  } catch {
    return null;
  }
}

/**
 * 本机已有的原图：上传队列的副本，或看过的原图留在 expo-image 磁盘缓存里的那份（缓存键见 useMediaSource）。
 * 大小对得上才算原件，缓存里可能是缩小过的。
 */
export async function localOriginalCopy(
  media: Pick<MediaRef, 'id' | 'kind' | 'size'>,
): Promise<string | null> {
  const pending = localUriFor(media.id, 'original');
  if (pending) return pending;
  if (media.kind !== 'image') return null;
  try {
    const path = await Image.getCachePathAsync(`${media.id}/original`);
    if (!path) return null;
    const file = new File(path.startsWith('file:') ? path : `file://${path}`);
    return file.exists && file.size === media.size ? file.uri : null;
  } catch {
    return null;
  }
}

function fileSize(uri: string, fallback?: number | null): number {
  try {
    return new File(uri).size ?? fallback ?? 0;
  } catch {
    return fallback ?? 0;
  }
}

function fromAsset(asset: ImagePicker.ImagePickerAsset): PickedFile {
  const mime = asset.mimeType ?? (asset.type === 'video' ? 'video/mp4' : 'image/jpeg');
  return {
    uri: asset.uri,
    kind: kindFromMime(mime),
    mime,
    size: fileSize(asset.uri, asset.fileSize),
    name: asset.fileName ?? undefined,
    durationMs: pickDurationMs(asset.duration),
    width: asset.width || undefined,
    height: asset.height || undefined,
  };
}

function pendingPickMarker(): File {
  return new File(Paths.document, 'pending-moment-pick');
}

/**
 * 系统照片选择器：不需要相册权限，只把用户选中的文件交给 App。
 * singleImage 用于头像这种只要一张照片的地方。
 */
export async function pickFromLibrary(options?: {
  singleImage?: boolean;
  /** 只在 E2E 构建里有效，见 e2eBulkMoment。 */
  e2eBulk?: boolean;
  /** 只在 E2E 构建里有效：反馈要一张带虚构 GPS 的 JPEG，验证上传前去掉了元数据。 */
  e2eFeedback?: boolean;
}): Promise<PickedFile[]> {
  if (IS_E2E && options?.e2eBulk) return e2eBulkMoment();
  if (IS_E2E && options?.e2eFeedback) return e2ePickFiles('feedback');
  if (IS_E2E) return e2ePickFiles(options?.singleImage ? 'avatar' : 'moment');
  const single = Boolean(options?.singleImage);
  const marker = pendingPickMarker();
  try {
    if (!single && !marker.exists) marker.create();
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: single ? ['images'] : ['images', 'videos'],
      allowsMultipleSelection: !single,
      quality: 1,
      videoMaxDuration: 0,
      exif: false,
    });
    return result.canceled ? [] : result.assets.map(fromAsset);
  } catch {
    // 原生层的错误是一长串英文，用户看不懂。
    throw new Error(t().ui.cantOpenGallery);
  } finally {
    // App 在选择器打开时被杀的话走不到这里，下次启动靠它知道选图被打断了。
    if (!single && marker.exists) marker.delete();
  }
}

/**
 * 选择器打开时 App 没了，用户点“添加”后 App 是冷启动的，原来的 Promise 已经不在。
 * 只有 Activity 被销毁、进程还在时，原生层才会暂存结果，这里取回给回忆用，头像和证件照的结果不能跑进来。
 * 进程被杀时取不回来：expo-modules-core 只在 onHostDestroy 保存请求，新进程对不上就丢弃结果。
 * 这时能做的是告诉用户再选一次，原图还在相册里。见 docs/PITFALLS.md。
 */
export async function recoverPendingPick(): Promise<{
  files: PickedFile[];
  interrupted: boolean;
}> {
  if (IS_E2E || Platform.OS !== 'android') return { files: [], interrupted: false };
  const marker = pendingPickMarker();
  if (!marker.exists) return { files: [], interrupted: false };
  const recent = isRecentPick(marker.modificationTime, Date.now());
  try {
    const assets = await firstFound(
      async () => {
        const result = await ImagePicker.getPendingResultAsync();
        return result && 'assets' in result && result.assets ? result.assets : null;
      },
      [0, 1000, 2000],
      (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    );
    if (assets) return { files: assets.map(fromAsset), interrupted: false };
    return { files: [], interrupted: recent };
  } finally {
    if (marker.exists) marker.delete();
  }
}

export async function takePhoto(): Promise<PickedFile[]> {
  if (IS_E2E) return e2ePickFiles('document-photo');
  const permission = await ImagePicker.requestCameraPermissionsAsync();
  if (!permission.granted) throw new Error(t().ui.noCameraPermission);
  const result = await ImagePicker.launchCameraAsync({ quality: 0.9, exif: false });
  return result.canceled ? [] : result.assets.map(fromAsset);
}

export async function pickDocument(): Promise<PickedFile[]> {
  if (IS_E2E) return e2ePickFiles('document-pdf');
  const result = await DocumentPicker.getDocumentAsync({
    type: ['image/*', 'application/pdf'],
    multiple: true,
    copyToCacheDirectory: true,
  });
  if (result.canceled) return [];
  return result.assets.map((asset) => {
    const mime = asset.mimeType ?? 'application/octet-stream';
    return {
      uri: asset.uri,
      kind: kindFromMime(mime),
      mime,
      size: fileSize(asset.uri, asset.size),
      name: asset.name,
    };
  });
}

/** 解码和保存共用一段：图片在原生内存里，JS 的垃圾回收感觉不到它的大小，等它来回收的话几张大图就能撑爆内存。 */
async function renderJpeg(
  source: string,
  targetUri: string,
  options: { decodeMaxSide: number; resizeWidth?: number; compress: number },
): Promise<{ size: number }> {
  const { decodeMaxSide, resizeWidth, compress } = options;
  const context = ImageManipulator.manipulate(source, {
    maxWidth: decodeMaxSide,
    maxHeight: decodeMaxSide,
  });
  let image: ImageRef | null = null;
  try {
    if (resizeWidth) context.resize({ width: resizeWidth });
    image = await context.renderAsync();
    const saved = await image.saveAsync({ format: SaveFormat.JPEG, compress });
    const target = new File(targetUri);
    if (target.exists) target.delete();
    await new File(saved.uri).move(target);
    return { size: target.size ?? 0 };
  } finally {
    image?.release();
    context.release();
  }
}

async function makeThumbnail(
  source: { uri: string; kind: 'image' | 'video' },
  targetUri: string,
  scope: MediaScope,
): Promise<{ size: number } | null> {
  let videoFrame: string | null = null;
  try {
    if (source.kind === 'video') {
      videoFrame = (
        await VideoThumbnails.getThumbnailAsync(source.uri, { time: 500, quality: 0.8 })
      ).uri;
    }
    // 解码时就缩小：12 MP 整张解码要 48 MB，108 MP 要 430 MB，而缩略图最宽只有 720。
    const { maxSide, width } = thumbnailSize(scope);
    return await renderJpeg(videoFrame ?? source.uri, targetUri, {
      decodeMaxSide: maxSide,
      resizeWidth: width,
      compress: 0.8,
    });
  } catch {
    // 缩略图失败不阻止上传：界面会退回显示原图或占位。
    return null;
  } finally {
    if (videoFrame) {
      try {
        new File(videoFrame).delete();
      } catch {
        // 留在缓存里也无妨，退出登录时会清。
      }
    }
  }
}

/**
 * 解码时就限制在长边以内（比这小的不放大），不用再 resize。
 * JPEG 是从解码后的位图重新编码的，不带原图的 EXIF：分享页靠这一点才不泄露拍摄地点，见 verify-uploads。
 */
async function makePreview(sourceUri: string, targetUri: string): Promise<{ size: number } | null> {
  try {
    return await renderJpeg(sourceUri, targetUri, {
      decodeMaxSide: PREVIEW_MAX_SIDE,
      compress: PREVIEW_QUALITY,
    });
  } catch {
    // 预览失败不阻止上传：这张照片就没有预览，查看器和分享页退回原图。
    return null;
  }
}

/**
 * 反馈的照片：和预览一样重新编码（JPEG，长边 2048，质量 0.8），不带原图的 EXIF 和 GPS，方向写进像素里。
 * 反馈的附件会公开（F-126），所以失败就抛错，调用方不能退回原图。
 */
export async function compressFeedbackPhoto(
  sourceUri: string,
  targetUri: string,
): Promise<{ size: number }> {
  const result = await renderJpeg(sourceUri, targetUri, {
    decodeMaxSide: PREVIEW_MAX_SIDE,
    compress: PREVIEW_QUALITY,
  });
  if (!result.size) throw new Error('empty jpeg');
  return result;
}

/**
 * 把文件收进 App 私有目录。选择器和录音的副本都在缓存目录，直接挪过去是瞬间完成的，
 * 也不用占两份空间；其他来源，或者挪不动时才复制。
 * 必须在写记录前做：缓存文件随时可能被系统清掉，而上传可能要等到连上 Wi-Fi。
 */
async function adoptFile(file: PickedFile, target: File): Promise<void> {
  if (file.uri === target.uri && target.exists) return;
  if (target.exists) target.delete();
  const source = new File(file.uri);
  if (file.uri.startsWith(Paths.cache.uri)) {
    try {
      await source.move(target);
      file.uri = target.uri;
      return;
    } catch {
      // 退回复制。
    }
  }
  await new File(file.uri).copy(target);
}

async function prepareFile(
  file: PickedFile,
  options: { id: string; scope: MediaScope; videoWifiOnly: boolean },
): Promise<{ ref: MediaRef; jobs: Omit<UploadJob, 'key' | 'attempts'>[] }> {
  const { id, scope } = options;
  const target = localFile(id, 'original');
  await adoptFile(file, target);
  const size = target.size ?? file.size;
  if (!size) {
    target.delete();
    throw new Error(t().ui.emptyFile(file.name ?? t().ui.thisFile));
  }
  const thumbable = file.kind === 'image' || file.kind === 'video';
  const jobs = mediaJobs({
    id,
    file: { kind: file.kind, mime: file.mime, size, name: file.name },
    scope,
    wifiOnly: file.kind === 'video' && options.videoWifiOnly,
    uris: {
      original: target.uri,
      thumb: localFile(id, 'thumb').uri,
      preview: localFile(id, 'preview').uri,
    },
  });
  return {
    jobs,
    ref: {
      id,
      kind: file.kind,
      name: file.name,
      mime: file.mime,
      size,
      durationMs: file.durationMs,
      width: file.width,
      height: file.height,
      peaks: file.peaks,
      // 还没生成也写 true：显示时取不到缩略图会退回原图，生成后不用再改一次记录。
      hasThumb: thumbable,
    },
  };
}

/** 加入上传队列，返回可以写入记录的引用。 */
export async function queueForUpload(
  queue: UploadQueue,
  file: PickedFile,
  options: { id: string; scope: MediaScope; videoWifiOnly: boolean },
): Promise<MediaRef> {
  const { ref, jobs } = await prepareFile(file, options);
  await queue.enqueue(jobs);
  return ref;
}

const fileIds = new WeakMap<PickedFile, string>();
const queuedRefs = new WeakMap<PickedFile, MediaRef>();

/**
 * 一批文件一起入队。一个文件失败不挡后面的。
 * 写记录失败时用户会再点一次保存：同一个文件用同一个 id，不会重复上传。
 */
export async function queueAllForUpload(
  queue: UploadQueue,
  files: readonly PickedFile[],
  options: { scope: MediaScope; videoWifiOnly: boolean },
): Promise<{ refs: MediaRef[]; failed: string[] }> {
  const jobs: Omit<UploadJob, 'key' | 'attempts'>[] = [];
  const fresh: [PickedFile, MediaRef][] = [];
  const { done, failed } = await importEach(files, async (file) => {
    const existing = queuedRefs.get(file);
    if (existing) return existing;
    const id = fileIds.get(file) ?? Crypto.randomUUID();
    fileIds.set(file, id);
    const prepared = await prepareFile(file, { ...options, id });
    jobs.push(...prepared.jobs);
    fresh.push([file, prepared.ref]);
    return prepared.ref;
  });
  if (jobs.length > 0) await queue.enqueue(jobs);
  for (const [file, ref] of fresh) queuedRefs.set(file, ref);
  return { refs: done, failed };
}

/** 把一张已有的图读进内存准备编辑。本地有副本就不走网络，否则先下载。 */
export async function loadForEditing(api: Api, ref: MediaRef): Promise<ImageRef> {
  const load = (uri: string) =>
    ImageManipulator.manipulate(uri, {
      maxWidth: EDIT_MAX_SIDE,
      maxHeight: EDIT_MAX_SIDE,
    }).renderAsync();
  const local = localUriFor(ref.id, 'original');
  if (local) return load(local);
  // 放在 uploads 目录而不是缓存：退出登录时会清掉，下一个登录的人看不到。
  const target = new File(uploadsDir(), `${ref.id}-editing`);
  try {
    const { urls } = await api.mediaUrls([{ id: ref.id, variant: 'original' }]);
    const url = urls[0]?.url;
    if (!url) throw new Error('no url');
    if (target.exists) target.delete();
    await File.downloadFileAsync(url, target);
    return await load(target.uri);
  } catch {
    // 不把原始错误显示出来：里面可能带着签名链接。
    throw new Error(t().ui.originalUnavailable);
  } finally {
    if (target.exists) target.delete();
  }
}

export function rotateImage(image: ImageRef): Promise<ImageRef> {
  return ImageManipulator.manipulate(image).rotate(90).renderAsync();
}

export function cropImage(
  image: ImageRef,
  rect: { originX: number; originY: number; width: number; height: number },
): Promise<ImageRef> {
  return ImageManipulator.manipulate(image).crop(rect).renderAsync();
}

/** 编辑结果写成文件。旋转、裁剪都在内存里做，只在这里编码一次，画质不会一轮轮变差。 */
export async function savedImageFile(image: ImageRef): Promise<PickedFile> {
  const saved = await image.saveAsync({ format: SaveFormat.JPEG, compress: 0.92 });
  return {
    uri: saved.uri,
    kind: 'image',
    mime: 'image/jpeg',
    size: fileSize(saved.uri),
    width: saved.width,
    height: saved.height,
  };
}

function toUploadError(error: unknown): unknown {
  if (error instanceof ApiFailure && error.status !== 0) {
    return new UploadHttpError(error.status, error.code, error.message);
  }
  return error;
}

/** 一片的临时文件。按并行的路数命名，所以最多这么几个，上次被杀留下的下次会被覆盖。 */
function partFile(localUri: string, slot: number): File {
  return new File(`${localUri}-part-${slot}`);
}

/** 一次读多少。分片本身只有 8 MB，但手机内存紧张时也不值得把一整片读进 JS。 */
const PART_COPY_CHUNK = 1024 * 1024;

/**
 * 把这一片复制成临时文件，再交给原生层流式上传。这样 JS 里只有一小块在内存里，
 * 进度和中断也都能用 File.upload 现成的（onProgress 能到片内字节，signal 真的断开连接）。
 */
async function writePartFile(
  source: File,
  temp: File,
  part: UploadPartTarget,
  signal: AbortSignal,
): Promise<void> {
  if (temp.exists) temp.delete();
  temp.create();
  const from = source.open(FileMode.ReadOnly);
  const to = temp.open(FileMode.ReadWrite);
  try {
    from.offset = part.offset;
    let left = part.size;
    while (left > 0) {
      signal.throwIfAborted();
      const chunk = await from.readBytes(Math.min(PART_COPY_CHUNK, left));
      if (chunk.length === 0) throw new UploadHttpError(409, 'file_changed', t().ui.fileChanged);
      await to.writeBytes(chunk);
      left -= chunk.length;
    }
  } finally {
    from.close();
    to.close();
  }
}

export function createUploadTransport(api: Api): UploadTransport {
  const wrap = async <T>(call: () => Promise<T>): Promise<T> => {
    try {
      return await call();
    } catch (error) {
      throw toUploadError(error);
    }
  };
  return {
    async requestUrl(request) {
      try {
        return await api.uploadUrl(request);
      } catch (error) {
        throw toUploadError(error);
      }
    },
    async put(job, target, onProgress, signal) {
      const file = new File(job.localUri);
      if (!file.exists) throw new UploadHttpError(410, 'local_missing', t().ui.localFileGone);
      const result = await file.upload(target.url, {
        httpMethod: 'PUT',
        uploadType: UploadType.BINARY_CONTENT,
        headers: target.headers,
        onProgress: ({ bytesSent }) => onProgress(bytesSent),
        signal,
      });
      return { status: result.status };
    },
    async complete(id, variant) {
      try {
        await api.completeUpload(id, variant);
      } catch (error) {
        throw toUploadError(error);
      }
    },
    async removeLocal(uri) {
      const file = new File(uri);
      if (file.exists) file.delete();
      // 传到一半被取消或被杀时，临时文件还在。
      for (let slot = 0; slot < MULTIPART_PARALLEL; slot++) {
        const part = partFile(uri, slot);
        if (part.exists) part.delete();
      }
    },
    async makeThumb(job) {
      if (!job.thumbSource || !new File(job.thumbSource.uri).exists) return null;
      if (job.variant === 'preview') return makePreview(job.thumbSource.uri, job.localUri);
      return makeThumbnail(job.thumbSource, job.localUri, job.scope);
    },
    cancelRemote: (id) => wrap(() => api.cancelUpload(id)),
    multipart: {
      start: (request) => wrap(() => api.multipartStart(request)),
      listParts: (job, uploadId) =>
        wrap(() => api.multipartParts(job.id, { variant: job.variant, uploadId })),
      partUrls: (job, uploadId, partNumbers) =>
        wrap(() => api.multipartPartUrls(job.id, { variant: job.variant, uploadId, partNumbers })),
      complete: (job, uploadId) =>
        wrap(() => api.multipartComplete(job.id, { variant: job.variant, uploadId })),
      async stat(job) {
        const file = new File(job.localUri);
        if (!file.exists) return null;
        return { size: file.size ?? 0, modifiedAt: file.modificationTime ?? undefined };
      },
      async putPart(job, part, onProgress, signal) {
        const source = new File(job.localUri);
        if (!source.exists) throw new UploadHttpError(410, 'local_missing', t().ui.localFileGone);
        const temp = partFile(job.localUri, part.slot);
        try {
          await writePartFile(source, temp, part, signal);
          const result = await temp.upload(part.url, {
            httpMethod: 'PUT',
            uploadType: UploadType.BINARY_CONTENT,
            onProgress: ({ bytesSent }) => onProgress(bytesSent),
            signal,
          });
          return { status: result.status };
        } finally {
          if (temp.exists) temp.delete();
        }
      },
    },
  };
}

/** PDF 用系统应用打开。证件的签名链接只有 10 分钟，所以先下载到缓存再打开。 */
export async function openDocumentFile(api: Api, queue: UploadQueue, ref: MediaRef): Promise<void> {
  void queue;
  const name = ref.name?.replace(/[^\w.\-一-龥]/g, '_') ?? `${ref.id}.pdf`;
  const target = new File(Paths.cache, `open-${ref.id}-${name}`);
  let uri = localUriFor(ref.id, 'original');
  if (!uri) {
    const { urls } = await api.mediaUrls([{ id: ref.id, variant: 'original' }]);
    const url = urls[0]?.url;
    if (!url) throw new Error(t().ui.fileNotReady);
    if (target.exists) target.delete();
    await File.downloadFileAsync(url, target);
    uri = target.uri;
  }
  if (Platform.OS === 'android') {
    const contentUri = new File(uri).contentUri;
    await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
      data: contentUri,
      flags: 1,
      type: ref.mime,
    });
    return;
  }
  await Sharing.shareAsync(uri, { mimeType: ref.mime });
}

/** 退出登录时清掉手机上的文件副本和图片缓存，下一个登录的人不能看到。 */
export async function clearLocalMedia(): Promise<void> {
  try {
    const dir = new Directory(Paths.document, 'uploads');
    if (dir.exists) dir.delete();
    // 不清的话，下一个登录的人会看到“刚才选的照片没带回来”。
    const marker = pendingPickMarker();
    if (marker.exists) marker.delete();
    await Image.clearDiskCache();
    await Image.clearMemoryCache();
  } catch {
    // 清缓存失败不影响退出。
  }
  clearPersonalCache();
}

/** 成长册、打开过的证件、导出文件和系统选择器的副本都留在缓存目录，不清就一直在手机上。 */
function clearPersonalCache(): void {
  try {
    for (const entry of new Directory(Paths.cache).list()) {
      try {
        if (entry instanceof File || isPersonalCacheDirectory(entry.name)) entry.delete();
      } catch {
        // 一个删不掉不影响其他的。
      }
    }
  } catch {
    // 同上：清缓存失败不影响退出。
  }
}
