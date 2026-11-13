import { t } from '../i18n';
import type { BreastSide, EventData } from '../schemas';

/**
 * 亲喂计时（issue #104）。计时状态都写在喂奶记录上，不在手机内存里：
 * 点一侧就写一条 `method: 'breast'`、没有 `endAt` 的记录，换边和结束只是改这条记录。
 * 所以 App 被杀、换一台手机都能接着计，家人也看得到正在喂。
 *
 * 不按秒写入：已经喂完的段落累加在 `leftSec`/`rightSec`，正在喂的这一段只记开始时间 `sideSince`，
 * 显示时用现在的时间算。`at` 是开始喂的时间，旧版 App 按它把这条当成一次喂奶。
 */

type FeedEvent = Extract<EventData, { type: 'feed' }>;

const HOUR = 3_600_000;

/**
 * 一次亲喂计时开着超过这么久，多半是忘了点“结束”。不再把计时当真：摘要只算已经喂完的段落，
 * 今天页提示去确认，不能一点就把几个小时记成亲喂。
 */
export const FORGOTTEN_BREASTFEED_MS = 2 * HOUR;

/** 不写成类型守卫：瓶喂和亲喂是同一种记录，守卫取反会把瓶喂收窄成 never。 */
export function isBreastFeed(event: EventData): boolean {
  return event.type === 'feed' && event.method === 'breast';
}

/** 还在计时的亲喂。 */
export function isOpenBreastFeed(event: EventData): event is FeedEvent {
  return event.type === 'feed' && event.method === 'breast' && event.endAt === undefined;
}

export const otherSide = (side: BreastSide): BreastSide => (side === 'left' ? 'right' : 'left');

/** 正在喂的这一段有多少秒。另一台手机的钟可能快一点，不能是负数。 */
function runningSeconds(feed: FeedEvent, now: number): number {
  if (feed.endAt !== undefined || !feed.side || feed.sideSince === undefined) return 0;
  return Math.max(0, Math.round((now - feed.sideSince) / 1000));
}

export interface BreastSeconds {
  left: number;
  right: number;
}

/** 两侧各喂了多少秒，算上正在计时的这一段。 */
export function breastSeconds(feed: FeedEvent, now: number): BreastSeconds {
  const running = runningSeconds(feed, now);
  return {
    left: (feed.leftSec ?? 0) + (feed.side === 'left' ? running : 0),
    right: (feed.rightSec ?? 0) + (feed.side === 'right' ? running : 0),
  };
}

/** 计时是不是忘了关。 */
export function isForgottenBreastFeed(feed: FeedEvent, now: number): boolean {
  return feed.endAt === undefined && now - feed.at > FORGOTTEN_BREASTFEED_MS;
}

/** 摘要里算多少毫秒。忘了关的计时只算已经喂完的段落。 */
export function breastDurationMs(feed: FeedEvent, now: number): number {
  const done = (feed.leftSec ?? 0) + (feed.rightSec ?? 0);
  const running = isForgottenBreastFeed(feed, now) ? 0 : runningSeconds(feed, now);
  return (done + running) * 1000;
}

/** 点一侧开始。`at` 可以早于现在（“15 分钟前”开始喂的），这一侧就从那时算起。 */
export function startBreastFeed(side: BreastSide, at: number): FeedEvent {
  return {
    type: 'feed',
    at,
    ml: 0,
    method: 'breast',
    side,
    sideSince: at,
    leftSec: 0,
    rightSec: 0,
  };
}

/** 换到另一侧：正在喂的这一段记进它那一侧。点的是正在喂的这一侧就什么都不做（返回 null）。 */
export function switchBreastSide(feed: FeedEvent, side: BreastSide, now: number): FeedEvent | null {
  if (feed.endAt !== undefined || feed.side === side) return null;
  const done = breastSeconds(feed, now);
  return {
    ...feed,
    leftSec: done.left,
    rightSec: done.right,
    side,
    sideSince: Math.max(now, feed.at),
  };
}

/** 结束：正在喂的这一段记进去，留下最后一侧，下次从另一侧开始。 */
export function finishBreastFeed(feed: FeedEvent, now: number): FeedEvent {
  const done = breastSeconds(feed, now);
  return {
    ...feed,
    leftSec: done.left,
    rightSec: done.right,
    sideSince: undefined,
    endAt: Math.max(now, feed.at),
  };
}

export type BreastFeedState =
  | { status: 'none' }
  | { status: 'running'; feed: FeedEvent }
  | { status: 'forgotten'; feed: FeedEvent };

/** 现在有没有正在计时的亲喂。两台手机离线时各开了一次的话，看最新的那次。 */
export function breastFeedState(events: readonly EventData[], now: number): BreastFeedState {
  let found: FeedEvent | null = null;
  for (const e of events) {
    if (isOpenBreastFeed(e) && e.at <= now && (!found || e.at > found.at)) found = e;
  }
  if (!found) return { status: 'none' };
  return { status: isForgottenBreastFeed(found, now) ? 'forgotten' : 'running', feed: found };
}

/** 下次从哪一侧开始：最近一次亲喂最后喂的那一侧的另一侧。还没有亲喂过时是 null，不猜。 */
export function nextBreastSide(events: readonly EventData[], now: number): BreastSide | null {
  let last: FeedEvent | null = null;
  for (const e of events) {
    if (e.type !== 'feed' || e.method !== 'breast') continue;
    if (e.side && e.at <= now && (!last || e.at > last.at)) last = e;
  }
  return last?.side ? otherSide(last.side) : null;
}

/** 一侧的分钟数。喂了不到半分钟也写 1 分：写 0 像是没喂。 */
const minutesOf = (seconds: number) => Math.max(1, Math.round(seconds / 60));

/** `左 12 分 · 右 8 分`。没喂的一侧不写。 */
export function breastSidesText(seconds: BreastSeconds): string {
  const text = t().domain.events;
  return (['left', 'right'] as const)
    .filter((side) => seconds[side] > 0)
    .map((side) => text.breastSideMinutes(side, minutesOf(seconds[side])))
    .join(' · ');
}

/** 时间线、Toast、家人横幅里的一句话。 */
export function describeBreastFeed(feed: FeedEvent, now: number): string {
  const text = t().domain.events;
  const parts = breastSidesText(breastSeconds(feed, now));
  if (feed.endAt !== undefined || !feed.side) return text.breastFeed(parts);
  return text.breastFeeding(parts || text.breastSide(feed.side));
}
