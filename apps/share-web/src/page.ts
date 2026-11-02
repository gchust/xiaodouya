import type { PublicMedia, PublicShareResponse } from '@xiaodouya/shared';
import { type ApiTarget, loadShare } from './api';
import { openLightbox } from './lightbox';
import { type MediaSlot, renderError, renderInvalid, renderLoading, renderShare } from './render';

/**
 * 刚取到的链接还打不开，说明不是过期，是文件本身有问题（比如浏览器放不了的格式）。
 * 这时再取一次没有用，还会一直请求。
 */
const FRESH_MS = 30_000;
/** 放大看图前，链接剩下不到这么久就先换一批，不等它在眼前变成打不开。 */
const EXPIRY_MARGIN_MS = 5 * 60_000;

export interface SharePageOptions {
  root: HTMLElement;
  token: string | null;
  api: ApiTarget;
  allowLocalHttp: boolean;
  fetcher?: typeof fetch;
  now?: () => number;
  photo?: typeof openLightbox;
}

function mediaById(data: PublicShareResponse): Map<string, PublicMedia> {
  return new Map(data.moments.flatMap((m) => m.media.map((file) => [file.id, file] as const)));
}

export function createSharePage({
  root,
  token,
  api,
  allowLocalHttp,
  fetcher,
  now = Date.now,
  photo = openLightbox,
}: SharePageOptions) {
  let lastFetchAt = 0;
  let linksLastMs = 0;
  let latest = new Map<string, PublicMedia>();
  let invalidated = false;
  let refreshing: Promise<void> | null = null;
  const failed = new Set<MediaSlot>();
  let closePhoto: (() => void) | null = null;

  const showInvalid = () => {
    invalidated = true;
    closePhoto?.();
    failed.clear();
    renderInvalid(root);
  };

  /** 文件的链接 1 小时过期。页面开得比这久时，打不开就重新取一次数据。 */
  async function refresh() {
    if (!token) return;
    const result = await loadShare(api, token, fetcher);
    lastFetchAt = now();
    const waiting = [...failed];
    failed.clear();
    if (result.kind === 'invalid') {
      showInvalid();
      return;
    }
    if (result.kind !== 'ok') {
      for (const slot of waiting) slot.markBroken();
      return;
    }
    latest = mediaById(result.data);
    linksLastMs = result.data.mediaExpiresIn * 1000;
    for (const slot of waiting) slot.update(latest.get(slot.id));
  }

  function refreshOnce() {
    refreshing ??= refresh().finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  function onMediaFailed(slot: MediaSlot) {
    if (now() - lastFetchAt < FRESH_MS) {
      slot.markBroken();
      return;
    }
    failed.add(slot);
    void refreshOnce();
  }

  function onMediaRetry(slot: MediaSlot) {
    failed.add(slot);
    void refreshOnce();
  }

  async function load() {
    invalidated = false;
    if (!token) {
      showInvalid();
      return;
    }
    renderLoading(root);
    const result = await loadShare(api, token, fetcher);
    lastFetchAt = now();
    switch (result.kind) {
      case 'ok':
        latest = mediaById(result.data);
        linksLastMs = result.data.mediaExpiresIn * 1000;
        renderShare(root, result.data, {
          now: now(),
          allowLocalHttp,
          onMediaFailed,
          onMediaRetry,
          onPhoto: (items, index) => {
            const open = () => {
              if (invalidated) return;
              const current = items.map((item) => latest.get(item.id) ?? item);
              closePhoto = photo(current, index, allowLocalHttp);
            };
            if (now() - lastFetchAt > linksLastMs - EXPIRY_MARGIN_MS) void refreshOnce().then(open);
            else open();
          },
        });
        break;
      case 'invalid':
        showInvalid();
        break;
      case 'busy':
      case 'error':
        renderError(root, result.kind === 'busy', () => void load());
        break;
    }
  }

  return { load };
}
