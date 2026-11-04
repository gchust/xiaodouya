import { z } from 'zod';
import { t } from '../i18n';
import {
  type BabyData,
  canReadCollection,
  canWriteCollection,
  type DiaperKind,
  diaperKinds,
  type EventData,
  type FormulaData,
  type Role,
} from '../schemas';
import { dayNumber, formatClock, startOfLocalDay } from './age';
import { type DaySummary, summarizeDay } from './events';
import {
  estimateNextFeed,
  type FeedDefaults,
  FORGOTTEN_SLEEP_MS,
  feedMilkFields,
  feedsNewestFirst,
  lastFeedDefaults,
  sleepState,
} from './feeding';
import { formatVolume, type Units } from './units';

/**
 * 桌面小工具的判断逻辑。小工具点击时 App 可能根本没开，这里只负责决定“该写什么、该显示什么”，
 * 写入走和界面相同的 RecordStore，所以同步和撤销都不需要另一套实现。
 */

export interface WidgetEntry {
  id: string;
  data: EventData;
}

/** 从本机保存的登录信息得出。App 里的判断只是体验，服务端同步时还会再校验一次。 */
export interface WidgetSession {
  signedIn: boolean;
  hasFamily: boolean;
  role: Role | null;
  /** 记录人的称呼，和 App 里记录时写的一样。 */
  label: string;
}

export type WidgetBlockReason = 'signedOut' | 'noFamily' | 'noAccess' | 'noBaby';

export function widgetBlockMessage(reason: WidgetBlockReason): string {
  return t().domain.widget[reason];
}

function blockReason(session: WidgetSession, hasBaby: boolean): WidgetBlockReason | null {
  if (!session.signedIn) return 'signedOut';
  if (!session.hasFamily) return 'noFamily';
  if (
    !session.role ||
    !canReadCollection(session.role, 'event') ||
    !canWriteCollection(session.role, 'event')
  ) {
    return 'noAccess';
  }
  return hasBaby ? null : 'noBaby';
}

/** 点击要做的事。id 在渲染小工具时生成并带在点击数据里，重复点击和任务重试都落在同一条记录上。 */
const WidgetAction = z.discriminatedUnion('type', [
  z.object({ type: z.literal('feed'), id: z.string().min(1) }),
  z.object({ type: z.literal('sleepStart'), id: z.string().min(1) }),
  z.object({ type: z.literal('sleepEnd'), sleepId: z.string().min(1) }),
  z.object({ type: z.literal('diaper'), id: z.string().min(1), kind: z.enum(diaperKinds) }),
]);
export type WidgetAction = z.infer<typeof WidgetAction>;

export function parseWidgetAction(data: unknown): WidgetAction | null {
  const parsed = WidgetAction.safeParse(data);
  return parsed.success ? parsed.data : null;
}

export type WidgetPlan =
  | { kind: 'blocked' }
  /** 状态已经变了（重复点击、家人先点了），不写任何东西，刷新显示就好。 */
  | { kind: 'noop' }
  /** 没有可以沿用的奶量。不能编一个默认值悄悄记下去。 */
  | { kind: 'needsAmount' }
  | { kind: 'write'; id: string; data: EventData };

export interface WidgetPlanInput {
  session: WidgetSession;
  hasBaby: boolean;
  /** 按发生时间倒序。 */
  entries: readonly WidgetEntry[];
  /** 家庭的奶粉配置。上一次用的奶粉要按现在的数值生成快照，和喂奶弹层一样。 */
  formulas: readonly { id: string; data: FormulaData }[];
  /** 这个 id 是否已经存在，已删除的也算：撤销之后，迟到的重试不能把记录变回来。 */
  isKnownId(id: string): boolean;
  now: number;
}

const events = (entries: readonly WidgetEntry[]) => entries.map((e) => e.data);

/** 能一键记的奶量。上一次是 0 或者没有记录时不能沿用，要去 App 里选。 */
function quickFeedMl(defaults: FeedDefaults): number | null {
  return defaults.ml !== undefined && defaults.ml > 0 ? defaults.ml : null;
}

