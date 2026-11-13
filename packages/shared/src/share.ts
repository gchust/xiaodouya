import { z } from 'zod';
import { type Age, ageParts, dayNumber, formatFullDate, formatShortDate } from './domain/age';
import { describeEvent } from './domain/events';
import { FORGOTTEN_SLEEP_MS } from './domain/feeding';
import {
  lengthUnits,
  temperatureUnits,
  type Units,
  volumeUnits,
  weightUnits,
} from './domain/units';
import { isCustomVaccineId } from './domain/vaccines';
import { t } from './i18n';
import { EventData, type MomentData } from './schemas';
import { DEFAULT_SHARE_TTL_DAYS, ShareDisplay, ShareTtlDays } from './shareSettings';

/** 夏令时结束那天是 25 小时。边界要算在内，否则那一天永远分享不了。 */
export const SHARE_MAX_RANGE_MS = 25 * 3_600_000;
export const MAX_ACTIVE_SHARES = 50;
/**
 * 公开响应里最多带多少个文件。一个文件要签两个链接，而 Edge Function 的 CPU 时间有限；
 * 超出的部分在 `omittedMedia` 里如实告诉页面，不悄悄缺内容。
 */
export const MAX_PUBLIC_MEDIA = 200;

export const ShareInclude = z.object({
  moments: z.boolean(),
  daily: z.boolean(),
  health: z.boolean(),
});
export type ShareInclude = z.infer<typeof ShareInclude>;

/** 健康记录默认关：体温、用药这些比照片更敏感，要分享的人自己打开。 */
export const defaultShareInclude: ShareInclude = { moments: true, daily: true, health: false };

export const ShareUnits = z.object({
  volume: z.enum(volumeUnits),
  temperature: z.enum(temperatureUnits),
  weight: z.enum(weightUnits),
  length: z.enum(lengthUnits),
});

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

export const CreateShareRequest = z
  .object({
    fromAt: z.number().int().nonnegative(),
    toAt: z.number().int().positive(),
    /** 分享者手机的时区。对方可能在别的时区，日期和钟点要按记录的人那边显示。 */
    timezone: z.string().min(1).max(64).refine(isValidTimeZone),
    include: ShareInclude.default(defaultShareInclude),
    units: ShareUnits,
    ttlDays: ShareTtlDays.default(DEFAULT_SHARE_TTL_DAYS),
    /** F-141 起的 App 一直带。没有时（旧版 App）和以前一样：真实名字、不带头像。 */
    display: ShareDisplay.optional(),
    /** 分享的是哪个宝宝（issue #106）。没有时（旧版 App）是旧版界面上显示的宝宝，见 `shareBabyId`。 */
    babyId: z.uuid().optional(),
  })
  .refine((v) => v.toAt > v.fromAt && v.toAt - v.fromAt <= SHARE_MAX_RANGE_MS, {
    path: ['toAt'],
  })
  .refine((v) => v.include.moments || v.include.daily || v.include.health, {
    path: ['include'],
  });
export type CreateShareRequest = z.input<typeof CreateShareRequest>;

export interface CreateShareResponse {
  id: string;
  /** 只在这里返回一次，库里只存哈希。 */
  token: string;
  expiresAt: number;
}

export type ShareKind = 'day' | 'timeline' | 'moments';

export interface ShareSummary {
  id: string;
  /** 新服务端一直带。旧服务端没有这个字段，按一天处理。 */
  kind?: ShareKind;
  fromAt: number;
  toAt: number;
  timezone: string;
  include: ShareInclude;
  expiresAt: number;
  createdAt: number;
  /** 只有选中回忆的链接（F-136）有：选了哪几段。 */
  momentIds?: string[];
  /** 创建时定下的名字和头像（F-141）。旧服务端没有这个字段。 */
  display?: ShareDisplay;
  /** 创建时选的宝宝（issue #106）。旧版 App 建的链接没有，属于旧版界面上显示的宝宝。 */
  babyId?: string;
  /** 创建者在家庭里的称呼。 */
  byLabel: string;
  canRevoke: boolean;
}

