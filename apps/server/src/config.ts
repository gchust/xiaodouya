import { Buffer } from 'node:buffer';
import { MAX_PUBLIC_MEDIA } from '@xiaodouya/shared';
import { z } from 'zod';

const bool = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : v === 'true' || v === '1'));

const optionalText = z
  .string()
  .optional()
  .transform((v) => (v ? v : undefined));

const DbEnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  DB_PREPARE: bool(true),
  DB_SSL: z.enum(['', 'false', 'require', 'verify-full']).optional(),
});

const EnvSchema = DbEnvSchema.extend({
  APP_SECRET: z.string().refine((v) => Buffer.from(v, 'base64').length >= 32, {
    message: '必须是至少 32 字节的 base64，可用 openssl rand -base64 32 生成',
  }),
  PORT: z.coerce.number().int().default(8787),
  ALLOW_SIGNUP: bool(true),
  MAX_UPLOAD_MB: z.coerce.number().int().positive().default(4096),
  MAX_IMAGE_MB: z.coerce.number().int().positive().default(50),
  MAX_VIDEO_MB: z.coerce.number().int().positive().default(1024),
  MAX_AUDIO_MB: z.coerce.number().int().positive().default(200),
  MAX_DOCUMENT_MB: z.coerce.number().int().positive().default(50),
  /** 依据见 docs/CAPACITY.md。0 表示不限。 */
  FAMILY_QUOTA_MB: z.coerce.number().int().nonnegative().default(102400),
  FAMILY_RECORDS_MB: z.coerce.number().int().nonnegative().default(100),
  MEDIA_TRASH_DAYS: z.coerce.number().int().positive().default(30),
  CLIENT_IP_HEADER: z.string().default('x-forwarded-for'),
  CLIENT_IP_POSITION: z.enum(['first', 'last']).default('last'),
  RATE_SYNC_PER_10MIN: z.coerce.number().int().nonnegative().default(600),
  RATE_UPLOAD_URL_PER_HOUR: z.coerce.number().int().nonnegative().default(2000),
  RATE_REGISTER_PER_IP_HOUR: z.coerce.number().int().nonnegative().default(20),
  RATE_REGISTER_GLOBAL_HOUR: z.coerce.number().int().nonnegative().default(1000),
  // 一个大家庭群里几十个人同时点开、NAT 后面共用一个地址也不该被挡。
  RATE_PUBLIC_SHARE_PER_IP_15MIN: z.coerce.number().int().nonnegative().default(120),
  RATE_PUBLIC_SHARE_PER_TOKEN_HOUR: z.coerce.number().int().nonnegative().default(600),
  S3_ENDPOINT: optionalText,
  S3_PUBLIC_ENDPOINT: optionalText,
  S3_REGION: optionalText,
  S3_BUCKET: optionalText,
  S3_ACCESS_KEY_ID: optionalText,
  S3_SECRET_ACCESS_KEY: optionalText,
  S3_FORCE_PATH_STYLE: bool(false),
  S3_BIND_UPLOAD_SIZE: bool(true),
  S3_MULTIPART_ENABLED: bool(true),
  ALLOW_CUSTOM_STORAGE: optionalText,
  ALLOW_PRIVATE_STORAGE_ENDPOINTS: bool(false),
  PUSH_ENABLED: bool(false),
  EXPO_ACCESS_TOKEN: optionalText,
  MAIL_PROVIDER: z.enum(['', 'none', 'resend', 'log']).optional(),
  RESEND_API_KEY: optionalText,
  MAIL_FROM: optionalText,
  NODE_ENV: optionalText,
});

export interface ServerStorageEnv {
  endpoint: string | undefined;
  publicEndpoint: string | undefined;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

export interface DbConfig {
  poolMax: number;
  prepare: boolean;
  /** false 时仍然遵守连接串里的 sslmode。 */
  ssl: false | 'require' | 'verify-full';
}

type Env = Record<string, string | undefined>;

export interface ClientIpConfig {
  /** 小写的请求头名。 */
  header: string;
  /** 取这个头里逗号分隔的第几段。代理追加时最后一段才是可信的。 */
  position: 'first' | 'last';
}

export interface RateLimits {
  /** 0 表示不限，下同。 */
  syncPerWindow: number;
  uploadUrlPerWindow: number;
  registerPerIpHour: number;
  registerGlobalHour: number;
  /** 分享页的公开接口，15 分钟一个窗口。 */
  sharePublicPerIp: number;
  /** 分享页的公开接口，一小时一个窗口。 */
  sharePublicPerToken: number;
  /** 一次公开响应最多带多少个文件，不是请求频率，也不能是 0。 */
  sharePublicMedia: number;
}

export interface Config {
  databaseUrl: string;
  db: DbConfig;
  appSecret: Buffer;
  port: number;
  allowSignup: boolean;
  maxUploadBytes: number;
  maxFileBytes: { image: number; video: number; audio: number; document: number };
  /** null 表示不限。 */
  familyQuotaBytes: number | null;
  familyRecordsBytes: number | null;
  mediaTrashDays: number;
  clientIp: ClientIpConfig;
  limits: RateLimits;
  serverStorage: ServerStorageEnv | null;
  /** 把声明的大小签进上传链接。个别存储不支持时关掉，complete 的校验还在。 */
  bindUploadSize: boolean;
  /** 大文件分片上传。存储不支持时（`cli check-multipart` 不通过）关掉，App 会退回单个 PUT。 */
  multipartEnabled: boolean;
  allowCustomStorage: boolean;
  allowPrivateEndpoints: boolean;
  pushEnabled: boolean;
  expoAccessToken: string | undefined;
  /** null 表示不发邮件：跳过邮箱验证，找回密码由部署者处理。 */
  mail: { provider: 'resend'; apiKey: string; from: string } | { provider: 'log' } | null;
}

/** 配错时拒绝启动：悄悄退回“不发邮件”的话，部署者要到有人找回不了密码才发现。 */
function toMailConfig(e: z.infer<typeof EnvSchema>): Config['mail'] {
  if (e.MAIL_PROVIDER === 'log') {
    if (e.NODE_ENV === 'production') {
      throw new Error(
        '环境变量配置有误：\n  MAIL_PROVIDER: log 会把验证码打进日志，不能用于生产环境',
      );
    }
    return { provider: 'log' };
  }
  if (e.MAIL_PROVIDER === 'resend') {
    if (!e.RESEND_API_KEY) {
      throw new Error('环境变量配置有误：\n  RESEND_API_KEY: MAIL_PROVIDER=resend 时必填');
    }
    if (!e.MAIL_FROM) {
      throw new Error('环境变量配置有误：\n  MAIL_FROM: MAIL_PROVIDER=resend 时必填');
    }
    return { provider: 'resend', apiKey: e.RESEND_API_KEY, from: e.MAIL_FROM };
  }
  return null;
}

function parseEnv<T extends z.ZodType>(schema: T, env: Env): z.infer<T> {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`环境变量配置有误：\n${lines.join('\n')}`);
  }
  return parsed.data;
}

