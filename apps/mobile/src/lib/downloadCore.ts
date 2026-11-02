import type { MediaKind, MediaRef } from '@xiaodouya/shared';
import { t } from '@xiaodouya/shared';

/** 下载的纯逻辑：文件名、存到哪里、流程和状态。不依赖 React Native，方便单元测试。 */

// ─── 文件名 ──────────────────────────────────────────────

/** 留出 “ (99)” 和系统自己加后缀的余地，文件系统的上限是 255 字节。 */
const MAX_NAME_BYTES = 200;

const EXTENSIONS: Record<string, readonly string[]> = {
  'image/jpeg': ['jpg', 'jpeg'],
  'image/jpg': ['jpg', 'jpeg'],
  'image/png': ['png'],
  'image/gif': ['gif'],
  'image/webp': ['webp'],
  'image/heic': ['heic'],
  'image/heif': ['heif', 'heic'],
  'video/mp4': ['mp4', 'm4v'],
  'video/quicktime': ['mov'],
  'video/3gpp': ['3gp'],
  'video/webm': ['webm'],
  'audio/mp4': ['m4a', 'mp4'],
  'audio/m4a': ['m4a'],
  'audio/x-m4a': ['m4a'],
  'audio/aac': ['aac'],
  'audio/mpeg': ['mp3'],
  'audio/wav': ['wav'],
  'audio/x-wav': ['wav'],
  'audio/ogg': ['ogg'],
  'application/pdf': ['pdf'],
};

const KIND_EXTENSION: Record<MediaKind, string> = {
  image: 'jpg',
  video: 'mp4',
  audio: 'm4a',
  pdf: 'pdf',
};

