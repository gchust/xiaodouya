import type { PublicMedia } from '@xiaodouya/shared';
import type { MediaSlot } from './render';

/**
 * 刚取到的链接还打不开，说明不是过期，是文件本身有问题（比如浏览器放不了的格式）。
 * 这时再取一次没有用，还会一直请求。
 */
const FRESH_MS = 30_000;
/** 放大看图前，链接剩下不到这么久就先换一批，不等它在眼前变成打不开。 */
const EXPIRY_MARGIN_MS = 5 * 60_000;

export type Refetched =
  | { kind: 'ok'; media: PublicMedia[]; expiresIn: number }
  | { kind: 'invalid' }
  | { kind: 'error' };

/**
 * 一批文件链接从哪来：时间线的一页，或者点开的一条回忆。链接 1 小时过期，
 * 打不开时从同一个来源重新取，只换这一批，不用重新加载整个页面。
 */
export interface MediaSource {
  onFailed(slot: MediaSlot): void;
  onRetry(slot: MediaSlot): void;
  /** 链接快过期时先换一批，再交给放大看图。 */
  fresh(items: PublicMedia[]): Promise<PublicMedia[]>;
}

export function createMediaSource(options: {
  media: PublicMedia[];
  expiresIn: number;
  refetch: () => Promise<Refetched>;
  onInvalid: () => void;
  now: () => number;
}): MediaSource {
  const { refetch, onInvalid, now } = options;
  let fetchedAt = now();
  let linksLastMs = options.expiresIn * 1000;
  let latest = new Map(options.media.map((file) => [file.id, file]));
  const failed = new Set<MediaSlot>();
  let refreshing: Promise<void> | null = null;

  async function refresh() {
    const result = await refetch();
    fetchedAt = now();
    const waiting = [...failed];
    failed.clear();
    if (result.kind === 'invalid') {
      onInvalid();
      return;
    }
    if (result.kind !== 'ok') {
      for (const slot of waiting) slot.markBroken();
      return;
    }
    latest = new Map(result.media.map((file) => [file.id, file]));
    linksLastMs = result.expiresIn * 1000;
    for (const slot of waiting) slot.update(latest.get(slot.id));
  }

  function refreshOnce() {
    refreshing ??= refresh().finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  return {
    onFailed(slot) {
      if (now() - fetchedAt < FRESH_MS) {
        slot.markBroken();
        return;
      }
      failed.add(slot);
      void refreshOnce();
    },
    onRetry(slot) {
      failed.add(slot);
      void refreshOnce();
    },
    async fresh(items) {
      if (now() - fetchedAt > linksLastMs - EXPIRY_MARGIN_MS) await refreshOnce();
      return items.map((item) => latest.get(item.id) ?? item);
    },
  };
}
