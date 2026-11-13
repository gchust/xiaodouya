import {
  BabyData,
  EventData,
  firstBabyId,
  hasShareContent,
  hasTimelineContent,
  type MediaRef,
  type MediaVariant,
  MomentData,
  type PublicMedia,
  type PublicMoment,
  type PublicShareResponse,
  type PublicTimelineEntry,
  type PublicTimelineMomentResponse,
  type PublicTimelineResponse,
  pickEventForShare,
  pickMomentForShare,
  publicBabyName,
  type ShareDisplay,
  type ShareInclude,
  type ShareKind,
  ShareUnits,
  shareBabyId,
  shareCoverId,
  shareDayAge,
  shareIncludesEvent,
  shareMomentAge,
  TIMELINE_PAGE_SIZE,
} from '@xiaodouya/shared';
import { familyBabies } from './babies';
import type { Config } from './config';
import { sha256 } from './crypto';
import type { Sql } from './db';
import { presignDownloads, storageById } from './storage';

/** 和 App 里回忆的文件一样长。撤销之后，已经发出去的链接最多还能用这么久，界面上写明了。 */
const PUBLIC_MEDIA_TTL = 3600;

export interface ShareRow {
  id: string;
  family_id: string;
  created_by: string;
  kind: ShareKind;
  from_at: string;
  to_at: string;
  timezone: string;
  include_moments: boolean;
  include_daily: boolean;
  include_health: boolean;
  units: unknown;
  /** 只有 `kind = 'moments'` 的行有。 */
  moment_ids: string[] | null;
  /** F-141 之前和旧版 App 建的行是空值，见 `shareDisplay`。 */
  show_name: boolean | null;
  baby_nickname: string | null;
  show_avatar: boolean | null;
  /** 创建时选的宝宝（issue #106）。旧行和旧版 App 建的行是空值，见 `shareBaby`。 */
  baby_id: string | null;
  expires_at: Date;
  created_at: Date;
}

export const shareInclude = (row: ShareRow): ShareInclude => ({
  moments: row.include_moments,
  daily: row.include_daily,
  health: row.include_health,
});

/** 列都是空值时和以前的链接一样：真实名字、不带头像（以前的分享页没有头像）。 */
export const shareDisplay = (row: ShareRow): ShareDisplay => ({
  showName: row.show_name ?? true,
  nickname: row.baby_nickname ?? '',
  showAvatar: row.show_avatar ?? false,
});

/**
 * 不存在、过期、撤销走同一条语句，分不出是哪一种。
 * 创建者还要是能读记录的成员：移出和降级时已经撤销了，这里是第二道，防止以后新增的路径漏掉。
 */
export async function findActiveShare(sql: Sql, token: string): Promise<ShareRow | null> {
  const [row] = await sql<ShareRow[]>`
    SELECT s.id, s.family_id, s.created_by, s.kind, s.from_at, s.to_at, s.timezone,
           s.include_moments, s.include_daily, s.include_health, s.units, s.moment_ids,
           s.show_name, s.baby_nickname, s.show_avatar, s.baby_id, s.expires_at, s.created_at
    FROM shares s
    JOIN memberships m ON m.family_id = s.family_id AND m.user_id = s.created_by AND m.role <> 'viewer'
    WHERE s.token_hash = ${sha256(token)} AND s.revoked_at IS NULL AND s.expires_at > now()`;
  return row ?? null;
}

interface MediaRow {
  id: string;
  variant: MediaVariant;
  mime: string;
  object_key: string;
  storage_config_id: string | null;
}

function publicKind(mime: string): PublicMedia['kind'] | null {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return null;
}

/**
 * 公开页面用哪几个变体。照片有预览就绝不发原图：原图可能带 EXIF 位置，陌生人也不用下几十 MB。
 * 视频的预览行不算数（正常客户端不会传，服务端也拒绝非图片），它只能放原文件。
 */
