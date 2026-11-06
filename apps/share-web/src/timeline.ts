import {
  agePartsText,
  dayNumberLabel,
  formatDateHeader,
  formatFullDate,
  formatMediaDuration,
  type PublicMedia,
  type PublicTimelineEntry,
  type PublicTimelineResponse,
  t,
  timelineRangeText,
  zonedCalendarDate,
  zonedClock,
  zonedParts,
} from '@xiaodouya/shared';
import { type ApiTarget, loadTimelineMoment, loadTimelinePage } from './api';
import { openLightbox } from './lightbox';
import { createMediaSource, type MediaSource } from './mediaSource';
import { openMomentView } from './momentView';
import {
  el,
  heroAvatar,
  imageTile,
  type MediaSlot,
  pageFooter,
  type RenderContext,
  renderError,
  renderInvalid,
  renderLoading,
  videoFrame,
} from './render';

/**
 * 时间线的分享页（F-133）：按日期分组，新的在前，每条回忆显示封面，往下滑自动加载更早的。
 * 所有内容都用 textContent 写入，地址写进 src 之前都过 `safeMediaUrl`（在 render.ts 里）。
 */

export interface TimelinePageOptions {
  root: HTMLElement;
  token: string | null;
  api: ApiTarget;
  allowLocalHttp: boolean;
  fetcher?: typeof fetch;
  now?: () => number;
  photo?: typeof openLightbox;
  /** 底部的“加载更多”进入视野时调用 `onVisible`。默认用 IntersectionObserver；没有它时只能点按钮。 */
  watch?: (target: HTMLElement, onVisible: () => void) => () => void;
}

/** 提前一屏开始取下一页，滑到底时已经有了。 */
const PRELOAD_MARGIN = '800px 0px';

function intersectionWatch(target: HTMLElement, onVisible: () => void): () => void {
  if (typeof IntersectionObserver === 'undefined') return () => {};
  const observer = new IntersectionObserver(
    (records) => {
      if (records.some((record) => record.isIntersecting)) onVisible();
    },
    { rootMargin: PRELOAD_MARGIN },
  );
  observer.observe(target);
  return () => observer.disconnect();
}

const dayKey = (at: number, timezone: string) => {
  const { year, month, day } = zonedParts(at, timezone);
  return `${year}-${month}-${day}`;
};

function pageHeader(
  data: PublicTimelineResponse,
  now: number,
  allowLocalHttp: boolean,
): HTMLElement {
  const { timezone } = data.range;
  const header = el('header', 'hero');
  const avatar = heroAvatar(data.baby.avatarUrl, allowLocalHttp);
  if (avatar) header.append(avatar);
  header.append(
    el(
      'p',
      'hero-date',
      timelineRangeText(data.range, now, (ms) => zonedCalendarDate(ms, timezone).getTime()),
    ),
  );
  const name = data.baby.name || t().share.fallbackName;
  header.append(
    el(
      'h1',
      'hero-title',
      data.kind === 'moments'
        ? t().share.momentsPageTitle(name)
        : t().share.timelinePageTitle(name),
    ),
  );
  if (data.baby.age) header.append(el('p', 'hero-age', agePartsText(data.baby.age)));
  return header;
}

function dateText(at: number, timezone: string, now: number): string {
  const day = zonedCalendarDate(at, timezone).getTime();
  const thisYear = zonedCalendarDate(now, timezone).getFullYear();
  return new Date(day).getFullYear() === thisYear ? formatDateHeader(day) : formatFullDate(day);
}

