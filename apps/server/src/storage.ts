import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { StorageConfigInput, StorageProvider, StorageTestResult } from '@xiaodouya/shared';
import type { Config } from './config';
import { decryptSecret } from './crypto';
import type { Sql } from './db';

export interface ResolvedStorage {
  /** null 表示服务端环境变量里的默认存储。 */
  configId: string | null;
  /** 服务端自己访问用的地址（可以是容器内部地址）。 */
  endpoint: string | undefined;
  /** 手机访问用的地址。SigV4 签名包含 Host，所以预签名必须用这个地址。 */
  publicEndpoint: string | undefined;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  publicBaseUrl: string | null;
}

export interface StorageRow {
  id: string;
  provider: string;
  account_id: string | null;
  endpoint: string | null;
  region: string | null;
  bucket: string;
  access_key_id: string;
  secret_encrypted: string;
  public_base_url: string | null;
}

export function endpointForProvider(
  provider: StorageProvider,
  input: { accountId?: string | null; endpoint?: string | null },
): string | undefined {
  if (provider === 'r2') {
    return input.accountId ? `https://${input.accountId}.r2.cloudflarestorage.com` : undefined;
  }
  if (provider === 'other') return input.endpoint ?? undefined;
  return undefined;
}

export function regionForProvider(provider: StorageProvider, region?: string | null): string {
  if (provider === 'r2') return 'auto';
  return region || (provider === 's3' ? 'ap-southeast-1' : 'auto');
}

function fromRow(row: StorageRow, key: Buffer): ResolvedStorage {
  const provider = row.provider as StorageProvider;
  const endpoint = endpointForProvider(provider, {
    accountId: row.account_id,
    endpoint: row.endpoint,
  });
  return {
    configId: row.id,
    endpoint,
    publicEndpoint: endpoint,
    region: regionForProvider(provider, row.region),
    bucket: row.bucket,
    accessKeyId: row.access_key_id,
    secretAccessKey: decryptSecret(row.secret_encrypted, key),
    // AWS 用虚拟主机风格；R2 和大多数兼容存储用路径风格最稳妥。
    forcePathStyle: provider !== 's3',
    publicBaseUrl: row.public_base_url,
  };
}

function fromEnv(config: Config): ResolvedStorage | null {
  const s = config.serverStorage;
  if (!s) return null;
  return {
    configId: null,
    endpoint: s.endpoint,
    publicEndpoint: s.publicEndpoint,
    region: s.region,
    bucket: s.bucket,
    accessKeyId: s.accessKeyId,
    secretAccessKey: s.secretAccessKey,
    forcePathStyle: s.forcePathStyle,
    publicBaseUrl: null,
  };
}

/** 待删除队列里记下的存储配置。null 表示服务端默认存储。 */
export function storageFromSnapshot(
  snapshot: StorageRow | null,
  config: Config,
): ResolvedStorage | null {
  return snapshot ? fromRow(snapshot, config.appSecret) : fromEnv(config);
}

export async function activeStorage(
  sql: Sql,
  config: Config,
  familyId: string,
): Promise<ResolvedStorage | null> {
  const [row] = await sql<StorageRow[]>`
    SELECT * FROM storage_configs WHERE family_id = ${familyId} AND active`;
  return row ? fromRow(row, config.appSecret) : fromEnv(config);
}

export async function storageById(
  sql: Sql,
  config: Config,
  familyId: string,
  configId: string | null,
): Promise<ResolvedStorage | null> {
  if (!configId) return fromEnv(config);
  const [row] = await sql<StorageRow[]>`
    SELECT * FROM storage_configs WHERE family_id = ${familyId} AND id = ${configId}`;
  return row ? fromRow(row, config.appSecret) : null;
}

function client(s: ResolvedStorage, endpoint: string | undefined): S3Client {
  return new S3Client({
    region: s.region,
    endpoint,
    forcePathStyle: s.forcePathStyle,
    credentials: { accessKeyId: s.accessKeyId, secretAccessKey: s.secretAccessKey },
    // 新版 SDK 默认附加校验和，部分 S3 兼容存储和预签名直传都不接受。
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    maxAttempts: 2,
  });
}

/**
 * 把声明的大小签进链接。否则拿到链接的人可以传任意大小，还能在 complete 校验之后用同一个链接覆盖成大文件，
 * 配额和大小限制都形同虚设。complete 时的 HEAD 校验仍然保留，它才是最终依据。
 */
export async function presignUpload(
  s: ResolvedStorage,
  key: string,
  mime: string,
  size: number,
  expiresIn: number,
  bindSize = true,
): Promise<string> {
  if (!bindSize) {
    return getSignedUrl(
      client(s, s.publicEndpoint),
      new PutObjectCommand({ Bucket: s.bucket, Key: key, ContentType: mime }),
      { expiresIn },
    );
  }
  return getSignedUrl(
    client(s, s.publicEndpoint),
    new PutObjectCommand({ Bucket: s.bucket, Key: key, ContentType: mime, ContentLength: size }),
    { expiresIn, signableHeaders: new Set(['content-length']) },
  );
}

/**
 * 确认这个存储真的按签名校验大小：错的大小被拒绝，对的大小能传上去。
 * 上线前对真实存储跑一次（`cli check-upload-size`）。开发用的 SeaweedFS 通过不代表 R2 也通过，
 * 而这一步要是不支持，所有上传都会失败。
 */