export function planWidgetAction(action: WidgetAction, input: WidgetPlanInput): WidgetPlan {
  const { session, hasBaby, entries, formulas, isKnownId, now } = input;
  if (blockReason(session, hasBaby)) return { kind: 'blocked' };
  const byName = session.label ? { byName: session.label } : {};
  const state = sleepState(events(entries), now);

  switch (action.type) {
    case 'feed': {
      if (isKnownId(action.id)) return { kind: 'noop' };
      const defaults = lastFeedDefaults(events(entries), formulas, now);
      const ml = quickFeedMl(defaults);
      if (ml === null) return { kind: 'needsAmount' };
      return {
        kind: 'write',
        id: action.id,
        data: { type: 'feed', at: now, ml, ...feedMilkFields(defaults), ...byName },
      };
    }
    case 'sleepStart':
      if (isKnownId(action.id) || state.status !== 'awake') return { kind: 'noop' };
      return { kind: 'write', id: action.id, data: { type: 'sleep', at: now, ...byName } };
    case 'sleepEnd': {
      // 忘记结束的睡眠要到 App 里确认：直接用现在当醒来时间，会多出一次十几小时的睡眠。
      if (state.status !== 'asleep') return { kind: 'noop' };
      const target = entries.find((e) => e.id === action.sleepId);
      if (target?.data !== state.sleep) return { kind: 'noop' };
      return { kind: 'write', id: target.id, data: { ...state.sleep, endAt: now } };
    }
    case 'diaper':
      if (isKnownId(action.id)) return { kind: 'noop' };
      return {
        kind: 'write',
        id: action.id,
        data: { type: 'diaper', at: now, kind: action.kind, ...byName },
      };
  }
}

export type WidgetSleep =
  | { status: 'awake'; lastEnd: number | null }
  | { status: 'asleep'; id: string; since: number }
  | { status: 'forgotten'; id: string; since: number };

/** 超过这么久没同步，小工具上才写出同步时间。平时不写，界面更干净；旧了要让人知道家人的记录可能还没到。 */
export const WIDGET_SYNC_STALE_MS = 30 * 60_000;
/** 和今天页一样：离下次喂奶不到 30 分钟算快到了。 */
const FEED_NEAR_MS = 30 * 60_000;

/**
 * 下次喂奶的估算。小工具最快 30 分钟才刷新一次，所以给具体时刻而不是“还有多久”，过一会儿也不会错。
 * 不到 3 次喂奶（`isLearned` 为假）就不估算：默认间隔是猜的，不能拿来提醒，也不能让人放心。
 */
export interface WidgetNextFeed {
  at: number;
  status: 'later' | 'near' | 'due';
}

/** 今天的节奏条。位置是一天里的比例（0 是 0 点，1 是明天 0 点），按时间先后排好。 */
export interface WidgetDayline {
  feeds: number[];
  diapers: number[];
  sleeps: { from: number; to: number }[];
  now: number;
}

export type WidgetView =
  | { kind: 'blocked'; reason: WidgetBlockReason; message: string }
  | {
      kind: 'ready';
      /** 算这份显示时的时间。 */
      now: number;
      babyName: string;
      /** 出生当天是第 1 天，和今天页的标题一样。 */
      dayNumber: number;
      nextFeed: WidgetNextFeed | null;
      lastDiaper: { id: string; at: number; kind: DiaperKind } | null;
      dayline: WidgetDayline;
      /** 是否在小工具上写出同步时间，见 `WIDGET_SYNC_STALE_MS`。 */
      showSync: boolean;
      lastFeed: { id: string; at: number; ml: number } | null;
      lastFeedAmount: string | null;
      canQuickFeed: boolean;
      sleep: WidgetSleep;
      today: DaySummary;
      todayAmount: string;
      units: Units;
      dayStart: number;
      syncedAt: number | null;
    };

export interface WidgetViewInput {
  session: WidgetSession;
  baby: BabyData | null;
  entries: readonly WidgetEntry[];
  units: Units;
  now: number;
  /** 手机所在时区的今天 0 点，见 `startOfLocalDay`。 */
  dayStart: number;
  /** 最后一次同步成功的时间。别的家人的记录要同步后才到，界面要说清楚数据新到什么时候。 */
  syncedAt: number | null;
}

function widgetSleep(entries: readonly WidgetEntry[], now: number): WidgetSleep {
  const state = sleepState(events(entries), now);
  if (state.status === 'awake') {
    const ends = entries.flatMap((e) =>
      e.data.type === 'sleep' && e.data.endAt && e.data.endAt <= now ? [e.data.endAt] : [],
    );
    return { status: 'awake', lastEnd: ends.length > 0 ? Math.max(...ends) : null };
  }
  const id = entries.find((e) => e.data === state.sleep)?.id ?? '';
  return { status: state.status, id, since: state.sleep.at };
}

function widgetNextFeed(entries: readonly WidgetEntry[], now: number): WidgetNextFeed | null {
  const estimate = estimateNextFeed(events(entries), now);
  if (!estimate.last || !estimate.isLearned) return null;
  const status =
    estimate.remainingMs <= 0 ? 'due' : estimate.remainingMs < FEED_NEAR_MS ? 'near' : 'later';
  return { at: estimate.last.at + estimate.intervalMs, status };
}

