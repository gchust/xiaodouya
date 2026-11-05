import {
  type EventData,
  formatDateHeader,
  formatFullDate,
  type MomentData,
  pendingShareFiles,
  type Role,
  SHARE_TIMELINE_ALL_FROM,
  type ShareInclude,
  type ShareKind,
  type ShareSummary,
  shareFragment,
  shareIncludesEvent,
  TIMELINE_SHARE_INCLUDE,
  t,
  timelineRangeText,
  zonedCalendarDate,
} from '@xiaodouya/shared';
import { localDayBounds } from './dates';

/** 不依赖 React Native，方便单元测试。 */

/** 手机所在时区的这一天。过夏令时的那天是 23 或 25 小时，不能用加减毫秒算。 */
export function shareDayRange(at: number): { fromAt: number; toAt: number } {
  const { start, end } = localDayBounds(at);
  return { fromAt: start, toAt: end };
}

const withoutSlash = (url: string) => url.trim().replace(/\/+$/, '');

/**
 * 分享页是静态页面，只连构建时写进去的 API。登录页换成自己的服务器后，
 * 那边的链接在分享页上打不开，所以这时不提供入口。
 */
export function canShare(options: {
  baseUrl: string | null;
  serverUrl: string;
  defaultServerUrl: string;
  role: Role | null;
}): boolean {
  const { baseUrl, serverUrl, defaultServerUrl, role } = options;
  if (!baseUrl?.trim()) return false;
  if (role !== 'admin' && role !== 'caregiver') return false;
  return withoutSlash(serverUrl) === withoutSlash(defaultServerUrl);
}

/** 令牌放在片段里：浏览器不会把它发给托管网页的服务器。 */
export function shareLinkUrl(baseUrl: string, token: string, kind: ShareKind = 'day'): string {
  return `${withoutSlash(baseUrl)}/#${shareFragment(kind, token)}`;
}

export type TimelinePreset = 'week' | 'month' | 'all' | 'custom';

const PRESET_DAYS: Record<'week' | 'month', number> = { week: 7, month: 30 };

/**
 * 时间线分享的范围，按手机所在时区的日历日算（含今天），结束都是今天的结尾：
 * 过夏令时的那周多一小时或少一小时，不能用加减毫秒算。自定义的开始晚于结束时是 null。
 */
export function shareTimelineRange(
  preset: TimelinePreset,
  now: number,
  custom?: { from: number; to: number },
): { fromAt: number; toAt: number } | null {
  const today = localDayBounds(now);
  if (preset === 'all') return { fromAt: SHARE_TIMELINE_ALL_FROM, toAt: today.end };
  if (preset === 'custom') {
    if (!custom) return null;
    const fromAt = localDayBounds(custom.from).start;
    // 选到未来时只到今天：服务端不收晚于明天的结束，链接也不该一直往后看。
    const toAt = Math.min(localDayBounds(custom.to).end, today.end);
    return fromAt < toAt ? { fromAt, toAt } : null;
  }
  return { fromAt: localDayBounds(now, 1 - PRESET_DAYS[preset]).start, toAt: today.end };
}

/** 这段时间里现在打开页面还看不到的回忆和文件。时间线不含记录，所以只按回忆算。 */
export function shareTimelinePending(
  source: PendingSource,
  range: { fromAt: number; toAt: number },
  uploadingIds: ReadonlySet<string>,
): { records: number; files: number } {
  return shareDayPending(source, range, TIMELINE_SHARE_INCLUDE, uploadingIds);
}

/** “已分享的链接”里每一行的标题，写明是一天还是时间线。 */
export function shareLinkTitle(share: ShareSummary, now: number): string {
  if (share.kind === 'timeline') {
    // 按创建时的时区：和对方打开的页面上写的一样。
    const calendar = (ms: number) => zonedCalendarDate(ms, share.timezone).getTime();
    return t().share.linkTitleTimeline(timelineRangeText(share, now, calendar));
  }
  return t().share.linkTitleDay(shareDayTitle(share.fromAt, now));
}

export function shareDayTitle(at: number, now: number): string {
  const sameYear = new Date(at).getFullYear() === new Date(now).getFullYear();
  return sameYear ? formatDateHeader(at) : formatFullDate(at);
}

interface PendingSource {
  events: readonly { data: EventData; dirty: boolean }[];
  moments: readonly { data: MomentData; dirty: boolean }[];
}

/** 这一天选中的内容里，现在打开页面还看不到多少。要明说，不能悄悄缺内容。 */
export function shareDayPending(
  { events, moments }: PendingSource,
  range: { fromAt: number; toAt: number },
  include: ShareInclude,
  uploadingIds: ReadonlySet<string>,
): { records: number; files: number } {
  const inRange = (at: number) => at >= range.fromAt && at < range.toAt;
  let records = events.filter(
    (e) => e.dirty && inRange(e.data.at) && shareIncludesEvent(e.data.type, include),
  ).length;
  if (!include.moments) return { records, files: 0 };
  records += moments.filter((m) => m.dirty && inRange(m.data.at)).length;
  return { records, files: pendingShareFiles(moments, range, uploadingIds) };
}
