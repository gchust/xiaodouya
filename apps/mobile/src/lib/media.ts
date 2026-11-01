import type { MediaKind, MediaRef, MediaScope } from '@xiaodouya/shared';
import * as DocumentPicker from 'expo-document-picker';
import { Directory, File, Paths, UploadType } from 'expo-file-system';
import { Image } from 'expo-image';
import { ImageManipulator, type ImageRef, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import * as IntentLauncher from 'expo-intent-launcher';
import * as Sharing from 'expo-sharing';
import * as VideoThumbnails from 'expo-video-thumbnails';
import { Platform } from 'react-native';
import {
  UploadHttpError,
  type UploadJob,
  type UploadQueue,
  type UploadTransport,
} from '../data/uploadQueue';
import { type Api, ApiFailure } from './api';
import { IS_E2E } from './config';
import { e2ePickFiles } from './e2eFixtures';
import { pickDurationMs } from './mediaUtils';

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

const THUMB_WIDTH = 720;
/** 编辑时要把图解码进内存，手机原图可能有上亿像素，不限制的话旋转时会内存不足。头像用不到更高的清晰度。 */
const EDIT_MAX_SIDE = 3000;

function uploadsDir(): Directory {
  const dir = new Directory(Paths.document, 'uploads');
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  return dir;
}

function localFile(id: string, variant: 'original' | 'thumb'): File {
  return new File(uploadsDir(), `${id}-${variant}`);
}

/** 上传中或刚选好的文件，优先从本地显示，不用等网络。 */
export function localUriFor(id: string, variant: 'original' | 'thumb'): string | null {
  try {
    const file = localFile(id, variant);
    return file.exists ? file.uri : null;
  } catch {
    return null;
  }
}

function kindFromMime(mime: string): MediaKind {
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'application/pdf') return 'pdf';
  return 'image';
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

/**
 * 系统照片选择器：不需要相册权限，只把用户选中的文件交给 App。
 * singleImage 用于头像这种只要一张照片的地方。
 */
export async function pickFromLibrary(options?: { singleImage?: boolean }): Promise<PickedFile[]> {
  if (IS_E2E) return e2ePickFiles(options?.singleImage ? 'avatar' : 'moment');
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: options?.singleImage ? ['images'] : ['images', 'videos'],
    allowsMultipleSelection: !options?.singleImage,
    quality: 1,
    videoMaxDuration: 0,
    exif: false,
  });
  return result.canceled ? [] : result.assets.map(fromAsset);
}

export async function takePhoto(): Promise<PickedFile[]> {
  if (IS_E2E) return e2ePickFiles('document-photo');
  const permission = await ImagePicker.requestCameraPermissionsAsync();
  if (!permission.granted) throw new Error('没有相机权限，可以在系统设置里打开');
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

async function makeThumbnail(
  file: PickedFile,
  id: string,
): Promise<{ uri: string; size: number } | null> {
  try {
    let sourceUri = file.uri;
    if (file.kind === 'video') {
      sourceUri = (await VideoThumbnails.getThumbnailAsync(file.uri, { time: 500, quality: 0.8 }))
        .uri;
    } else if (file.kind !== 'image') {
      return null;
    }
    const context = ImageManipulator.manipulate(sourceUri);
    context.resize({ width: THUMB_WIDTH });
    const image = await context.renderAsync();
    const saved = await image.saveAsync({ format: SaveFormat.JPEG, compress: 0.8 });
    const target = localFile(id, 'thumb');
    if (target.exists) target.delete();
    await new File(saved.uri).move(target);
    return { uri: target.uri, size: target.size ?? 0 };
  } catch {
    // 缩略图失败不阻止上传：界面会退回显示原图或占位。
    return null;
  }
}

/**
 * 把选中的文件复制进 App 私有目录并加入上传队列，返回可以写入记录的引用。
 * 必须先复制：相册 URI 和缓存文件都可能在 App 重启后失效，而上传可能要等到连上 Wi-Fi。
 */
export async function queueForUpload(
  queue: UploadQueue,
  file: PickedFile,
  options: { id: string; scope: MediaScope; videoWifiOnly: boolean },
): Promise<MediaRef> {
  const { id, scope } = options;
  const target = localFile(id, 'original');
  if (target.exists) target.delete();
  await new File(file.uri).copy(target);
  const size = target.size ?? file.size;
  if (!size) {
    target.delete();
    throw new Error(`${file.name ?? '这个文件'}是空的，没有添加`);
  }
  const thumb = await makeThumbnail(file, id);
  const wifiOnly = file.kind === 'video' && options.videoWifiOnly;
  const jobs: Omit<UploadJob, 'key' | 'attempts'>[] = [];
  // 缩略图排在前面：它小，传得快，家人能先看到。
  if (thumb) {
    jobs.push({
      id,
      variant: 'thumb',
      scope,
      localUri: thumb.uri,
      mime: 'image/jpeg',
      size: thumb.size,
      wifiOnly: false,
    });
  }
  jobs.push({
    id,
    variant: 'original',
    scope,
    localUri: target.uri,
    mime: file.mime,
    size,
    filename: file.name,
    wifiOnly,
  });
  await queue.enqueue(jobs);
  return {
    id,
    kind: file.kind,
    name: file.name,
    mime: file.mime,
    size,
    durationMs: file.durationMs,
    width: file.width,
    height: file.height,
    peaks: file.peaks,
    hasThumb: Boolean(thumb),
  };
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
    throw new Error('原图暂时取不到，联网后再试一次');
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

export function createUploadTransport(api: Api): UploadTransport {
  return {
    async requestUrl(request) {
      try {
        return await api.uploadUrl(request);
      } catch (error) {
        throw toUploadError(error);
      }
    },
    async put(job, target, onProgress) {
      const file = new File(job.localUri);
      if (!file.exists)
        throw new UploadHttpError(410, 'local_missing', '本地文件不见了，请重新添加');
      const result = await file.upload(target.url, {
        httpMethod: 'PUT',
        uploadType: UploadType.BINARY_CONTENT,
        headers: target.headers,
        onProgress: ({ bytesSent }) => onProgress(bytesSent),
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
    if (!url) throw new Error('文件还没有上传完成，或者你没有查看权限');
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
    await Image.clearDiskCache();
    await Image.clearMemoryCache();
  } catch {
    // 清缓存失败不影响退出。
  }
}
