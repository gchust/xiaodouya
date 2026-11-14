import { type MediaRef, type WidgetPrefs, widgetAvatarKey, widgetBabyId } from '@xiaodouya/shared';
import { Directory, File, Paths } from 'expo-file-system';
import { ImageManipulator, type ImageRef, SaveFormat } from 'expo-image-manipulator';
import type { CoreServices } from '../data/services';
import { localUriFor } from '../lib/media';
import { avatarFileName, squareCrop, staleAvatarFiles, WIDGET_AVATAR_PX } from './avatarFile';
import { readWidgetPrefs } from './prefs';
import type { WidgetAvatarUri } from './views';

/**
 * 小工具上的头像：一张缩小、裁成正方形的 JPEG，放在 App 私有的 document 目录。
 * 小工具画图时只读这个文件，不联网：后台任务可能在没网时跑，签名链接也会过期。
 * 文件由 App 在前台准备（`updateWidgetAvatar`），家人换了头像而 App 没打开时，
 * 键对不上就不显示，回到原来的色点，不会显示旧头像。
 */
const DIR_NAME = 'widget-avatar';
/** 解码时就限制大小，原图可能有上亿像素，而这里只要 128 px。 */
const DECODE_MAX_SIDE = 512;
/** 同一张头像拿不到文件（还没传完、没网）时，隔一会儿再试，不要每次刷新都请求。 */
const RETRY_MS = 60_000;

function avatarDir(): Directory {
  const dir = new Directory(Paths.document, DIR_NAME);
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  return dir;
}

/** 小工具渲染时用：有这张头像的缓存就给出 data URI，没有就是 null。 */
export async function readWidgetAvatar(key: string): Promise<WidgetAvatarUri | null> {
  try {
    const file = new File(avatarDir(), avatarFileName(key));
    if (!file.exists) return null;
    return `data:image/jpeg;base64,${await file.base64()}`;
  } catch {
    return null;
  }
}

/** 退出登录、删除账号时清掉。也在 `clearLocalMedia` 里调用。 */
export function clearWidgetAvatars(): void {
  try {
    const dir = new Directory(Paths.document, DIR_NAME);
    if (dir.exists) dir.delete();
  } catch {
    // 清不掉不影响退出；下次准备头像时会把不是当前头像的文件删掉。
  }
}

function prune(dir: Directory, key: string | null): boolean {
  let changed = false;
  for (const entry of dir.list()) {
    if (!(entry instanceof File) || !staleAvatarFiles([entry.name], key).length) continue;
    try {
      entry.delete();
      changed = true;
    } catch {
      // 下次再删。
    }
  }
  return changed;
}

/** 本机有副本（这台手机刚换的头像）就不走网络；否则下载缩略图，没有缩略图时用预览图。 */
async function sourceFor(
  core: Pick<CoreServices, 'api'>,
  avatar: MediaRef,
  temp: File,
): Promise<string | null> {
  const local = localUriFor(avatar.id, 'thumb') ?? localUriFor(avatar.id, 'original');
  if (local) return local;
  const { urls } = await core.api.mediaUrls([
    { id: avatar.id, variant: 'thumb' },
    { id: avatar.id, variant: 'preview' },
  ]);
  const url = urls.find((u) => u.variant === 'thumb' && u.url)?.url ?? urls.find((u) => u.url)?.url;
  if (!url) return null;
  if (temp.exists) temp.delete();
  await File.downloadFileAsync(url, temp);
  return temp.uri;
}

/** 解码后的图在原生内存里，JS 的垃圾回收感觉不到，每一步都要自己放掉。 */
async function writeSquare(source: string, target: File): Promise<void> {
  const refs: ImageRef[] = [];
  const decode = ImageManipulator.manipulate(source, {
    maxWidth: DECODE_MAX_SIDE,
    maxHeight: DECODE_MAX_SIDE,
  });
  try {
    const decoded = await decode.renderAsync();
    refs.push(decoded);
    const shape = ImageManipulator.manipulate(decoded)
      .crop(squareCrop(decoded.width, decoded.height))
      .resize({ width: WIDGET_AVATAR_PX, height: WIDGET_AVATAR_PX });
    try {
      const square = await shape.renderAsync();
      refs.push(square);
      const saved = await square.saveAsync({ format: SaveFormat.JPEG, compress: 0.85 });
      if (target.exists) target.delete();
      await new File(saved.uri).move(target);
    } finally {
      shape.release();
    }
  } finally {
    for (const ref of refs) ref.release();
    decode.release();
  }
}

/** 小工具上那个宝宝的头像：固定给哪个宝宝记就是谁的（issue #106）。 */
function widgetAvatar(store: CoreServices['store'], prefs: WidgetPrefs) {
  const snapshot = store.getSnapshot();
  const babyId = widgetBabyId(prefs, snapshot.babies, snapshot.baby?.id ?? null);
  return store.viewFor(babyId).baby?.data.avatar;
}

let running: Promise<boolean> | null = null;
let rerun = false;
let lastMiss: { key: string; at: number } | null = null;

async function update(core: Pick<CoreServices, 'api' | 'db' | 'store'>): Promise<boolean> {
  const prefs = await readWidgetPrefs(core.db);
  const avatar = widgetAvatar(core.store, prefs);
  const key = widgetAvatarKey(prefs, avatar);
  const dir = avatarDir();
  let changed = prune(dir, key);
  if (!key || !avatar) return changed;
  const target = new File(dir, avatarFileName(key));
  if (target.exists) return changed;
  if (lastMiss?.key === key && Date.now() - lastMiss.at < RETRY_MS) return changed;
  const temp = new File(dir, `${key}.download`);
  try {
    const source = await sourceFor(core, avatar, temp);
    if (!source) {
      lastMiss = { key, at: Date.now() };
      return changed;
    }
    await writeSquare(source, target);
    lastMiss = null;
    changed = true;
  } catch {
    // 不把错误往外抛也不记日志：里面可能带着签名链接。下一次刷新再试。
    lastMiss = { key, at: Date.now() };
  } finally {
    if (temp.exists) temp.delete();
  }
  // 等的这段时间里可能关了开关或者换了头像：再对一次，删掉不该留的。
  const latestPrefs = await readWidgetPrefs(core.db);
  const latest = widgetAvatarKey(latestPrefs, widgetAvatar(core.store, latestPrefs));
  if (latest !== key) prune(dir, latest);
  return changed;
}

/**
 * 让缓存和现在的头像、开关对上：该有的准备好，不该留的删掉。返回有没有变化，变了要重画小工具。
 * 同时只跑一份；跑的时候又被叫到，跑完再来一轮。
 */
export async function updateWidgetAvatar(
  core: Pick<CoreServices, 'api' | 'db' | 'store'>,
): Promise<boolean> {
  if (running) {
    rerun = true;
    return running;
  }
  running = (async () => {
    let changed = false;
    try {
      do {
        rerun = false;
        changed = (await update(core).catch(() => false)) || changed;
      } while (rerun);
    } finally {
      running = null;
    }
    return changed;
  })();
  return running;
}
