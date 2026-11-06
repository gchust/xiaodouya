import { z } from 'zod';
import { MULTIPART_URL_BATCH } from './domain/multipart';
import { lengthUnits, temperatureUnits, volumeUnits, weightUnits } from './domain/units';
import type { FeedbackConfig } from './feedback';
import { t } from './i18n';
import { locales } from './i18n/locale';
import { SharePrefs } from './shareSettings';

/** 所有时间都是毫秒时间戳（UTC）。 */
const timestamp = z.number().int().nonnegative();
const shortText = z.string().max(200);
const longText = z.string().max(20_000);

/** 一份家人自己的证件最多给多少位家人看（F-137）。 */
export const MAX_DOCUMENT_READERS = 50;

/** 一条记录最多带多少个文件。改大之前要想到旧版 App：校验不过的记录它们显示不出来。 */
export const MAX_MEDIA_PER_RECORD = 100;

export const mediaKinds = ['image', 'video', 'audio', 'pdf'] as const;
export type MediaKind = (typeof mediaKinds)[number];

export const MediaRef = z.looseObject({
  id: z.uuid(),
  kind: z.enum(mediaKinds),
  name: shortText.optional(),
  mime: shortText,
  size: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  /** 录音波形，0–1，最多 64 个点。 */
  peaks: z.array(z.number().min(0).max(1)).max(64).optional(),
  hasThumb: z.boolean().optional(),
});
export type MediaRef = z.infer<typeof MediaRef>;

const eventBase = {
  at: timestamp,
  note: shortText.optional(),
  byName: shortText.optional(),
};

export const diaperKinds = ['wee', 'poo', 'both'] as const;
export type DiaperKind = (typeof diaperKinds)[number];

export const milkTypes = ['formula', 'breast', 'mixed'] as const;
export type MilkType = (typeof milkTypes)[number];

/**
 * 营养标签上的数值。没有的项必须保持缺失：缺失是“不知道”，0 是“标签写了 0”。
 * 单位固定：能量 kcal，维生素 D 是 µg，输入时的 kJ、IU 换算见 health/nutrition。
 * 单项格式不对只丢这一项，不能让整条记录校验失败。
 */
const nutrientAmount = z.number().min(0).max(100_000).optional().catch(undefined);
export const NutrientValues = z.looseObject({
  energyKcal: nutrientAmount,
  proteinG: nutrientAmount,
  fatG: nutrientAmount,
  carbsG: nutrientAmount,
  calciumMg: nutrientAmount,
  ironMg: nutrientAmount,
  vitaminDUg: nutrientAmount,
});
export type NutrientValues = z.infer<typeof NutrientValues>;

/** 喂奶当时奶粉的数值。之后改配方或删掉奶粉，已经记下的那天不跟着变。 */
export const FormulaSnapshot = z.looseObject({
  name: shortText,
  per100ml: NutrientValues,
});
export type FormulaSnapshot = z.infer<typeof FormulaSnapshot>;

/** 喂奶、尿布等“今天”页的记录。 */
export const EventData = z.discriminatedUnion('type', [
  z.looseObject({
    ...eventBase,
    type: z.literal('feed'),
    ml: z.number().int().min(0).max(1000),
    // v0.1.0 的记录没有这三个字段，算“没标注”。都带 catch：不认识的值不能让喂奶从时间线消失。
    milkType: z.enum(milkTypes).optional().catch(undefined),
    formulaId: z.string().max(64).optional().catch(undefined),
    formula: FormulaSnapshot.optional().catch(undefined),
  }),
  z.looseObject({ ...eventBase, type: z.literal('diaper'), kind: z.enum(diaperKinds) }),
  z.looseObject({ ...eventBase, type: z.literal('sleep'), endAt: timestamp.optional() }),
  z.looseObject({ ...eventBase, type: z.literal('temp'), celsius: z.number().min(30).max(45) }),
  z.looseObject({
    ...eventBase,
    type: z.literal('med'),
    name: shortText.min(1),
    dose: shortText.optional(),
  }),
  z.looseObject({ ...eventBase, type: z.literal('bath') }),
  z.looseObject({ ...eventBase, type: z.literal('solids'), food: shortText.min(1) }),
  z.looseObject({
    ...eventBase,
    type: z.literal('growth'),
    weightKg: z.number().min(0.3).max(100),
    lengthCm: z.number().min(20).max(250),
  }),
  z.looseObject({
    ...eventBase,
    type: z.literal('vaccine'),
    vaccineId: shortText,
    name: shortText,
  }),
]);
export type EventData = z.infer<typeof EventData>;
export type EventType = EventData['type'];

