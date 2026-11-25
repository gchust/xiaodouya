import type { Db } from './db';
import { driveBlobs } from './drive';
import { runMaintenance } from './maintenance';
import { handle, type ProxyConfig } from './s3';

/**
 * Cloudflare Worker 入口。HTTP 请求走 S3 代理，定时任务做合并和清理。
 * 所有值都是 Worker 的 Secret 或变量（见 wrangler.toml 和 docs/DEPLOYMENT.md），仓库里不写任何账号信息。
 */
export interface Env {
  DB: Db;
  /** 服务端签名用的密钥，等于服务端的 S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY。 */
  PROXY_ACCESS_KEY_ID: string;
  PROXY_SECRET_ACCESS_KEY: string;
  PROXY_BUCKET: string;
  /** 存进 Drive 的前缀，默认 families/。其他前缀（releases/、backups/、feedback/）留在 R2。 */
  DRIVE_PREFIX?: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GOOGLE_REFRESH_TOKEN: string;
  DRIVE_ROOT_FOLDER_ID?: string;
  UPSTREAM_ENDPOINT?: string;
  UPSTREAM_BUCKET?: string;
  UPSTREAM_REGION?: string;
  UPSTREAM_ACCESS_KEY_ID?: string;
  UPSTREAM_SECRET_ACCESS_KEY?: string;
  /** 单个 PUT 或单片的上限（字节）。免费版域名的请求体上限是 100 MB。 */
  MAX_PUT_BYTES?: string;
}

const REQUIRED = [
  'PROXY_ACCESS_KEY_ID',
  'PROXY_SECRET_ACCESS_KEY',
  'PROXY_BUCKET',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_REFRESH_TOKEN',
] as const;

const UPSTREAM = [
  'UPSTREAM_ENDPOINT',
  'UPSTREAM_BUCKET',
  'UPSTREAM_ACCESS_KEY_ID',
  'UPSTREAM_SECRET_ACCESS_KEY',
] as const;

/** 缺了配置就整体拒绝，不悄悄降级：少了上游会让旧文件读不到，删除也只删一半。 */
export function configFromEnv(env: Env): ProxyConfig | { error: string } {
  const missing: string[] = REQUIRED.filter((name) => !env[name]);
  if (!env.DB) missing.push('DB');
  const upstreamSet = UPSTREAM.filter((name) => env[name]);
  if (upstreamSet.length > 0 && upstreamSet.length < UPSTREAM.length) {
    missing.push(...UPSTREAM.filter((name) => !env[name]));
  }
  if (missing.length > 0) return { error: `missing config: ${missing.join(', ')}` };
  const maxPut = Number(env.MAX_PUT_BYTES ?? 100 * 1000 * 1000);
  if (!Number.isInteger(maxPut) || maxPut <= 0) return { error: 'invalid MAX_PUT_BYTES' };
  const prefix = env.DRIVE_PREFIX ?? 'families/';
  if (!prefix.endsWith('/')) return { error: 'DRIVE_PREFIX must end with /' };
  return {
    bucket: env.PROXY_BUCKET,
    credentials: {
      accessKeyId: env.PROXY_ACCESS_KEY_ID,
      secretAccessKey: env.PROXY_SECRET_ACCESS_KEY,
    },
    drivePrefix: prefix,
    upstream:
      upstreamSet.length === UPSTREAM.length
        ? {
            endpoint: env.UPSTREAM_ENDPOINT!,
            bucket: env.UPSTREAM_BUCKET!,
            region: env.UPSTREAM_REGION ?? 'auto',
            credentials: {
              accessKeyId: env.UPSTREAM_ACCESS_KEY_ID!,
              secretAccessKey: env.UPSTREAM_SECRET_ACCESS_KEY!,
            },
          }
        : null,
    maxPutBytes: maxPut,
  };
}

/** Workers 的 fetch 只有拿到 FixedLengthStream 才会带 Content-Length 往外发，Drive 续传需要它。 */
function fixedLength(body: ReadableStream<Uint8Array>, size: number): ReadableStream<Uint8Array> {
  const fixed = new (
    globalThis as unknown as {
      FixedLengthStream: new (n: number) => TransformStream<Uint8Array, Uint8Array>;
    }
  ).FixedLengthStream(size);
  void body.pipeTo(fixed.writable).catch(() => {});
  return fixed.readable;
}

function deps(env: Env, config: ProxyConfig) {
  const blobs = driveBlobs(
    {
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      refreshToken: env.GOOGLE_REFRESH_TOKEN,
      rootFolderId: env.DRIVE_ROOT_FOLDER_ID || null,
    },
    { fetch: (input, init) => fetch(input, init), db: env.DB, fixedLength },
  );
  return {
    config,
    db: env.DB,
    blobs,
    fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
    fixedLength,
    now: Date.now,
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const config = configFromEnv(env);
    if ('error' in config) {
      console.error('drive-proxy', config.error);
      return new Response(null, { status: 503 });
    }
    return handle(request, deps(env, config));
  },

  async scheduled(_event: unknown, env: Env): Promise<void> {
    const config = configFromEnv(env);
    if ('error' in config) {
      console.error('drive-proxy', config.error);
      return;
    }
    const report = await runMaintenance(deps(env, config));
    // 只记计数，不记 id。
    console.log('drive-proxy maintenance', JSON.stringify(report));
  },
};
