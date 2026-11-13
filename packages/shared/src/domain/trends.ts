import type { EventData } from '../schemas';
import { FORGOTTEN_SLEEP_MS } from './feeding';

/**
 * 趋势页（issue #107）：一周、一个月里每天喂了几次、多少，睡了多久，换了几次尿布。
 * 只统计，不判断多少算够：判断属于健康内容（AGENTS.md 第 8 节），要有来源和医护复核。
 */

export type TrendRange = 7 | 30;

export interface TrendDay {
  /** 手机时区这一天的 0 点和第二天 0 点。夏令时那天是 23 或 25 小时。 */
  start: number;
  end: number;
  /** 今天还没过完，只统计到现在，不能和完整的一天比。 */
  partial: boolean;
  /** 这一天过去了多少（0–1），过完的天是 1。 */
  elapsed: number;
  /** 所有喂奶，含亲喂。 */
  feeds: number;
  nursingFeeds: number;
  /** 算进奶量的喂奶次数。 */
  amountFeeds: number;
  /** 瓶喂的奶量，ml。没有一次带奶量的喂奶时是 null：没记不等于喝了 0ml。 */
  ml: number | null;
  diapers: number;
  /** 尿尿和便便的次数。`都有` 两边各算一次，所以加起来可以比换的次数多。 */
  wee: number;
  poo: number;
  /** 没有睡眠记录时是 null。重叠的几段只算一次。 */
  sleepMs: number | null;
  /** 睡眠在这一天里的位置，0 是 0 点，1 是第二天 0 点，按先后排好、互不重叠。 */
  sleeps: { from: number; to: number }[];
  /** 这一天量的体温，℃，按时间先后。 */
  temps: number[];
}

type FeedEvent = Extract<EventData, { type: 'feed' }>;

/**
 * 亲喂（#104 加的 `method: 'breast'`）。#104 合并前旧版本不认识这个字段，
 * 记录照样能过校验（looseObject 保留多余字段），这里先认出来，不把亲喂的 0ml 当成摄入。
 */
export function isNursingFeed(e: EventData): e is FeedEvent {
  return e.type === 'feed' && e.method === 'breast';
}

/**
 * 能算进奶量的喂奶。0ml 不算：#104 之前亲喂的家庭只能记“母乳 0ml”，
 * 算进去的话只有亲喂的那天会显示成喝了 0ml。
 */
function hasAmount(e: FeedEvent): boolean {
  return e.method !== 'breast' && e.ml > 0;
}

function emptyDay(start: number, end: number, now: number): TrendDay {
  const partial = now < end;
  return {
    start,
    end,
    partial,
    elapsed: partial ? Math.max(0, (now - start) / (end - start)) : 1,
    feeds: 0,
    nursingFeeds: 0,
    amountFeeds: 0,
    ml: null,
    diapers: 0,
    wee: 0,
    poo: 0,
    sleepMs: null,
    sleeps: [],
    temps: [],
  };
}

/** 合并重叠的时间段：两个家人各记了一次同一段睡眠时不能算两遍。 */
function mergeSpans(spans: { from: number; to: number }[]): { from: number; to: number }[] {
  const sorted = [...spans].sort((a, b) => a.from - b.from);
  const merged: { from: number; to: number }[] = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last && span.from <= last.to) last.to = Math.max(last.to, span.to);
    else merged.push({ ...span });
  }
  return merged;
}

/**
 * 最近 `range` 个日历日（含今天），旧的在前。按手机时区分天，夏令时那天按日历算，不用 86400000 加减。
 * 睡眠的规则和今日汇总（`summarizeDay`）一样：正在睡的算到现在；超过 12 小时没结束的是忘了点“醒了”，
 * 整段不算。是不是忘了要用真正的现在判断，不能用那一天的 24 点，不然几天前没关的计时会把那天算满。
 */
export function trendDays(
  events: readonly EventData[],
  now: number,
  range: TrendRange,
): TrendDay[] {
  const today = new Date(now);
  const y = today.getFullYear();
  const m = today.getMonth();
  const d = today.getDate();
  const days: TrendDay[] = [];
  for (let back = range - 1; back >= 0; back--) {
    const start = new Date(y, m, d - back).getTime();
    const end = new Date(y, m, d - back + 1).getTime();
    days.push(emptyDay(start, end, now));
  }
  const first = days[0]?.start ?? now;
  const dayOf = (ms: number): TrendDay | undefined => {
    if (ms < first || ms > now) return undefined;
    for (let i = days.length - 1; i >= 0; i--) {
      const day = days[i];
      if (day && ms >= day.start) return day;
    }
    return undefined;
  };

  const sleepSpans: { from: number; to: number }[] = [];
  const temps: { at: number; celsius: number }[] = [];
  for (const e of events) {
    if (e.type === 'sleep') {
      if (e.at > now) continue;
      if (e.endAt === undefined && now - e.at > FORGOTTEN_SLEEP_MS) continue;
      const to = Math.min(e.endAt ?? now, now);
      if (to > e.at && to > first) sleepSpans.push({ from: Math.max(e.at, first), to });
      continue;
    }
    const day = dayOf(e.at);
    if (!day) continue;
    if (e.type === 'feed') {
      day.feeds += 1;
      if (isNursingFeed(e)) day.nursingFeeds += 1;
      if (hasAmount(e)) {
        day.amountFeeds += 1;
        day.ml = (day.ml ?? 0) + e.ml;
      }
    } else if (e.type === 'diaper') {
      day.diapers += 1;
      if (e.kind !== 'poo') day.wee += 1;
      if (e.kind !== 'wee') day.poo += 1;
    } else if (e.type === 'temp') {
      temps.push({ at: e.at, celsius: e.celsius });
    }
  }

  for (const { at, celsius } of temps.sort((a, b) => a.at - b.at)) {
    dayOf(at)?.temps.push(celsius);
  }

  for (const span of mergeSpans(sleepSpans)) {
    for (const day of days) {
      const from = Math.max(span.from, day.start);
      const to = Math.min(span.to, day.end);
      if (to <= from) continue;
      day.sleepMs = (day.sleepMs ?? 0) + (to - from);
      const length = day.end - day.start;
      day.sleeps.push({ from: (from - day.start) / length, to: (to - day.start) / length });
    }
  }
  return days;
}

/**
 * 过完的、有这项记录的天的平均，并给出是几天。今天没过完不算；没记的天也不算，
 * 不然哪天忘了记就会把平均拉低，看起来像吃少了。
 */
export function trendAverage(
  days: readonly TrendDay[],
  pick: (day: TrendDay) => number | null,
): { value: number; days: number } | null {
  let sum = 0;
  let count = 0;
  for (const day of days) {
    if (day.partial) continue;
    const value = pick(day);
    if (value === null) continue;
    sum += value;
    count += 1;
  }
  return count === 0 ? null : { value: sum / count, days: count };
}
