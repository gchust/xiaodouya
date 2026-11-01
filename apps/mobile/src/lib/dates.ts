import { formatClock, formatFullDate } from '@xiaodouya/shared';

export function formatBirthTime(ms: number): string {
  return `${formatFullDate(ms)} ${formatClock(ms)}`;
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