function publicRows(rows: readonly MediaRow[]): { main?: MediaRow; thumb?: MediaRow } {
  const original = rows.find((row) => row.variant === 'original');
  const preview = rows.find((row) => row.variant === 'preview');
  const thumb = rows.find((row) => row.variant === 'thumb');
  const useOriginal = !preview || (original && !original.mime.startsWith('image/'));
  return { main: useOriginal ? original : preview, thumb };
}

/** 这个文件在公开页面上算哪一类。以服务端记的类型为准，记录里写的不算。 */
function rowsKind(rows: readonly MediaRow[]): PublicMedia['kind'] | null {
  const { main, thumb } = publicRows(rows);
  return publicKind((main ?? thumb)?.mime ?? '');
}

/**
 * 只认传完的、回忆里的、这个家庭的文件。记录是客户端写的：文件 id 可以写成证件或别家的，
 * 类型也可以乱写，所以都以 media 表为准。
 */
async function readyMemoryMedia(
  sql: Sql,
  familyId: string,
  ids: readonly string[],
): Promise<Map<string, MediaRow[]>> {
  const rows =
    ids.length === 0
      ? []
      : await sql<MediaRow[]>`
          SELECT id, variant, mime, object_key, storage_config_id FROM media
          WHERE family_id = ${familyId} AND status = 'ready' AND scope = 'memory'
            AND id = ANY(${ids}::uuid[])`;
  const byId = new Map<string, MediaRow[]>();
  for (const row of rows) byId.set(row.id, [...(byId.get(row.id) ?? []), row]);
  return byId;
}

/**
 * 给这些文件的要发出去的变体签名，键是 `文件 id/变体`。
 *
 * 一律签名，不用存储配置的公开地址：那种地址不会过期，撤销链接后还一直能打开。
 * 只签要发出去的：每个签名都花 Edge Function 的 CPU，签了不发的原图也没有用。
 */
async function signPublicRows(
  sql: Sql,
  config: Config,
  familyId: string,
  files: readonly (readonly MediaRow[])[],
): Promise<Map<string, string>> {
  const signed = new Map<string, string>();
  const byStorage = new Map<string | null, MediaRow[]>();
  for (const rows of files) {
    const { main, thumb } = publicRows(rows);
    for (const row of [main, thumb]) {
      if (!row) continue;
      byStorage.set(row.storage_config_id, [...(byStorage.get(row.storage_config_id) ?? []), row]);
    }
  }
  for (const [configId, group] of byStorage) {
    try {
      const storage = await storageById(sql, config, familyId, configId);
      if (!storage) continue;
      const urls = await presignDownloads(
        storage,
        group.map((row) => row.object_key),
        PUBLIC_MEDIA_TTL,
      );
      group.forEach((row, index) => {
        const url = urls[index];
        if (url) signed.set(`${row.id}/${row.variant}`, url);
      });
    } catch {
      // 一份存储配置坏了（比如密钥解不开）不能让整页打不开。不记原因：错误里可能带着地址。
      console.warn('分享页：有一份存储配置签不了链接');
    }
  }
  return signed;
}

async function signMedia(
  sql: Sql,
  config: Config,
  familyId: string,
  moments: MomentData[],
  maxMedia: number,
): Promise<{ urls: Map<string, MediaRow[]>; signed: Map<string, string>; omitted: number }> {
  const ids = [...new Set(moments.flatMap((m) => m.media.map((file) => file.id)))];
  const byId = await readyMemoryMedia(sql, familyId, ids);
  const kept = ids.filter((id) => byId.has(id));
  const allowed = kept.slice(0, maxMedia);
  const urls = new Map(allowed.map((id) => [id, byId.get(id) ?? []]));
  const signed = await signPublicRows(sql, config, familyId, [...urls.values()]);
  return { urls, signed, omitted: kept.length - allowed.length };
}

