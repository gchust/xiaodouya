import { t } from '../i18n';
import type { EventData } from '../schemas';
import { formatDuration } from './age';
import { breastDurationMs, describeBreastFeed, isBreastFeed } from './breastfeeding';
import { FORGOTTEN_SLEEP_MS } from './feeding';
import {
  formatLength,
  formatTemperature,
  formatVolume,
  formatWeight,
  metricUnits,
  type Units,
} from './units';
import { vaccineRecordName } from './vaccines';

export const eventColors: Record<EventData['type'], string> = {
  feed: '#c0714f',
  diaper: '#c9a24a',
  // 吸奶和喂奶都是奶，用同一个颜色，靠文字区分（和辅食、尿布同色一样）。
  pump: '#c0714f',
  sleep: '#7d8fb8',
  temp: '#b8645e',
  med: '#8a7a9e',
  bath: '#6f9aa0',
  solids: '#c9a24a',
  growth: '#6f9a6a',
  vaccine: '#6f9a6a',
};

export function describeEvent(event: EventData, now: number, units: Units = metricUnits): string {
  const text = t().domain.events;
  switch (event.type) {
    case 'feed':
      if (isBreastFeed(event)) return describeBreastFeed(event, now);
      return text.feed(formatVolume(event.ml, units.volume));
    case 'diaper':
      return text.diaper(text[event.kind]);
    case 'pump':
      return text.pump(
        formatVolume(event.ml, units.volume),
        event.side ? text.pumpSide(event.side) : undefined,
      );
    case 'sleep':
      return event.endAt
        ? text.slept(formatDuration(event.endAt - event.at))
        : text.sleeping(formatDuration(now - event.at));
    case 'temp':
      return text.temp(formatTemperature(event.celsius, units.temperature));
    case 'med':
      return text.med(event.name, event.dose);
    case 'bath':
      return text.bath;
    case 'solids':
      return text.solids(event.food);
    case 'growth':
      return text.growth(
        formatWeight(event.weightKg, units.weight),
        formatLength(event.lengthCm, units.length),
        event.headCm === undefined ? undefined : formatLength(event.headCm, units.length),
      );
    case 'vaccine':
      return text.vaccine(vaccineRecordName(event.vaccineId, event.name));
  }
}

export interface DaySummary {
  /** 喂奶次数，瓶喂和亲喂都算。 */
  feeds: number;
  /** 瓶喂的奶量。亲喂没有奶量。 */
  ml: number;
  /** 其中亲喂几次、一共喂了多久（正在喂的算到现在，忘了关的计时不算）。 */
  breastFeeds: number;
  breastMs: number;
  diapers: number;
  wetDiapers: number;
  sleepMs: number;
}

const emptySummary = (): DaySummary => ({
  feeds: 0,
  ml: 0,
  breastFeeds: 0,
  breastMs: 0,
  diapers: 0,
  wetDiapers: 0,
  sleepMs: 0,
});

function addFeed(summary: DaySummary, feed: Extract<EventData, { type: 'feed' }>, now: number) {
  summary.feeds += 1;
  if (isBreastFeed(feed)) {
    summary.breastFeeds += 1;
    summary.breastMs += breastDurationMs(feed, now);
  } else {
    summary.ml += feed.ml;
  }
}

/** 统计 `now` 往前 24 小时。跨越窗口起点的睡眠只算窗口内的部分。 */
export function summarize24h(events: readonly EventData[], now: number): DaySummary {
  const start = now - 86_400_000;
  const summary = emptySummary();
  for (const e of events) {
    if (e.type === 'sleep') {
      const end = Math.min(e.endAt ?? now, now);
      const begin = Math.max(e.at, start);
      if (end > begin) summary.sleepMs += end - begin;
      continue;
    }
    if (e.at <= start || e.at > now) continue;
    if (e.type === 'feed') addFeed(summary, e, now);
    else if (e.type === 'diaper') {
      summary.diapers += 1;
      if (e.kind !== 'poo') summary.wetDiapers += 1;
    }
  }
  return summary;
}

