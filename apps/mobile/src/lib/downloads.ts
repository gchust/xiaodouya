import { Directory, File, Paths } from 'expo-file-system';
import * as MediaLibrary from 'expo-media-library/legacy';
import * as Sharing from 'expo-sharing';
import { useCallback, useSyncExternalStore } from 'react';
import { Platform } from 'react-native';
import type { Api } from './api';
import { IS_E2E } from './config';
import {
  createDownloader,
  type DownloadOutcome,
  type DownloadPorts,
  type DownloadRequest,
  type DownloadState,
  FolderNameTakenError,
  galleryUri,
} from './downloadCore';
import { localOriginalCopy } from './media';

/** 这个目录随时可以整个删掉：放的都是下载途中的临时文件，用完就清。 */
function tempRoot(): Directory {
  return new Directory(Paths.cache, 'downloads');
}

/** 为什么 E2E 不走系统文件夹选择器：系统界面随版本变化，同 e2eFixtures.ts。 */
function e2eFolder(): string {
  const dir = new Directory(Paths.document, 'e2e-downloads');
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  return dir.uri;
}

function isNameTaken(error: unknown): boolean {
  return error instanceof Error && /already exists/i.test(error.message);
}

function isPickerCancelled(error: unknown): boolean {
  return (
    error instanceof Error &&
    ((error as Error & { code?: string }).code === 'ERR_PICKER_CANCELLED' ||
      /cancel/i.test(error.message))
  );
}

function ports(getApi: () => Api | null): DownloadPorts {
  return {
    async requestGalleryAccess() {
      // Android 13 起写相册不需要权限，原生层也不检查，不要多弹一次。
      if (Platform.OS === 'android' && Number(Platform.Version) >= 33) return true;
      const permission = await MediaLibrary.requestPermissionsAsync(true);
      return permission.granted;
    },
    async pickFolder() {
      if (IS_E2E) return e2eFolder();
      try {
        return (await Directory.pickDirectoryAsync()).uri;
      } catch (error) {
        if (isPickerCancelled(error)) return null;
        throw error;
      }
    },
    findLocalCopy: localOriginalCopy,
    async signedUrl(media) {
      const api = getApi();
      if (!api) return null;
      // 下载永远是原图，不是预览。
      // 不用 mediaUrlBatcher 的缓存：要一条刚签发的，下载大文件时不会差一点就过期。
      const { urls } = await api.mediaUrls([{ id: media.id, variant: 'original' }]);
      return urls[0]?.url ?? null;
    },
    availableBytes() {
      try {
        return Paths.availableDiskSpace;
      } catch {
        return Number.POSITIVE_INFINITY;
      }
    },
    prepareTemp(id, fileName) {
      const dir = new Directory(tempRoot(), id);
      if (dir.exists) dir.delete();
      dir.create({ intermediates: true, idempotent: true });
      return new File(dir, fileName).uri;
    },
    async fetchTo(url, tempUri, { signal, onProgress }) {
      await File.downloadFileAsync(url, new File(tempUri), {
        idempotent: true,
        signal,
        onProgress: ({ bytesWritten, totalBytes }) => onProgress(bytesWritten, totalBytes),
      });
    },
    async copyInto(from, tempUri) {
      await new File(from).copy(new File(tempUri));
    },
    sizeOf(uri) {
      return new File(uri).size ?? 0;
    },
    async saveToGallery(tempUri) {
      await MediaLibrary.saveToLibraryAsync(galleryUri(tempUri));
    },
    async saveToFolder(tempUri, folder) {
      try {
        // 只能复制进文件夹，让它用临时文件的名字：先 createFile 再覆盖的话，
        // expo-file-system 会把刚建的文档删掉，然后写不进去。
        await new File(tempUri).copy(new Directory(folder));
      } catch (error) {
        if (isNameTaken(error)) throw new FolderNameTakenError();
        throw error;
      }
    },
    renameTemp(tempUri, fileName) {
      const file = new File(tempUri);
      file.rename(fileName);
      return file.uri;
    },
    async share(tempUri, mime) {
      await Sharing.shareAsync(tempUri, { mimeType: mime });
    },
    removeTemp(id) {
      const dir = new Directory(tempRoot(), id);
      if (dir.exists) dir.delete();
    },
  };
}

let currentApi: Api | null = null;
const downloader = createDownloader(
  ports(() => currentApi),
  { platform: Platform.OS },
);

export function startDownload(api: Api, request: DownloadRequest): Promise<DownloadOutcome> {
  currentApi = api;
  return downloader.start(request);
}

export function cancelDownload(id: string): void {
  downloader.cancel(id);
}

export function useDownloadState(id: string): DownloadState | null {
  const snapshot = useCallback(() => downloader.stateOf(id), [id]);
  return useSyncExternalStore(downloader.subscribe, snapshot);
}

/** 启动时和退出登录时调用：上次被杀留下的文件，尤其是证件，不能一直躺在缓存里。 */
export function clearDownloads(): void {
  downloader.cancelAll();
  try {
    const root = tempRoot();
    if (root.exists) root.delete();
  } catch {
    // 下次启动再清。
  }
}