/**
 * 家庭对疫苗本的配置，每一剂一条：隐藏、改计划时间，或者自己加的一剂（`custom:` 开头）。
 *
 * 放在 `event` 集合而不是新集合，也没有 `at`，理由和奶粉配置一样，见 docs/ARCHITECTURE.md 的
 * “疫苗本的家庭配置”。一剂一条，两位家人同时改不同的剂次不会互相覆盖。
 * 内置表永远不改，这里只是一层覆盖。单项格式不对只丢这一项。
 */
export const VaccinePlanData = z.looseObject({
  type: z.literal('vaccine-plan'),
  /** 这条配置管哪一剂。内置的是 `sg:bcg`；自己加的是 `custom:<这条记录的 id>`，接种记录也写这个 id。 */
  vaccineId: shortText.min(1),
  /** 自己加的疫苗的名字。 */
  name: shortText.min(1).optional().catch(undefined),
  /** 只影响显示和提醒。已经记录的接种不受它影响。 */
  hidden: z.boolean().optional().catch(undefined),
  /** 计划接种那天的当地中午，时区差几个小时也还是同一天。优先于月龄。 */
  plannedAt: timestamp.optional().catch(undefined),
  /** 自己加的疫苗按月龄算时的月龄。 */
  months: z.number().int().min(0).max(240).optional().catch(undefined),
});
export type VaccinePlanData = z.infer<typeof VaccinePlanData>;

export function isVaccinePlanData(data: unknown): data is VaccinePlanData {
  return (data as { type?: unknown } | null)?.type === 'vaccine-plan';
}

export const formulaBases = ['per100ml', 'per100g'] as const;
export type FormulaBasis = (typeof formulaBases)[number];

/**
 * 家庭配置的一款奶粉。
 *
 * 放在 `event` 集合而不是新集合，理由写在 docs/ARCHITECTURE.md 的“奶粉和营养”：v0.1.0 收到不认识的
 * 集合会在启动时崩溃，旧服务端会拒绝整批同步。放在这里，viewer 也和喂奶记录一样读不到。
 *
 * 不能有 `at`：v0.1.0 的横幅和服务端推送只处理一小时内的 `at`，没有它才不会弹“记录了 undefined”。
 * `basis` 不认识时整条不显示（校验失败的记录会保留），不能猜数值是按什么算的。
 */
export const FormulaData = z.looseObject({
  type: z.literal('formula'),
  name: shortText.min(1),
  /** 从哪个预置来的。数值已经复制进来，预置更新不会改变这个家庭的配置。 */
  presetId: z.string().max(64).optional().catch(undefined),
  basis: z.enum(formulaBases),
  values: NutrientValues,
  /** 每 100 ml 冲好的奶用多少克粉。`basis` 是 per100g 时靠它换算，缺了就不换算。 */
  powderGPer100ml: z.number().positive().max(100).optional().catch(undefined),
});
export type FormulaData = z.infer<typeof FormulaData>;

export function isFormulaData(data: unknown): data is FormulaData {
  return (data as { type?: unknown } | null)?.type === 'formula';
}

/** 一笔钱最多多少（最小单位）。人民币是 100 亿元，远超家里会记的数，又在安全整数以内。 */
export const MAX_MONEY_MINOR = 1_000_000_000_000;

export const moneyFlows = ['in', 'out'] as const;
export type MoneyFlow = (typeof moneyFlows)[number];

/**
 * 小金库的一笔（issue #90）：谁给了宝宝多少钱，或者拿出多少（存进银行、花掉）。只是记账，不碰真实的钱。
 *
 * 放在 `event` 集合而不是新集合，理由和奶粉配置一样（docs/ARCHITECTURE.md 的“小金库”）：旧版 App 校验不过，
 * 保留但不显示；viewer 和喂奶一样读不到也写不了。日期放在 `happenedAt` 而不是 `at`：旧版 App 的横幅、
 * 服务端推送和分享页都按 `at` 认“一条记录”，带上 `at` 会提示“记录了 undefined”。
 *
 * 金额是币种最小单位的整数（分、美分；日元就是日元），不用浮点。币种是 ISO 4217 代码，这个版本不认识的
 * 币种也保留，按两位小数显示。`flow` 不认识时整条不显示：不能猜它让余额变多还是变少。
 * 可选项格式不对只丢这一项。
 */