export interface ShareListResponse {
  shares: ShareSummary[];
}

/** 令牌放请求体，不放地址，这样不会进函数和代理的访问日志。 */
export const PublicShareRequest = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});

export const publicMediaKinds = ['image', 'video', 'audio'] as const;

export const PublicMedia = z.object({
  /** 链接过期后重新取数据时，靠它对上页面里的元素。 */
  id: z.string(),
  kind: z.enum(publicMediaKinds),
  /** 照片是预览图，没有预览的旧照片才是原图；视频和录音是原文件。都没传完时是 null，这时只有缩略图。 */
  url: z.string().nullable(),
  thumbUrl: z.string().nullable(),
  width: z.number().optional(),
  height: z.number().optional(),
  durationMs: z.number().optional(),
});
export type PublicMedia = z.infer<typeof PublicMedia>;

export const PublicMoment = z.object({
  at: z.number(),
  title: z.string(),
  text: z.string(),
  milestone: z.boolean(),
  byName: z.string().optional(),
  media: z.array(PublicMedia),
});
export type PublicMoment = z.infer<typeof PublicMoment>;

/**
 * 宝宝头像的签名链接（F-141）。只有创建链接时选了显示头像才有；旧服务端没有这个字段。
 * 只发缩略图（重新编码过，没有原图的 EXIF 和位置），没有缩略图时不发。
 */
const PublicAvatarUrl = z.string().nullable().optional();

export const PublicShareResponse = z.object({
  baby: z.object({
    /** 按链接的设置换过：隐藏时是空字符串，有称呼时是称呼。 */
    name: z.string(),
    avatarUrl: PublicAvatarUrl,
    /** 服务端算好的第几天和月龄，不下发出生时间。没有档案或者还没出生时是 null。 */
    dayNumber: z.number().nullable(),
    age: z.object({ months: z.number(), days: z.number() }).nullable(),
  }),
  range: z.object({ fromAt: z.number(), toAt: z.number(), timezone: z.string() }),
  units: ShareUnits,
  events: z.array(EventData),
  moments: z.array(PublicMoment),
  /** 文件太多放不下的数量。 */
  omittedMedia: z.number(),
  /** 文件链接还有多少秒过期。 */
  mediaExpiresIn: z.number(),
});
export type PublicShareResponse = z.infer<typeof PublicShareResponse>;

export type ShareEventGroup = 'daily' | 'health';

/**
 * 吸奶不进分享页（null）：记的是大人，不是宝宝的一天。已经部署的分享页按 `z.array(EventData)` 解析整个响应，
 * 不认识的类型会让整页打不开，所以服务端也绝不能发它。
 */
export function shareEventGroup(type: EventData['type']): ShareEventGroup | null {
  switch (type) {
    case 'pump':
      return null;
    case 'feed':
    case 'diaper':
    case 'sleep':
    case 'solids':
    case 'bath':
      return 'daily';
    case 'temp':
    case 'med':
    case 'growth':
    case 'vaccine':
      return 'health';
  }
}

export function shareIncludesEvent(type: EventData['type'], include: ShareInclude): boolean {
  const group = shareEventGroup(type);
  return group !== null && include[group];
}

/**
 * 公开页面上一条记录能出现的全部字段，逐字段构造。`looseObject` 会保留未知字段，
 * 比如喂奶的奶粉快照、新版本写入的东西，所以绝不能把 `record.data` 原样发出去。
 */
