import { z } from 'zod';
import type { Locale } from './i18n/locale';

/**
 * 应用内更新（旁加载的 APK，见 docs/ARCHITECTURE.md 的“应用内更新”）。
 * 发布脚本 `scripts/publish-apk.sh` 写清单，服务端读清单签下载链接，App 下载校验后交给系统安装。
 * 版本只按 versionCode 比：Android 也只认它，versionName 只是给人看的。
 */

/** 存储里的位置。和 App 的文件（`families/`）、备份（`backups/`）分开。 */
export const DEFAULT_RELEASE_PREFIX = 'releases/android/';
export const RELEASE_MANIFEST_NAME = 'latest.json';

/** 自动检查的间隔。手动点“检查更新”不受它限制。 */
export const UPDATE_CHECK_INTERVAL_MS = 24 * 3_600_000;

const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
const ReleaseNotes = z.object({
  zh: z.string().max(2000).optional(),
  en: z.string().max(2000).optional(),
});
export type ReleaseNotes = z.infer<typeof ReleaseNotes>;

/** 不用 strict：以后的发布脚本可能多写字段，旧服务端照样能读。 */
export const ReleaseManifest = z.object({
  platform: z.literal('android'),
  versionCode: z.number().int().positive(),
  versionName: z.string().min(1).max(40),
  apk: z.object({
    key: z.string().min(1).max(300),
    size: z.number().int().positive(),
    sha256: Sha256Hex,
  }),
  /** 低于它的版本必须更新（比如服务端不再兼容）。没有就是都还能用。 */
  minSupportedVersionCode: z.number().int().positive().optional(),
  notes: ReleaseNotes.optional(),
  publishedAt: z.string().max(40),
});
export type ReleaseManifest = z.infer<typeof ReleaseManifest>;

/**
 * 服务端只给发布前缀下面、文件名本身的对象签链接：清单和 APK 在同一个 Bucket 里，
 * 清单要是被写坏或写错，不能借它签出家庭的照片和证件。
 */
export function isReleaseKey(key: string, prefix: string): boolean {
  if (!key.startsWith(prefix)) return false;
  const name = key.slice(prefix.length);
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && !name.includes('..');
}

export function updateDecision(
  manifest: Pick<ReleaseManifest, 'versionCode' | 'minSupportedVersionCode'>,
  currentVersionCode: number,
): { available: boolean; required: boolean } {
  const available = manifest.versionCode > currentVersionCode;
  const required =
    available &&
    manifest.minSupportedVersionCode !== undefined &&
    currentVersionCode < manifest.minSupportedVersionCode;
  return { available, required };
}

export const AppUpdateQuery = z.object({
  platform: z.literal('android'),
  versionCode: z.coerce.number().int().positive(),
});
export type AppUpdateQuery = z.infer<typeof AppUpdateQuery>;

export const AppUpdateInfo = z.object({
  versionCode: z.number().int().positive(),
  versionName: z.string().min(1).max(40),
  size: z.number().int().positive(),
  sha256: Sha256Hex,
  /** 短时效的签名链接。不能写进日志。 */
  url: z.url(),
  expiresIn: z.number().int().positive(),
  required: z.boolean(),
  notes: ReleaseNotes.nullable(),
});
export type AppUpdateInfo = z.infer<typeof AppUpdateInfo>;

/** update 为 null：没有更新的版本，或者这台服务器没有发布过。 */
export const AppUpdateResponse = z.object({ update: AppUpdateInfo.nullable() });
export type AppUpdateResponse = z.infer<typeof AppUpdateResponse>;

export function shouldAutoCheckUpdate(lastCheckedAt: number | null, now: number): boolean {
  if (lastCheckedAt === null || lastCheckedAt > now) return true;
  return now - lastCheckedAt >= UPDATE_CHECK_INTERVAL_MS;
}

