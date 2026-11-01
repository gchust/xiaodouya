import type { EventData } from '../schemas';

type FeedEvent = Extract<EventData, { type: 'feed' }>;

const HOUR = 3_600_000;
const DEFAULT_INTERVAL = 3 * HOUR;
/** 太近的两次算同一顿（比如分两次喝），太远的多半是漏记，都不该影响平均间隔。 */
const MIN_GAP = 20 * 60_000;
const MAX_GAP = 8 * HOUR;
/** 喂奶间隔变得快。补记的旧记录，或者停记很久之前的规律，都不能用来估算现在。 */
const LEARNING_WINDOW = 7 * 24 * HOUR;

export function feedsNewestFirst(events: readonly EventData[], now: number): FeedEvent[] {
  return events
    .filter((e): e is FeedEvent => e.type === 'feed' && e.at <= now)
    .sort((a, b) => b.at - a.at);
}

export interface FeedEstimate {
  last: FeedEvent | null;
  sinceMs: number;
  intervalMs: number;
  /** 间隔是否来自足够的真实数据；否则是默认值，界面不应显示得太肯定。 */
  isLearned: boolean;
  /** 距离下次的毫秒数，负数表示已超过。 */
  remainingMs: number;
}

export function estimateNextFeed(events: readonly EventData[], now: number): FeedEstimate {
  const feeds = feedsNewestFirst(events, now);
  const last = feeds[0] ?? null;
  const gaps: number[] = [];
  for (let i = 1; i < feeds.length && gaps.length < 5; i++) {
    if (feeds[i]!.at < now - LEARNING_WINDOW) break;
    const gap = feeds[i - 1]!.at - feeds[i]!.at;
    if (gap >= MIN_GAP && gap <= MAX_GAP) gaps.push(gap);
  }
  const isLearned = gaps.length >= 2;
  const intervalMs = isLearned ? gaps.reduce((a, b) => a + b, 0) / gaps.length : DEFAULT_INTERVAL;
  const sinceMs = last ? now - last.at : 0;
  return { last, sinceMs, intervalMs, isLearned, remainingMs: intervalMs - sinceMs };
}

/**
 * 下一次喂奶提醒还要等多久；不该提醒时是 null。
 * 只在已经学到喂奶规律时才提醒，默认间隔不够可靠，不应该半夜吵醒人。
 */
export function feedReminderDelayMs(events: readonly EventData[], now: number): number | null {
  const estimate = estimateNextFeed(events, now);
  if (!estimate.last || !estimate.isLearned || estimate.remainingMs <= 0) return null;
  return estimate.remainingMs;
}

export function activeSleep(
  events: readonly EventData[],
): Extract<EventData, { type: 'sleep' }> | null {
  let found: Extract<EventData, { type: 'sleep' }> | null = null;
  for (const e of events) {
    if (e.type === 'sleep' && !e.endAt && (!found || e.at > found.at)) found = e;
  }
  return found;
}
