import { formulaSnapshot } from '../health/nutrition';
import type { EventData, FormulaData, FormulaSnapshot, MilkType } from '../schemas';

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

/** 写进记录的字段。没标注就不写这些键，和 v0.1.0 的记录一样。 */
export function feedMilkFields(milk: FeedMilk): Partial<FeedMilk> {
  if (!milk.milkType) return {};
  if (milk.milkType !== 'formula' || !milk.formulaId) return { milkType: milk.milkType };
  return { milkType: 'formula', formulaId: milk.formulaId, formula: milk.formula };
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