/** 自动检查到新版本时，同一个版本只提示一次；必须更新的每次都提示。 */
export function shouldNotifyUpdate(
  update: Pick<AppUpdateInfo, 'versionCode' | 'required'>,
  notifiedVersionCode: number | null,
): boolean {
  return update.required || update.versionCode !== notifiedVersionCode;
}

/**
 * 自动下载新版本（issue #74）。设置存在这台手机上，不同步给家人：流量和存储是这台手机的事。
 * 默认关，用户自己打开才下载；打开后默认只在 Wi-Fi 下，安装包四五十 MB。
 */
export const AutoUpdatePrefs = z.object({ autoDownload: z.boolean(), wifiOnly: z.boolean() });
export type AutoUpdatePrefs = z.infer<typeof AutoUpdatePrefs>;
export const defaultAutoUpdatePrefs: AutoUpdatePrefs = { autoDownload: false, wifiOnly: true };

/** 和上传队列一样分三种。连着 Wi-Fi 以外的网络都按移动数据算。 */
export type NetworkKind = 'wifi' | 'cellular' | 'none';

/**
 * 同一个版本（同一个文件）最多自动开始下载几次。断网、被杀、Wi-Fi 断开都算一次，
 * 最坏多花三个安装包的流量，之后只提示有新版本，用户自己点下载。
 */
export const AUTO_DOWNLOAD_MAX_ATTEMPTS = 3;

export type AutoDownloadBlocker = 'off' | 'offline' | 'needsWifi' | 'exhausted';

/** null 是现在可以自动下载。 */
export function autoDownloadBlocker(input: {
  prefs: AutoUpdatePrefs;
  network: NetworkKind;
  attempts: number;
}): AutoDownloadBlocker | null {
  if (!input.prefs.autoDownload) return 'off';
  if (input.network === 'none') return 'offline';
  if (input.prefs.wifiOnly && input.network !== 'wifi') return 'needsWifi';
  if (input.attempts >= AUTO_DOWNLOAD_MAX_ATTEMPTS) return 'exhausted';
  return null;
}

type AttemptTarget = Pick<AppUpdateInfo, 'versionCode' | 'sha256'>;
const attemptPrefix = (update: AttemptTarget) => `${update.versionCode}:${update.sha256}:`;

/** 存的是 `版本号:sha256:次数`，只记最近一个版本。 */
export function autoAttemptsFor(stored: string | null, update: AttemptTarget): number {
  const prefix = attemptPrefix(update);
  if (!stored?.startsWith(prefix)) return 0;
  const count = Number(stored.slice(prefix.length));
  return Number.isInteger(count) && count > 0 ? count : 0;
}

export function recordAutoAttempt(stored: string | null, update: AttemptTarget): string {
  return `${attemptPrefix(update)}${autoAttemptsFor(stored, update) + 1}`;
}

/** 文件和发布的对不上时不再自动下：再下一次多半还是同一个坏文件。 */
export function exhaustAutoAttempts(update: AttemptTarget): string {
  return `${attemptPrefix(update)}${AUTO_DOWNLOAD_MAX_ATTEMPTS}`;
}

/**
 * 下好、校验过、还没装的版本，记在本机。App 被杀后重新打开时用它在本地重新核对文件，
 * 不用等下一次检查就能提示安装。不存签名链接。
 */
export const DownloadedUpdate = AppUpdateInfo.omit({ url: true, expiresIn: true });
export type DownloadedUpdate = z.infer<typeof DownloadedUpdate>;

export function parseDownloadedUpdate(raw: string | null): DownloadedUpdate | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = DownloadedUpdate.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** 发布说明是发布者写的，不翻译：按语言取，没有就用另一种。 */
export function releaseNotesFor(
  notes: ReleaseNotes | null | undefined,
  locale: Locale,
): string | null {
  if (!notes) return null;
  const other: Locale = locale === 'zh' ? 'en' : 'zh';
  const text = notes[locale]?.trim() || notes[other]?.trim();
  return text || null;
}