/** 一个文件在公开页面上的样子。没有签出任何链接、或者类型不对时是 null。 */
function publicFile(
  file: MediaRef,
  rows: readonly MediaRow[],
  signed: Map<string, string>,
): PublicMedia | null {
  const { main } = publicRows(rows);
  const url = (main && signed.get(`${file.id}/${main.variant}`)) ?? null;
  const thumbUrl = signed.get(`${file.id}/thumb`) ?? null;
  if (!url && !thumbUrl) return null;
  const kind = rowsKind(rows);
  if (!kind) return null;
  return {
    id: file.id,
    kind,
    url,
    thumbUrl,
    ...(file.width ? { width: file.width } : {}),
    ...(file.height ? { height: file.height } : {}),
    ...(file.durationMs ? { durationMs: file.durationMs } : {}),
  };
}

function publicMediaOf(
  moment: MomentData,
  rows: Map<string, MediaRow[]>,
  signed: Map<string, string>,
): PublicMedia[] {
  const out: PublicMedia[] = [];
  for (const file of moment.media) {
    const found = rows.get(file.id);
    if (!found) continue;
    const media = publicFile(file, found, signed);
    if (media) out.push(media);
  }
  return out;
}

interface ShareBaby {
  /** 链接属于的宝宝，没有档案时是 null。 */
  id: string | null;
  /** 没写 `babyId` 的记录属于它。 */
  firstId: string | null;
  /** 页面上的名字、头像和月龄。档案删了或读不懂时是 null，记录照样按 `id` 过滤。 */
  data: BabyData | null;
}

/**
 * 链接属于哪个宝宝（issue #106）。创建时选的，或者旧版 App 建的链接：旧版界面上显示的宝宝。
 * 以前取 `updated_at_client` 最大的档案，有第二个宝宝后改一下档案就换了。
 */
async function shareBaby(sql: Sql, share: ShareRow): Promise<ShareBaby> {
  const babies = await familyBabies(sql, share.family_id);
  const id = shareBabyId(babies, share.baby_id);
  const row = babies.find((baby) => baby.id === id && !baby.deleted);
  const parsed = BabyData.safeParse(row?.data);
  return { id, firstId: firstBabyId(babies), data: parsed.success ? parsed.data : null };
}

/**
 * 只要这个宝宝的记录，规则和 `recordBabyId` 一样：没写 `babyId` 的属于第一个宝宝。
 * 库里的 `babyId` 都过过 zod（格式不对的写入时已经丢掉），所以是字符串就是一个宝宝的 id。
 * 只用在照护记录和回忆上，它们都属于宝宝；全家共用的记录不能用它过滤。
 */
function ofBaby(sql: Sql, baby: ShareBaby) {
  return baby.id === baby.firstId
    ? sql`(jsonb_typeof(data->'babyId') IS DISTINCT FROM 'string' OR data->>'babyId' = ${baby.id})`
    : sql`data->>'babyId' = ${baby.id}`;
}

/**
 * 头像的签名链接（F-141）。只在创建链接时选了显示头像才签。
 * 只签缩略图：它是从位图重新编码的，没有原图的 EXIF 和拍摄地点，也够页面顶上那一小块用；
 * 没有缩略图（还没传完、旧版本没做出来）时不发，绝不退回原图。
 * 和回忆的文件一样以 media 表为准：档案是客户端写的，id 可以写成回忆或别家的文件。
 */
async function publicAvatarUrl(
  sql: Sql,
  config: Config,
  share: ShareRow,
  baby: BabyData | null,
): Promise<string | null> {
  const avatarId = baby?.avatar?.id;
  if (!avatarId) return null;
  const [row] = await sql<MediaRow[]>`
    SELECT id, variant, mime, object_key, storage_config_id FROM media
    WHERE family_id = ${share.family_id} AND status = 'ready' AND scope = 'avatar'
      AND variant = 'thumb' AND id = ${avatarId}::uuid AND mime LIKE 'image/%'`;
  if (!row) return null;
  try {
    const storage = await storageById(sql, config, share.family_id, row.storage_config_id);
    if (!storage) return null;
    const [url] = await presignDownloads(storage, [row.object_key], PUBLIC_MEDIA_TTL);
    return url ?? null;
  } catch {
    // 和回忆的文件一样：签不了就不显示头像，整页照常打开。不记原因，错误里可能带着地址。
    console.warn('分享页：头像签不了链接');
    return null;
  }
}

