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
 * 加宝宝时写的 `createdAt`：“现在”和“已有最大的 `createdAt` 加 1”中较大的那个。`babies` 是全部档案，
 * 删除的也算。手机时钟慢了也排在已有的宝宝后面，不会抢走第一个宝宝的旧记录。
 */
export function nextBabyCreatedAt(babies: readonly BabyRef[], now: number): number {
  let latest = -1;
  for (const baby of babies) {
    if (baby.createdAt !== undefined && baby.createdAt > latest) latest = baby.createdAt;
  }
  return Math.max(Math.floor(now), latest + 1, 0);
}

/**
 * 分享链接属于哪个宝宝。创建时选了就是那个；没选的（旧版 App 建的）是旧版界面上显示的宝宝，
 * 档案全删了时是第一个宝宝：那时它的旧记录还在，旧链接照样能看到。
 */
export function shareBabyId(babies: readonly BabyRef[], requested: string | null): string | null {
  return requested ?? defaultBaby(babies)?.id ?? firstBabyId(babies);
}

/**
 * App 在每个请求的这个头里写自己支持到哪一级。旧版 App 都不写，算 0。
 * 用级别不用 versionCode：自动发版的包在按宝宝过滤做完之前 versionCode 也一直在涨。
 */
export const CLIENT_LEVEL_HEADER = 'x-client-level';
/** 按宝宝过滤的 App 从这一级开始。v0.1.0 到第一步的版本不过滤，第二个宝宝的记录会混进时间线。 */
export const MULTI_BABY_CLIENT_LEVEL = 1;

export function parseClientLevel(header: string | null | undefined): number {
  const text = header?.trim() ?? '';
  return /^\d{1,6}$/.test(text) ? Number(text) : 0;
}

/**
 * 这个版本的 App 还能不能和这个家庭同步。`babies` 是家庭的全部档案，删除的也算：它们照样参与排序，
 * 删除可以撤销，那个宝宝的记录也还在。
 *
 * 还要有一份带 `createdAt` 的，也就是按宝宝过滤的 App 加过宝宝：v0.1.0 之前可能有两台手机各建了一份
 * 档案（都没有 `createdAt`）的家庭，那时还没有能加宝宝的版本，挡住它们只会让全家同步不了、也没有新版可换。
 */
export function needsMultiBabyUpgrade(clientLevel: number, babies: readonly BabyRef[]): boolean {
  return (
    clientLevel < MULTI_BABY_CLIENT_LEVEL &&
    babies.length > 1 &&
    babies.some((baby) => baby.createdAt !== undefined)
  );
}

/**
 * 服务端收到一份档案时它的 `createdAt`，返回 null 是拒绝。`existing` 是库里同一个 id 的档案。
 *
 * `createdAt` 只在建档时定一次：家庭已经有档案时，新档案必须带；改已有的档案时一直用库里的。
 * 后加的宝宝丢了它（旧版保存时丢掉、格式坏了被 `catch` 丢掉）就会和第一个宝宝并列，按 id 排可能
 * 拿走全部旧记录；第一个宝宝写上一个时间也可能排到后加的宝宝后面。补回去而不拒绝修改，
 * 这样旧版改个名字也不会失败。
 *
 * 建档页的档案（id 是家庭 id）什么时候到都可以不带：一台手机的发件箱不保证先发它，
 * 后加的宝宝先传上去的话，它被拒就再也传不上去，后加的宝宝反而成了第一个。
 */
export function settleBabyCreatedAt(
  existing: BabyRef | undefined,
  incoming: number | undefined,
  context: { familyHasBaby: boolean; isFamilyProfile: boolean },
): { createdAt: number | undefined } | null {
  if (existing) return { createdAt: existing.createdAt };
  if (incoming === undefined && context.familyHasBaby && !context.isFamilyProfile) return null;
  return { createdAt: incoming };
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
