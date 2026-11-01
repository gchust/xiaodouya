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

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  APP_SECRET: z.string().refine((v) => Buffer.from(v, 'base64').length >= 32, {
    message: '必须是至少 32 字节的 base64，可用 openssl rand -base64 32 生成',
  }),
  PORT: z.coerce.number().int().default(8787),
  ALLOW_SIGNUP: bool(true),
  MAX_UPLOAD_MB: z.coerce.number().int().positive().default(4096),
  S3_ENDPOINT: optionalText,
  S3_PUBLIC_ENDPOINT: optionalText,
  S3_REGION: optionalText,
  S3_BUCKET: optionalText,
  S3_ACCESS_KEY_ID: optionalText,
  S3_SECRET_ACCESS_KEY: optionalText,
  S3_FORCE_PATH_STYLE: bool(false),
  ALLOW_CUSTOM_STORAGE: bool(true),
  ALLOW_PRIVATE_STORAGE_ENDPOINTS: bool(false),
  PUSH_ENABLED: bool(false),
  EXPO_ACCESS_TOKEN: optionalText,
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

export interface Config {
  databaseUrl: string;
  appSecret: Buffer;
  port: number;
  allowSignup: boolean;
  maxUploadBytes: number;
  serverStorage: ServerStorageEnv | null;
  allowCustomStorage: boolean;
  allowPrivateEndpoints: boolean;
  pushEnabled: boolean;
  expoAccessToken: string | undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`环境变量配置有误：\n${lines.join('\n')}`);
  }
  const e = parsed.data;
  const hasStorage = e.S3_BUCKET && e.S3_ACCESS_KEY_ID && e.S3_SECRET_ACCESS_KEY;
  return {
    databaseUrl: e.DATABASE_URL,
    appSecret: Buffer.from(e.APP_SECRET, 'base64').subarray(0, 32),
    port: e.PORT,
    allowSignup: e.ALLOW_SIGNUP,
    maxUploadBytes: e.MAX_UPLOAD_MB * 1024 * 1024,
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
    allowCustomStorage: e.ALLOW_CUSTOM_STORAGE,
    allowPrivateEndpoints: e.ALLOW_PRIVATE_STORAGE_ENDPOINTS,
    pushEnabled: e.PUSH_ENABLED,
    expoAccessToken: e.EXPO_ACCESS_TOKEN,
  };
}