/**
 * 公开页面上的宝宝：名字按链接的设置换过，真实名字不出服务端。
 * 没选头像时连 `avatarUrl` 这个字段都没有，旧链接的回答和以前一模一样。
 */
async function publicBaby(sql: Sql, config: Config, share: ShareRow, baby: BabyData | null) {
  const display = shareDisplay(share);
  return {
    name: publicBabyName(baby?.name ?? '', display),
    ...(display.showAvatar ? { avatarUrl: await publicAvatarUrl(sql, config, share, baby) } : {}),
  };
}

/**
 * 公开页面的全部内容，每次现查：之后删掉的记录会从页面上消失。
 * 这里的每个字段都是逐个写出来的。要加字段先想想：拿到链接的人是谁都有可能。
 */
export async function buildPublicShare(
  sql: Sql,
  config: Config,
  share: ShareRow,
): Promise<PublicShareResponse> {
  const include = shareInclude(share);
  const fromAt = Number(share.from_at);
  const toAt = Number(share.to_at);
  const wanted = [
    ...(include.daily || include.health ? ['event'] : []),
    ...(include.moments ? ['moment'] : []),
  ];
  // 配置型事件（奶粉、疫苗本）没有 at 的在这里过滤掉，带了 at 的靠后面的 EventData 校验。
  // 用 CASE：AND 不保证执行顺序，at 不是数字的行不能进到类型转换里。
  const baby = await shareBaby(sql, share);
  const rows = await sql<{ collection: string; data: unknown }[]>`
    SELECT collection, data FROM records
    WHERE family_id = ${share.family_id} AND NOT deleted AND collection = ANY(${wanted})
      AND ${ofBaby(sql, baby)}
      AND CASE WHEN jsonb_typeof(data->'at') = 'number'
               THEN (data->>'at')::double precision >= ${fromAt}::double precision
                AND (data->>'at')::double precision < ${toAt}::double precision
               ELSE false END`;
  const events: EventData[] = [];
  const parsedMoments: MomentData[] = [];
  for (const row of rows) {
    if (row.collection === 'event') {
      const parsed = EventData.safeParse(row.data);
      if (parsed.success && shareIncludesEvent(parsed.data.type, include)) {
        events.push(pickEventForShare(parsed.data));
      }
    } else {
      const parsed = MomentData.safeParse(row.data);
      if (parsed.success) parsedMoments.push(parsed.data);
    }
  }
  events.sort((a, b) => a.at - b.at);
  parsedMoments.sort((a, b) => a.at - b.at);

  const { urls, signed, omitted } = await signMedia(
    sql,
    config,
    share.family_id,
    parsedMoments,
    config.limits.sharePublicMedia,
  );
  const moments: PublicMoment[] = parsedMoments
    .map((moment) => pickMomentForShare(moment, publicMediaOf(moment, urls, signed)))
    .filter(hasShareContent);

  const profile = baby.data;
  const dayAge = profile ? shareDayAge(profile.birthAt, toAt, share.timezone) : null;

  return {
    baby: {
      ...(await publicBaby(sql, config, share, profile)),
      dayNumber: dayAge?.dayNumber ?? null,
      age: dayAge?.age ? { months: dayAge.age.months, days: dayAge.age.days } : null,
    },
    range: { fromAt, toAt, timezone: share.timezone },
    units: ShareUnits.parse(share.units),
    events,
    moments,
    omittedMedia: omitted,
    mediaExpiresIn: PUBLIC_MEDIA_TTL,
  };
}

// ─── 分享时间线（F-133） ─────────────────────────────────