function widgetLastDiaper(entries: readonly WidgetEntry[], now: number) {
  let last: { id: string; at: number; kind: DiaperKind } | null = null;
  for (const { id, data } of entries) {
    if (data.type !== 'diaper' || data.at > now) continue;
    if (!last || data.at > last.at) last = { id, at: data.at, kind: data.kind };
  }
  return last;
}

/**
 * 睡眠和 `summarizeDay` 用同一套规则：跨午夜的只算今天这段，正在睡的算到现在，
 * 忘了结束的（超过 12 小时没点醒了）不画，不然一整天都是蓝的。
 */
export function widgetDayline(
  events: readonly EventData[],
  dayStart: number,
  now: number,
): WidgetDayline {
  // 明天 0 点按日历算，夏令时那天是 23 或 25 小时。
  const dayEnd = startOfLocalDay(dayStart + 36 * 3_600_000);
  const at = (ms: number) => Math.min(1, Math.max(0, (ms - dayStart) / (dayEnd - dayStart)));
  const line: WidgetDayline = { feeds: [], diapers: [], sleeps: [], now: at(now) };
  for (const e of events) {
    if (e.type === 'sleep') {
      if (!e.endAt && now - e.at > FORGOTTEN_SLEEP_MS) continue;
      const end = Math.min(e.endAt ?? now, now);
      const begin = Math.max(e.at, dayStart);
      if (end > begin) line.sleeps.push({ from: at(begin), to: at(end) });
      continue;
    }
    if (e.at < dayStart || e.at > now) continue;
    if (e.type === 'feed') line.feeds.push(at(e.at));
    else if (e.type === 'diaper') line.diapers.push(at(e.at));
  }
  line.feeds.sort((a, b) => a - b);
  line.diapers.sort((a, b) => a - b);
  line.sleeps.sort((a, b) => a.from - b.from);
  return line;
}

export function buildWidgetView(input: WidgetViewInput): WidgetView {
  const { session, baby, entries, units, now, dayStart, syncedAt } = input;
  const reason = blockReason(session, Boolean(baby));
  if (reason || !baby) {
    const blocked = reason ?? 'noBaby';
    return { kind: 'blocked', reason: blocked, message: widgetBlockMessage(blocked) };
  }
  const last = feedsNewestFirst(events(entries), now)[0];
  const lastEntry = last ? entries.find((e) => e.data === last) : undefined;
  const today = summarizeDay(events(entries), dayStart, now);
  return {
    kind: 'ready',
    now,
    babyName: baby.name,
    dayNumber: dayNumber(baby.birthAt, now),
    nextFeed: widgetNextFeed(entries, now),
    lastDiaper: widgetLastDiaper(entries, now),
    dayline: widgetDayline(events(entries), dayStart, now),
    showSync: syncedAt === null || now - syncedAt > WIDGET_SYNC_STALE_MS,
    lastFeed: last && lastEntry ? { id: lastEntry.id, at: last.at, ml: last.ml } : null,
    lastFeedAmount: last ? formatVolume(last.ml, units.volume) : null,
    canQuickFeed: quickFeedMl(lastFeedDefaults(events(entries), [], now)) !== null,
    sleep: widgetSleep(entries, now),
    today,
    todayAmount: formatVolume(today.ml, units.volume),
    units,
    dayStart,
    syncedAt,
  };
}

/**
 * 小工具的一行放不下时先截短名字。系统的省略号靠不住：名字太长时旁边的同步时间会被挤没，
 * 而那是判断数据新不新的依据。宽度按“西文 1、中日韩 2”粗略算。
 */
export function shortBabyName(name: string, maxWidth: number): string {
  const chars = Array.from(name);
  const width = (ch: string) => ((ch.codePointAt(0) ?? 0) >= 0x2e80 ? 2 : 1);
  if (chars.reduce((sum, ch) => sum + width(ch), 0) <= maxWidth) return name;
  let used = 0;
  let out = '';
  for (const ch of chars) {
    used += width(ch);
    if (used > maxWidth - 1) break;
    out += ch;
  }
  return `${out}…`;
}

export function formatSyncedAt(syncedAt: number | null, dayStart: number): string {
  const text = t().domain.widget;
  if (syncedAt === null) return text.notSynced;
  if (syncedAt >= dayStart) return text.syncedAt(formatClock(syncedAt));
  return text.syncedOn(new Date(syncedAt));
}