export function createTimelinePage({
  root,
  token,
  api,
  allowLocalHttp,
  fetcher,
  now = Date.now,
  photo = openLightbox,
  watch = intersectionWatch,
}: TimelinePageOptions) {
  let invalidated = false;
  /** 打开着的回忆和放大的照片。链接失效时一起关掉。 */
  const overlays = new Set<() => void>();
  let stopWatching: (() => void) | null = null;
  let timezone = '';
  /** 选中回忆的链接（F-136）没有“更早的”可言，结尾和空的说法不一样。 */
  let selected = false;
  let cursor: string | null = null;
  let loading = false;
  let moreFailed = false;
  let shown = 0;
  let list: HTMLElement | null = null;
  let more: HTMLElement | null = null;
  let lastDay: { key: string; entries: HTMLElement } | null = null;

  const showInvalid = () => {
    invalidated = true;
    stopWatching?.();
    for (const close of [...overlays]) close();
    overlays.clear();
    renderInvalid(root);
  };

  const openPhoto = (items: PublicMedia[], index: number) => {
    if (invalidated) return () => {};
    const close = photo(items, index, allowLocalHttp);
    overlays.add(close);
    return close;
  };

  function openMoment(entry: PublicTimelineEntry) {
    if (invalidated || !token) return;
    const close = openMomentView({
      entry,
      timezone,
      dateText: dateText(entry.at, timezone, now()),
      allowLocalHttp,
      now,
      load: () => loadTimelineMoment(api, token, entry.id, fetcher),
      onInvalid: showInvalid,
      photo: openPhoto,
    });
    overlays.add(close);
  }

  /** 封面。只有一张照片时点开直接放大，只有一个视频时就在这里播放，其他情况打开整条回忆。 */
  function coverNode(
    entry: PublicTimelineEntry,
    cover: PublicMedia,
    ctx: RenderContext,
    slots: MediaSlot[],
  ): HTMLElement {
    const single = entry.visualCount === 1 && entry.audioCount === 0;
    if (cover.kind === 'video' && (single || !cover.thumbUrl)) {
      const { node, slot } = videoFrame(cover, ctx);
      node.classList.add('tl-cover');
      slots.push(slot);
      return node;
    }
    const frame = el('div', 'frame tl-cover');
    const onOpen =
      single && cover.kind === 'image' ? () => ctx.onPhoto([cover], 0) : () => openMoment(entry);
    // 视频的封面用它的缩略图；视频文件本身不能当图片显示。
    const asImage = (media: PublicMedia): PublicMedia =>
      media.kind === 'video' ? { ...media, url: null } : media;
    const inner = imageTile(asImage(cover), frame, entry.title, ctx, onOpen);
    const button = frame.querySelector('button');
    if (button && !(single && cover.kind === 'image')) {
      button.setAttribute(
        'aria-label',
        entry.title.trim() ? t().share.openMoment(entry.title) : t().share.openMomentUntitled,
      );
      button.classList.add('tile-open');
    }
    slots.push({
      id: cover.id,
      update: (next) => inner.update(next && asImage(next)),
      markBroken: () => inner.markBroken(),
    });
    if (cover.kind === 'video') {
      frame.append(
        el(
          'span',
          'duration',
          cover.durationMs ? `▶ ${formatMediaDuration(cover.durationMs)}` : '▶',
        ),
      );
    }
    if (entry.visualCount > 1) {
      frame.append(el('span', 'tl-count', t().share.itemsTotal(entry.visualCount)));
    }
    return frame;
  }

  function entryNode(entry: PublicTimelineEntry, ctx: RenderContext, slots: MediaSlot[]) {
    const node = el('article', 'tl-entry');
    const head = el('div', 'tl-entry-head');
    if (entry.title.trim()) head.append(el('h3', 'moment-title', entry.title));
    if (entry.milestone) head.append(el('span', 'tag', t().share.milestone));
    head.append(el('time', 'tl-time', zonedClock(entry.at, timezone)));
    node.append(head);
    if (entry.cover) node.append(coverNode(entry, entry.cover, ctx, slots));
    else if (entry.visualCount > 0) {
      // 有照片但这次一个链接都没签出来：留一个能点开整条回忆的入口，不让内容悄悄消失。
      const open = el('button', 'more-button', t().share.itemsTotal(entry.visualCount));
      open.type = 'button';
      open.addEventListener('click', () => openMoment(entry));
      node.append(open);
    }
    if (entry.audioCount > 0) {
      const audio = el('button', 'tl-audio', `▶ ${t().share.audioCount(entry.audioCount)}`);
      audio.type = 'button';
      audio.setAttribute(
        'aria-label',
        entry.title.trim() ? t().share.openMoment(entry.title) : t().share.openMomentUntitled,
      );
      audio.addEventListener('click', () => openMoment(entry));
      node.append(audio);
    }
    if (entry.text.trim()) node.append(el('p', 'moment-text', entry.text));
    if (entry.byName) node.append(el('p', 'entry-detail', t().share.wroteBy(entry.byName)));
    return node;
  }

  function dayGroup(entry: PublicTimelineEntry): HTMLElement {
    const key = dayKey(entry.at, timezone);
    if (lastDay?.key === key) return lastDay.entries;
    const section = el('section', 'tl-day');
    const head = el('header', 'tl-day-head');
    head.append(el('h2', 'tl-date', dateText(entry.at, timezone, now())));
    if (entry.dayNumber !== null)
      head.append(el('span', 'tl-daynum', dayNumberLabel(entry.dayNumber)));
    const entries = el('div', 'tl-entries');
    section.append(head, entries);
    list?.append(section);
    lastDay = { key, entries };
    return entries;
  }

  function sourceFor(page: PublicTimelineResponse, pageCursor: string | undefined): MediaSource {
    const covers = page.entries.flatMap((entry) => (entry.cover ? [entry.cover] : []));
    return createMediaSource({
      media: covers,
      expiresIn: page.mediaExpiresIn,
      now,
      onInvalid: showInvalid,
      refetch: async () => {
        if (!token) return { kind: 'invalid' };
        const result = await loadTimelinePage(api, token, pageCursor, fetcher);
        if (result.kind === 'ok') {
          return {
            kind: 'ok',
            media: result.data.entries.flatMap((entry) => (entry.cover ? [entry.cover] : [])),
            expiresIn: result.data.mediaExpiresIn,
          };
        }
        return result.kind === 'invalid' ? { kind: 'invalid' } : { kind: 'error' };
      },
    });
  }

  function appendPage(page: PublicTimelineResponse, pageCursor: string | undefined) {
    const source = sourceFor(page, pageCursor);
    const ctx: RenderContext = {
      now: now(),
      allowLocalHttp,
      onMediaFailed: (slot) => source.onFailed(slot),
      onMediaRetry: (slot) => source.onRetry(slot),
      onPhoto: (items, index) => {
        void source.fresh(items).then((current) => openPhoto(current, index));
      },
    };
    const slots: MediaSlot[] = [];
    for (const entry of page.entries) dayGroup(entry).append(entryNode(entry, ctx, slots));
    shown += page.entries.length;
    cursor = page.nextCursor;
  }

  function renderMore() {
    if (!more) return;
    more.replaceChildren();
    if (cursor !== null) {
      const button = el(
        'button',
        'more-button',
        loading
          ? t().share.loadingMore
          : moreFailed
            ? t().share.loadMoreFailed
            : t().share.loadMore,
      );
      button.type = 'button';
      button.disabled = loading;
      button.addEventListener('click', () => void loadMore());
      more.append(button);
    } else if (shown > 0 && !selected) {
      more.append(el('p', 'note', t().share.timelineEnd));
    }
  }

  /** 内容排完后底部还在视野里（一页太短、或者整页都是空的回忆）就接着取。 */
  function rewatch() {
    stopWatching?.();
    stopWatching = null;
    if (more && cursor !== null && !moreFailed && !invalidated) {
      stopWatching = watch(more, () => void loadMore());
    }
  }

  async function loadMore() {
    if (loading || cursor === null || invalidated || !token) return;
    const pageCursor = cursor;
    loading = true;
    moreFailed = false;
    renderMore();
    const result = await loadTimelinePage(api, token, pageCursor, fetcher);
    loading = false;
    if (invalidated) return;
    if (result.kind === 'invalid') {
      showInvalid();
      return;
    }
    if (result.kind === 'ok') appendPage(result.data, pageCursor);
    else moreFailed = true;
    if (shown === 0 && cursor === null) renderEmpty();
    renderMore();
    rewatch();
  }

  function renderEmpty() {
    const empty = el('section', 'state state-soft');
    empty.append(
      el('p', 'state-title', selected ? t().share.momentsEmptyTitle : t().share.timelineEmptyTitle),
    );
    empty.append(
      el('p', 'state-body', selected ? t().share.momentsEmptyBody : t().share.emptyBody),
    );
    list?.replaceWith(empty);
    list = null;
  }

  async function load() {
    invalidated = false;
    stopWatching?.();
    if (!token) {
      showInvalid();
      return;
    }
    renderLoading(root);
    const result = await loadTimelinePage(api, token, undefined, fetcher);
    if (result.kind === 'invalid') {
      showInvalid();
      return;
    }
    if (result.kind !== 'ok') {
      renderError(root, result.kind === 'busy', () => void load());
      return;
    }
    const data = result.data;
    timezone = data.range.timezone;
    selected = data.kind === 'moments';
    shown = 0;
    lastDay = null;
    moreFailed = false;
    root.replaceChildren();
    root.append(pageHeader(data, now(), allowLocalHttp));
    list = el('div', 'tl');
    root.append(list);
    more = el('div', 'tl-more');
    root.append(more);
    root.append(pageFooter());
    appendPage(data, undefined);
    if (shown === 0 && cursor === null) renderEmpty();
    renderMore();
    rewatch();
  }

  return { load, loadMore };
}