function parseCursor(cursor: string): { at: number; id: string } {
  const dot = cursor.indexOf('.');
  return { at: Number(cursor.slice(0, dot)), id: cursor.slice(dot + 1) };
}

/** 回忆的 at 不是数字时是 NULL，不进到类型转换里。 */
const momentAt = (row: { at: number | null }) => row.at ?? 0;

/**
 * 回忆的 at 是数字时取出来，不是时为 NULL：不让它进到类型转换里。
 * 只要链接那个宝宝的（issue #106），选中回忆的链接也一样：选的时候界面上只有这个宝宝的回忆。
 */
const momentsOf = (sql: Sql, share: ShareRow, baby: ShareBaby) => sql`
  SELECT id, data,
         CASE WHEN jsonb_typeof(data->'at') = 'number'
              THEN (data->>'at')::double precision END AS at
  FROM records
  WHERE family_id = ${share.family_id} AND collection = 'moment' AND NOT deleted
    AND ${ofBaby(sql, baby)}
    ${share.kind === 'moments' ? sql`AND id = ANY(${share.moment_ids ?? []}::uuid[])` : sql``}`;

/**
 * 链接能看到哪些回忆：时间线是 [from, to) 里的，选中回忆的链接（F-136）只认选中的 id，
 * 不管它们现在的时间。家庭、`collection = 'moment'`、没删、属于哪个宝宝由 `momentsOf` 管。
 */
function inShare(sql: Sql, share: ShareRow) {
  return share.kind === 'moments'
    ? sql`at IS NOT NULL`
    : sql`at >= ${Number(share.from_at)}::double precision
          AND at < ${Number(share.to_at)}::double precision`;
}

/**
 * 页面顶上的范围。选中回忆的链接用现在还在的那几段的头尾（改了时间、删掉一段都会跟着变），
 * 一段都不在了时用创建时手机算的。
 */
async function shareRange(
  sql: Sql,
  share: ShareRow,
  baby: ShareBaby,
): Promise<{ fromAt: number; toAt: number }> {
  const stored = { fromAt: Number(share.from_at), toAt: Number(share.to_at) };
  if (share.kind !== 'moments') return stored;
  const [row] = await sql<{ first: number | null; last: number | null }[]>`
    SELECT min(at) AS first, max(at) AS last FROM (${momentsOf(sql, share, baby)}) moments
    WHERE ${inShare(sql, share)}`;
  return row?.first != null && row.last != null
    ? { fromAt: Number(row.first), toAt: Number(row.last) + 1 }
    : stored;
}

/**
 * 时间线的一页。新的在前，按 (at, id) 倒序用游标翻，同一毫秒的回忆不会漏也不会重复。
 * 每条只签封面，点开时再取全部文件（`buildPublicTimelineMoment`），一页的签名数因此有上限。
 * 调用前要确认 `share.kind` 是 `timeline` 或 `moments`，游标要先过 `PublicTimelineRequest`。
 */
