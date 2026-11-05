import {
  agePartsText,
  type EventData,
  eventColors,
  formatDateHeader,
  formatFullDate,
  formatMediaDuration,
  formatVolume,
  type PublicMedia,
  type PublicMoment,
  type PublicShareResponse,
  shareEventText,
  summarizeDay,
  t,
  zonedCalendarDate,
  zonedClock,
} from '@xiaodouya/shared';
import { fullRowAspect, layoutGallery } from './gallery';
import { safeMediaUrl } from './media';

/**
 * 所有内容都用 textContent 写入。宝宝的名字和备注是别人写的，这里绝不拼 HTML，
 * 地址写进 src 之前都过 `safeMediaUrl`。
 */

const ACCENT = '#c0714f';

export interface MediaSlot {
  id: string;
  /** 换上新链接（media 没有了说明文件被删了，这一格去掉）。 */
  update(media: PublicMedia | undefined): void;
  /** 确实打不开了。 */
  markBroken(): void;
}

export interface RenderContext {
  now: number;
  allowLocalHttp: boolean;
  onPhoto(items: PublicMedia[], index: number): void;
  onMediaFailed(slot: MediaSlot): void;
  onMediaRetry(slot: MediaSlot): void;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// ─── 文件 ───────────────────────────────────────────────

/** 文件被删了：去掉这一格。并排的另一张还在，这一行还要留着。 */
function removeFrame(frame: HTMLElement) {
  const row = frame.closest('.gallery-row');
  frame.remove();
  if (row && row.childElementCount === 0) row.remove();
}

function brokenNotice(onRetry: () => void): HTMLButtonElement {
  const notice = el('button', 'media-broken');
  notice.type = 'button';
  notice.append(el('span', 'media-broken-title', t().share.mediaFailed));
  notice.append(el('span', 'media-broken-retry', t().share.mediaRetry));
  notice.addEventListener('click', (event) => {
    event.stopPropagation();
    onRetry();
  });
  return notice;
}

/** 一格文件：正常时是 `content`，打不开时换成可以重试的提示。 */
function slotShell(id: string, frame: HTMLElement, content: HTMLElement, ctx: RenderContext) {
  let notice: HTMLButtonElement | null = null;
  const slot: MediaSlot & { clearBroken(): void } = {
    id,
    update: () => {},
    markBroken() {
      if (notice) return;
      notice = brokenNotice(() => ctx.onMediaRetry(slot));
      content.hidden = true;
      frame.append(notice);
    },
    clearBroken() {
      notice?.remove();
      notice = null;
      content.hidden = false;
    },
  };
  return slot;
}

export function imageTile(
  media: PublicMedia,
  frame: HTMLElement,
  alt: string,
  ctx: RenderContext,
  onOpen: () => void,
): MediaSlot {
  const button = el('button', 'tile');
  button.type = 'button';
  button.setAttribute('aria-label', t().share.openPhoto);
  const img = el('img');
  img.setAttribute('loading', 'lazy');
  img.setAttribute('decoding', 'async');
  img.alt = alt;
  button.append(img);
  frame.append(button);
  button.addEventListener('click', onOpen);

  const slot = slotShell(media.id, frame, button, ctx);
  let sources: string[] = [];
  let index = 0;
  const show = (next: PublicMedia) => {
    // 缩略图优先：原图可能很大，也可能是浏览器显示不了的 HEIC。
    sources = [next.thumbUrl, next.url]
      .map((url) => safeMediaUrl(url, ctx.allowLocalHttp))
      .filter((url): url is string => url !== null);
    index = 0;
    if (sources[0]) img.setAttribute('src', sources[0]);
    else slot.markBroken();
  };
  img.addEventListener('error', () => {
    index += 1;
    const next = sources[index];
    if (next) img.setAttribute('src', next);
    else ctx.onMediaFailed(slot);
  });
  slot.update = (next) => {
    if (!next) {
      removeFrame(frame);
      return;
    }
    slot.clearBroken();
    show(next);
  };
  show(media);
  return slot;
}

export function videoFrame(
  media: PublicMedia,
  ctx: RenderContext,
): { node: HTMLElement; slot: MediaSlot } {
  const frame = el('div', 'frame frame-video');
  frame.style.aspectRatio = String(fullRowAspect(media));
  const video = el('video');
  video.setAttribute('controls', '');
  video.setAttribute('playsinline', '');
  video.setAttribute('preload', 'none');
  video.setAttribute('aria-label', t().share.videoLabel);
  frame.append(video);
  if (media.durationMs) {
    frame.append(el('span', 'duration', `▶ ${formatMediaDuration(media.durationMs)}`));
  }
  const slot = slotShell(media.id, frame, video, ctx);
  const show = (next: PublicMedia) => {
    const url = safeMediaUrl(next.url, ctx.allowLocalHttp);
    const poster = safeMediaUrl(next.thumbUrl, ctx.allowLocalHttp);
    if (poster) video.setAttribute('poster', poster);
    if (url) video.setAttribute('src', url);
    else slot.markBroken();
  };
  video.addEventListener('error', () => ctx.onMediaFailed(slot));
  // 只隐藏时长角标，不抢控件的位置。
  video.addEventListener('play', () => frame.classList.add('is-playing'));
  slot.update = (next) => {
    if (!next) {
      removeFrame(frame);
      return;
    }
    slot.clearBroken();
    show(next);
    video.load();
  };
  show(media);
  return { node: frame, slot };
}

export function audioPlayer(
  media: PublicMedia,
  ctx: RenderContext,
): { node: HTMLElement; slot: MediaSlot } {
  const frame = el('div', 'audio');
  const audio = el('audio');
  audio.setAttribute('controls', '');
  audio.setAttribute('preload', 'none');
  audio.setAttribute('aria-label', t().share.audioLabel);
  frame.append(audio);
  const slot = slotShell(media.id, frame, audio, ctx);
  const show = (next: PublicMedia) => {
    const url = safeMediaUrl(next.url, ctx.allowLocalHttp);
    if (url) audio.setAttribute('src', url);
    else slot.markBroken();
  };
  audio.addEventListener('error', () => ctx.onMediaFailed(slot));
  slot.update = (next) => {
    if (!next) {
      frame.remove();
      return;
    }
    slot.clearBroken();
    show(next);
    audio.load();
  };
  show(media);
  return { node: frame, slot };
}

// ─── 页面各部分 ─────────────────────────────────────────

function pageHeader(data: PublicShareResponse, now: number): HTMLElement {
  const header = el('header', 'hero');
  const { fromAt, timezone } = data.range;
  const day = zonedCalendarDate(fromAt, timezone).getTime();
  const sameYear = new Date(day).getFullYear() === new Date(now).getFullYear();
  header.append(el('p', 'hero-date', sameYear ? formatDateHeader(day) : formatFullDate(day)));

  const name = data.baby.name || t().share.fallbackName;
  const { dayNumber, age } = data.baby;
  let title = name;
  if (dayNumber !== null && data.baby.name) {
    title =
      dayNumber > 0
        ? t().today.title(name, dayNumber)
        : t().share.pageTitleBefore(name, 1 - dayNumber);
  }
  header.append(el('h1', 'hero-title', title));
  if (age) header.append(el('p', 'hero-age', agePartsText(age)));
  return header;
}

function daySummary(data: PublicShareResponse, now: number): HTMLElement | null {
  const end = Math.min(now, data.range.toAt);
  const summary = summarizeDay(data.events, data.range.fromAt, end);
  const text = t().share;
  const stats: [string, string, string?][] = [];
  if (summary.feeds > 0) {
    stats.push([
      text.statFeeds,
      text.statFeedsValue(summary.feeds),
      // 亲喂没有奶量，写 0 不是事实。
      summary.ml > 0 ? formatVolume(summary.ml, data.units.volume) : undefined,
    ]);
  }
  if (summary.diapers > 0) stats.push([text.statDiapers, text.statDiapersValue(summary.diapers)]);
  if (summary.sleepMs > 0) {
    stats.push([text.statSleep, text.statSleepValue((summary.sleepMs / 3_600_000).toFixed(1))]);
  }
  if (stats.length === 0) return null;
  const card = el('section', 'summary');
  for (const [label, value, sub] of stats) {
    const stat = el('div', 'stat');
    stat.append(el('span', 'stat-label', label));
    stat.append(el('span', 'stat-value', value));
    if (sub) stat.append(el('span', 'stat-sub', sub));
    card.append(stat);
  }
  return card;
}

/** 照片和视频排成相册（`layoutGallery`）。点照片在这些照片里放大翻看，视频在格子里播放。 */
export function galleryGrid(
  files: PublicMedia[],
  altOf: (file: PublicMedia) => string,
  ctx: RenderContext,
  slots: MediaSlot[],
): HTMLElement {
  const photos = files.filter((file) => file.kind === 'image');
  const gallery = el('div', 'gallery');
  for (const row of layoutGallery(files)) {
    const rowNode = el('div', `gallery-row gallery-row-${row.kind}`);
    for (const file of row.items) {
      if (file.kind === 'video') {
        const { node, slot } = videoFrame(file, ctx);
        rowNode.append(node);
        slots.push(slot);
        continue;
      }
      const frame = el('div', 'frame');
      if (row.kind === 'full') frame.style.aspectRatio = String(fullRowAspect(file));
      rowNode.append(frame);
      slots.push(
        imageTile(file, frame, altOf(file), ctx, () => ctx.onPhoto(photos, photos.indexOf(file))),
      );
    }
    gallery.append(rowNode);
  }
  return gallery;
}

function gallerySection(
  data: PublicShareResponse,
  ctx: RenderContext,
  slots: MediaSlot[],
): HTMLElement | null {
  const items = data.moments.flatMap((moment) =>
    moment.media.filter((file) => file.kind !== 'audio').map((file) => ({ file, moment })),
  );
  if (items.length === 0 && data.omittedMedia === 0) return null;
  const section = el('section', 'photos');
  const files = items.map((item) => item.file);
  const altOf = new Map(items.map(({ file, moment }) => [file, moment.title]));
  if (files.length > 0)
    section.append(galleryGrid(files, (file) => altOf.get(file) ?? '', ctx, slots));
  if (data.omittedMedia > 0) {
    section.append(el('p', 'note', t().share.omittedMedia(data.omittedMedia)));
  }
  return section;
}

type TimelineItem =
  | { at: number; kind: 'event'; event: EventData }
  | { at: number; kind: 'moment'; moment: PublicMoment };

function timelineRow(
  at: number,
  timezone: string,
  color: string,
): {
  row: HTMLElement;
  body: HTMLElement;
} {
  const row = el('li', 'entry');
  row.append(el('time', 'entry-time', zonedClock(at, timezone)));
  const rail = el('span', 'entry-rail');
  const dot = el('span', 'entry-dot');
  dot.style.backgroundColor = color;
  rail.append(dot);
  row.append(rail);
  const body = el('div', 'entry-body');
  row.append(body);
  return { row, body };
}

function eventRow(event: EventData, data: PublicShareResponse, ctx: RenderContext): HTMLElement {
  const { row, body } = timelineRow(event.at, data.range.timezone, eventColors[event.type]);
  body.append(el('p', 'entry-title', shareEventText(event, ctx.now, data.units)));
  const detail = [event.note, event.byName].filter((part): part is string => Boolean(part));
  if (detail.length > 0) body.append(el('p', 'entry-detail', detail.join(' · ')));
  return row;
}

function momentRow(
  moment: PublicMoment,
  data: PublicShareResponse,
  ctx: RenderContext,
  slots: MediaSlot[],
): HTMLElement {
  const { row, body } = timelineRow(moment.at, data.range.timezone, ACCENT);
  row.classList.add('entry-moment');
  if (moment.milestone) body.append(el('span', 'tag', t().share.milestone));
  if (moment.title.trim()) body.append(el('h3', 'moment-title', moment.title));
  if (moment.text.trim()) body.append(el('p', 'moment-text', moment.text));
  for (const file of moment.media) {
    if (file.kind !== 'audio') continue;
    const { node, slot } = audioPlayer(file, ctx);
    body.append(node);
    slots.push(slot);
  }
  if (moment.byName) body.append(el('p', 'entry-detail', t().share.wroteBy(moment.byName)));
  return row;
}

function timelineSection(
  data: PublicShareResponse,
  ctx: RenderContext,
  slots: MediaSlot[],
): HTMLElement | null {
  const items: TimelineItem[] = [
    ...data.events.map((event) => ({ at: event.at, kind: 'event' as const, event })),
    ...data.moments.map((moment) => ({ at: moment.at, kind: 'moment' as const, moment })),
  ].sort((a, b) => a.at - b.at);
  if (items.length === 0) return null;
  const section = el('section', 'timeline');
  section.append(el('h2', 'section-title', t().share.timelineTitle));
  const list = el('ol', 'entries');
  for (const item of items) {
    list.append(
      item.kind === 'event'
        ? eventRow(item.event, data, ctx)
        : momentRow(item.moment, data, ctx, slots),
    );
  }
  section.append(list);
  return section;
}

export function pageFooter(): HTMLElement {
  const footer = el('footer', 'foot');
  footer.append(el('p', 'foot-note', t().share.footerNote));
  footer.append(el('p', 'foot-brand', t().share.footer));
  return footer;
}

// ─── 整页 ───────────────────────────────────────────────

/** 返回页面上的文件，链接过期时靠它们换地址。 */
export function renderShare(
  root: HTMLElement,
  data: PublicShareResponse,
  ctx: RenderContext,
): MediaSlot[] {
  const slots: MediaSlot[] = [];
  root.replaceChildren();
  root.append(pageHeader(data, ctx.now));
  const summary = daySummary(data, ctx.now);
  if (summary) root.append(summary);
  const gallery = gallerySection(data, ctx, slots);
  if (gallery) root.append(gallery);
  const timeline = timelineSection(data, ctx, slots);
  if (timeline) root.append(timeline);
  if (!gallery && !timeline) {
    const empty = el('section', 'state state-soft');
    empty.append(el('p', 'state-title', t().share.emptyTitle));
    empty.append(el('p', 'state-body', t().share.emptyBody));
    root.append(empty);
  }
  root.append(pageFooter());
  return slots;
}

export function renderLoading(root: HTMLElement): void {
  root.replaceChildren();
  const skeleton = el('div', 'skeleton');
  skeleton.setAttribute('role', 'status');
  skeleton.setAttribute('aria-label', t().share.loading);
  for (const part of [
    'sk-line sk-short',
    'sk-line sk-title',
    'sk-line sk-age',
    'sk-card',
    'sk-photo',
  ]) {
    skeleton.append(el('div', part));
  }
  root.append(skeleton);
}

function stateScreen(root: HTMLElement, title: string, body: string): HTMLElement {
  root.replaceChildren();
  const screen = el('section', 'state');
  screen.append(el('span', 'state-mark'));
  screen.append(el('h1', 'state-title', title));
  screen.append(el('p', 'state-body', body));
  root.append(screen);
  root.append(pageFooterBrand());
  return screen;
}

function pageFooterBrand(): HTMLElement {
  const footer = el('footer', 'foot');
  footer.append(el('p', 'foot-brand', t().share.footer));
  return footer;
}

/** 只说这一句，不透露是过期、撤销还是根本不存在。 */
export function renderInvalid(root: HTMLElement): void {
  stateScreen(root, t().share.invalidTitle, t().share.invalidBody);
}

export function renderError(root: HTMLElement, busy: boolean, onRetry: () => void): void {
  const screen = stateScreen(
    root,
    t().share.errorTitle,
    busy ? t().share.busyBody : t().share.errorBody,
  );
  const button = el('button', 'state-button', t().share.retry);
  button.type = 'button';
  button.addEventListener('click', onRetry);
  screen.append(button);
}