export async function checkUploadSizeBinding(
  s: ResolvedStorage,
): Promise<{ ok: boolean; message: string }> {
  const key = `.xiaodouya-size-check-${crypto.randomUUID()}`;
  const mime = 'application/octet-stream';
  const url = await presignUpload(s, key, mime, 16, 300);
  const put = async (size: number) =>
    (
      await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': mime },
        body: new Uint8Array(size),
      })
    ).status;
  try {
    const wrong = await put(17);
    const right = await put(16);
    const ok = wrong >= 400 && wrong < 500 && right >= 200 && right < 300;
    return {
      ok,
      message: `声明 16 字节：传 17 字节返回 ${wrong}，传 16 字节返回 ${right}`,
    };
  } finally {
    await deleteObject(s, key);
  }
}

export async function presignDownload(
  s: ResolvedStorage,
  key: string,
  expiresIn: number,
): Promise<string> {
  return getSignedUrl(
    client(s, s.publicEndpoint),
    new GetObjectCommand({ Bucket: s.bucket, Key: key }),
    { expiresIn },
  );
}

export async function headObject(
  s: ResolvedStorage,
  key: string,
): Promise<{ size: number } | null> {
  try {
    const r = await client(s, s.endpoint).send(
      new HeadObjectCommand({ Bucket: s.bucket, Key: key }),
    );
    return { size: r.ContentLength ?? 0 };
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status === 404) return null;
    throw error;
  }
}

export async function deleteObject(s: ResolvedStorage, key: string): Promise<void> {
  await client(s, s.endpoint).send(new DeleteObjectCommand({ Bucket: s.bucket, Key: key }));
}

/** 用 BlockList 而不是字符串判断：IPv6 的写法很多（比如 ::ffff:7f00:1 就是 127.0.0.1）。 */
const blockedAddresses = (() => {
  const list = new BlockList();
  for (const [net, prefix] of [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['224.0.0.0', 3],
  ] as const) {
    list.addSubnet(net, prefix, 'ipv4');
  }
  for (const [net, prefix] of [
    ['::', 96], // 未指定、回环、IPv4 兼容地址
    ['64:ff9b::', 96], // NAT64，内嵌 IPv4
    ['2002::', 16], // 6to4，内嵌 IPv4
    ['fc00::', 7], // 唯一本地
    ['fe80::', 10], // 链路本地
    ['ff00::', 8], // 组播
  ] as const) {
    list.addSubnet(net, prefix, 'ipv6');
  }
  return list;
})();

export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true;
  // IPv4 映射地址（::ffff:a.b.c.d）由 BlockList 按 IPv4 规则检查。
  return blockedAddresses.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

/**
 * 存储地址由用户填写，服务端会去连接它。不校验的话，任何家庭管理员都能用“测试连接”
 * 探测服务器内网（SSRF）。自建内网 MinIO 时用 ALLOW_PRIVATE_STORAGE_ENDPOINTS 放开。
 */
export async function assertEndpointAllowed(endpoint: string, config: Config): Promise<void> {
  if (config.allowPrivateEndpoints) return;
  const url = new URL(endpoint);
  if (url.protocol !== 'https:') throw new Error('存储地址必须使用 https');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((r) => r.address);
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new Error('不能使用内网地址作为存储地址');
  }
}

export function resolvedFromInput(
  input: StorageConfigInput,
  secretAccessKey: string,
): ResolvedStorage {
  const endpoint = endpointForProvider(input.provider, input);
  return {
    configId: null,
    endpoint,
    publicEndpoint: endpoint,
    region: regionForProvider(input.provider, input.region),
    bucket: input.bucket,
    accessKeyId: input.accessKeyId,
    secretAccessKey,
    forcePathStyle: input.provider !== 's3',
    publicBaseUrl: input.publicBaseUrl ?? null,
  };
}

/** 真实地写入、读回、删除一个小文件，只要有一步失败就算不通过。 */
export async function testStorage(s: ResolvedStorage): Promise<StorageTestResult> {
  const started = Date.now();
  const key = `.xiaodouya-connection-test-${crypto.randomUUID()}`;
  const body = 'xiaodouya';
  const c = client(s, s.endpoint);
  try {
    await c.send(
      new PutObjectCommand({ Bucket: s.bucket, Key: key, Body: body, ContentType: 'text/plain' }),
    );
    const read = await c.send(new GetObjectCommand({ Bucket: s.bucket, Key: key }));
    const text = await read.Body?.transformToString();
    await c.send(new DeleteObjectCommand({ Bucket: s.bucket, Key: key }));
    if (text !== body) throw new Error('读回的内容不一致');
    return { ok: true, latencyMs: Date.now() - started, message: '读写正常' };
  } catch (error) {
    return { ok: false, latencyMs: Date.now() - started, message: describeStorageError(error) };
  }
}

export function describeStorageError(error: unknown): string {
  const e = error as { name?: string; $metadata?: { httpStatusCode?: number }; code?: string };
  const status = e.$metadata?.httpStatusCode;
  if (e.name === 'NoSuchBucket' || status === 404) return '找不到这个 Bucket，请检查名称和区域';
  if (status === 401 || status === 403 || e.name === 'SignatureDoesNotMatch') {
    return '密钥不正确，或没有这个 Bucket 的读写权限';
  }
  if (e.code === 'ENOTFOUND' || e.code === 'ECONNREFUSED' || e.code === 'ETIMEDOUT') {
    return '连接不上存储地址，请检查 Endpoint 或 Account ID';
  }
  return '连接失败，请检查配置是否填写完整';
}
