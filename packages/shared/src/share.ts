import { z } from 'zod';
import { type Age, ageParts, dayNumber } from './domain/age';
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

export const SHARE_TTL_DAYS = [1, 7, 30] as const;
export const DEFAULT_SHARE_TTL_DAYS = 7;
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
    ttlDays: z.union(SHARE_TTL_DAYS.map((days) => z.literal(days))).default(DEFAULT_SHARE_TTL_DAYS),
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

export interface ShareSummary {
  id: string;
  fromAt: number;
  toAt: number;
  timezone: string;
  include: ShareInclude;
  expiresAt: number;
  createdAt: number;
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
  /** 原文件还没传完时是 null，这时只有缩略图。 */
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

export const PublicShareResponse = z.object({
  baby: z.object({
    name: z.string(),
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

export function shareEventGroup(type: EventData['type']): ShareEventGroup {
  switch (type) {
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
  return include[shareEventGroup(type)];
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
      return { ...base, type: 'feed', ml: event.ml };
    case 'diaper':
      return { ...base, type: 'diaper', kind: event.kind };
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
