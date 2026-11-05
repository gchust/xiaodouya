import {
  type PublicMedia,
  type PublicTimelineEntry,
  type PublicTimelineMomentResponse,
  t,
  zonedClock,
} from '@xiaodouya/shared';
import type { Loaded } from './api';
import { createMediaSource } from './mediaSource';
import { audioPlayer, el, galleryGrid, type MediaSlot, type RenderContext } from './render';

export interface MomentViewOptions {
  entry: PublicTimelineEntry;
  timezone: string;
  dateText: string;
  allowLocalHttp: boolean;
  now: () => number;
  load: () => Promise<Loaded<PublicTimelineMomentResponse>>;
  onInvalid: () => void;
  /** 放大看图，返回关掉它的函数。 */
  photo: (items: PublicMedia[], index: number) => () => void;
}

/** 关掉时要先停下：从页面上拿掉的 audio、video 在浏览器里还会接着放。 */
function stopMedia(root: HTMLElement) {
  for (const node of root.querySelectorAll('audio, video')) {
    (node as HTMLMediaElement).pause?.();
  }
}

/**
 * 点开时间线上的一条回忆：全屏的一页，照片和视频排成相册，录音用系统播放器，文字在下面。
 * 文件是这时才取的，所以时间线一页只用签封面。所有内容都用 textContent 写入。
 */
export function openMomentView(options: MomentViewOptions): () => void {
  const { entry, timezone, allowLocalHttp, now, load, onInvalid, photo } = options;
  const opener = document.activeElement as HTMLElement | null;
  const overlay = el('div', 'sheet');
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', entry.title.trim() || t().share.openMomentUntitled);
  const bar = el('div', 'sheet-bar');
  const close = el('button', 'sheet-close', '×');
  close.type = 'button';
  close.setAttribute('aria-label', t().share.closeMoment);
  bar.append(close);
  const body = el('div', 'sheet-body');
  overlay.append(bar, body);

  body.append(el('p', 'hero-date', `${options.dateText} · ${zonedClock(entry.at, timezone)}`));
  if (entry.milestone) body.append(el('span', 'tag', t().share.milestone));
  if (entry.title.trim()) body.append(el('h2', 'moment-title', entry.title));
  const files = el('div', 'sheet-files');
  body.append(files);
  if (entry.text.trim()) body.append(el('p', 'moment-text', entry.text));
  if (entry.byName) body.append(el('p', 'entry-detail', t().share.wroteBy(entry.byName)));

  let closed = false;
  let closePhoto: (() => void) | null = null;

  const render = (data: PublicTimelineMomentResponse) => {
    const source = createMediaSource({
      media: data.media,
      expiresIn: data.mediaExpiresIn,
      now,
      onInvalid,
      refetch: async () => {
        const result = await load();
        return result.kind === 'ok'
          ? { kind: 'ok', media: result.data.media, expiresIn: result.data.mediaExpiresIn }
          : result.kind === 'invalid'
            ? { kind: 'invalid' }
            : { kind: 'error' };
      },
    });
    const ctx: RenderContext = {
      now: now(),
      allowLocalHttp,
      onMediaFailed: (slot) => source.onFailed(slot),
      onMediaRetry: (slot) => source.onRetry(slot),
      onPhoto: (items, index) => {
        void source.fresh(items).then((current) => {
          if (!closed) closePhoto = photo(current, index);
        });
      },
    };
    const slots: MediaSlot[] = [];
    files.replaceChildren();
    const visual = data.media.filter((file) => file.kind !== 'audio');
    if (visual.length > 0) {
      files.append(galleryGrid(visual, () => entry.title, ctx, slots));
    }
    for (const file of data.media) {
      if (file.kind !== 'audio') continue;
      const { node, slot } = audioPlayer(file, ctx);
      files.append(node);
      slots.push(slot);
    }
    if (data.omittedMedia > 0) {
      files.append(el('p', 'note', t().share.omittedMedia(data.omittedMedia)));
    }
  };

  const fetchFiles = async () => {
    files.replaceChildren();
    const loading = el('div', 'sheet-loading');
    loading.setAttribute('role', 'status');
    loading.setAttribute('aria-label', t().share.loading);
    files.append(loading);
    const result = await load();
    if (closed) return;
    if (result.kind === 'ok') {
      render(result.data);
      return;
    }
    if (result.kind === 'invalid') {
      onInvalid();
      return;
    }
    files.replaceChildren();
    const retry = el('button', 'more-button', t().share.loadMoreFailed);
    retry.type = 'button';
    retry.addEventListener('click', () => void fetchFiles());
    files.append(retry);
  };

  const onKey = (event: KeyboardEvent) => {
    // 放大的照片在上面时，Esc 先关照片。
    if (event.key === 'Escape' && !document.querySelector('.lightbox')) dismiss();
  };

  function dismiss() {
    if (closed) return;
    closed = true;
    closePhoto?.();
    stopMedia(overlay);
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    document.documentElement.classList.remove('sheet-open');
    opener?.focus?.();
  }

  close.addEventListener('click', dismiss);
  document.addEventListener('keydown', onKey);
  document.documentElement.classList.add('sheet-open');
  document.body.append(overlay);
  close.focus();
  if (entry.visualCount + entry.audioCount > 0) void fetchFiles();
  return dismiss;
}
