import { Buffer } from 'node:buffer';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  scrypt as scryptCb,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, salt, key] = stored.split('$');
  if (scheme !== 'scrypt' || !n || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64');
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, {
    ...SCRYPT,
    N: Number(n),
  });
  return timingSafeEqual(actual, expected);
}

/**
 * 邮箱不存在时也算一遍 scrypt，否则响应时间就暴露了邮箱是否存在。
 * 这是虚构密码的哈希，参数要和 SCRYPT 一致，改 N 时一起改。
 */
const DUMMY_PASSWORD_HASH =
  'scrypt$32768$AAAAAAAAAAAAAAAAAAAAAA==$Y8MYoqnX4lWGWuAOv64MBPfBINQKVV0WkGusAfOtPo4=';

export async function burnPasswordCheck(password: string): Promise<void> {
  await verifyPassword(password, DUMMY_PASSWORD_HASH);
}

/** 6 位验证码，首位可以是 0。 */
export function newEmailCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/**
 * 验证码只有一百万种，不带密钥的哈希在数据库泄露时一秒就能撞出来，所以用 APP_SECRET 做 HMAC。
 * 用途和账号也算进去：一种用途的验证码不能拿去当另一种用。
 */
export function hashEmailCode(secret: Buffer, scope: string, code: string): string {
  return createHmac('sha256', secret).update(`${scope}:${code}`).digest('hex');
}

export function safeEqualHex(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** 不含容易认错的字符（0/O、1/I/L），方便念给家人听。 */
const INVITE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

export function newInviteCode(): string {
  const bytes = randomBytes(8);
  return Array.from(bytes, (b) => INVITE_ALPHABET[b % INVITE_ALPHABET.length]).join('');
}

export function encryptSecret(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [
    'v1',
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    data.toString('base64'),
  ].join('.');
}

export function decryptSecret(stored: string, key: Buffer): string {
  const [version, iv, tag, data] = stored.split('.');
  if (version !== 'v1' || !iv || !tag || !data) throw new Error('无法识别的密文格式');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString(
    'utf8',
  );
}