// 控制字符会弄坏路径，方向符（U+202E 等）能把 exe 伪装成 jpg。其他文字都是合法的，这是面向各国的 App。
// biome-ignore lint/suspicious/noControlCharactersInRegex: 就是要去掉控制字符
const INVISIBLE = /[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g;
const ILLEGAL_RUN = /[/\\:*?"<>|]+/g;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

function utf8Length(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/** 文件名拆成主名和扩展名。“录音 · 03.14” 里的 14 全是数字，不算扩展名。 */
function splitExtension(name: string): [stem: string, extension: string] {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return [name, ''];
  const extension = name.slice(dot + 1);
  if (!/^[a-zA-Z0-9]{1,5}$/.test(extension) || /^\d+$/.test(extension)) return [name, ''];
  return [name.slice(0, dot), extension];
}

function truncateBytes(text: string, maxBytes: number): string {
  let out = '';
  let bytes = 0;
  // 按码点遍历，不会把表情符号切成两半。
  for (const char of text) {
    bytes += utf8Length(char);
    if (bytes > maxBytes) break;
    out += char;
  }
  return out;
}

/** 去掉系统不允许的字符。结果可能是空的，调用方要有退路。 */
export function safeFileName(raw: string): string {
  const cleaned = raw
    .replace(INVISIBLE, '')
    .replace(ILLEGAL_RUN, '_')
    .replace(/^[\s._]+/, '')
    .replace(/[\s.]+$/, '');
  if (!cleaned) return '';
  const [stem, extension] = splitExtension(cleaned);
  const suffix = extension ? `.${extension}` : '';
  const short = truncateBytes(stem, MAX_NAME_BYTES - utf8Length(suffix)).replace(/[\s.]+$/, '');
  const name = `${short}${suffix}`;
  return RESERVED.test(name) ? `_${name}` : name;
}

/** 系统相册靠扩展名判断类型，所以扩展名必须和真实类型一致。 */
function withExtension(name: string, media: { mime: string; kind: MediaKind }): string {
  const expected = EXTENSIONS[media.mime.split(';')[0]?.trim().toLowerCase() ?? ''];
  const extension = splitExtension(name)[1].toLowerCase();
  if (expected) return expected.includes(extension) ? name : `${name}.${expected[0]}`;
  return extension ? name : `${name}.${KIND_EXTENSION[media.kind]}`;
}

/** 文件名加序号，序号在扩展名前面。n 从 1 开始，1 就是原名。 */
export function numberedFileName(name: string, n: number): string {
  if (n <= 1) return name;
  const [stem, extension] = splitExtension(name);
  return `${stem} (${n})${extension ? `.${extension}` : ''}`;
}

function localDate(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 一组文件的下载名：优先用原名，没有就用标题和日期。
 * 一起算才能保证同一条回忆、同一份证件里的文件不重名。
 */
export function downloadFileNames(
  items: readonly Pick<MediaRef, 'id' | 'kind' | 'mime' | 'name'>[],
  context: { title: string; at?: number },
): Map<string, string> {
  const fallback = safeFileName(
    context.at === undefined ? context.title : `${context.title} ${localDate(context.at)}`,
  );
  const taken = new Set<string>();
  const names = new Map<string, string>();
  for (const item of items) {
    const base = withExtension(
      safeFileName(item.name ?? '') || fallback || t().common.appName,
      item,
    );
    let n = 1;
    let name = base;
    // 不区分大小写：文件以后可能拷到不区分大小写的文件系统上。
    while (taken.has(name.toLowerCase())) {
      n += 1;
      name = numberedFileName(base, n);
    }
    taken.add(name.toLowerCase());
    names.set(item.id, name);
  }
  return names;
}

/**
 * 交给相册的地址。expo-file-system 只编码空格和少数符号，中文等字符保持原样，
 * 而 Android 的 MimeTypeMap.getFileExtensionFromUrl 遇到这些字符就取不到扩展名，
 * 视频会被当成类型未知的图片。原生层取文件名时会解码，用户看到的名字不变。
 */
export function galleryUri(fileUri: string): string {
  const slash = fileUri.lastIndexOf('/') + 1;
  const name = fileUri
    .slice(slash)
    .replace(/[^a-zA-Z0-9_.\-()%]+/g, (run) =>
      encodeURIComponent(run).replace(
        /[!'~*]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    );
  return `${fileUri.slice(0, slash)}${name}`;
}

// ─── 存到哪里 ────────────────────────────────────────────

/**
 * gallery：系统相册；folder：用户选的文件夹（Android）；share：系统分享面板，可以存到“文件”（iOS）。
 * 证件不进相册：相册是全手机可见、还可能自动上传到云端的地方。
 */
export type SaveTarget = 'gallery' | 'folder' | 'share';

export function saveTargetFor(
  media: { kind: MediaKind },
  options: { sensitive: boolean; platform: string },
): SaveTarget {
  if (!options.sensitive && (media.kind === 'image' || media.kind === 'video')) return 'gallery';
  return options.platform === 'android' ? 'folder' : 'share';
}

// ─── 流程 ────────────────────────────────────────────────

export type DownloadFailure =
  | 'permission'
  | 'not-ready'
  | 'network'
  | 'no-space'
  | 'incomplete'
  | 'save';

export type DownloadOutcome =
  | { status: 'saved'; target: SaveTarget }
  | { status: 'cancelled'; quiet: boolean }
  | { status: 'failed'; reason: DownloadFailure }
  | { status: 'busy' };

/** preparing 和 saving 阶段没有进度可显示；saving 已经在写目标位置，不能再取消。 */
export interface DownloadState {
  phase: 'preparing' | 'downloading' | 'saving';
  fraction: number | null;
}

const failureText = (reason: DownloadFailure): string => {
  const text = t().ui;
  const byReason: Record<DownloadFailure, string> = {
    permission: text.dlPermission,
    'not-ready': text.dlNotReady,
    network: text.dlNetwork,
    'no-space': text.dlNoSpace,
    incomplete: text.dlIncomplete,
    save: text.dlSave,
  };
  return byReason[reason];
};

/**
 * 只用固定文案。原生层的错误信息可能带着签名链接，不能显示，也不能写进日志。
 * 返回 null 表示不用打扰用户。
 */
export function downloadMessage(outcome: DownloadOutcome): string | null {
  switch (outcome.status) {
    case 'saved':
      if (outcome.target === 'gallery') return t().ui.dlSavedGallery;
      return outcome.target === 'folder' ? t().ui.dlSavedFolder : null;
    case 'cancelled':
      return outcome.quiet ? null : t().ui.dlCancelled;
    case 'failed':
      return failureText(outcome.reason);
    case 'busy':
      return null;
  }
}

export class FolderNameTakenError extends Error {}

export interface DownloadRequest {
  media: Pick<MediaRef, 'id' | 'kind' | 'mime' | 'size'>;
  fileName: string;
  /** 证件：不进相册，见 saveTargetFor。 */
  sensitive: boolean;
}

/** 和平台打交道的部分，真实实现在 downloads.ts。 */
export interface DownloadPorts {
  requestGalleryAccess(): Promise<boolean>;
  /** 返回文件夹地址，用户取消时返回 null。 */
  pickFolder(): Promise<string | null>;
  /** 手机上已有的完整副本，比如还在上传队列里的原件。 */
  findLocalCopy(media: DownloadRequest['media']): Promise<string | null>;
  signedUrl(media: DownloadRequest['media']): Promise<string | null>;
  availableBytes(): number;
  /** 准备一个带可读文件名的临时位置，返回地址。 */
  prepareTemp(id: string, fileName: string): string;
  fetchTo(
    url: string,
    tempUri: string,
    options: { signal: AbortSignal; onProgress: (written: number, total: number) => void },
  ): Promise<void>;
  copyInto(from: string, tempUri: string): Promise<void>;
  sizeOf(uri: string): number;
  saveToGallery(tempUri: string): Promise<void>;
  /** 文件夹里已有同名文件时抛 FolderNameTakenError。 */
  saveToFolder(tempUri: string, folder: string): Promise<void>;
  renameTemp(tempUri: string, fileName: string): string;
  share(tempUri: string, mime: string): Promise<void>;
  removeTemp(id: string): void;
}

const MAX_NAME_ATTEMPTS = 50;

class Failed extends Error {
  constructor(public reason: DownloadFailure) {
    super(reason);
  }
}

/**
 * 下载放在页面之外：退出页面不影响它，回到页面还能看到进度。
 * 同一个文件同时只有一份。先选位置、再取链接，这样证件不会在用户犹豫时躺在缓存里，
 * 链接也总是刚签发的。
 */
export function createDownloader(ports: DownloadPorts, options: { platform: string }) {
  const states = new Map<string, DownloadState>();
  const running = new Map<string, { controller: AbortController; quiet: boolean }>();
  const listeners = new Set<() => void>();

  const publish = (id: string, state: DownloadState | null) => {
    if (state) states.set(id, state);
    else states.delete(id);
    for (const listener of listeners) listener();
  };

  async function saveInFolder(tempUri: string, fileName: string, folder: string) {
    let uri = tempUri;
    for (let n = 1; n <= MAX_NAME_ATTEMPTS; n++) {
      if (n > 1) uri = ports.renameTemp(uri, numberedFileName(fileName, n));
      try {
        await ports.saveToFolder(uri, folder);
        return;
      } catch (error) {
        if (!(error instanceof FolderNameTakenError)) throw error;
      }
    }
    throw new Failed('save');
  }

  async function run(request: DownloadRequest, signal: AbortSignal): Promise<SaveTarget | null> {
    const { media, fileName } = request;
    const target = saveTargetFor(media, {
      sensitive: request.sensitive,
      platform: options.platform,
    });
    // React Native 的 AbortSignal 没有 throwIfAborted。
    const stopIfAborted = () => {
      if (signal.aborted) throw new Error('aborted');
    };
    if (media.size > ports.availableBytes()) throw new Failed('no-space');

    let folder: string | null = null;
    if (target === 'gallery' && !(await ports.requestGalleryAccess())) {
      throw new Failed('permission');
    }
    if (target === 'folder') {
      folder = await ports.pickFolder();
      if (!folder) return null;
    }
    stopIfAborted();

    const tempUri = ports.prepareTemp(media.id, fileName);
    const local = await ports.findLocalCopy(media);
    if (local) {
      await ports.copyInto(local, tempUri);
    } else {
      let url: string | null;
      try {
        url = await ports.signedUrl(media);
      } catch {
        throw new Failed('network');
      }
      if (!url) throw new Failed('not-ready');
      stopIfAborted();
      publish(media.id, { phase: 'downloading', fraction: 0 });
      let percent = 0;
      try {
        await ports.fetchTo(url, tempUri, {
          signal,
          onProgress: (written, total) => {
            const whole = total > 0 ? total : media.size;
            if (whole <= 0) return;
            const next = Math.min(100, Math.floor((written / whole) * 100));
            // 原生层事件很密，百分比变了才刷新界面。
            if (next === percent) return;
            percent = next;
            publish(media.id, { phase: 'downloading', fraction: next / 100 });
          },
        });
      } catch (error) {
        if (signal.aborted) throw error;
        throw new Failed('network');
      }
    }
    stopIfAborted();
    if (media.size > 0 && ports.sizeOf(tempUri) !== media.size) throw new Failed('incomplete');

    publish(media.id, { phase: 'saving', fraction: null });
    if (target === 'gallery') await ports.saveToGallery(tempUri);
    else if (target === 'share') await ports.share(tempUri, media.mime);
    else if (folder) await saveInFolder(tempUri, fileName, folder);
    return target;
  }

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    stateOf(id: string): DownloadState | null {
      return states.get(id) ?? null;
    },
    /** 不会抛错，结果都在返回值里。 */
    async start(request: DownloadRequest): Promise<DownloadOutcome> {
      const { id } = request.media;
      if (running.has(id)) return { status: 'busy' };
      const entry = { controller: new AbortController(), quiet: false };
      running.set(id, entry);
      publish(id, { phase: 'preparing', fraction: null });
      try {
        const target = await run(request, entry.controller.signal);
        return target ? { status: 'saved', target } : { status: 'cancelled', quiet: true };
      } catch (error) {
        if (entry.controller.signal.aborted) return { status: 'cancelled', quiet: entry.quiet };
        return { status: 'failed', reason: error instanceof Failed ? error.reason : 'save' };
      } finally {
        try {
          ports.removeTemp(id);
        } catch {
          // 留下的临时文件下次启动时会清掉。
        }
        running.delete(id);
        publish(id, null);
      }
    },
    /** 用户主动取消。保存阶段已经在写目标位置，不能取消。 */
    cancel(id: string) {
      if (states.get(id)?.phase === 'saving') return;
      running.get(id)?.controller.abort();
    },
    /** 退出登录：全部停下，不提示，提示会落到下一个登录的人眼前。 */
    cancelAll() {
      for (const entry of running.values()) {
        entry.quiet = true;
        entry.controller.abort();
      }
    },
  };
}

export type Downloader = ReturnType<typeof createDownloader>;

/** 进度文字：还不知道多少时不显示数字。 */
export function downloadProgressLabel(state: DownloadState | null): string | null {
  if (state?.phase !== 'downloading' || state.fraction === null) return null;
  return `${Math.round(state.fraction * 100)}%`;
}