export const MoneyData = z.looseObject({
  type: z.literal('money'),
  flow: z.enum(moneyFlows),
  amountMinor: z.number().int().positive().max(MAX_MONEY_MINOR),
  currency: z.string().regex(/^[A-Z]{3}$/),
  /** 哪天的事：今天记的是保存那一刻，补记以前的是那天的当地中午（时区差几个小时也还是同一天）。 */
  happenedAt: timestamp,
  /** 谁给的，用户填的原文，不翻译。只对收到的有意义。 */
  from: shortText.optional().catch(undefined),
  /** 场合或用途的 id（`lunar-new-year`、`bank`），名字在 regions/moneyCategories.ts。不认识的不显示。 */
  category: z.string().max(64).optional().catch(undefined),
  note: shortText.optional().catch(undefined),
  byName: shortText.optional().catch(undefined),
});
export type MoneyData = z.infer<typeof MoneyData>;

export function isMoneyData(data: unknown): data is MoneyData {
  return (data as { type?: unknown } | null)?.type === 'money';
}

export const MomentData = z.looseObject({
  title: shortText,
  text: longText,
  at: timestamp,
  milestone: z.boolean(),
  media: z.array(MediaRef).max(MAX_MEDIA_PER_RECORD),
  byName: shortText.optional(),
  /**
   * 时间线上当封面的照片或视频，指向 `media` 里的一个 id。没有、找不到或者指向录音时用第一个（见 momentCover）。
   * 格式不对只丢掉这一项，不能让整条回忆校验失败；旧版 App 不认识它，按第一个显示。
   */
  coverMediaId: z.uuid().optional().catch(undefined),
});
export type MomentData = z.infer<typeof MomentData>;

export const LetterData = z.looseObject({
  title: shortText,
  text: longText,
  at: timestamp,
  byName: shortText.optional(),
});
export type LetterData = z.infer<typeof LetterData>;

export const DocumentData = z.looseObject({
  name: shortText.min(1),
  subtitle: shortText.optional(),
  number: shortText.optional(),
  issuedOn: shortText.optional(),
  expiresOn: shortText.optional(),
  files: z.array(MediaRef).max(MAX_MEDIA_PER_RECORD),
  /**
   * 家人自己的证件（F-137）：本人的账号 id。没有这个字段的是宝宝的证件。
   * 不加 catch：格式不对时整条校验失败（不显示、服务端不收），不能把私人证件当成全家的。
   */
  owner: z.uuid().optional(),
  /** 本人选的能看的家人。格式不对只丢这一项，结果是谁都不给看，不会多给人看。 */
  sharedWith: z.array(z.uuid()).max(MAX_DOCUMENT_READERS).optional().catch(undefined),
});
export type DocumentData = z.infer<typeof DocumentData>;

export const BabyData = z.looseObject({
  name: shortText.min(1),
  birthAt: timestamp,
  birthWeightKg: z.number().min(0.3).max(10).optional(),
  birthLengthCm: z.number().min(20).max(80).optional(),
  hospital: shortText.optional(),
  bloodType: shortText.optional(),
  avatar: MediaRef.optional(),
  /**
   * 不用枚举：新版本写入的地区，旧版本要能读、能原样保存，界面按“其他地区”显示。
   * 没有这个字段的是 v0.1.0 的档案，按新加坡处理（见 regionFor）。
   * 格式不对也只丢掉这一项，不能让整份档案校验失败。
   */
  region: z.string().max(32).optional().catch(undefined),
});
export type BabyData = z.infer<typeof BabyData>;

export const collectionSchemas = {
  baby: BabyData,
  event: z.union([EventData, FormulaData, VaccinePlanData, MoneyData]),
  moment: MomentData,
  letter: LetterData,
  document: DocumentData,
} as const;

export const collections = ['baby', 'event', 'moment', 'letter', 'document'] as const;
export type Collection = (typeof collections)[number];

export interface CollectionData {
  baby: BabyData;
  event: EventData | FormulaData | VaccinePlanData | MoneyData;
  moment: MomentData;
  letter: LetterData;
  document: DocumentData;
}

/** 把未知数据按集合校验；失败时返回 null，由调用方决定如何处理。 */
export function parseCollectionData<C extends Collection>(
  collection: C,
  data: unknown,
): CollectionData[C] | null {
  const parsed = collectionSchemas[collection].safeParse(data);
  return parsed.success ? (parsed.data as CollectionData[C]) : null;
}

