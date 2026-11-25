import { BlobNotFound, type BlobStore, SESSION_ALIGN } from './blobs';
import type { Db } from './db';
import { countedStream, LengthMismatch } from './fixed';
import {
  type Credentials,
  sha256Hex,
  signRequest,
  UNSIGNED_PAYLOAD,
  uriEncode,
  verifyRequest,
} from './sigv4';
import { escapeXml, parseCompleteParts, s3Error, xmlResponse } from './xml';

/**
 * 一个只实现小豆芽用到的那部分 S3 接口的代理。
 *
 * `drivePrefix` 下的对象（家庭文件）存进 BlobStore（Google Drive），其他对象（APK 发布、备份、反馈附件、
 * 存储检查）原样转发给上游（R2）。`drivePrefix` 下元数据里没有的对象也去上游读：切换之前传的旧文件还在 R2。
 */
export interface ProxyConfig {
  /** 服务端配置里的 S3_BUCKET。只接受路径风格（S3_FORCE_PATH_STYLE=true）。 */
  bucket: string;
  /** 服务端用来签名的密钥。 */
  credentials: Credentials;
  drivePrefix: string;
  upstream: {
    endpoint: string;
    bucket: string;
    region: string;
    credentials: Credentials;
  } | null;
  /** 单个 PUT 或单片的上限。S3 是 5 GiB。 */
  maxPutBytes: number;
}

export interface Deps {
  config: ProxyConfig;
  db: Db;
  blobs: BlobStore;
  fetch: typeof fetch;
  /** 把正文包成正好 `size` 字节的流：多了少了都报错。Workers 用 FixedLengthStream。 */
  fixedLength(body: ReadableStream<Uint8Array>, size: number): ReadableStream<Uint8Array>;
  now(): number;
}

/** S3 要求除最后一片外每片至少 5 MiB。 */
const MIN_PART_BYTES = 5 * 1024 * 1024;
/** 正文要算哈希时最多读进内存多少（只有服务端自己写的小文件会这样签）。 */
const MAX_HASHED_BODY = 64 * 1024 * 1024;
/** 不再被引用的块一天后才删：同时在下载的请求可能还在读。 */
export const ORPHAN_DELAY_MS = 24 * 3600 * 1000;

const NOT_IMPLEMENTED = () => s3Error(501, 'NotImplemented', 'Not supported by this proxy');

export async function handle(request: Request, deps: Deps): Promise<Response> {
  const response = await route(request, deps);
  // 出错时没读的正文要丢掉，否则客户端还在等着把它发完，连接一直挂着。
  if (response.status >= 400 && request.body && !request.bodyUsed) {
    await request.body.cancel().catch(() => {});
  }
  return response;
}

async function route(request: Request, deps: Deps): Promise<Response> {
  const url = new URL(request.url);
  const segments = url.pathname.split('/');
  // segments[0] 是开头的空串。
  const bucket = decode(segments[1] ?? '');
  const key = segments.slice(2).map(decode).join('/');
  if (bucket === null || key === null) return s3Error(400, 'InvalidURI', 'Invalid path');

  const auth = await verifyRequest(request, deps.config.credentials, deps.now() / 1000);
  if (!auth.ok) return s3Error(403, auth.code, auth.message);
  if (bucket !== deps.config.bucket) return s3Error(404, 'NoSuchBucket', 'No such bucket');

  if (!key?.startsWith(deps.config.drivePrefix)) return forward(request, key, deps);
  if (auth.payloadHash.startsWith('STREAMING-')) return NOT_IMPLEMENTED();

  const q = url.searchParams;
  const uploadId = q.get('uploadId');
  try {
    switch (request.method) {
      case 'PUT':
        if (request.headers.has('x-amz-copy-source')) return NOT_IMPLEMENTED();
        if (uploadId !== null)
          return await uploadPart(request, key, uploadId, auth.payloadHash, deps);
        return await putObject(request, key, auth.payloadHash, deps);
      case 'POST':
        if (q.has('uploads')) return await createUpload(request, key, deps);
        if (uploadId !== null) return await completeUpload(request, key, uploadId, deps);
        return NOT_IMPLEMENTED();
      case 'GET':
      case 'HEAD':
        if (uploadId !== null) return await listParts(key, uploadId, q, deps);
        return await getObject(request, key, deps);
      case 'DELETE':
        if (uploadId !== null) return await abortUpload(key, uploadId, deps);
        return await deleteObject(request, key, deps);
      default:
        return s3Error(405, 'MethodNotAllowed', 'Method not allowed');
    }
  } catch (error) {
    if (error instanceof BodyError) return s3Error(400, error.code, error.message);
    // 不把内部错误（可能带 Drive 的地址）返回给客户端。
    console.error('drive-proxy error', error instanceof Error ? error.name : 'unknown');
    return s3Error(500, 'InternalError', 'We encountered an internal error. Please try again.');
  }
}

