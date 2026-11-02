import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
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

const statusOf = (error: unknown) =>
  (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;

/** 分片上传已经合并、中止，或者被存储的生命周期规则清掉了。不同存储的错误名不完全一样，都看状态码。 */
export function isNoSuchUpload(error: unknown): boolean {
  return (error as { name?: string }).name === 'NoSuchUpload' || statusOf(error) === 404;
}

/** 4xx 和 501 说明这个存储不接受分片上传（或者配置有问题，单个 PUT 也会照常报出来）。其余是暂时的。 */
export function multipartUnsupported(error: unknown): boolean {
  const status = statusOf(error);
  return status !== undefined && ((status >= 400 && status < 500) || status === 501);
}

export async function createMultipart(
  s: ResolvedStorage,
  key: string,
  mime: string,
): Promise<string> {
  const created = await client(s, s.endpoint).send(
    new CreateMultipartUploadCommand({ Bucket: s.bucket, Key: key, ContentType: mime }),
  );
  if (!created.UploadId) throw new Error('存储没有返回 UploadId');
  return created.UploadId;
}

/** 和 presignUpload 一样把大小签进去，这样一片传不了超过声明的大小。 */
export async function presignPart(
  s: ResolvedStorage,
  key: string,
  uploadId: string,
  partNumber: number,
  size: number,
  expiresIn: number,
  bindSize = true,
): Promise<string> {
  const part = { Bucket: s.bucket, Key: key, UploadId: uploadId, PartNumber: partNumber };
  if (!bindSize) {
    return getSignedUrl(client(s, s.publicEndpoint), new UploadPartCommand(part), { expiresIn });
  }
  return getSignedUrl(
    client(s, s.publicEndpoint),
    new UploadPartCommand({ ...part, ContentLength: size }),
    { expiresIn, signableHeaders: new Set(['content-length']) },
  );
}

export interface StoredPart {
  partNumber: number;
  size: number;
  etag: string;
}

/** 以存储为准：一页最多 1000 片，大文件要翻页。 */
export async function listMultipartParts(
  s: ResolvedStorage,
  key: string,
  uploadId: string,
): Promise<StoredPart[]> {
  const parts: StoredPart[] = [];
  let marker: string | undefined;
  for (;;) {
    const page = await client(s, s.endpoint).send(
      new ListPartsCommand({
        Bucket: s.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumberMarker: marker,
      }),
    );
    for (const part of page.Parts ?? []) {
      if (part.PartNumber === undefined || !part.ETag) continue;
      parts.push({ partNumber: part.PartNumber, size: part.Size ?? 0, etag: part.ETag });
    }
    if (!page.IsTruncated || !page.NextPartNumberMarker) return parts;
    marker = page.NextPartNumberMarker;
  }
}

export async function completeMultipart(
  s: ResolvedStorage,
  key: string,
  uploadId: string,
  parts: readonly StoredPart[],
): Promise<void> {
  await client(s, s.endpoint).send(
    new CompleteMultipartUploadCommand({
      Bucket: s.bucket,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: {
        Parts: [...parts]
          .sort((a, b) => a.partNumber - b.partNumber)
          .map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
      },
    }),
  );
}

/** 已经不在了也算成功：目的就是让它不在。 */
export async function abortMultipart(
  s: ResolvedStorage,
  key: string,
  uploadId: string,
): Promise<void> {
  try {
    await client(s, s.endpoint).send(
      new AbortMultipartUploadCommand({ Bucket: s.bucket, Key: key, UploadId: uploadId }),
    );
  } catch (error) {
    if (!isNoSuchUpload(error)) throw error;
  }
}

/**
 * 对真实存储走一遍手机会做的事：分片上传、列分片、完成、下载核对、清理，再确认中止后分片真的没了。
 * 开发用的 SeaweedFS 通过不代表 R2 也通过，所以上线前要跑一次（`cli check-multipart`）。
 * 不通过时设置 S3_MULTIPART_ENABLED=false，App 会退回单个 PUT。
 */
export async function checkMultipartUpload(
  s: ResolvedStorage,
  bindSize = true,
): Promise<{ ok: boolean; message: string }> {
  // 5 MiB 是 S3 和 R2 允许的最小片，除最后一片外不能更小。
  const partSize = 5 * 1024 * 1024;
  const last = 1234;
  const file = new Uint8Array(partSize + last);
  for (let i = 0; i < file.length; i += 1024) file[i] = i % 251;
  const key = `.xiaodouya-multipart-check-${crypto.randomUUID()}`;
  const abortKey = `${key}-abort`;
  const mime = 'application/octet-stream';
  const steps: string[] = [];
  const url = (uploadId: string, partNumber: number, size: number) =>
    presignPart(s, key, uploadId, partNumber, size, 300, bindSize);
  const put = async (target: string, body: Uint8Array<ArrayBuffer>) => {
    const response = await fetch(target, { method: 'PUT', body });
    await response.arrayBuffer();
    return response.status;
  };
  let uploadId: string | null = null;
  let abortId: string | null = null;
  try {
    uploadId = await createMultipart(s, key, mime);
    steps.push('开始');
    if (bindSize) {
      const wrong = await put(await url(uploadId, 1, partSize), file.subarray(0, partSize + 1));
      if (wrong < 400 || wrong >= 500) {
        return {
          ok: false,
          message: `声明 ${partSize} 字节的片多传 1 字节返回 ${wrong}，应该被拒绝`,
        };
      }
      steps.push(`多传 1 字节被拒绝（${wrong}）`);
    }
    for (const [partNumber, body] of [
      [1, file.subarray(0, partSize)],
      [2, file.subarray(partSize)],
    ] as const) {
      const status = await put(await url(uploadId, partNumber, body.length), body);
      if (status < 200 || status >= 300) {
        return { ok: false, message: `第 ${partNumber} 片上传返回 ${status}` };
      }
    }
    steps.push('传两片');
    const parts = await listMultipartParts(s, key, uploadId);
    if (parts.length !== 2 || parts[0]?.size !== partSize || parts[1]?.size !== last) {
      return {
        ok: false,
        message: `列分片结果不对：${parts.map((p) => `${p.partNumber}/${p.size}`).join(',')}`,
      };
    }
    steps.push('列分片');
    await completeMultipart(s, key, uploadId, parts);
    uploadId = null;
    steps.push('完成');
    const read = await client(s, s.endpoint).send(
      new GetObjectCommand({ Bucket: s.bucket, Key: key }),
    );
    const downloaded = await read.Body?.transformToByteArray();
    if (!downloaded || !sameBytes(downloaded, file)) {
      return { ok: false, message: '下载回来的内容和上传的不一致' };
    }
    steps.push('下载核对');

    abortId = await createMultipart(s, abortKey, mime);
    const abortUrl = await presignPart(s, abortKey, abortId, 1, partSize, 300, bindSize);
    const aborted = await put(abortUrl, file.subarray(0, partSize));
    if (aborted < 200 || aborted >= 300)
      return { ok: false, message: `中止前的上传返回 ${aborted}` };
    await abortMultipart(s, abortKey, abortId);
    const stillThere = await listMultipartParts(s, abortKey, abortId).then(
      () => true,
      (error: unknown) => {
        if (isNoSuchUpload(error)) return false;
        throw error;
      },
    );
    if (stillThere) return { ok: false, message: '中止后还能列出分片' };
    abortId = null;
    steps.push('中止');
    return { ok: true, message: `通过：${steps.join('、')}` };
  } finally {
    // 清理失败不盖掉真正的结果，生命周期规则是兜底。
    await Promise.allSettled([
      deleteObject(s, key),
      ...(uploadId ? [abortMultipart(s, key, uploadId)] : []),
      ...(abortId ? [abortMultipart(s, abortKey, abortId)] : []),
    ]);
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
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

/**
 * 一次签很多个文件。每次新建 S3Client 很贵，分享页一天可能有几百个链接，而 Edge Function 的 CPU 时间有限。
 */
export async function presignDownloads(
  s: ResolvedStorage,
  keys: readonly string[],
  expiresIn: number,
): Promise<string[]> {
  const shared = client(s, s.publicEndpoint);
  return Promise.all(
    keys.map((key) =>
      getSignedUrl(shared, new GetObjectCommand({ Bucket: s.bucket, Key: key }), { expiresIn }),
    ),
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
    return { ok: true, latencyMs: Date.now() - started, message: '读写正常', reason: 'ok' };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      message: describeStorageError(error),
      reason: storageErrorReason(error),
    };
  }
}

/** 新版 App 按原因显示当前语言的文字，见 shared 的 storageTestMessage。 */
export function storageErrorReason(
  error: unknown,
): 'noBucket' | 'badKey' | 'unreachable' | 'unknown' {
  const e = error as { name?: string; $metadata?: { httpStatusCode?: number }; code?: string };
  const status = e.$metadata?.httpStatusCode;
  if (e.name === 'NoSuchBucket' || status === 404) return 'noBucket';
  if (status === 401 || status === 403 || e.name === 'SignatureDoesNotMatch') return 'badKey';
  if (e.code === 'ENOTFOUND' || e.code === 'ECONNREFUSED' || e.code === 'ETIMEDOUT') {
    return 'unreachable';
  }
  return 'unknown';
}

export function describeStorageError(error: unknown): string {
  switch (storageErrorReason(error)) {
    case 'noBucket':
      return '找不到这个 Bucket，请检查名称和区域';
    case 'badKey':
      return '密钥不正确，或没有这个 Bucket 的读写权限';
    case 'unreachable':
      return '连接不上存储地址，请检查 Endpoint 或 Account ID';
    default:
      return '连接失败，请检查配置是否填写完整';
  }
}