// ─── 角色和权限 ──────────────────────────────────────────────

export const roles = ['admin', 'caregiver', 'viewer'] as const;
export const Role = z.enum(roles);
export type Role = z.infer<typeof Role>;

/** 跟随当前语言，所以是属性而不是固定的文字。 */
export const roleLabels: Record<Role, string> = {
  get admin() {
    return t().domain.roles.admin;
  },
  get caregiver() {
    return t().domain.roles.caregiver;
  },
  get viewer() {
    return t().domain.roles.viewer;
  },
};

const viewerCollections: readonly Collection[] = ['baby', 'moment', 'letter'];

export function canReadCollection(role: Role, collection: Collection): boolean {
  return role !== 'viewer' || viewerCollections.includes(collection);
}

export function canWriteCollection(role: Role, _collection: Collection): boolean {
  return role !== 'viewer';
}

/**
 * `personal` 是家人自己的证件里的文件（F-137），只有本人和本人选的家人能取链接，见 canReadOwnedMedia。
 * 旧服务端不认识它，会拒绝上传：服务端要先于新版 App 部署。
 */
export const mediaScopes = ['memory', 'document', 'avatar', 'personal'] as const;
export const MediaScope = z.enum(mediaScopes);
export type MediaScope = z.infer<typeof MediaScope>;

/** 只看角色。私人证件的文件还要按本人的设置判断，见 canReadOwnedMedia。 */
export function canReadMediaScope(role: Role, scope: MediaScope): boolean {
  return role !== 'viewer' || (scope !== 'document' && scope !== 'personal');
}

/** 证件类的文件：宝宝的和家人自己的。链接有效期、不走 CDN、缩略图大小都一样。 */
export function isDocumentScope(scope: MediaScope): boolean {
  return scope === 'document' || scope === 'personal';
}

// ─── 同步 ───────────────────────────────────────────────────

export const SyncChange = z.object({
  id: z.uuid(),
  collection: z.enum(collections),
  data: z.unknown(),
  deleted: z.boolean(),
  /** 客户端修改时间，用于后写胜出。 */
  updatedAt: timestamp,
});
export type SyncChange = z.infer<typeof SyncChange>;

export const SyncRequest = z.object({
  cursor: z.number().int().nonnegative(),
  changes: z.array(SyncChange).max(500),
});
export type SyncRequest = z.infer<typeof SyncRequest>;

export const ServerRecord = SyncChange.extend({
  seq: z.number().int().positive(),
  createdBy: z.uuid().nullable(),
});
export type ServerRecord = z.infer<typeof ServerRecord>;

export const SyncResponse = z.object({
  cursor: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  records: z.array(ServerRecord),
  /** 被拒绝的改动：客户端应丢弃它们，防止发件箱卡死。 */
  rejected: z.array(z.object({ id: z.uuid(), reason: z.string() })),
  /** 当前角色。客户端靠它发现权限变化：升级后要重新拉历史，降级后要清掉读不到的数据。 */
  role: Role,
});
export type SyncResponse = z.infer<typeof SyncResponse>;

// ─── 账号和家庭 ──────────────────────────────────────────────

const email = z.email().max(200);
const password = z.string().min(8).max(200);
const displayName = z.string().trim().min(1).max(40);

export const RegisterRequest = z.object({
  email,
  password,
  displayName,
  inviteCode: z.string().trim().max(32).optional(),
});
export const LoginRequest = z.object({ email, password: z.string().max(200) });
export const CreateFamilyRequest = z.object({
  name: z.string().trim().min(1).max(60),
  label: displayName,
});
export const CreateInviteRequest = z.object({
  role: Role,
  label: displayName,
});
export const AcceptInviteRequest = z.object({
  code: z.string().trim().min(4).max(32),
});
export const UpdateMemberRequest = z.object({
  role: Role.optional(),
  label: displayName.optional(),
});

export interface PublicUser {
  id: string;
  email: string;
  displayName: string;
}

export interface FamilyMember {
  userId: string;
  label: string;
  role: Role;
  /** 毫秒时间戳；null 表示还没有上线过。 */
  lastSeenAt: number | null;
}

export interface PendingInvite {
  id: string;
  label: string;
  role: Role;
  expiresAt: number;
}

