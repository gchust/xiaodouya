import { formatClock, formatFullDate } from '@xiaodouya/shared';

export function formatBirthTime(ms: number): string {
  return `${formatFullDate(ms)} ${formatClock(ms)}`;
}

/** 出生时间不能晚于现在。天数、月龄和疫苗时间都从它算起，错了影响整个 App。 */
export function isBirthInFuture(birthAt: number, now: number): boolean {
  return birthAt > now;
}

/**
 * 接种日期变成记录时间。今天的用现在，这样时间线顺序才对；补记以前的放在那天中午，
 * 时区差几个小时也还是同一天。不接受未来的日期。
 */
export function doseTimestamp(picked: Date, now: number): number {
  if (picked.toDateString() === new Date(now).toDateString()) return now;
  const noon = new Date(picked.getFullYear(), picked.getMonth(), picked.getDate(), 12).getTime();
  return Math.min(noon, now);
}

/** 手机时区里这一天的范围。过夏令时的那天不是 24 小时，不能用加减毫秒算。 */
export function localDayBounds(ms: number, offsetDays = 0): { start: number; end: number } {
  const day = new Date(ms);
  const y = day.getFullYear();
  const m = day.getMonth();
  const d = day.getDate() + offsetDays;
  return { start: new Date(y, m, d).getTime(), end: new Date(y, m, d + 1).getTime() };
}

/** 改接种日期：日期没变就保留原来的时刻，只改备注不能把时间线上的位置挪走。 */
export function editedDoseTimestamp(originalAt: number, picked: Date, now: number): number {
  return picked.toDateString() === new Date(originalAt).toDateString()
    ? originalAt
    : doseTimestamp(picked, now);
}

/** 计划接种日期存成当地中午，时区差几个小时也还是同一天。可以是未来，也可以已经过去。 */
export function plannedDayTimestamp(picked: Date): number {
  return new Date(picked.getFullYear(), picked.getMonth(), picked.getDate(), 12).getTime();
}

export function plannedDaysLater(days: number, now: number): Date {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days, 12);
}

/** 下个月的今天。下个月没有这一天时（1 月 31 日）取月底，不跳到再下一个月。 */
export function plannedNextMonth(now: number): Date {
  const d = new Date(now);
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 2, 0).getDate();
  return new Date(d.getFullYear(), d.getMonth() + 1, Math.min(d.getDate(), lastDay), 12);
}

/** 记录时间的选择：相对现在的几个偏移（保存时才算成时间），或者一个确定的时刻。 */
export type TimeChoice = { kind: 'offset'; minutes: number } | { kind: 'exact'; at: number };

export function resolveTimeChoice(choice: TimeChoice, now: number): number {
  return choice.kind === 'exact' ? choice.at : now - choice.minutes * 60_000;
}

/**
 * 换日期时保留时刻。今天的日期配上比现在晚的时刻时退回现在：
 * 用户选的是“哪一天”，不该因为原来的时刻而看到“时间还没到”。
 */
export function withDate(at: number, picked: Date, now: number): number {
  const d = new Date(at);
  d.setFullYear(picked.getFullYear(), picked.getMonth(), picked.getDate());
  return Math.min(d.getTime(), now);
}

/** 换时刻时保留日期。时刻可能选到未来，由 checkRecordTime 提示，这里不改用户选的值。 */
export function withClock(at: number, picked: Date): number {
  const d = new Date(at);
  d.setHours(picked.getHours(), picked.getMinutes(), 0, 0);
  return d.getTime();
}

/** 今天、昨天、前天这几个快捷日期。 */
export function withDaysAgo(at: number, daysAgo: number, now: number): number {
  const day = new Date(now);
  day.setDate(day.getDate() - daysAgo);
  return withDate(at, day, now);
}

export function isDaysAgo(at: number, daysAgo: number, now: number): boolean {
  const day = new Date(now);
  day.setDate(day.getDate() - daysAgo);
  return day.toDateString() === new Date(at).toDateString();
}

/** 成员状态：刚刚活跃算在线，否则显示大致时间。 */
export function formatLastSeen(
  lastSeenAt: number | null,
  now: number,
): { text: string; online: boolean } {
  if (!lastSeenAt) return { text: '还没上线', online: false };
  const diff = now - lastSeenAt;
  if (diff < 5 * 60_000) return { text: '在线', online: true };
  if (diff < 3_600_000) return { text: `${Math.floor(diff / 60_000)} 分钟前`, online: false };
  const today = new Date(now);
  const seen = new Date(lastSeenAt);
  if (today.toDateString() === seen.toDateString()) return { text: '今天', online: false };
  const yesterday = new Date(now - 86_400_000);
  if (yesterday.toDateString() === seen.toDateString()) return { text: '昨天', online: false };
  return { text: `${seen.getMonth() + 1}月${seen.getDate()}日`, online: false };
}