export function pickEventForShare(event: EventData): EventData {
  const base = {
    at: event.at,
    ...(event.note ? { note: event.note } : {}),
    ...(event.byName ? { byName: event.byName } : {}),
  };
  switch (event.type) {
    case 'feed':
      if (event.method === 'breast') {
        // 亲喂只发显示要用的：哪一侧、各喂了多久、什么时候结束。
        const pick = <K extends 'side' | 'sideSince' | 'leftSec' | 'rightSec' | 'endAt'>(key: K) =>
          event[key] === undefined ? {} : { [key]: event[key] };
        return {
          ...base,
          type: 'feed',
          ml: 0,
          method: 'breast',
          ...pick('side'),
          ...pick('sideSince'),
          ...pick('leftSec'),
          ...pick('rightSec'),
          ...pick('endAt'),
        };
      }
      return { ...base, type: 'feed', ml: event.ml };
    case 'diaper':
      return { ...base, type: 'diaper', kind: event.kind };
    case 'pump':
      // 不会发出去（`shareEventGroup` 是 null），这里只是保证逐字段构造。
      return { ...base, type: 'pump', ml: event.ml, ...(event.side ? { side: event.side } : {}) };
    case 'sleep':
      return { ...base, type: 'sleep', ...(event.endAt ? { endAt: event.endAt } : {}) };
    case 'temp':
      return { ...base, type: 'temp', celsius: event.celsius };
    case 'med':
      return {
        ...base,
        type: 'med',
        name: event.name,
        ...(event.dose ? { dose: event.dose } : {}),
      };
    case 'bath':
      return { ...base, type: 'bath' };
    case 'solids':
      return { ...base, type: 'solids', food: event.food };
    case 'growth':
      return { ...base, type: 'growth', weightKg: event.weightKg, lengthCm: event.lengthCm };
    case 'vaccine':
      // 内置剂次的 id 用来换语言；自己加的疫苗 id 里是记录的 UUID，页面用不上。
      return {
        ...base,
        type: 'vaccine',
        vaccineId: isCustomVaccineId(event.vaccineId) ? 'custom' : event.vaccineId,
        name: event.name,
      };
  }
}

export function pickMomentForShare(moment: MomentData, media: PublicMedia[]): PublicMoment {
  return {
    at: moment.at,
    title: moment.title,
    text: moment.text,
    milestone: moment.milestone,
    ...(moment.byName ? { byName: moment.byName } : {}),
    media,
  };
}

/** 没有文字也没有能显示的文件的回忆，页面上是一块空白，不发。 */
export function hasShareContent(moment: PublicMoment): boolean {
  return Boolean(moment.title.trim() || moment.text.trim() || moment.media.length > 0);
}