function decode(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

class BodyError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * 校验正文并交给块存储。content-length 签进去时（上传链接绑定了大小），它已经被签名保护，
 * 这里再保证收到的字节数和它一样。
 */
async function storeBody(
  request: Request,
  payloadHash: string,
  deps: Deps,
): Promise<{ blobId: string; size: number }> {
  const lengthHeader = request.headers.get('content-length');
  if (lengthHeader === null || !/^\d+$/.test(lengthHeader)) {
    throw new BodyError('MissingContentLength', 'You must provide the Content-Length HTTP header.');
  }
  const size = Number(lengthHeader);
  if (size > deps.config.maxPutBytes) {
    throw new BodyError('EntityTooLarge', 'Your proposed upload exceeds the maximum allowed size');
  }
  let body: ReadableStream<Uint8Array> = request.body ?? new Response(new Uint8Array()).body!;
  if (payloadHash !== UNSIGNED_PAYLOAD) {
    if (!/^[0-9a-f]{64}$/.test(payloadHash) || size > MAX_HASHED_BODY) {
      throw new BodyError('InvalidRequest', 'Unsupported x-amz-content-sha256');
    }
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.length !== size) {
      throw new BodyError('IncompleteBody', 'Body length does not match Content-Length');
    }
    if ((await sha256Hex(bytes)) !== payloadHash) {
      throw new BodyError(
        'XAmzContentSHA256Mismatch',
        'The provided x-amz-content-sha256 does not match',
      );
    }
    body = new Response(bytes).body!;
  }
  let mismatch = false;
  const counted = countedStream(body, size, () => {
    mismatch = true;
  });
  try {
    const blobId = await deps.blobs.put(deps.fixedLength(counted, size), size);
    return { blobId, size };
  } catch (error) {
    if (mismatch || error instanceof LengthMismatch) {
      throw new BodyError('IncompleteBody', 'Body length does not match Content-Length');
    }
    throw error;
  }
}

