import {
  type EventData,
  formatDateHeader,
  formatFullDate,
  type MomentData,
  pendingShareFiles,
  type Role,
  type ShareInclude,
  shareIncludesEvent,
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
export function shareLinkUrl(baseUrl: string, token: string): string {
  return `${withoutSlash(baseUrl)}/#${token}`;
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
