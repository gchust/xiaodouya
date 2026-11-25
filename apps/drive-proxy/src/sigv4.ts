/**
 * AWS Signature V4，只实现 S3 用到的部分：预签名链接（参数在 query 里）和 Authorization 头。
 * 服务端用 AWS SDK 签名、手机拿预签名链接，代理必须和 S3 算出一样的结果，所以这里的每一步都按 AWS 文档：
 * https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html
 */

const encoder = new TextEncoder();

export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';
/** 签名时间和代理时间最多差多少（AWS 也是 15 分钟）。 */
const MAX_CLOCK_SKEW_SECONDS = 15 * 60;
/** 预签名链接最长 7 天，和 S3 一样。 */
const MAX_PRESIGN_SECONDS = 7 * 24 * 3600;

export interface Credentials {
  accessKeyId: string;
  secretAccessKey: string;
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(data: string | Uint8Array<ArrayBuffer>): Promise<string> {
  return hex(
    await crypto.subtle.digest('SHA-256', typeof data === 'string' ? encoder.encode(data) : data),
  );
}

async function hmac(
  key: ArrayBuffer | Uint8Array<ArrayBuffer>,
  data: string,
): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  return crypto.subtle.sign('HMAC', k, encoder.encode(data));
}

/** S3 的 URI 编码：除了不保留字符都编码，空格是 %20。路径里的 / 不编码。 */
export function uriEncode(value: string, keepSlash = false): string {
  let out = '';
  for (const byte of encoder.encode(value)) {
    const c = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-._~]/.test(c) || (keepSlash && c === '/')) out += c;
    else out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

/** 收到的路径先解码再按 S3 的规则编码：不同客户端对同一个 key 的编码可能不一样（比如要不要编码 `~`）。 */
export function canonicalPath(pathname: string): string {
  return pathname
    .split('/')
    .map((segment) => uriEncode(safeDecode(segment)))
    .join('/');
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function canonicalQuery(params: URLSearchParams, skip?: string): string {
  const pairs: [string, string][] = [];
  for (const [k, v] of params) {
    if (k === skip) continue;
    pairs.push([uriEncode(k), uriEncode(v)]);
  }
  pairs.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1));
  return pairs.map(([k, v]) => `${k}=${v}`).join('&');
}

