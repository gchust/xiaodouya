import { t } from '../i18n';
import {
  type FavoriteData,
  type FavoriteFolderData,
  type FavoriteTarget,
  favoriteTargets,
  MAX_RESOURCE_URL,
} from '../schemas';
import { parseWebUrl } from './webUrl';

/**
 * 育儿资料和收藏（issue #98）的纯规则：认来源、整理链接、从分享的文字里取链接和标题、收藏和收藏夹。
 * 见 docs/ARCHITECTURE.md 的“育儿资料和收藏”。
 */

export const resourceSources = ['douyin', 'bilibili', 'youtube', 'xiaohongshu', 'other'] as const;
export type ResourceSource = (typeof resourceSources)[number];

/**
 * 每个平台的域名，包括分享出来的短链（v.douyin.com、b23.tv、youtu.be、xhslink.com）。
 * 新增平台只加这里和 i18n 的名字。
 */
const SOURCE_DOMAINS: Record<Exclude<ResourceSource, 'other'>, readonly string[]> = {
  douyin: ['douyin.com', 'iesdouyin.com'],
  bilibili: ['bilibili.com', 'b23.tv', 'bili2233.cn'],
  youtube: ['youtube.com', 'youtu.be', 'youtube-nocookie.com'],
  xiaohongshu: ['xiaohongshu.com', 'xhslink.com'],
};

/** 按主机名的结尾认，并且在点的边界上：`notyoutube.com`、`youtu.be.evil.example` 都不算。 */
export function resourceSource(url: string): ResourceSource {
  const host = parseWebUrl(url)?.host;
  if (!host) return 'other';
  for (const [source, domains] of Object.entries(SOURCE_DOMAINS)) {
    if (domains.some((domain) => host === domain || host.endsWith(`.${domain}`))) {
      return source as ResourceSource;
    }
  }
  return 'other';
}

export function resourceSourceLabel(source: ResourceSource): string {
  return t().library.sources[source];
}

/** 没填标题时用的，比如 `B站视频`。填个链接就能存。 */
export function defaultResourceTitle(source: ResourceSource): string {
  return t().library.defaultTitles[source];
}

/** 链接后面紧跟的中文标点、括号不算链接（小红书的分享文字是“链接，复制本条信息……”）。 */
const URL_IN_TEXT = /https?:\/\/[^\s　-〿＀-￯一-鿿"'<>「」【】]+/i;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"]+$/;

function findUrl(text: string): { url: string; index: number } | null {
  const match = URL_IN_TEXT.exec(text);
  if (!match) return null;
  const url = match[0].replace(TRAILING_PUNCTUATION, '');
  if (url.length > MAX_RESOURCE_URL || !parseWebUrl(url)) return null;
  return { url, index: match.index };
}

/**
 * 用户粘贴或输入的链接。可以是一整段分享文字，取出里面的链接；没写协议的（`b23.tv/AbC`）补上 https。
 * 不是网页链接时返回 null。
 */
