import {
  type EventData,
  formatDateHeader,
  formatFullDate,
  isDefaultShareDisplay,
  MAX_SHARE_MOMENTS,
  type MomentData,
  pendingShareFiles,
  type Role,
  SHARE_NICKNAME_MAX,
  SHARE_TIMELINE_ALL_FROM,
  ShareDisplay,
  type ShareInclude,
  type ShareKind,
  type SharePrefs,
  type ShareSummary,
  shareFragment,
  shareIncludesEvent,
  sharePrefsOf,
  TIMELINE_SHARE_INCLUDE,
  t,
  timelineRangeText,
  zonedCalendarDate,
} from '@xiaodouya/shared';
import { localDayBounds } from './dates';

/** 不依赖 React Native，方便单元测试。 */

/**
 * 链接属于哪个宝宝（issue #106）。有几个宝宝时是当前宝宝；只有一个宝宝时不带，请求和以前一样，
 * 服务端按“旧版界面上显示的宝宝”处理，就是这一个。
 */
export function shareBabyField(snapshot: { multiBaby: boolean; baby: { id: string } | null }): {
  babyId?: string;
} {
  return snapshot.multiBaby && snapshot.baby ? { babyId: snapshot.baby.id } : {};
}

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

/** “已分享的链接”里每一行的标题，写明是一天、时间线还是选中的回忆。 */
export function shareLinkTitle(
  share: ShareSummary,
  now: number,
  moments: readonly TitledMoment[] = [],
): string {
  if (share.kind === 'moments') {
    return share.momentIds?.length
      ? t().share.linkTitleMoments(shareMomentsTitle(share.momentIds, moments))
      : t().share.linkTitleMomentsBare;
  }
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
  moments: readonly { id?: string; data: MomentData; dirty: boolean }[];
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

// ─── 分享回忆（F-136） ───────────────────────────────

interface TitledMoment {
  id: string;
  data: Pick<MomentData, 'title' | 'at'>;
}

/**
 * 选中回忆的头尾，只用来在「已分享的链接」里排序和给旧版 App 显示日期：
 * 公开接口按 id 查，不按这个范围。
 */
export function shareMomentsRange(moments: readonly { data: Pick<MomentData, 'at'> }[]): {
  fromAt: number;
  toAt: number;
} {
  const times = moments.map((m) => m.data.at);
  return { fromAt: Math.max(0, Math.min(...times)), toAt: Math.max(...times) + 1 };
}

/** 一段写它的标题（没有标题是“这一刻”），几段写段数。手机上找不到的（家人刚删掉）只算数。 */
export function shareMomentsTitle(
  ids: readonly string[],
  moments: readonly TitledMoment[],
): string {
  if (ids.length === 1) {
    const found = moments.find((m) => m.id === ids[0]);
    if (found) return found.data.title.trim() || t().ui.thisMoment;
  }
  return t().share.momentsCount(ids.length);
}

/** 选中的回忆里，现在打开页面还看不到的回忆和文件。 */
export function shareMomentsPending(
  source: PendingSource,
  ids: readonly string[],
  uploadingIds: ReadonlySet<string>,
): { records: number; files: number } {
  const chosen = new Set(ids);
  const moments = source.moments.filter((m) => m.id !== undefined && chosen.has(m.id));
  return {
    records: moments.filter((m) => m.dirty).length,
    files: moments.reduce(
      (count, m) => count + m.data.media.filter((file) => uploadingIds.has(file.id)).length,
      0,
    ),
  };
}

/** 选择模式里点一段：没选的加到后面，选了的拿掉。选满了不再加，原样返回。 */
export function toggleSelection(selected: readonly string[], id: string): readonly string[] {
  if (selected.includes(id)) return selected.filter((item) => item !== id);
  if (selected.length >= MAX_SHARE_MOMENTS) return selected;
  return [...selected, id];
}

// ─── 分享设置（F-141） ───────────────────────────────

/** 名字这一项的说法：显示为“小宝” / 不显示名字 / 显示名字。 */
export function shareDisplayShown(display: ShareDisplay): string {
  if (!display.showName) return t().share.shownHidden;
  const nickname = display.nickname.trim();
  return nickname ? t().share.shownAs(nickname) : t().share.shownReal;
}

/** 分享弹层上收起时的一行：对方看到：显示为“小宝” · 带头像。 */
export function shareDisplaySummary(display: ShareDisplay): string {
  return t().share.summaryLine(shareDisplayShown(display), display.showAvatar);
}

/** 家人页“分享设置”那一行的副标题。 */
export function shareSettingsSub(prefs: SharePrefs | undefined): string {
  const { ttlDays, display } = sharePrefsOf(prefs);
  return t().share.settingsRowSub(ttlDays, shareDisplayShown(display), display.showAvatar);
}

/** 称呼不合规时的说明，和服务端用同一个规则（`ShareDisplay`）。 */
export function nicknameProblem(nickname: string): string | null {
  return ShareDisplay.shape.nickname.safeParse(nickname).success
    ? null
    : t().share.nicknameBad(SHARE_NICKNAME_MAX);
}

/**
 * 确定服务端不认识这些选项、而这次又改过名字或头像时要提醒：旧服务端会悄悄丢掉选项，
 * 页面上照样是真实名字。还不知道（离线、还没问到）时不提醒，那时也建不了链接。
 */
export function shareDisplayUnsupported(display: ShareDisplay, supported: boolean | null): boolean {
  return supported === false && !isDefaultShareDisplay(display);
}