export interface MeResponse {
  user: PublicUser;
  /** 服务器没有配置邮件时无从验证，也算 true，App 不用再判断一次。 */
  emailVerified: boolean;
  family: { id: string; name: string } | null;
  role: Role | null;
  label: string | null;
  members: FamilyMember[];
  invites: PendingInvite[];
  prefs: Prefs;
  /**
   * 这个账号能不能在 App 里看收到的反馈（服务端 FEEDBACK_VIEWER_EMAILS）。只用来决定显不显示入口，
   * 真正的权限在服务端每次请求时判断。旧服务端没有这个字段，当作不能。
   */
  canViewFeedback?: boolean;
}

export interface AuthResponse {
  token: string;
  user: PublicUser;
}

/**
 * 只存用户自己改过的单位，没改过的跟随家庭的地区（见 effectiveUnits）。
 * 不认识的值只丢掉这一项：`mergePrefs` 校验失败会把整份偏好退回默认值。
 */
export const UnitPrefs = z.object({
  volume: z.enum(volumeUnits).optional().catch(undefined),
  temperature: z.enum(temperatureUnits).optional().catch(undefined),
  weight: z.enum(weightUnits).optional().catch(undefined),
  length: z.enum(lengthUnits).optional().catch(undefined),
});
export type UnitPrefs = z.infer<typeof UnitPrefs>;

export const Prefs = z.object({
  feedReminder: z.boolean(),
  familyNotify: z.boolean(),
  quietNight: z.boolean(),
  timezone: z.string().max(64),
  documentLock: z.boolean(),
  videoWifiOnly: z.boolean(),
  units: UnitPrefs.optional().catch(undefined),
  /** 没有时跟随手机。不认识的值同样只丢掉这一项，新版本加了语言也不影响旧版本的其他偏好。 */
  locale: z.enum(locales).optional().catch(undefined),
  /** 分享的默认值（F-141）。没有时用默认值；旧版 App 写偏好时不带它，服务端保留原来的。 */
  share: SharePrefs.optional().catch(undefined),
});
export type Prefs = z.infer<typeof Prefs>;

export const defaultPrefs: Prefs = {
  feedReminder: true,
  familyNotify: true,
  quietNight: true,
  // 服务端不知道手机的时区。App 启动后会把手机的时区写上来（见 mobile 的 timezoneToSync）。
  timezone: 'UTC',
  documentLock: false,
  videoWifiOnly: true,
};

export const PushTokenRequest = z.object({
  token: z.string().min(1).max(300),
  deviceId: z.string().min(1).max(100),
});

// ─── 文件 ───────────────────────────────────────────────────

/**
 * original 永远不压缩。preview 是重新编码的 JPEG（长边约 2048），查看器和分享页默认用它。
 * 旧版 App 只请求自己认识的变体，服务端按请求回答，所以它收不到 preview。
 */
export const mediaVariants = ['original', 'thumb', 'preview'] as const;
export const MediaVariant = z.enum(mediaVariants);
export type MediaVariant = z.infer<typeof MediaVariant>;

/** 上传白名单：其他类型一律拒绝，避免存储被当成任意文件托管。 */
export function isAllowedMime(mime: string, scope: MediaScope): boolean {
  const lower = mime.toLowerCase();
  if (isDocumentScope(scope)) return lower.startsWith('image/') || lower === 'application/pdf';
  if (scope === 'avatar') return lower.startsWith('image/');
  return lower.startsWith('image/') || lower.startsWith('video/') || lower.startsWith('audio/');
}

export const UploadUrlRequest = z.object({
  id: z.uuid(),
  scope: MediaScope,
  variant: MediaVariant,
  mime: z.string().min(1).max(120),
  size: z.number().int().positive(),
  filename: z.string().max(200).optional(),
});
export type UploadUrlRequest = z.infer<typeof UploadUrlRequest>;

export interface UploadUrlResponse {
  url: string;
  headers: Record<string, string>;
  expiresIn: number;
}

export const CompleteUploadRequest = z.object({ variant: MediaVariant });

export const MultipartStartRequest = UploadUrlRequest;
export type MultipartStartRequest = z.infer<typeof MultipartStartRequest>;

export interface MultipartStartResponse {
  uploadId: string;
  partSize: number;
}

export const MultipartRef = z.object({
  variant: MediaVariant,
  uploadId: z.string().min(1).max(2048),
});
export type MultipartRef = z.infer<typeof MultipartRef>;

export interface MultipartPartsResponse {
  /** 存储里已有的片。服务端直接问存储，不记账。 */
  parts: { partNumber: number; size: number }[];
  /** 文件其实已经合并好了（上次完成后还没来得及收到响应），直接调完成接口。 */
  complete: boolean;
}