export function normalizeResourceUrl(input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  const found = findUrl(text);
  if (found) return found.url;
  // 没有协议：只在整段像一个域名开头的地址时补，不能把一句话当成链接。
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+([/?#]\S*)?$/i.test(text)) {
    const url = `https://${text}`;
    return url.length <= MAX_RESOURCE_URL && parseWebUrl(url) ? url : null;
  }
  return null;
}

const MAX_TITLE = 100;

/** 各平台分享文字里不是标题的部分。只影响预填的标题，用户还能改。 */
const BOILERPLATE: readonly RegExp[] = [
  /复制打开抖音，?看看/g,
  /[，,]?\s*复制本条信息，?打开【小红书】App查看精彩内容[！!]?/g,
  /😆\s*[A-Za-z0-9]+\s*😆/g,
];

function cleanTitle(text: string): string {
  let title = text;
  for (const pattern of BOILERPLATE) title = title.replace(pattern, ' ');
  title = title
    // 开头的口令数字（`7.94 `）
    .replace(/^\s*\d+(\.\d+)?\s+/, '')
    // 结尾的话题（`# 辅食 # 育儿`）
    .replace(/(\s*#\s*[^\s#]+)+\s*$/, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,，:：]+|[\s,，:：]+$/g, '');
  return title.length > MAX_TITLE ? `${title.slice(0, MAX_TITLE - 1)}…` : title;
}

/**
 * 从别的 App 分享过来（或粘贴）的一段文字里取链接和标题。
 *
 * - B站：`【标题-哔哩哔哩】 https://b23.tv/…`
 * - 抖音：`7.94 复制打开抖音，看看【某某的作品】描述 # 话题 https://v.douyin.com/…/ 口令`
 * - 小红书：`标题 http://xhslink.com/a/…，复制本条信息，打开【小红书】App查看精彩内容！`
 * - YouTube：只有链接，标题在分享的主题（Android 的 EXTRA_SUBJECT）里
 *
 * 没有链接时返回 null。取不到标题时没有 `title`，界面用默认标题。
 */
export function parseSharedText(
  text: string,
  subject?: string | null,
): { url: string; title?: string } | null {
  const found = findUrl(text);
  if (!found) return null;
  const { url } = found;
  const fromSubject = subject ? cleanTitle(subject) : '';
  if (fromSubject && !findUrl(fromSubject)) return { url, title: fromSubject };

  const before = text.slice(0, found.index);
  let title = '';
  const bracket = /【([^】]+)】([^【]*)$/.exec(before);
  if (bracket?.[1]) {
    const inside = bracket[1].replace(/[-_]哔哩哔哩.*$/, '').trim();
    const rest = cleanTitle(bracket[2] ?? '');
    title = rest || cleanTitle(inside);
  } else {
    title = cleanTitle(before);
  }
  if (!title) {
    const after = cleanTitle(text.slice(found.index + found.url.length));
    // 链接后面通常是口令和提示，只有像一句话时才用
    if (/[\p{L}]{2,}/u.test(after) && !/^[\w@:/.\s]+$/.test(after)) title = after;
  }
  return title ? { url, title } : { url };
}

// ─── 收藏 ───────────────────────────────────────────────────

/**
 * 收藏记录的 id：把目标 id 的每一位十六进制数取反，版本位和变体位不动，还是合法的 UUID。
 * 两台手机离线收藏同一条，得到同一个 id，同步时后写胜出，不会多出一条。
 * 不能直接用目标的 id：服务端不接受一个 id 换集合（回忆在 `moment`，收藏在 `event`）。
 */
export function favoriteIdFor(targetId: string): string {
  const lower = targetId.toLowerCase();
  let out = '';
  for (let i = 0; i < lower.length; i++) {
    const ch = lower[i] as string;
    // 第 14 位是版本，第 19 位是变体
    if (ch === '-' || i === 14 || i === 19) out += ch;
    else out += (15 - Number.parseInt(ch, 16)).toString(16);
  }
  return out;
}

interface Entry<T> {
  id: string;
  data: T;
  updatedAt: number;
}

export interface FavoriteItem {
  target: FavoriteTarget;
  targetId: string;
  /** 收藏这条记录本身的 id。 */
  favoriteId: string;
  data: FavoriteData;
}

/**
 * 收藏列表：新收藏的在前。目标删掉了（或这台手机读不到）就不显示；不认识的目标类型跳过。
 * 同一个目标有几条收藏（按规则不会有，留个底）时取最近改的那条。
 */
export function favoriteItems(input: {
  favorites: readonly Entry<FavoriteData>[];
  resourceIds: ReadonlySet<string>;
  momentIds: ReadonlySet<string>;
  /** 只看这个收藏夹里的。 */
  folderId?: string | null;
}): FavoriteItem[] {
  const byTarget = new Map<string, Entry<FavoriteData>>();
  for (const entry of input.favorites) {
    const known = (favoriteTargets as readonly string[]).includes(entry.data.target);
    if (!known) continue;
    const ids = entry.data.target === 'moment' ? input.momentIds : input.resourceIds;
    if (!ids.has(entry.data.targetId)) continue;
    const prev = byTarget.get(entry.data.targetId);
    if (!prev || entry.updatedAt > prev.updatedAt) byTarget.set(entry.data.targetId, entry);
  }
  const folderId = input.folderId;
  return [...byTarget.values()]
    .filter((e) => !folderId || (e.data.folders ?? []).includes(folderId))
    .sort((a, b) => b.data.addedAt - a.data.addedAt || a.id.localeCompare(b.id))
    .map((e) => ({
      target: e.data.target as FavoriteTarget,
      targetId: e.data.targetId,
      favoriteId: e.id,
      data: e.data,
    }));
}

/** 每个还在的收藏夹里有几项。被删掉的收藏夹不算。 */
export function favoriteFolderCounts(
  items: readonly FavoriteItem[],
  liveFolderIds: ReadonlySet<string>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    for (const folder of new Set(item.data.folders ?? [])) {
      if (liveFolderIds.has(folder)) counts.set(folder, (counts.get(folder) ?? 0) + 1);
    }
  }
  return counts;
}

/** 放进或拿出一个收藏夹。别的字段（包括新版本的未知字段）不动。 */
export function withFolderToggled<T extends FavoriteData>(data: T, folderId: string): T {
  const folders = data.folders ?? [];
  return {
    ...data,
    folders: folders.includes(folderId)
      ? folders.filter((f) => f !== folderId)
      : [...folders, folderId],
  };
}

/** 收藏夹按建的先后排，新建的在最后，胶囊的位置不会跳。 */
export function sortedFolders<T extends Entry<FavoriteFolderData>>(folders: readonly T[]): T[] {
  return [...folders].sort(
    (a, b) => a.data.createdAt - b.data.createdAt || a.id.localeCompare(b.id),
  );
}