/**
 * 统计从 `dayStart` 到 `now`，给“今日汇总”用，不同于滚动的 24 小时。
 * 跨午夜的睡眠只算今天的部分；忘记结束的睡眠不算，否则会多出一段没有发生过的睡眠。
 */
export function summarizeDay(
  events: readonly EventData[],
  dayStart: number,
  now: number,
): DaySummary {
  const summary = emptySummary();
  for (const e of events) {
    if (e.type === 'sleep') {
      if (!e.endAt && now - e.at > FORGOTTEN_SLEEP_MS) continue;
      const end = Math.min(e.endAt ?? now, now);
      const begin = Math.max(e.at, dayStart);
      if (end > begin) summary.sleepMs += end - begin;
      continue;
    }
    if (e.at < dayStart || e.at > now) continue;
    if (e.type === 'feed') addFeed(summary, e, now);
    else if (e.type === 'diaper') {
      summary.diapers += 1;
      if (e.kind !== 'poo') summary.wetDiapers += 1;
    }
  }
  return summary;
}

const TIMELINE_LIMIT = 8;

/**
 * 今天页的时间线，`entries` 按时间倒序。
 * 只放真的在过去 24 小时里的记录：这一栏只显示钟点，补记的旧记录混进来会被看成今天的。
 * 跨过窗口起点的睡眠算在摘要里，没结束的睡眠要能点开改，所以也放进来。
 */
export function timelineEntries<E extends { data: EventData }>(
  entries: readonly E[],
  now: number,
): E[] {
  const start = now - 86_400_000;
  return entries
    .filter(({ data }) => {
      if (data.type === 'growth' || data.at > now) return false;
      if (data.at > start) return true;
      return data.type === 'sleep' && (data.endAt === undefined || data.endAt > start);
    })
    .slice(0, TIMELINE_LIMIT);
}

export interface DayGroup<T> {
  dayStart: number;
  data: T[];
}

export type EventDay<E> = DayGroup<E>;

/** 按当地日历日分组，天和天里都是新的在前。 */
export function groupByDay<T>(items: readonly T[], at: (item: T) => number): DayGroup<T>[] {
  const days = new Map<number, T[]>();
  for (const item of items) {
    const dayStart = new Date(at(item)).setHours(0, 0, 0, 0);
    const day = days.get(dayStart);
    if (day) day.push(item);
    else days.set(dayStart, [item]);
  }
  return [...days.entries()]
    .sort(([a], [b]) => b - a)
    .map(([dayStart, data]) => ({ dayStart, data: data.sort((a, b) => at(b) - at(a)) }));
}

/** 全部记录页：按当地日历日分组，新的在前。 */
export function eventsByDay<E extends { data: EventData }>(entries: readonly E[]): EventDay<E>[] {
  return groupByDay(entries, (entry) => entry.data.at);
}

/** 只有瓶喂时和以前一样（`喂奶 4 次 · 330ml`）；有亲喂时分开写，不写亲喂的 0ml。 */
export function summaryText(s: DaySummary, units: Units = metricUnits): string {
  const text = t().domain.events;
  const sleepHours = (s.sleepMs / 3_600_000).toFixed(1);
  if (s.breastFeeds === 0) {
    return text.summary(s.feeds, formatVolume(s.ml, units.volume), s.diapers, sleepHours);
  }
  const parts: string[] = [];
  if (s.feeds > s.breastFeeds) parts.push(text.bottlePart(formatVolume(s.ml, units.volume)));
  // `breastMs` 已经是每一条两侧写出来的分钟数之和。刚开始计时、还是 0 秒时就不写时长。
  const minutes = Math.round(s.breastMs / 60_000);
  parts.push(
    minutes > 0
      ? text.breastPart(text.breastDuration(Math.floor(minutes / 60), minutes % 60))
      : text.breastOnly,
  );
  return text.summaryMixed(s.feeds, parts, s.diapers, sleepHours);
}