export const MultipartPartUrlsRequest = MultipartRef.extend({
  partNumbers: z.array(z.number().int().min(1).max(10_000)).min(1).max(MULTIPART_URL_BATCH),
});
export type MultipartPartUrlsRequest = z.infer<typeof MultipartPartUrlsRequest>;

export interface MultipartPartUrlsResponse {
  urls: { partNumber: number; url: string; size: number }[];
  expiresIn: number;
}

export const MediaUrlsRequest = z.object({
  items: z.array(z.object({ id: z.uuid(), variant: MediaVariant })).max(200),
});

export interface MediaUrlsResponse {
  urls: { id: string; variant: MediaVariant; url: string | null; expiresIn: number }[];
}

// ─── 存储配置 ───────────────────────────────────────────────

export const storageProviders = ['r2', 's3', 'other'] as const;
export const StorageProvider = z.enum(storageProviders);
export type StorageProvider = z.infer<typeof StorageProvider>;

export const storageProviderNames: Record<StorageProvider, string> = {
  r2: 'Cloudflare R2',
  s3: 'AWS S3',
  get other() {
    return t().domain.storage.otherProvider;
  },
};

/** 写入配置。secret 省略表示沿用已保存的值。 */
export const StorageConfigInput = z.object({
  provider: StorageProvider,
  accountId: z.string().trim().max(100).optional(),
  endpoint: z.url().max(300).optional(),
  region: z.string().trim().max(60).optional(),
  bucket: z.string().trim().min(1).max(100),
  accessKeyId: z.string().trim().min(1).max(200),
  secretAccessKey: z.string().min(1).max(300).optional(),
  publicBaseUrl: z.url().max(300).optional(),
});
export type StorageConfigInput = z.infer<typeof StorageConfigInput>;

/** 读回配置：永远不包含 Secret。 */
export interface StorageConfigView {
  source: 'family' | 'server' | 'none';
  provider: StorageProvider | null;
  accountId: string | null;
  endpoint: string | null;
  region: string | null;
  bucket: string | null;
  accessKeyId: string | null;
  hasSecret: boolean;
  publicBaseUrl: string | null;
}

export interface StorageTestResult {
  ok: boolean;
  latencyMs: number;
  message: string;
  /** 新版 App 按它显示当前语言，v0.1.0 显示 message。 */
  reason?: string;
}

export interface StorageUsage {
  image: number;
  video: number;
  audio: number;
  document: number;
  /** 上面四类之和：已传完、没有被删除的文件。 */
  total: number;
  /** 这个家庭在平台存储上的上限（字节）。null 表示不限，比如用自己的存储。 */
  quota: number | null;
  /** 算进上限的用量：total 里在平台存储上的部分，加上传中的预留。 */
  quotaUsed: number;
  /** 正在上传、已经预留的空间。 */
  pending: number;
  /** 所在记录已删除、等待清理的文件。还占着存储，但在配额以内不算用量，这样删除能马上腾出空间。 */
  trash: number;
  /** 已删除的文件保留多少天后彻底清理。 */
  trashDays: number;
}

/** 不用登录就能读的服务器能力，App 据此决定显示什么。只能加字段，旧版 App 还在读。 */
export interface PublicConfig {
  /** false 时普通用户只能用平台托管的存储，App 不显示 S3 表单。 */
  allowCustomStorage: boolean;
  /** 配置了邮件：登录页显示“忘记密码”。 */
  passwordReset: boolean;
  /** 配置了邮件：注册后引导验证邮箱。 */
  emailVerification: boolean;
  /** 反馈问题。旧服务器没有这个字段，App 当作不可用。 */
  feedback?: FeedbackConfig;
  /**
   * 服务端认识家人自己的证件（F-137）。旧服务端不按 owner 过滤，私人证件会发给全家，
   * 所以 App 只有看到它才让人新建自己的证件。
   */
  personalDocuments?: boolean;
  /**
   * 服务端按创建时的设置换掉名字、决定带不带头像（F-141）。旧服务端会悄悄丢掉这些选项、
   * 照样发真实名字，所以 App 只有看到它才显示分享设置。
   */
  shareDisplay?: boolean;
}

export interface ApiError {
  error: {
    code: string;
    /** 一直是中文：v0.1.0 直接显示它。新版 App 按 `code` 和 `params` 显示当前语言（见 apiErrorMessage）。 */
    message: string;
    params?: Record<string, string | number>;
  };
}
