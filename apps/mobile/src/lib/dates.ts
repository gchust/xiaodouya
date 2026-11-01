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