async function putObject(request: Request, key: string, payloadHash: string, deps: Deps) {
  const { blobId, size } = await storeBody(request, payloadHash, deps);
  const etag = `"${randomHex(16)}"`;
  const contentType = request.headers.get('content-type') ?? 'binary/octet-stream';
  const now = deps.now();
  const { db } = deps;
  await db.batch([
    ...orphanObjectChunks(db, key, now),
    db
      .prepare(
        'INSERT OR REPLACE INTO objects (key, size, content_type, etag, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .bind(key, size, contentType, etag, now),
    db
      .prepare('INSERT INTO chunks (key, idx, blob_id, size) VALUES (?, 0, ?, ?)')
      .bind(key, blobId, size),
  ]);
  return new Response(null, { status: 200, headers: { etag } });
}

/** 把对象现有的块转进待删除，并删掉对象。放在同一批语句里，和写新内容是一个事务。 */
function orphanObjectChunks(db: Db, key: string, now: number) {
  return [
    db
      .prepare(
        'INSERT OR IGNORE INTO orphans (blob_id, delete_after) SELECT blob_id, ? FROM chunks WHERE key = ?',
      )
      .bind(now + ORPHAN_DELAY_MS, key),
    db.prepare('DELETE FROM chunks WHERE key = ?').bind(key),
    db.prepare('DELETE FROM objects WHERE key = ?').bind(key),
    db.prepare('DELETE FROM compactions WHERE key = ?').bind(key),
  ];
}

interface UploadRow {
  upload_id: string;
  key: string;
  content_type: string;
}

async function findUpload(key: string, uploadId: string, deps: Deps): Promise<UploadRow | null> {
  const row = await deps.db
    .prepare('SELECT upload_id, key, content_type FROM uploads WHERE upload_id = ?')
    .bind(uploadId)
    .first<UploadRow>();
  return row && row.key === key ? row : null;
}

const noSuchUpload = () =>
  s3Error(
    404,
    'NoSuchUpload',
    'The specified upload does not exist. The upload ID may be invalid, or the upload may have been aborted or completed.',
  );

async function createUpload(request: Request, key: string, deps: Deps) {
  const uploadId = randomHex(24);
  const contentType = request.headers.get('content-type') ?? 'binary/octet-stream';
  await deps.db
    .prepare('INSERT INTO uploads (upload_id, key, content_type, created_at) VALUES (?, ?, ?, ?)')
    .bind(uploadId, key, contentType, deps.now())
    .run();
  return xmlResponse(
    200,
    `<InitiateMultipartUploadResult><Bucket>${escapeXml(deps.config.bucket)}</Bucket><Key>${escapeXml(key)}</Key><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`,
  );
}

async function uploadPart(
  request: Request,
  key: string,
  uploadId: string,
  payloadHash: string,
  deps: Deps,
) {
  const partNumber = Number(new URL(request.url).searchParams.get('partNumber'));
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000) {
    return s3Error(400, 'InvalidArgument', 'Part number must be an integer between 1 and 10000');
  }
  if (!(await findUpload(key, uploadId, deps))) return noSuchUpload();
  const { blobId, size } = await storeBody(request, payloadHash, deps);
  const etag = `"${randomHex(16)}"`;
  const now = deps.now();
  const { db } = deps;
  // 只在上传还在时写入：传这一片的时候上传可能被中止或完成了。
  await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO orphans (blob_id, delete_after)
         SELECT blob_id, ? FROM parts WHERE upload_id = ? AND part_number = ?
           AND EXISTS (SELECT 1 FROM uploads WHERE upload_id = ?)`,
      )
      .bind(now + ORPHAN_DELAY_MS, uploadId, partNumber, uploadId),
    db
      .prepare(
        `INSERT OR REPLACE INTO parts (upload_id, part_number, blob_id, size, etag, created_at)
         SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM uploads WHERE upload_id = ?)`,
      )
      .bind(uploadId, partNumber, blobId, size, etag, now, uploadId),
  ]);
  const stored = await db
    .prepare('SELECT blob_id FROM parts WHERE upload_id = ? AND part_number = ?')
    .bind(uploadId, partNumber)
    .first<{ blob_id: string }>();
  if (stored?.blob_id !== blobId) {
    await orphan(db, [blobId], now);
    return noSuchUpload();
  }
  return new Response(null, { status: 200, headers: { etag } });
}

async function orphan(db: Db, blobIds: string[], now: number) {
  if (blobIds.length === 0) return;
  await db.batch(
    blobIds.map((id) =>
      db
        .prepare('INSERT OR IGNORE INTO orphans (blob_id, delete_after) VALUES (?, ?)')
        .bind(id, now + ORPHAN_DELAY_MS),
    ),
  );
}

interface PartRow {
  part_number: number;
  blob_id: string;
  size: number;
  etag: string;
  created_at: number;
}

async function loadParts(uploadId: string, deps: Deps): Promise<PartRow[]> {
  const { results } = await deps.db
    .prepare(
      'SELECT part_number, blob_id, size, etag, created_at FROM parts WHERE upload_id = ? ORDER BY part_number',
    )
    .bind(uploadId)
    .all<PartRow>();
  return results;
}

async function listParts(key: string, uploadId: string, q: URLSearchParams, deps: Deps) {
  if (!(await findUpload(key, uploadId, deps))) return noSuchUpload();
  const marker = Number(q.get('part-number-marker') ?? 0) || 0;
  const maxParts = Math.min(1000, Math.max(1, Number(q.get('max-parts') ?? 1000) || 1000));
  const all = (await loadParts(uploadId, deps)).filter((p) => p.part_number > marker);
  const page = all.slice(0, maxParts);
  const truncated = all.length > page.length;
  const last = page.at(-1)?.part_number ?? marker;
  const parts = page
    .map(
      (p) =>
        `<Part><PartNumber>${p.part_number}</PartNumber><LastModified>${new Date(p.created_at).toISOString()}</LastModified><ETag>${escapeXml(p.etag)}</ETag><Size>${p.size}</Size></Part>`,
    )
    .join('');
  return xmlResponse(
    200,
    `<ListPartsResult><Bucket>${escapeXml(deps.config.bucket)}</Bucket><Key>${escapeXml(key)}</Key><UploadId>${uploadId}</UploadId><PartNumberMarker>${marker}</PartNumberMarker><NextPartNumberMarker>${last}</NextPartNumberMarker><MaxParts>${maxParts}</MaxParts><IsTruncated>${truncated}</IsTruncated>${parts}</ListPartsResult>`,
  );
}

async function completeUpload(request: Request, key: string, uploadId: string, deps: Deps) {
  const upload = await findUpload(key, uploadId, deps);
  if (!upload) return noSuchUpload();
  const requested = parseCompleteParts(await request.text());
  if (!requested || requested.length === 0) {
    return s3Error(400, 'MalformedXML', 'The XML you provided was not well-formed');
  }
  const stored = new Map((await loadParts(uploadId, deps)).map((p) => [p.part_number, p]));
  const chosen: PartRow[] = [];
  let previous = 0;
  for (const r of requested) {
    if (r.partNumber <= previous) {
      return s3Error(400, 'InvalidPartOrder', 'The list of parts was not in ascending order.');
    }
    previous = r.partNumber;
    const part = stored.get(r.partNumber);
    if (!part || part.etag !== r.etag) {
      return s3Error(400, 'InvalidPart', 'One or more of the specified parts could not be found.');
    }
    chosen.push(part);
  }
  if (chosen.slice(0, -1).some((p) => p.size < MIN_PART_BYTES)) {
    return s3Error(
      400,
      'EntityTooSmall',
      'Your proposed upload is smaller than the minimum allowed size',
    );
  }
  const size = chosen.reduce((sum, p) => sum + p.size, 0);
  const etag = `"${randomHex(16)}-${chosen.length}"`;
  const now = deps.now();
  const chosenIds = new Set(chosen.map((p) => p.blob_id));
  const unused = [...stored.values()]
    .filter((p) => !chosenIds.has(p.blob_id))
    .map((p) => p.blob_id);
  const { db } = deps;
  await db.batch([
    ...orphanObjectChunks(db, key, now),
    db
      .prepare(
        'INSERT INTO objects (key, size, content_type, etag, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .bind(key, size, upload.content_type, etag, now),
    ...chosen.map((p, idx) =>
      db
        .prepare('INSERT INTO chunks (key, idx, blob_id, size) VALUES (?, ?, ?, ?)')
        .bind(key, idx, p.blob_id, p.size),
    ),
    ...unused.map((id) =>
      db
        .prepare('INSERT OR IGNORE INTO orphans (blob_id, delete_after) VALUES (?, ?)')
        .bind(id, now + ORPHAN_DELAY_MS),
    ),
    db.prepare('DELETE FROM parts WHERE upload_id = ?').bind(uploadId),
    db.prepare('DELETE FROM uploads WHERE upload_id = ?').bind(uploadId),
    ...(chosen.length > 1 && compactable(chosen.map((p) => p.size))
      ? [
          db
            .prepare(
              'INSERT INTO compactions (key, etag, session, updated_at) VALUES (?, ?, NULL, ?)',
            )
            .bind(key, etag, now),
        ]
      : []),
  ]);
  return xmlResponse(
    200,
    `<CompleteMultipartUploadResult><Bucket>${escapeXml(deps.config.bucket)}</Bucket><Key>${escapeXml(key)}</Key><ETag>${escapeXml(etag)}</ETag></CompleteMultipartUploadResult>`,
  );
}

/** Drive 续传要求除最后一段外都是 256 KiB 的整数倍。App 的片是 8 MiB，只有超过 80 GB 的文件才会不满足。 */
export function compactable(sizes: number[]): boolean {
  return sizes.slice(0, -1).every((s) => s % SESSION_ALIGN === 0);
}

async function abortUpload(key: string, uploadId: string, deps: Deps) {
  if (!(await findUpload(key, uploadId, deps))) return noSuchUpload();
  const now = deps.now();
  const { db } = deps;
  await db.batch([
    db
      .prepare(
        'INSERT OR IGNORE INTO orphans (blob_id, delete_after) SELECT blob_id, ? FROM parts WHERE upload_id = ?',
      )
      .bind(now + ORPHAN_DELAY_MS, uploadId),
    db.prepare('DELETE FROM parts WHERE upload_id = ?').bind(uploadId),
    db.prepare('DELETE FROM uploads WHERE upload_id = ?').bind(uploadId),
  ]);
  return new Response(null, { status: 204 });
}

interface ObjectRow {
  size: number;
  content_type: string;
  etag: string;
  created_at: number;
}

interface ChunkRow {
  blob_id: string;
  size: number;
}

/** 解析单段 Range。返回 null 表示没有或者不是 bytes 范围（照 S3 的做法当成整个文件）。 */
export function parseRange(
  header: string | null,
  size: number,
): { start: number; end: number } | null | 'unsatisfiable' {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  if (m[1] === '') {
    const suffix = Number(m[2]);
    if (suffix === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (start >= size || end < start) return 'unsatisfiable';
  return { start, end };
}

/** 预签名下载可以覆盖的响应头，和 S3 一样。 */
const RESPONSE_OVERRIDES: [string, string][] = [
  ['response-content-type', 'content-type'],
  ['response-content-disposition', 'content-disposition'],
  ['response-cache-control', 'cache-control'],
  ['response-content-language', 'content-language'],
  ['response-content-encoding', 'content-encoding'],
  ['response-expires', 'expires'],
];

async function getObject(request: Request, key: string, deps: Deps): Promise<Response> {
  const object = await deps.db
    .prepare('SELECT size, content_type, etag, created_at FROM objects WHERE key = ?')
    .bind(key)
    .first<ObjectRow>();
  if (!object) {
    if (deps.config.upstream) return forward(request, key, deps);
    return request.method === 'HEAD'
      ? new Response(null, { status: 404 })
      : s3Error(404, 'NoSuchKey', 'The specified key does not exist.');
  }
  const headers = new Headers({
    'content-type': object.content_type,
    etag: object.etag,
    'last-modified': new Date(object.created_at).toUTCString(),
    'accept-ranges': 'bytes',
  });
  const q = new URL(request.url).searchParams;
  for (const [param, header] of RESPONSE_OVERRIDES) {
    const value = q.get(param);
    if (value !== null) headers.set(header, value);
  }
  const range = parseRange(request.headers.get('range'), object.size);
  if (range === 'unsatisfiable') {
    return s3Error(416, 'InvalidRange', 'The requested range is not satisfiable', {
      'content-range': `bytes */${object.size}`,
    });
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? object.size - 1;
  const length = object.size === 0 ? 0 : end - start + 1;
  headers.set('content-length', String(length));
  if (range) headers.set('content-range', `bytes ${start}-${end}/${object.size}`);
  const status = range ? 206 : 200;
  if (request.method === 'HEAD' || length === 0) return new Response(null, { status, headers });

  const { results: chunks } = await deps.db
    .prepare('SELECT blob_id, size FROM chunks WHERE key = ? ORDER BY idx')
    .bind(key)
    .all<ChunkRow>();
  const pieces = slicePieces(chunks, start, end);
  // 第一块先打开再返回响应头：块丢了要能返回 500，而不是一个截断的 200。
  const blobs = deps.blobs;
  let first: ReadableStream<Uint8Array>;
  try {
    const p = pieces[0]!;
    first = await blobs.get(p.blobId, p.start, p.end);
  } catch (error) {
    if (error instanceof BlobNotFound) {
      console.error('drive-proxy missing blob');
      return s3Error(500, 'InternalError', 'Stored data is missing');
    }
    throw error;
  }
  const body = concatStreams(first, pieces.slice(1), (p) => blobs.get(p.blobId, p.start, p.end));
  return new Response(body, { status, headers });
}

export interface Piece {
  blobId: string;
  start: number;
  end: number;
}

/** 把对象里的 [start, end] 换算成每一块里的范围。 */
export function slicePieces(chunks: ChunkRow[], start: number, end: number): Piece[] {
  const pieces: Piece[] = [];
  let offset = 0;
  for (const chunk of chunks) {
    const chunkEnd = offset + chunk.size - 1;
    if (chunk.size > 0 && chunkEnd >= start && offset <= end) {
      pieces.push({
        blobId: chunk.blob_id,
        start: Math.max(start, offset) - offset,
        end: Math.min(end, chunkEnd) - offset,
      });
    }
    offset += chunk.size;
  }
  return pieces;
}

/** 一块读完再开下一块：同时只连一个 Drive 文件，也不把整个文件读进内存。 */
function concatStreams<T>(
  first: ReadableStream<Uint8Array>,
  rest: T[],
  open: (item: T) => Promise<ReadableStream<Uint8Array>>,
): ReadableStream<Uint8Array> {
  let reader = first.getReader();
  let index = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        const { done, value } = await reader.read();
        if (!done) {
          controller.enqueue(value);
          return;
        }
        if (index >= rest.length) {
          controller.close();
          return;
        }
        reader = (await open(rest[index++]!)).getReader();
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

async function deleteObject(request: Request, key: string, deps: Deps): Promise<Response> {
  const now = deps.now();
  await deps.db.batch(orphanObjectChunks(deps.db, key, now));
  // 切换前的旧文件在上游。不管这边有没有，都在上游删一次，删除不能只删一半。
  if (deps.config.upstream) {
    const upstream = await forward(request, key, deps);
    if (upstream.status >= 300 && upstream.status !== 404) return upstream;
    await upstream.body?.cancel();
  }
  return new Response(null, { status: 204 });
}

/** 转发时去掉的 query 参数：原来的签名，上游要用自己的密钥重签。 */
const AUTH_PARAMS = new Set([
  'X-Amz-Algorithm',
  'X-Amz-Credential',
  'X-Amz-Date',
  'X-Amz-Expires',
  'X-Amz-SignedHeaders',
  'X-Amz-Signature',
  'X-Amz-Security-Token',
  'X-Amz-Content-Sha256',
]);

/** 转发给上游的请求头，其余（包括 authorization、cookie）都不带。 */
const FORWARD_HEADERS = [
  'content-type',
  'content-length',
  'content-md5',
  'content-disposition',
  'content-encoding',
  'cache-control',
  'range',
  'if-match',
  'if-none-match',
  'if-modified-since',
  'if-unmodified-since',
];

const RESPONSE_HEADERS = [
  'content-type',
  'content-length',
  'content-range',
  'content-disposition',
  'content-encoding',
  'cache-control',
  'etag',
  'last-modified',
  'accept-ranges',
  'expires',
];

async function forward(request: Request, key: string, deps: Deps): Promise<Response> {
  const upstream = deps.config.upstream;
  if (!upstream) return NOT_IMPLEMENTED();
  const source = new URL(request.url);
  const target = new URL(
    `${upstream.endpoint.replace(/\/$/, '')}/${uriEncode(upstream.bucket)}/${uriEncode(key, true)}`,
  );
  for (const [k, v] of source.searchParams)
    if (!AUTH_PARAMS.has(k)) target.searchParams.append(k, v);
  const headers = new Headers();
  for (const name of FORWARD_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  for (const [name, value] of request.headers) {
    if (name.startsWith('x-amz-meta-') || name.startsWith('x-amz-checksum-'))
      headers.set(name, value);
  }
  const incomingHash = request.headers.get('x-amz-content-sha256');
  if (incomingHash && /^[0-9a-f]{64}$/.test(incomingHash))
    headers.set('x-amz-content-sha256', incomingHash);
  else if (incomingHash?.startsWith('STREAMING-')) return NOT_IMPLEMENTED();
  await signRequest({
    method: request.method,
    url: target,
    headers,
    credentials: upstream.credentials,
    region: upstream.region,
  });
  let body: ReadableStream<Uint8Array> | null = null;
  if (request.body && request.method !== 'GET' && request.method !== 'HEAD') {
    const length = request.headers.get('content-length');
    body =
      length !== null && /^\d+$/.test(length)
        ? deps.fixedLength(request.body, Number(length))
        : request.body;
  }
  const response = await deps.fetch(target, {
    method: request.method,
    headers,
    body,
    duplex: 'half',
  } as RequestInit);
  const out = new Headers();
  for (const name of RESPONSE_HEADERS) {
    const value = response.headers.get(name);
    if (value !== null) out.set(name, value);
  }
  return new Response(request.method === 'HEAD' ? null : response.body, {
    status: response.status,
    headers: out,
  });
}
