const DAY_MS = 86_400_000;

function startOfDay(ms: number): Date {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** 手机所在时区的当天 0 点。夏令时切换的那天也准，不能用 86400000 取整。 */
export function startOfLocalDay(ms: number): number {
  return startOfDay(ms).getTime();
}

/** 按日历日算第几天，出生当天是第 1 天。用四舍五入抵消夏令时造成的 23/25 小时。 */
export function dayNumber(birthAt: number, at: number): number {
  return Math.round((startOfDay(at).getTime() - startOfDay(birthAt).getTime()) / DAY_MS) + 1;
}

/** 回忆可以早于出生（孕期的照片），不能显示成“第 -3 天”。 */
export function dayLabel(birthAt: number, at: number): string {
  const day = dayNumber(birthAt, at);
  return day > 0 ? `第 ${day} 天` : `出生前 ${1 - day} 天`;
}

export interface Age {
  months: number;
  days: number;
}

export function ageParts(birthAt: number, at: number): Age {
  const birth = new Date(birthAt);
  const now = new Date(at);
  let months = (now.getFullYear() - birth.getFullYear()) * 12 + now.getMonth() - birth.getMonth();
  // 出生在 31 号时，短月份的“满月日”按该月最后一天算。
  const anchor = (m: number) => {
    const y = birth.getFullYear();
    const lastDay = new Date(y, birth.getMonth() + m + 1, 0).getDate();
    return new Date(y, birth.getMonth() + m, Math.min(birth.getDate(), lastDay));
  };
  const today = startOfDay(at);
  if (anchor(months).getTime() > today.getTime()) months -= 1;
  months = Math.max(0, months);
  const days = Math.max(0, Math.round((today.getTime() - anchor(months).getTime()) / DAY_MS));
  return { months, days };
}

export function ageText(birthAt: number, at: number): string {
  if (at < birthAt) return '还没出生';
  const { months, days } = ageParts(birthAt, at);
  if (months >= 24) {
    const years = Math.floor(months / 12);
    const rest = months % 12;
    return rest ? `${years} 岁 ${rest} 个月` : `${years} 岁`;
  }
  if (months === 0) return days === 0 ? '今天出生' : `${days} 天`;
  return days ? `${months} 个月零 ${days} 天` : `${months} 个月`;
}

const pad = (n: number) => String(n).padStart(2, '0');

export function formatClock(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatMonthDay(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getMonth() + 1)}.${pad(d.getDate())}`;
}

export function formatFullDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`;
}

export function formatDateHeader(ms: number): string {
  const d = new Date(ms);
  return `${d.getMonth() + 1}月${d.getDate()}日 · 星期${'日一二三四五六'[d.getDay()]}`;
}

/** “1小时9分” / “25分钟” */
export function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  const hours = Math.floor(minutes / 60);
  if (!hours) return `${minutes}分钟`;
  return minutes % 60 ? `${hours}小时${minutes % 60}分` : `${hours}小时`;
}

/** 计时器样式 “2:41”（时:分） */
export function formatHoursMinutes(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  return `${Math.floor(minutes / 60)}:${pad(minutes % 60)}`;
}

/** 媒体时长 “1:12”（分:秒） */
export function formatMediaDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(seconds / 60)}:${pad(seconds % 60)}`;
}

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0';
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
