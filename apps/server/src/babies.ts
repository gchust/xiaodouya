import {
  type BabyRef,
  babyRefOf,
  defaultBaby,
  MULTI_BABY_CLIENT_LEVEL,
  needsMultiBabyUpgrade,
  parseClientLevel,
} from '@xiaodouya/shared';
import type { Sql } from './db';

/**
 * 服务端这边的多个宝宝（issue #106），规则在 shared 的 domain/babies.ts，见 docs/ARCHITECTURE.md 的“多个宝宝”。
 * 这里的查询都走 `records_babies` 部分索引，不扫家庭的全部记录。
 */

type Db = Pick<Sql, 'unsafe'>;

export interface BabyRow extends BabyRef {
  /** 库里的原文。删除标记的内容是客户端原样发来的，不一定是一份完整的档案。 */
  data: unknown;
}

/** 家庭的全部档案，删除的也要：它们照样参与排序。 */
export async function familyBabies(db: Db, familyId: string): Promise<BabyRow[]> {
  const rows = await db.unsafe<{ id: string; data: unknown; deleted: boolean }[]>(
    `SELECT id, data, deleted FROM records WHERE family_id = $1 AND collection = 'baby'`,
    [familyId],
  );
  return rows.map((row) => ({ ...babyRefOf(row.id, row.data, row.deleted), data: row.data }));
}

/** 排序要用的部分，不取整份档案：旧版 App 每次同步都要查一次。 */
async function babyRefs(db: Db, familyId: string): Promise<BabyRef[]> {
  const rows = await db.unsafe<{ id: string; created_at: unknown; deleted: boolean }[]>(
    `SELECT id, data->'createdAt' AS created_at, deleted FROM records
     WHERE family_id = $1 AND collection = 'baby'`,
    [familyId],
  );
  return rows.map((row) => babyRefOf(row.id, { createdAt: row.created_at }, row.deleted));
}

/**
 * 这个请求的 App 能不能和这个家庭同步。新版 App 带着级别，不用查库；
 * 旧版 App 每次多一条走索引的小查询。
 */
export async function blocksOldClient(
  db: Db,
  familyId: string,
  header: string | undefined,
): Promise<boolean> {
  const level = parseClientLevel(header);
  if (level >= MULTI_BABY_CLIENT_LEVEL) return false;
  return needsMultiBabyUpgrade(level, await babyRefs(db, familyId));
}

/** 档案里写的地区。不是字符串就当没有，和 BabyData 的 `catch` 一样。 */
export function regionOf(data: unknown): string | undefined {
  const region = (data as { region?: unknown } | null)?.region;
  return typeof region === 'string' ? region : undefined;
}

/**
 * 家庭的地区：旧版界面上显示的那个宝宝（按顺序第一个没删除的）的地区。
 * 用在推送的单位和其他家人新建档案时，以前取的是 `updated_at_client` 最大的档案。
 */
export async function familyRegion(db: Db, familyId: string): Promise<string | undefined> {
  return regionOf(defaultBaby(await familyBabies(db, familyId))?.data);
}

/** 档案的 `createdAt` 换成定好的值。删除标记的内容可能不是对象，也要写得进去，否则排序时它就缺了。 */
export function withCreatedAt(data: unknown, createdAt: number | undefined): unknown {
  const isObject = data !== null && typeof data === 'object' && !Array.isArray(data);
  if (!isObject && createdAt === undefined) return data;
  const { createdAt: _ignored, ...rest } = isObject ? (data as Record<string, unknown>) : {};
  return createdAt === undefined ? rest : { ...rest, createdAt };
}