/** 日历上的一个时刻在某个时区里读出来是什么。 */
export interface ZonedParts {
  year: number;
  /** 1–12 */
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function zonedFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: isValidTimeZone(timeZone) ? timeZone : undefined,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

export function zonedParts(ms: number, timeZone: string): ZonedParts {
  const values: Record<string, number> = {};
  for (const part of zonedFormatter(timeZone).formatToParts(new Date(ms))) {
    if (part.type !== 'literal') values[part.type] = Number(part.value);
  }
  return {
    year: values.year ?? 0,
    month: values.month ?? 1,
    day: values.day ?? 1,
    hour: (values.hour ?? 0) % 24,
    minute: values.minute ?? 0,
  };
}

/** 时区里的钟点。直接读 Intl 的结果：当地没有的钟点（对方那边正好跳过一小时）也不会被挪走。 */
export function zonedClock(ms: number, timeZone: string): string {
  const { hour, minute } = zonedParts(ms, timeZone);
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/**
 * 一个本地时区的 Date，年月日读出来和那个时区的日历一样。日期文字和月龄计算都读本地时区的
 * getter，服务端和对方的浏览器都不在分享者的时区。取中午：任何时区的夏令时都不会跳过中午。
 */
export function zonedCalendarDate(ms: number, timeZone: string): Date {
  const { year, month, day } = zonedParts(ms, timeZone);
  return new Date(year, month - 1, day, 12);
}

/** 这一天是第几天、多大。按分享者的时区算，和 App 里那天看到的一样。还没出生时月龄是 null。 */
export function shareDayAge(
  birthAt: number,
  toAt: number,
  timeZone: string,
): { dayNumber: number; age: Age | null } {
  // 用这一天的最后一刻：出生当天的 0 点早于出生时间，但那天已经出生了。
  const last = toAt - 1;
  const birth = zonedCalendarDate(birthAt, timeZone).getTime();
  const day = zonedCalendarDate(last, timeZone).getTime();
  return {
    dayNumber: dayNumber(birth, day),
    age: last < birthAt ? null : ageParts(birth, day),
  };
}

/**
 * 分享页上一条记录的文字。没结束的睡眠不能一直算下去：页面可能几天后才打开，
 * 超过忘记结束的时限后不写时长，否则会显示“已睡 72 小时”。
 */
export function shareEventText(event: EventData, now: number, units: Units): string {
  if (event.type === 'sleep' && !event.endAt && now - event.at > FORGOTTEN_SLEEP_MS) {
    return t().share.sleepNotEnded;
  }
  return describeEvent(event, now, units);
}

export interface ShareDayCounts {
  records: number;
  moments: number;
  files: number;
}

interface CountableEvent {
  data: EventData;
}
interface CountableMoment {
  data: Pick<MomentData, 'at' | 'media'>;
}

/** 弹层上的条数，范围和选项与服务端的规则相同（`at` 落在 [fromAt, toAt) 里）。 */
export function countShareDay(
  events: readonly CountableEvent[],
  moments: readonly CountableMoment[],
  range: { fromAt: number; toAt: number },
  include: ShareInclude,
): ShareDayCounts {
  const inRange = (at: number) => at >= range.fromAt && at < range.toAt;
  const counts: ShareDayCounts = { records: 0, moments: 0, files: 0 };
  for (const { data } of events) {
    if (inRange(data.at) && shareIncludesEvent(data.type, include)) counts.records += 1;
  }
  if (include.moments) {
    for (const { data } of moments) {
      if (!inRange(data.at)) continue;
      counts.moments += 1;
      counts.files += data.media.length;
    }
  }
  return counts;
}

/** 一天里还没传完的文件 id。这些文件现在打开页面看不到。 */
export function pendingShareFiles(
  moments: readonly CountableMoment[],
  range: { fromAt: number; toAt: number },
  pendingIds: ReadonlySet<string>,
): number {
  let count = 0;
  for (const { data } of moments) {
    if (data.at < range.fromAt || data.at >= range.toAt) continue;
    for (const file of data.media) if (pendingIds.has(file.id)) count += 1;
  }
  return count;
}

// ─── 分享时间线（F-133） ─────────────────────────────────

/**
 * 时间线每页几条回忆。列表上每条只签封面（预览或原文件加缩略图，最多 2 个签名），
 * 一页最多 40 个签名；点开一条回忆时再取它的全部文件，那一次最多 `MAX_PUBLIC_MEDIA` 个。
 */
export const TIMELINE_PAGE_SIZE = 20;
/** “全部”从 0 开始，结束仍是创建那天：之后新记的回忆不会自己跑进已经发出去的链接。 */
export const SHARE_TIMELINE_ALL_FROM = 0;
/** 时间线只有回忆。喂奶、尿布这些记录和健康记录都不发，比分享一天暴露得少。 */
export const TIMELINE_SHARE_INCLUDE: ShareInclude = { moments: true, daily: false, health: false };
/** 结束最晚是创建时之后这么久。手机算的是当地今天的结尾，任何时区都在两天以内。 */
export const SHARE_TIMELINE_MAX_AHEAD_MS = 2 * 24 * 3_600_000;

const SHARE_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const FRAGMENT_PREFIX: Record<Exclude<ShareKind, 'day'>, string> = {
  timeline: 't/',
  moments: 'm/',
};

/** 链接的片段。一天的链接一直是 `#令牌`，旧版 App 发出去的链接要照常打开。 */
export function shareFragment(kind: ShareKind, token: string): string {
  return kind === 'day' ? token : `${FRAGMENT_PREFIX[kind]}${token}`;
}

export function parseShareFragment(hash: string): { kind: ShareKind; token: string } | null {
  const fragment = hash.replace(/^#/, '');
  const prefixed = (Object.entries(FRAGMENT_PREFIX) as [ShareKind, string][]).find(([, prefix]) =>
    fragment.startsWith(prefix),
  );
  const kind = prefixed?.[0] ?? 'day';
  const token = prefixed ? fragment.slice(prefixed[1].length) : fragment;
  return SHARE_TOKEN.test(token) ? { kind, token } : null;
}

export const CreateTimelineShareRequest = z
  .object({
    fromAt: z.number().int().nonnegative(),
    toAt: z.number().int().positive(),
    timezone: z.string().min(1).max(64).refine(isValidTimeZone),
    ttlDays: ShareTtlDays.default(DEFAULT_SHARE_TTL_DAYS),
    /** F-141 起的 App 一直带。没有时（旧版 App）和以前一样：真实名字、不带头像。 */
    display: ShareDisplay.optional(),
    /** 分享的是哪个宝宝（issue #106）。没有时（旧版 App）是旧版界面上显示的宝宝，见 `shareBabyId`。 */
    babyId: z.uuid().optional(),
  })
  .refine((v) => v.toAt > v.fromAt, { path: ['toAt'] });
export type CreateTimelineShareRequest = z.input<typeof CreateTimelineShareRequest>;

/** 游标是上一页最后一条的 `at.回忆 id`，按 (at, id) 倒序翻页：同一毫秒的两条也不会漏。 */
export const TIMELINE_CURSOR =
  /^\d{1,16}\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const PublicTimelineRequest = z.object({
  token: PublicShareRequest.shape.token,
  cursor: z.string().regex(TIMELINE_CURSOR).optional(),
});

export const PublicTimelineMomentRequest = z.object({
  token: PublicShareRequest.shape.token,
  momentId: z.uuid(),
});

const PublicAge = z.object({ months: z.number(), days: z.number() });

export const PublicTimelineEntry = z.object({
  /** 回忆的 id，点开时用它取全部文件。和文件 id 一样是客户端生成的 UUID，不靠它授权。 */
  id: z.string(),
  at: z.number(),
  title: z.string(),
  text: z.string(),
  milestone: z.boolean(),
  byName: z.string().optional(),
  dayNumber: z.number().nullable(),
  age: PublicAge.nullable(),
  /** F-119 设置的封面；没设、没传完或者是录音时是第一个能显示的照片或视频。 */
  cover: PublicMedia.nullable(),
  /** 能显示的照片和视频有几个，包括封面。 */
  visualCount: z.number(),
  audioCount: z.number(),
});
export type PublicTimelineEntry = z.infer<typeof PublicTimelineEntry>;

export const PublicTimelineResponse = z.object({
  /** 选中回忆的链接（F-136）用同一个回答，`range` 是现在还在的那几段的头尾。 */
  kind: z.enum(['timeline', 'moments']),
  baby: z.object({
    name: z.string(),
    avatarUrl: PublicAvatarUrl,
    /** 范围最后一天的月龄，服务端算好，不发出生时间。 */
    age: PublicAge.nullable(),
  }),
  range: z.object({ fromAt: z.number(), toAt: z.number(), timezone: z.string() }),
  /** 新的在前，和 App 的时间线一样。 */
  entries: z.array(PublicTimelineEntry),
  /** 没有更早的了是 null。一页可能因为跳过空的回忆而不满，只要它不是 null 就还有。 */
  nextCursor: z.string().nullable(),
  mediaExpiresIn: z.number(),
});
export type PublicTimelineResponse = z.infer<typeof PublicTimelineResponse>;

export const PublicTimelineMomentResponse = z.object({
  media: z.array(PublicMedia),
  omittedMedia: z.number(),
  mediaExpiresIn: z.number(),
});
export type PublicTimelineMomentResponse = z.infer<typeof PublicTimelineMomentResponse>;

export function hasTimelineContent(entry: PublicTimelineEntry): boolean {
  return Boolean(
    entry.title.trim() || entry.text.trim() || entry.visualCount > 0 || entry.audioCount > 0,
  );
}

/** 一条回忆在分享者的时区里是第几天、多大。孕期的回忆没有月龄。 */
export function shareMomentAge(
  birthAt: number,
  at: number,
  timeZone: string,
): { dayNumber: number; age: Age | null } {
  // 按日历日比：出生当天、早于出生时刻的回忆也是第 1 天。
  const birth = zonedCalendarDate(birthAt, timeZone).getTime();
  const day = zonedCalendarDate(at, timeZone).getTime();
  return { dayNumber: dayNumber(birth, day), age: day < birth ? null : ageParts(birth, day) };
}

/**
 * 时间线上的封面，规则和 App 的 `momentCover` 一样，只是“能显示”以服务端的 media 表为准：
 * 设置的封面没传完、被移除或者其实是录音时，回到第一个能显示的。
 */
export function shareCoverId(
  media: readonly { id: string }[],
  coverMediaId: string | undefined,
  visualIds: ReadonlySet<string>,
): string | null {
  const visible = media.filter((file) => visualIds.has(file.id));
  return (visible.find((file) => file.id === coverMediaId) ?? visible[0])?.id ?? null;
}

/**
 * 时间线范围的文字。`calendar` 把时刻换成本地日历上的那一天：App 里用手机的时区（原样返回），
 * 网页里用分享者的时区（`zonedCalendarDate`）。
 */
export function timelineRangeText(
  range: { fromAt: number; toAt: number },
  now: number,
  calendar: (ms: number) => number,
): string {
  const year = (ms: number) => new Date(ms).getFullYear();
  const thisYear = year(calendar(now));
  const last = calendar(range.toAt - 1);
  if (range.fromAt === SHARE_TIMELINE_ALL_FROM) {
    return t().share.rangeAllUntil(
      year(last) === thisYear ? formatShortDate(last) : formatFullDate(last),
    );
  }
  const first = calendar(range.fromAt);
  const format =
    year(first) === thisYear && year(last) === thisYear ? formatShortDate : formatFullDate;
  if (format(first) === format(last)) return format(first);
  return t().share.rangeText(format(first), format(last));
}

// ─── 分享回忆（F-136） ───────────────────────────────

/**
 * 一个链接最多选几段。只看 id 不看时间，翻页和封面签名都和时间线一样（一页 20 条），
 * 这里只是让请求体和库里的数组有个边。
 */
export const MAX_SHARE_MOMENTS = 100;

/**
 * 选一段或几段回忆。公开接口只按这些 id 查，不按时间；`fromAt`、`toAt` 是手机按选中的回忆算的
 * 头尾，只用来在「已分享的链接」里排序和给旧版 App 显示日期（旧版不认识这种链接，按一天显示）。
 * 还没传到服务器的回忆也收：传上来以后页面上就有，弹层会说明现在还缺什么。
 */
export const CreateMomentsShareRequest = z
  .object({
    momentIds: z
      .array(z.uuid())
      .min(1)
      .max(MAX_SHARE_MOMENTS)
      .refine((ids) => new Set(ids).size === ids.length),
    fromAt: z.number().int().nonnegative(),
    toAt: z.number().int().positive(),
    timezone: z.string().min(1).max(64).refine(isValidTimeZone),
    ttlDays: ShareTtlDays.default(DEFAULT_SHARE_TTL_DAYS),
    /** F-141 起的 App 一直带。没有时（旧版 App）和以前一样：真实名字、不带头像。 */
    display: ShareDisplay.optional(),
    /** 分享的是哪个宝宝（issue #106）。没有时（旧版 App）是旧版界面上显示的宝宝，见 `shareBabyId`。 */
    babyId: z.uuid().optional(),
  })
  .refine((v) => v.toAt > v.fromAt, { path: ['toAt'] });
export type CreateMomentsShareRequest = z.input<typeof CreateMomentsShareRequest>;
