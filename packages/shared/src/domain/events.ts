import { t } from '../i18n';
import type { EventData } from '../schemas';
import { formatDuration } from './age';
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
      return text.feed(formatVolume(event.ml, units.volume));
    case 'diaper':
      return text.diaper(text[event.kind]);
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
      );
    case 'vaccine':
      return text.vaccine(vaccineRecordName(event.vaccineId, event.name));
  }
}

export interface DaySummary {
  feeds: number;
  ml: number;
  diapers: number;
  wetDiapers: number;
  sleepMs: number;
}

/** 统计 `now` 往前 24 小时。跨越窗口起点的睡眠只算窗口内的部分。 */
export function summarize24h(events: readonly EventData[], now: number): DaySummary {
  const start = now - 86_400_000;
  const summary: DaySummary = { feeds: 0, ml: 0, diapers: 0, wetDiapers: 0, sleepMs: 0 };
  for (const e of events) {
    if (e.type === 'sleep') {
      const end = Math.min(e.endAt ?? now, now);
      const begin = Math.max(e.at, start);
      if (end > begin) summary.sleepMs += end - begin;
      continue;
    }
    if (e.at <= start || e.at > now) continue;
    if (e.type === 'feed') {
      summary.feeds += 1;
      summary.ml += e.ml;
    } else if (e.type === 'diaper') {
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
  const summary: DaySummary = { feeds: 0, ml: 0, diapers: 0, wetDiapers: 0, sleepMs: 0 };
  for (const e of events) {
    if (e.type === 'sleep') {
      if (!e.endAt && now - e.at > FORGOTTEN_SLEEP_MS) continue;
      const end = Math.min(e.endAt ?? now, now);
      const begin = Math.max(e.at, dayStart);
      if (end > begin) summary.sleepMs += end - begin;
      continue;
    }
    if (e.at < dayStart || e.at > now) continue;
    if (e.type === 'feed') {
      summary.feeds += 1;
      summary.ml += e.ml;
    } else if (e.type === 'diaper') {
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

export interface EventDay<E> {
  dayStart: number;
  data: E[];
}

/** 全部记录页：按当地日历日分组，新的在前。 */
export function eventsByDay<E extends { data: EventData }>(entries: readonly E[]): EventDay<E>[] {
  const days = new Map<number, E[]>();
  for (const entry of entries) {
    const dayStart = new Date(entry.data.at).setHours(0, 0, 0, 0);
    const day = days.get(dayStart);
    if (day) day.push(entry);
    else days.set(dayStart, [entry]);
  }
  return [...days.entries()]
    .sort(([a], [b]) => b - a)
    .map(([dayStart, data]) => ({
      dayStart,
      data: data.sort((a, b) => b.data.at - a.data.at),
    }));
}

export function summaryText(s: DaySummary, units: Units = metricUnits): string {
  return t().domain.events.summary(
    s.feeds,
    formatVolume(s.ml, units.volume),
    s.diapers,
    (s.sleepMs / 3_600_000).toFixed(1),
  );
}
