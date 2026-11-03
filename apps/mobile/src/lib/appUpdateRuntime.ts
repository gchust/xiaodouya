import { Directory, File, Paths } from 'expo-file-system';
import * as IntentLauncher from 'expo-intent-launcher';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { AppUpdateNative } from '../../modules/app-update';
import type { SqliteDb } from '../data/sqlite';
import type { Api } from './api';
import { UpdateController, type UpdatePhase } from './appUpdate';
import { SELF_UPDATE_ENABLED } from './config';

const APK_MIME = 'application/vnd.android.package-archive';
const FLAG_GRANT_READ_URI_PERMISSION = 1;

let controller: UpdateController | null = null;

const updatesDir = () => new Directory(Paths.cache, 'updates');

/**
 * 只有打开了应用内更新的 Android 构建才有。单例：关掉弹层、换页面都不打断下载。
 * api 和 db 来自 getCoreServices，整个进程只有一份。
 */
export function getUpdateController(api: Api, db: SqliteDb): UpdateController | null {
  const native = AppUpdateNative;
  if (!SELF_UPDATE_ENABLED || !native) return null;
  if (controller) return controller;
  controller = new UpdateController({
    currentVersionCode: () => native.currentVersion().code,
    fetchUpdate: (code) => api.appUpdate(code),
    apkFile: (code) => new File(updatesDir(), `xiaodouya-${code}.apk`).uri,
    fileSize(uri) {
      const file = new File(uri);
      return file.exists ? file.size : null;
    },
    deleteFile(uri) {
      try {
        const file = new File(uri);
        if (file.exists) file.delete();
      } catch {
        // 缓存目录，删不掉系统以后也会清。
      }
    },
    async download(url, uri, onProgress, signal) {
      const dir = updatesDir();
      if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
      await File.downloadFileAsync(url, new File(uri), {
        idempotent: true,
        signal,
        onProgress: ({ bytesWritten, totalBytes }) => onProgress(bytesWritten, totalBytes),
      });
    },
    sha256: (uri) => native.sha256(uri),
    async install(uri) {
      // 用 App 自己的 FileProvider 给安装界面一个临时的读取授权，不用把文件放到公共目录。
      await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
        data: new File(uri).contentUri,
        flags: FLAG_GRANT_READ_URI_PERMISSION,
        type: APK_MIME,
      });
    },
    getMeta: (key) => db.getMeta(key),
    setMeta: (key, value) => db.setMeta(key, value),
    now: () => Date.now(),
  });
  return controller;
}

/** 已经装上的（和更旧的）安装包没用了，几十 MB，不留着。启动时调一次，不放在渲染里。 */
export function removeInstalledApks(): void {
  const currentCode = AppUpdateNative?.currentVersion().code;
  if (!SELF_UPDATE_ENABLED || !currentCode) return;
  try {
    const dir = updatesDir();
    if (!dir.exists) return;
    for (const entry of dir.list()) {
      const code = Number(/^xiaodouya-(\d+)\.apk$/.exec(entry.name)?.[1]);
      if (entry instanceof File && (!code || code <= currentCode)) entry.delete();
    }
  } catch {
    // 清不掉不影响使用。
  }
}

export function currentAppVersion(): { code: number; name: string } | null {
  return AppUpdateNative?.currentVersion() ?? null;
}

const IDLE: UpdatePhase = { kind: 'idle' };
const noop = () => () => {};

export function useUpdatePhase(updates: UpdateController | null): UpdatePhase {
  return useSyncExternalStore(updates?.subscribe ?? noop, updates?.getState ?? (() => IDLE));
}

const canInstallPackages = () => AppUpdateNative?.canRequestPackageInstalls() ?? false;

/** “安装未知应用”的授权。用户去设置里打开后回到 App 时重新读。 */
export function useCanInstallPackages(): boolean {
  const [allowed, setAllowed] = useState(canInstallPackages);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') setAllowed(canInstallPackages());
    });
    return () => sub.remove();
  }, []);
  return allowed;
}

export function openInstallSettings(): void {
  AppUpdateNative?.openInstallSettings();
}
