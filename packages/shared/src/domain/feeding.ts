import { formulaSnapshot } from '../health/nutrition';
import type { EventData, FormulaData, FormulaSnapshot, MilkType } from '../schemas';

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

/** 记录上和奶类型有关的字段。 */
export interface FeedMilk {
  milkType: MilkType | undefined;
  formulaId?: string;
  formula?: FormulaSnapshot;
}

export interface FeedDefaults extends FeedMilk {
  ml: number | undefined;
}

/**
 * 记喂奶时的默认值：不多一步，直接沿用上一次。喂奶弹层和桌面小工具都用这个。
 *
 * - 奶量跟最新的一条。奶类型跟最近标过的一条：家人用旧版记的没有这些字段，不能把默认值清掉。
 * - 快照用奶粉现在的数值，这样改配方后新的喂奶按新的算。奶粉被删了就不再沿用，也不用旧快照。
 */
export function lastFeedDefaults(
  events: readonly EventData[],
  formulas: readonly { id: string; data: FormulaData }[],
  now: number,
): FeedDefaults {
  const feeds = feedsNewestFirst(events, now);
  const ml = feeds[0]?.ml;
  const marked = feeds.find((feed) => feed.milkType);
  if (marked?.milkType !== 'formula') return { ml, milkType: marked?.milkType };
  const current = formulas.find((formula) => formula.id === marked.formulaId);
  if (!current) return { ml, milkType: 'formula' };
  return {
    ml,
    milkType: 'formula',
    formulaId: current.id,
    formula: formulaSnapshot(current.data),
  };
}

/**
 * 补记时的默认值。比所有喂奶都晚的时间就是“下一次”，和 `lastFeedDefaults` 一样。
 *
 * 更早的时间按那之前最近标过的一条，连快照一起照抄：那天用的就是那时的数值，奶粉后来改过或删了都一样。
 * 那之前没有标过的就不标，显示数据不足，不拿现在的奶粉去猜以前喂的是什么。
 */
export function feedDefaultsAt(
  events: readonly EventData[],
  formulas: readonly { id: string; data: FormulaData }[],
  at: number,
  now: number,
): FeedDefaults {
  const feeds = feedsNewestFirst(events, now);
  const newest = feeds[0];
  if (!newest || at >= newest.at) return lastFeedDefaults(events, formulas, now);
  const marked = feeds.find((feed) => feed.at <= at && feed.milkType);
  return { ml: newest.ml, ...(marked ? feedMilkOf(marked) : { milkType: undefined }) };
}

/** 一条记录上的奶类型字段，修改时用。 */
export function feedMilkOf(feed: FeedEvent): FeedMilk {
  return { milkType: feed.milkType, formulaId: feed.formulaId, formula: feed.formula };
}

/** 写进记录的字段。没标注就不写这些键，和 v0.1.0 的记录一样。 */
export function feedMilkFields(milk: FeedMilk): Partial<FeedMilk> {
  if (!milk.milkType) return {};
  if (milk.milkType !== 'formula' || !milk.formulaId) return { milkType: milk.milkType };
  return { milkType: 'formula', formulaId: milk.formulaId, formula: milk.formula };
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
