import {
  BabyData,
  EventData,
  hasShareContent,
  type MediaVariant,
  MomentData,
  type PublicMedia,
  type PublicMoment,
  type PublicShareResponse,
  pickEventForShare,
  pickMomentForShare,
  type ShareInclude,
  ShareUnits,
  shareDayAge,
  shareIncludesEvent,
} from '@xiaodouya/shared';
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
  from_at: string;
  to_at: string;
  timezone: string;
  include_moments: boolean;
  include_daily: boolean;
  include_health: boolean;
  units: unknown;
  expires_at: Date;
  created_at: Date;
}

export const shareInclude = (row: ShareRow): ShareInclude => ({
  moments: row.include_moments,
  daily: row.include_daily,
  health: row.include_health,
});

/**
 * 不存在、过期、撤销走同一条语句，分不出是哪一种。
 * 创建者还要是能读记录的成员：移出和降级时已经撤销了，这里是第二道，防止以后新增的路径漏掉。
 */
export async function findActiveShare(sql: Sql, token: string): Promise<ShareRow | null> {
  const [row] = await sql<ShareRow[]>`
    SELECT s.id, s.family_id, s.created_by, s.from_at, s.to_at, s.timezone,
           s.include_moments, s.include_daily, s.include_health, s.units, s.expires_at, s.created_at
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

/**
 * 只发传完的、回忆里的、这个家庭的文件。记录是客户端写的：文件 id 可以写成证件或别家的，
 * 类型也可以乱写，所以都以 media 表为准。
 *
 * 一律签名，不用存储配置的公开地址：那种地址不会过期，撤销链接后还一直能打开。
 */
async function signMedia(
  sql: Sql,
  config: Config,
  familyId: string,
  moments: MomentData[],
  maxMedia: number,
): Promise<{ urls: Map<string, MediaRow[]>; signed: Map<string, string>; omitted: number }> {
  const ids = [...new Set(moments.flatMap((m) => m.media.map((file) => file.id)))];
  const rows =
    ids.length === 0
      ? []
      : await sql<MediaRow[]>`
          SELECT id, variant, mime, object_key, storage_config_id FROM media
          WHERE family_id = ${familyId} AND status = 'ready' AND scope = 'memory'
            AND id = ANY(${ids}::uuid[])`;
  const byId = new Map<string, MediaRow[]>();
  for (const row of rows) byId.set(row.id, [...(byId.get(row.id) ?? []), row]);
  const kept = ids.filter((id) => byId.has(id));
  const allowed = kept.slice(0, maxMedia);
  const signed = new Map<string, string>();
  const byStorage = new Map<string | null, MediaRow[]>();
  for (const id of allowed) {
    const { main, thumb } = publicRows(byId.get(id) ?? []);
    // 只签要发出去的：每个签名都花 Edge Function 的 CPU，签了不发的原图也没有用。
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
  const urls = new Map(allowed.map((id) => [id, byId.get(id) ?? []]));
  return { urls, signed, omitted: kept.length - allowed.length };
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
    const { main, thumb } = publicRows(found);
    const url = (main && signed.get(`${file.id}/${main.variant}`)) ?? null;
    const thumbUrl = signed.get(`${file.id}/thumb`) ?? null;
    if (!url && !thumbUrl) continue;
    const kind = publicKind((main ?? thumb)?.mime ?? '');
    if (!kind) continue;
    out.push({
      id: file.id,
      kind,
      url,
      thumbUrl,
      ...(file.width ? { width: file.width } : {}),
      ...(file.height ? { height: file.height } : {}),
      ...(file.durationMs ? { durationMs: file.durationMs } : {}),
    });
  }
  return out;
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
  const rows = await sql<{ collection: string; data: unknown }[]>`
    SELECT collection, data FROM records
    WHERE family_id = ${share.family_id} AND NOT deleted AND collection = ANY(${wanted})
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

  const [babyRow] = await sql<{ data: unknown }[]>`
    SELECT data FROM records
    WHERE family_id = ${share.family_id} AND collection = 'baby' AND NOT deleted
    ORDER BY updated_at_client DESC LIMIT 1`;
  const baby = BabyData.safeParse(babyRow?.data);
  const dayAge = baby.success ? shareDayAge(baby.data.birthAt, toAt, share.timezone) : null;

  return {
    baby: {
      name: baby.success ? baby.data.name : '',
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