function canonicalHeaderValue(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

async function signingKey(secret: string, date: string, region: string, service: string) {
  const kDate = await hmac(encoder.encode(`AWS4${secret}`), date);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

interface CanonicalInput {
  method: string;
  path: string;
  query: string;
  headers: [string, string][];
  payloadHash: string;
}

async function signature(
  secret: string,
  amzDate: string,
  scope: { date: string; region: string; service: string },
  input: CanonicalInput,
): Promise<string> {
  const canonicalHeaders = input.headers.map(([k, v]) => `${k}:${v}\n`).join('');
  const signedHeaders = input.headers.map(([k]) => k).join(';');
  const canonicalRequest = [
    input.method,
    input.path,
    input.query,
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join('\n');
  const scopeText = `${scope.date}/${scope.region}/${scope.service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scopeText,
    await sha256Hex(canonicalRequest),
  ].join('\n');
  const key = await signingKey(secret, scope.date, scope.region, scope.service);
  return hex(await hmac(key, stringToSign));
}

/** 常量时间比较，不让签名对不对从耗时里看出来。 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function parseAmzDate(value: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  if (!m) return null;
  return Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!) / 1000;
}

export type VerifyResult =
  | {
      ok: true;
      /** 签进去的头（小写）。content-length 在里面时，上传的字节数必须和它一样。 */
      signedHeaders: Set<string>;
      /** x-amz-content-sha256 的值；预签名链接是 UNSIGNED-PAYLOAD。 */
      payloadHash: string;
      presigned: boolean;
    }
  | {
      ok: false;
      code: 'AccessDenied' | 'SignatureDoesNotMatch' | 'InvalidAccessKeyId';
      message: string;
    };

const deny = (
  code: 'AccessDenied' | 'SignatureDoesNotMatch' | 'InvalidAccessKeyId',
  message: string,
): VerifyResult => ({ ok: false, code, message });

/** 校验收到的请求。`nowSeconds` 只给测试用。 */
export async function verifyRequest(
  request: Request,
  credentials: Credentials,
  nowSeconds = Date.now() / 1000,
): Promise<VerifyResult> {
  const url = new URL(request.url);
  const params = url.searchParams;
  const presigned = params.get('X-Amz-Algorithm') === 'AWS4-HMAC-SHA256';

  let credential: string;
  let signedHeaderNames: string[];
  let given: string;
  let amzDate: string;
  let payloadHash: string;
  if (presigned) {
    credential = params.get('X-Amz-Credential') ?? '';
    signedHeaderNames = (params.get('X-Amz-SignedHeaders') ?? '').split(';').filter(Boolean);
    given = params.get('X-Amz-Signature') ?? '';
    amzDate = params.get('X-Amz-Date') ?? '';
    payloadHash = params.get('X-Amz-Content-Sha256') ?? UNSIGNED_PAYLOAD;
    const expires = Number(params.get('X-Amz-Expires'));
    const signedAt = parseAmzDate(amzDate);
    if (
      !Number.isInteger(expires) ||
      expires < 1 ||
      expires > MAX_PRESIGN_SECONDS ||
      signedAt === null
    ) {
      return deny('AccessDenied', 'Invalid presigned parameters');
    }
    if (nowSeconds > signedAt + expires) return deny('AccessDenied', 'Request has expired');
    if (signedAt > nowSeconds + MAX_CLOCK_SKEW_SECONDS) {
      return deny('AccessDenied', 'Request is not yet valid');
    }
  } else {
    const auth = request.headers.get('authorization') ?? '';
    const m =
      /^AWS4-HMAC-SHA256\s+Credential=([^,\s]+),\s*SignedHeaders=([^,\s]+),\s*Signature=([0-9a-f]{64})$/.exec(
        auth.trim(),
      );
    if (!m) return deny('AccessDenied', 'Missing or malformed authorization');
    credential = m[1]!;
    signedHeaderNames = m[2]!.split(';');
    given = m[3]!;
    amzDate = request.headers.get('x-amz-date') ?? '';
    payloadHash = request.headers.get('x-amz-content-sha256') ?? '';
    const signedAt = parseAmzDate(amzDate);
    if (signedAt === null || Math.abs(nowSeconds - signedAt) > MAX_CLOCK_SKEW_SECONDS) {
      return deny('AccessDenied', 'Request time too skewed');
    }
    if (!payloadHash) return deny('AccessDenied', 'Missing x-amz-content-sha256');
  }

  const [keyId, date, region, service, terminator] = credential.split('/');
  if (!keyId || !date || !region || service !== 's3' || terminator !== 'aws4_request') {
    return deny('AccessDenied', 'Malformed credential');
  }
  if (!safeEqual(keyId, credentials.accessKeyId)) {
    return deny('InvalidAccessKeyId', 'Unknown access key');
  }
  if (!amzDate.startsWith(date)) return deny('AccessDenied', 'Credential date mismatch');
  // host 必须签进去，否则链接可以拿到别的主机上用。
  if (!signedHeaderNames.includes('host')) return deny('AccessDenied', 'Host must be signed');

  const headers: [string, string][] = [];
  for (const name of [...signedHeaderNames].sort()) {
    const value = name === 'host' ? url.host : request.headers.get(name);
    if (value === null) return deny('AccessDenied', `Signed header missing: ${name}`);
    headers.push([name, canonicalHeaderValue(value)]);
  }

  const expected = await signature(
    credentials.secretAccessKey,
    amzDate,
    { date, region, service },
    {
      method: request.method,
      path: canonicalPath(url.pathname),
      query: canonicalQuery(params, presigned ? 'X-Amz-Signature' : undefined),
      headers,
      payloadHash,
    },
  );
  if (!safeEqual(expected, given)) {
    return deny('SignatureDoesNotMatch', 'The request signature does not match');
  }
  return { ok: true, signedHeaders: new Set(signedHeaderNames), payloadHash, presigned };
}

function amzNow(now: Date): string {
  return now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

/**
 * 给转发到上游（R2）的请求签名。正文不算哈希（UNSIGNED-PAYLOAD）：边收边转，不能先读完。
 * `headers` 里的每一个都签进去。
 */
export async function signRequest(input: {
  method: string;
  url: URL;
  headers: Headers;
  credentials: Credentials;
  region: string;
  now?: Date;
}): Promise<void> {
  const amzDate = amzNow(input.now ?? new Date());
  const date = amzDate.slice(0, 8);
  input.headers.set('host', input.url.host);
  input.headers.set('x-amz-date', amzDate);
  if (!input.headers.has('x-amz-content-sha256')) {
    input.headers.set('x-amz-content-sha256', UNSIGNED_PAYLOAD);
  }
  const headers: [string, string][] = [];
  input.headers.forEach((value, name) => {
    headers.push([name.toLowerCase(), canonicalHeaderValue(value)]);
  });
  headers.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const sig = await signature(
    input.credentials.secretAccessKey,
    amzDate,
    { date, region: input.region, service: 's3' },
    {
      method: input.method,
      path: canonicalPath(input.url.pathname),
      query: canonicalQuery(input.url.searchParams),
      headers,
      payloadHash: input.headers.get('x-amz-content-sha256')!,
    },
  );
  const scope = `${input.credentials.accessKeyId}/${date}/${input.region}/s3/aws4_request`;
  input.headers.set(
    'authorization',
    `AWS4-HMAC-SHA256 Credential=${scope}, SignedHeaders=${headers.map(([k]) => k).join(';')}, Signature=${sig}`,
  );
  // fetch 自己会写 host，留着会被当成重复的头。
  input.headers.delete('host');
}