export async function buildPublicTimeline(
  sql: Sql,
  config: Config,
  share: ShareRow,
  cursor: string | undefined,
): Promise<PublicTimelineResponse> {
  const after = cursor ? parseCursor(cursor) : null;
  const baby = await shareBaby(sql, share);
  const rows = await sql<{ id: string; data: unknown; at: number | null }[]>`
    SELECT id, data, at FROM (${momentsOf(sql, share, baby)}) moments
    WHERE ${inShare(sql, share)}
      ${
        after
          ? sql`AND (at < ${after.at}::double precision
                     OR (at = ${after.at}::double precision AND id < ${after.id}::uuid))`
          : sql``
      }
    ORDER BY at DESC, id DESC
    LIMIT ${TIMELINE_PAGE_SIZE + 1}`;
  const page = rows.slice(0, TIMELINE_PAGE_SIZE);
  const last = page.at(-1);
  const nextCursor =
    rows.length > TIMELINE_PAGE_SIZE && last ? `${momentAt(last)}.${last.id}` : null;

  const moments: { id: string; data: MomentData }[] = [];
  for (const row of page) {
    const parsed = MomentData.safeParse(row.data);
    if (parsed.success) moments.push({ id: row.id, data: parsed.data });
  }
  const byId = await readyMemoryMedia(sql, share.family_id, [
    ...new Set(moments.flatMap((m) => m.data.media.map((file) => file.id))),
  ]);
  const kindOf = (id: string) => {
    const found = byId.get(id);
    return found ? rowsKind(found) : null;
  };
  const covers = moments.map(({ data }) => {
    const visual = new Set(
      data.media
        .map((file) => file.id)
        .filter((id) => {
          const kind = kindOf(id);
          return kind === 'image' || kind === 'video';
        }),
    );
    const audio = new Set(data.media.map((file) => file.id).filter((id) => kindOf(id) === 'audio'));
    const coverId = shareCoverId(data.media, data.coverMediaId, visual);
    return { visual, audio, file: data.media.find((file) => file.id === coverId) ?? null };
  });
  const signed = await signPublicRows(
    sql,
    config,
    share.family_id,
    covers.flatMap(({ file }) => (file ? [byId.get(file.id) ?? []] : [])),
  );

  const profile = baby.data;
  const entries: PublicTimelineEntry[] = moments
    .map(({ id, data }, index) => {
      const { visual, audio, file } = covers[index] ?? {
        visual: new Set<string>(),
        audio: new Set<string>(),
        file: null,
      };
      const age = profile ? shareMomentAge(profile.birthAt, data.at, share.timezone) : null;
      return {
        id,
        at: data.at,
        title: data.title,
        text: data.text,
        milestone: data.milestone,
        ...(data.byName ? { byName: data.byName } : {}),
        dayNumber: age?.dayNumber ?? null,
        age: age?.age ? { months: age.age.months, days: age.age.days } : null,
        cover: file ? publicFile(file, byId.get(file.id) ?? [], signed) : null,
        visualCount: visual.size,
        audioCount: audio.size,
      };
    })
    .filter(hasTimelineContent);

  const { fromAt, toAt } = await shareRange(sql, share, baby);
  const rangeAge = profile ? shareDayAge(profile.birthAt, toAt, share.timezone).age : null;
  return {
    kind: share.kind === 'moments' ? 'moments' : 'timeline',
    baby: {
      ...(await publicBaby(sql, config, share, profile)),
      age: rangeAge ? { months: rangeAge.months, days: rangeAge.days } : null,
    },
    range: { fromAt, toAt, timezone: share.timezone },
    entries,
    nextCursor,
    mediaExpiresIn: PUBLIC_MEDIA_TTL,
  };
}

/**
 * 点开时间线上的一条回忆：它的全部文件。`momentId` 是对方传来的，
 * 必须是这个家庭、没删、在这个链接里的回忆（时间线看范围，选中回忆的链接看选中的 id），
 * 否则返回 null（和失效一样的回答）。
 */
export async function buildPublicTimelineMoment(
  sql: Sql,
  config: Config,
  share: ShareRow,
  momentId: string,
): Promise<PublicTimelineMomentResponse | null> {
  const baby = await shareBaby(sql, share);
  const [row] = await sql<{ data: unknown }[]>`
    SELECT data FROM (${momentsOf(sql, share, baby)}) moments
    WHERE id = ${momentId}::uuid AND ${inShare(sql, share)}`;
  const parsed = MomentData.safeParse(row?.data);
  if (!parsed.success) return null;
  const { urls, signed, omitted } = await signMedia(
    sql,
    config,
    share.family_id,
    [parsed.data],
    config.limits.sharePublicMedia,
  );
  return {
    media: publicMediaOf(parsed.data, urls, signed),
    omittedMedia: omitted,
    mediaExpiresIn: PUBLIC_MEDIA_TTL,
  };
}
