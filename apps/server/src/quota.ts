import type postgres from 'postgres';
import type { Config } from './config';
import type { Sql } from './db';

/**
 * 预留多久后不再占配额。链接只有 1 小时，但慢网传大视频可以传很久。
 * 太长的话放弃的上传会一直挡住家人，过期后 complete 还会再查一次，不会超。
 */
export const RESERVATION_HOURS = 6;

type Query = Sql | postgres.TransactionSql;

export interface PlatformUsage {
  ready: number;
  pending: number;
  trash: number;
}

/**
 * 统计家庭在平台存储上的用量。自己的存储（storage_config_id 不为空）不花平台的钱，不算。
 * `exclude` 是正在处理的文件本身：同一个文件重新申请链接时不能重复计算。
 */
export async function platformUsage(
  q: Query,
  familyId: string,
  exclude?: { id: string; variant: string },
): Promise<PlatformUsage> {
  const excludeId = exclude?.id ?? null;
  const excludeVariant = exclude?.variant ?? null;
  const [row] = await (q as Sql)<{ ready: string; pending: string; trash: string }[]>`
    SELECT
      COALESCE(SUM(size) FILTER (WHERE status = 'ready' AND unreferenced_at IS NULL), 0) AS ready,
      COALESCE(SUM(size) FILTER (
        WHERE status = 'pending' AND reserved_at > now() - interval '1 hour' * ${RESERVATION_HOURS}
      ), 0) AS pending,
      COALESCE(SUM(size) FILTER (WHERE status = 'ready' AND unreferenced_at IS NOT NULL), 0) AS trash
    FROM media
    WHERE family_id = ${familyId} AND storage_config_id IS NULL
      AND NOT (id IS NOT DISTINCT FROM ${excludeId}::uuid AND variant IS NOT DISTINCT FROM ${excludeVariant})`;
  return {
    ready: Number(row?.ready ?? 0),
    pending: Number(row?.pending ?? 0),
    trash: Number(row?.trash ?? 0),
  };
}

/**
 * 算进配额的用量。待清理的文件在配额以内不算，这样删除能马上腾出空间；
 * 超过配额的部分要算，否则反复“上传再删除”可以无限占用存储，每个家庭最多占到两倍配额。
 */
export function countedBytes(usage: PlatformUsage, quota: number): number {
  return usage.ready + usage.pending + Math.max(0, usage.trash - quota);
}

/** 单个家庭的设定优先于全局默认值；0 表示不限，和 FAMILY_QUOTA_MB=0 一致。 */
export function familyQuotaBytes(
  config: Config,
  overrideMb: string | number | null,
): number | null {
  if (overrideMb === null) return config.familyQuotaBytes;
  const mb = Number(overrideMb);
  return mb > 0 ? mb * 1024 * 1024 : null;
}

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * 记录里提到的所有 UUID。
 * 故意不按字段（media、files、avatar）取：将来的版本可能在别的地方引用文件，
 * 旧服务端也会原样保存这些字段。多算一个引用只是晚点清理，少算就是删了用户的照片。
 */
export function uuidsIn(json: string): string[] {
  return (json.match(UUID_PATTERN) ?? []).map((id) => id.toLowerCase());
}

/** 家庭里未删除的记录提到的所有 UUID，判断文件还有没有人用，和 uuidsIn 的规则相同。 */
export async function liveReferences(q: Query, familyId: string): Promise<Set<string>> {
  const rows = await (q as Sql)<{ id: string }[]>`
    SELECT DISTINCT lower(m[1]) AS id
    FROM records r,
      regexp_matches(r.data::text, '([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})', 'g') AS m
    WHERE r.family_id = ${familyId} AND NOT r.deleted`;
  return new Set(rows.map((r) => r.id));
}
