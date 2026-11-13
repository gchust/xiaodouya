import {
  type Collection,
  type CollectionData,
  isFavoriteData,
  isFavoriteFolderData,
  isFormulaData,
  isResourceData,
} from '../schemas';

/**
 * 多个宝宝的数据规则（issue #106），见 docs/ARCHITECTURE.md 的“多个宝宝”。
 *
 * 记录可以带 `babyId`；没有的属于家庭的**第一个宝宝**。第一个宝宝按建档先后排，不按 `updatedAt`：
 * 旧版 App 取 `updatedAt` 最大的档案，家里加了第二个宝宝之后，改一下档案就会把第一个宝宝“换掉”。
 * 这样以后支持多个宝宝时，旧记录不用迁移。
 */
export interface BabyRef {
  id: string;
  /** 建档时间。现有家庭的档案没有：它们都是家庭的第一个宝宝。 */
  createdAt?: number;
  deleted?: boolean;
}

/**
 * 从一条 `baby` 记录的原文取排序要用的部分。删除标记和这个版本读不懂的档案也要参与排序，
 * 所以直接读原文，不经过 BabyData 的校验。
 */
export function babyRefOf(id: string, data: unknown, deleted: boolean): BabyRef {
  const createdAt = (data as { createdAt?: unknown } | null)?.createdAt;
  return Number.isSafeInteger(createdAt) && (createdAt as number) >= 0
    ? { id, createdAt: createdAt as number, deleted }
    : { id, deleted };
}

/** 早建的在前。没有 `createdAt` 的排最前；相同时按 id，所有手机排出同一个顺序。 */
export function compareBabies(a: BabyRef, b: BabyRef): number {
  const at = (baby: BabyRef) => baby.createdAt ?? -1;
  return at(a) - at(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function orderBabies<T extends BabyRef>(babies: readonly T[]): T[] {
  return [...babies].sort(compareBabies);
}

/**
 * 没有 `babyId` 的记录属于谁。删除的宝宝也算：删除是软删除，可以撤销，
 * 它的旧记录不能因此变成另一个宝宝的。
 */
export function firstBabyId(babies: readonly BabyRef[]): string | null {
  return orderBabies(babies)[0]?.id ?? null;
}

/** 界面上显示的宝宝。只支持一个宝宝的版本只显示这一个：按顺序第一个没删除的。 */
export function defaultBaby<T extends BabyRef>(babies: readonly T[]): T | null {
  return orderBabies(babies).find((baby) => !baby.deleted) ?? null;
}

/**
 * 这条记录是不是属于某个宝宝。档案本身、奶粉、育儿资料、收藏和收藏夹是全家共用的，
 * 家人自己的证件（有 `owner`）是那个人的，都不属于哪个宝宝。
 */
export function isBabyScoped(collection: Collection, data: unknown): boolean {
  switch (collection) {
    case 'baby':
      return false;
    case 'event':
      return !(
        isFormulaData(data) ||
        isResourceData(data) ||
        isFavoriteData(data) ||
        isFavoriteFolderData(data)
      );
    case 'document':
      return (data as { owner?: unknown } | null)?.owner === undefined;
    case 'moment':
    case 'letter':
      return true;
  }
}

/**
 * 记录属于哪个宝宝。全家共用的返回 null；没写 `babyId` 的属于第一个宝宝。
 * `babyId` 指向本机还没有的宝宝（还没同步到）时仍算那个宝宝的，不回落，否则同步前后会换主人。
 * `data` 要先过 zod：格式不对的 `babyId` 校验时已经丢掉了。
 */
export function recordBabyId(
  collection: Collection,
  data: unknown,
  firstId: string | null,
): string | null {
  if (!isBabyScoped(collection, data)) return null;
  const babyId = (data as { babyId?: unknown } | null)?.babyId;
  return typeof babyId === 'string' ? babyId : firstId;
}

/**
 * 新建记录时写上它属于哪个宝宝。只在新建时用：修改已有的记录不能改它的主人，
 * 没有 `babyId` 的旧记录本来就属于第一个宝宝，不用补。
 */
export function withBabyId<C extends Collection>(
  collection: C,
  data: CollectionData[C],
  babyId: string | undefined,
): CollectionData[C] {
  if (!babyId || !isBabyScoped(collection, data)) return data;
  if ((data as { babyId?: unknown }).babyId !== undefined) return data;
  return { ...data, babyId };
}