const toDbConfig = (e: z.infer<typeof DbEnvSchema>): DbConfig => ({
  poolMax: e.DB_POOL_MAX,
  prepare: e.DB_PREPARE,
  ssl: e.DB_SSL === 'require' || e.DB_SSL === 'verify-full' ? e.DB_SSL : false,
});

/** 只连数据库的命令（迁移、重置密码）用：不要求填 APP_SECRET 这些无关的配置。 */
export function loadDbConfig(env: Env = process.env): { databaseUrl: string; db: DbConfig } {
  const e = parseEnv(DbEnvSchema, env);
  return { databaseUrl: e.DATABASE_URL, db: toDbConfig(e) };
}

const MB = 1024 * 1024;

export function loadConfig(env: Env = process.env): Config {
  const e = parseEnv(EnvSchema, env);
  const hasStorage = e.S3_BUCKET && e.S3_ACCESS_KEY_ID && e.S3_SECRET_ACCESS_KEY;
  return {
    databaseUrl: e.DATABASE_URL,
    db: toDbConfig(e),
    appSecret: Buffer.from(e.APP_SECRET, 'base64').subarray(0, 32),
    port: e.PORT,
    allowSignup: e.ALLOW_SIGNUP,
    maxUploadBytes: e.MAX_UPLOAD_MB * MB,
    maxFileBytes: {
      image: e.MAX_IMAGE_MB * MB,
      video: e.MAX_VIDEO_MB * MB,
      audio: e.MAX_AUDIO_MB * MB,
      document: e.MAX_DOCUMENT_MB * MB,
    },
    familyQuotaBytes: e.FAMILY_QUOTA_MB > 0 ? e.FAMILY_QUOTA_MB * MB : null,
    familyRecordsBytes: e.FAMILY_RECORDS_MB > 0 ? e.FAMILY_RECORDS_MB * MB : null,
    mediaTrashDays: e.MEDIA_TRASH_DAYS,
    clientIp: { header: e.CLIENT_IP_HEADER.trim().toLowerCase(), position: e.CLIENT_IP_POSITION },
    limits: {
      syncPerWindow: e.RATE_SYNC_PER_10MIN,
      uploadUrlPerWindow: e.RATE_UPLOAD_URL_PER_HOUR,
      registerPerIpHour: e.RATE_REGISTER_PER_IP_HOUR,
      registerGlobalHour: e.RATE_REGISTER_GLOBAL_HOUR,
      sharePublicPerIp: e.RATE_PUBLIC_SHARE_PER_IP_15MIN,
      sharePublicPerToken: e.RATE_PUBLIC_SHARE_PER_TOKEN_HOUR,
      sharePublicMedia: MAX_PUBLIC_MEDIA,
    },
    serverStorage: hasStorage
      ? {
          endpoint: e.S3_ENDPOINT,
          publicEndpoint: e.S3_PUBLIC_ENDPOINT ?? e.S3_ENDPOINT,
          region: e.S3_REGION ?? 'auto',
          bucket: e.S3_BUCKET!,
          accessKeyId: e.S3_ACCESS_KEY_ID!,
          secretAccessKey: e.S3_SECRET_ACCESS_KEY!,
          forcePathStyle: e.S3_FORCE_PATH_STYLE,
        }
      : null,
    // 没写时：配了平台存储就是托管模式，普通用户不能填 S3 密钥；什么都没配的自建服务器只能让管理员自己填。
    allowCustomStorage:
      e.ALLOW_CUSTOM_STORAGE === undefined
        ? !hasStorage
        : e.ALLOW_CUSTOM_STORAGE === 'true' || e.ALLOW_CUSTOM_STORAGE === '1',
    bindUploadSize: e.S3_BIND_UPLOAD_SIZE,
    multipartEnabled: e.S3_MULTIPART_ENABLED,
    allowPrivateEndpoints: e.ALLOW_PRIVATE_STORAGE_ENDPOINTS,
    pushEnabled: e.PUSH_ENABLED,
    expoAccessToken: e.EXPO_ACCESS_TOKEN,
    mail: toMailConfig(e),
  };
}
