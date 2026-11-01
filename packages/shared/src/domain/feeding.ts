import type { EventData } from '../schemas';

type FeedEvent = Extract<EventData, { type: 'feed' }>;

const HOUR = 3_600_000;
const DEFAULT_INTERVAL = 3 * HOUR;
/** 太近的两次算同一顿（比如分两次喝），太远的多半是漏记，都不该影响平均间隔。 */
const MIN_GAP = 20 * 60_000;
const MAX_GAP = 8 * HOUR;

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
    const gap = feeds[i - 1]!.at - feeds[i]!.at;
    if (gap >= MIN_GAP && gap <= MAX_GAP) gaps.push(gap);
  }
  const isLearned = gaps.length >= 2;
  const intervalMs = isLearned ? gaps.reduce((a, b) => a + b, 0) / gaps.length : DEFAULT_INTERVAL;
  const sinceMs = last ? now - last.at : 0;
  return { last, sinceMs, intervalMs, isLearned, remainingMs: intervalMs - sinceMs };
}

/** 一次睡超过这么久多半是忘了点“醒了”，不能当真。 */
export const FORGOTTEN_SLEEP_MS = 12 * HOUR;

type SleepEvent = Extract<EventData, { type: 'sleep' }>;

export type SleepState =
  | { status: 'awake' }
  | { status: 'asleep'; sleep: SleepEvent }
  | { status: 'forgotten'; sleep: SleepEvent };

export function sleepState(events: readonly EventData[], now: number): SleepState {
  const sleep = activeSleep(events.filter((e) => e.at <= now));
  if (!sleep) return { status: 'awake' };
  return { status: now - sleep.at > FORGOTTEN_SLEEP_MS ? 'forgotten' : 'asleep', sleep };
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
