/**
 * 一次性回填（F-134）：把旧证件宽 720 的缩略图缩到长边 256（`cli shrink-document-thumbs`）。
 *
 * F-131 起 App 新传的证件缩略图长边 256，看不清证件号；之前传的是宽 720，看得清。仓库所有者决定
 * 证件的缩略图不用兼容旧版 App，所以直接覆盖原来的 thumb 对象，不新增变体名。
 *
 * 为什么不会丢数据：
 * - 只碰 scope = 'document' 的 thumb。原图、回忆、头像一个字节都不读写。缩略图是从原图派生的。
 * - 从现有的缩略图缩，不从原图做：原图的 EXIF 方向没写进像素（jpeg-js 不管方向），缩出来会是倒的；
 *   而且没有缩略图的证件，记录里也没有 hasThumb，补做了 App 也不会显示（记录归 App 同步，这里不改）。
 * - S3 的 PUT 是原子的，对象要么是旧的要么是新的。写完对象、没来得及改 media 的大小就中断时，
 *   重跑会读到一张已经不超过 256 的图，只把记录的大小补上（repaired），不再缩一次。
 * - 写之前拿着和同步、定时清理同一把家庭锁，并核对这一行还在、没变：清理不会在我们读完之后删掉对象，
 *   又被我们写回来变成没人管的文件。
 *
 * 只在 Node 上跑（jpeg-js 是纯 JS 的 JPEG 编解码，没有原生依赖）。不要从 app.ts 引用它，
 * Edge Function 的包里不该有它（scripts/build-edge.mjs 会检查）。
 */
import { DOCUMENT_THUMB_MAX_SIDE } from '@xiaodouya/shared';
import jpeg from 'jpeg-js';
import type { Config } from './config';
import type { Sql } from './db';
import {
  assertEndpointAllowed,
  describeStorageError,
  putObjectBytes,
  type ResolvedStorage,
  readObjectBytes,
  storageById,
} from './storage';

/** 和 App 新传的证件缩略图一样：JPEG 质量 0.8（`makeThumbnail` 的 compress）。 */
const QUALITY = 80;
/** 旧缩略图宽 720、长边最多 1440，几百 KB。比这大得多的不是 App 传的，不解码。 */
const MAX_THUMB_BYTES = 8 * 1024 * 1024;
const BATCH = 50;

export interface ShrinkReport {
  dryRun: boolean;
  /** 看过的证件缩略图（不含等 APP_SECRET 的）。 */
  examined: number;
  /** 缩小并写回的。dry-run 时是会缩小的数量，没有写。 */
  shrunk: number;
  /** 长边已经不超过 256，没动。 */
  alreadySmall: number;
  /** 对象已经缩好、media 记录的大小还是旧的（上次中途断了），补上了大小。 */
  repaired: number;
  /** 不是 JPEG、带着不是 1 的 EXIF 方向、太大或解不开，没动。不算失败。 */
  unsupported: number;
  /** media 里有记录、存储里没有对象。没动。 */
  missing: number;
  /** 在家庭自带的存储里、因为没有 APP_SECRET 这次没处理的。不算失败。 */
  waitingForSecret: number;
  /** 读写存储或数据库出错。下次重跑会再试。 */
  failed: number;
  /** 缩小的那些，原来一共多少字节、缩完多少（dry-run 也算，是缩完会有多少）。 */
  bytesBefore: number;
  bytesAfter: number;
  /** 失败原因和次数。只有翻译过的原因，不含地址、object key 和原始错误。 */
  failures: Record<string, number>;
}

export interface ShrinkOptions {
  /** 只读、只统计，不写存储也不改记录。 */
  dryRun?: boolean;
  /** 这次最多缩小几张，分批上线用。补记录大小（repaired）不算在内。 */
  limit?: number;
  /** false 表示没有真实的 APP_SECRET，解不开家庭自带存储的密钥，那些家庭跳过并计数。 */
  customStorage?: boolean;
  /** 只处理这个家庭，先拿一家试的时候用。 */
  familyId?: string;
}

interface ThumbRow {
  id: string;
  family_id: string;
  object_key: string;
  storage_config_id: string | null;
  size: string;
  mime: string;
}

/** 从 JPEG 文件头读宽高（第一个 SOF 段）。不是 JPEG 或读不到时是 null。 */
export function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < bytes.length && bytes[i] === 0xff) {
    const marker = bytes[i + 1]!;
    const isFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      return {
        height: (bytes[i + 5]! << 8) | bytes[i + 6]!,
        width: (bytes[i + 7]! << 8) | bytes[i + 8]!,
      };
    }
    if (marker === 0xda) return null;
    i += 2 + ((bytes[i + 2]! << 8) | bytes[i + 3]!);
  }
  return null;
}

/**
 * EXIF 里的方向（0x0112），没有时是 null。jpeg-js 解码时不管它：方向不是 1 的图缩出来会是转过的，
 * 而重新编码会去掉 EXIF，方向就丢了。App 传的缩略图是重新编码过的，方向已经在像素里，不该有这一项。
 */
export function jpegOrientation(bytes: Uint8Array): number | null {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let i = 2;
  while (i + 4 <= view.length && view[i] === 0xff) {
    const marker = view[i + 1]!;
    if (marker === 0xda || marker === 0xd9) break;
    const length = view.readUInt16BE(i + 2);
    const body = view.subarray(i + 4, i + 2 + length);
    if (marker === 0xe1 && body.subarray(0, 6).toString('latin1') === 'Exif\0\0') {
      const tiff = body.subarray(6);
      if (tiff.length < 8) return null;
      const little = tiff.subarray(0, 2).toString('latin1') === 'II';
      const u16 = (at: number) => (little ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at));
      const u32 = (at: number) => (little ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at));
      const start = u32(4);
      if (start + 2 > tiff.length) return null;
      const count = u16(start);
      for (let entry = 0; entry < count; entry++) {
        const at = start + 2 + entry * 12;
        if (at + 12 > tiff.length) break;
        if (u16(at) === 0x0112) return u16(at + 8);
      }
      return null;
    }
    i += 2 + length;
  }
  return null;
}

/** 每个目标像素覆盖源图的哪一段、各占多少：按面积平均，缩小几倍也不会出现锯齿和摩尔纹。 */
function areaWeights(source: number, target: number) {
  const scale = source / target;
  return Array.from({ length: target }, (_, index) => {
    const from = index * scale;
    const to = (index + 1) * scale;
    const start = Math.floor(from);
    const end = Math.min(source, Math.ceil(to));
    const weights = new Float64Array(end - start);
    for (let s = start; s < end; s++) {
      weights[s - start] = (Math.min(to, s + 1) - Math.max(from, s)) / scale;
    }
    return { start, weights };
  });
}

/** RGBA 缩小，先横向再纵向。只用于缩小，调用方保证目标不比源大。 */
function downscale(
  data: Uint8Array,
  width: number,
  height: number,
  targetWidth: number,
  targetHeight: number,
): Uint8Array {
  const columns = areaWeights(width, targetWidth);
  const rows = areaWeights(height, targetHeight);
  const horizontal = new Float64Array(targetWidth * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < targetWidth; x++) {
      const { start, weights } = columns[x]!;
      for (let channel = 0; channel < 4; channel++) {
        let sum = 0;
        for (let k = 0; k < weights.length; k++) {
          sum += data[(y * width + start + k) * 4 + channel]! * weights[k]!;
        }
        horizontal[(y * targetWidth + x) * 4 + channel] = sum;
      }
    }
  }
  const out = new Uint8Array(targetWidth * targetHeight * 4);
  for (let y = 0; y < targetHeight; y++) {
    const { start, weights } = rows[y]!;
    for (let x = 0; x < targetWidth; x++) {
      for (let channel = 0; channel < 4; channel++) {
        let sum = 0;
        for (let k = 0; k < weights.length; k++) {
          sum += horizontal[((start + k) * targetWidth + x) * 4 + channel]! * weights[k]!;
        }
        out[(y * targetWidth + x) * 4 + channel] = Math.min(255, Math.max(0, Math.round(sum)));
      }
    }
  }
  return out;
}

/**
 * 缩到长边 maxSide（不放大），重新编码成 JPEG。jpeg-js 只写 JFIF 的 APP0，不带原来的 EXIF、XMP 和注释。
 * 解码设了分辨率和内存上限：一张故意做坏的大图不能把进程撑爆。
 */
export function shrinkJpeg(bytes: Uint8Array, maxSide = DOCUMENT_THUMB_MAX_SIDE): Buffer {
  const image = jpeg.decode(bytes, {
    useTArray: true,
    formatAsRGBA: true,
    maxResolutionInMP: 40,
    maxMemoryUsageInMB: 512,
  });
  const long = Math.max(image.width, image.height);
  const scale = Math.min(1, maxSide / long);
  const targetWidth = Math.max(1, Math.round(image.width * scale));
  const targetHeight = Math.max(1, Math.round(image.height * scale));
  const data = downscale(image.data, image.width, image.height, targetWidth, targetHeight);
  return jpeg.encode({ data, width: targetWidth, height: targetHeight }, QUALITY).data;
}

/** 只留翻译过的原因：原始错误里可能有存储地址和请求信息，CI 日志是公开的。 */
function failureReason(error: unknown): string {
  if (error instanceof Error && !('$metadata' in error) && !('code' in error)) {
    return error.message.slice(0, 120);
  }
  return describeStorageError(error);
}

export async function shrinkDocumentThumbs(
  sql: Sql,
  config: Config,
  { dryRun = false, limit, customStorage = true, familyId }: ShrinkOptions = {},
): Promise<ShrinkReport> {
  const report: ShrinkReport = {
    dryRun,
    examined: 0,
    shrunk: 0,
    alreadySmall: 0,
    repaired: 0,
    unsupported: 0,
    missing: 0,
    waitingForSecret: 0,
    failed: 0,
    bytesBefore: 0,
    bytesAfter: 0,
    failures: {},
  };
  const fail = (reason: string) => {
    report.failed += 1;
    report.failures[reason] = (report.failures[reason] ?? 0) + 1;
  };
  // 同一个家庭的同一份存储配置只解密、查地址一次。
  const storages = new Map<string, Promise<ResolvedStorage>>();
  const storageFor = (row: ThumbRow) => {
    const cacheKey = `${row.family_id}/${row.storage_config_id ?? ''}`;
    let found = storages.get(cacheKey);
    if (!found) {
      found = (async () => {
        const storage = await storageById(sql, config, row.family_id, row.storage_config_id);
        if (!storage) throw new Error('存储配置不可用');
        // 地址可能在保存之后改为解析到内网，连接前再查一次。
        if (storage.configId && storage.endpoint) {
          await assertEndpointAllowed(storage.endpoint, config);
        }
        return storage;
      })();
      // 失败的不缓存成功，但也不反复解析：同一家后面的缩略图一样会失败，各自计数。
      storages.set(cacheKey, found);
    }
    return found;
  };

  const familyFilter = familyId ? sql`AND family_id = ${familyId}` : sql``;
  let after = '00000000-0000-0000-0000-000000000000';
  for (;;) {
    if (limit !== undefined && report.shrunk >= limit) break;
    const rows = await sql<ThumbRow[]>`
      SELECT id, family_id, object_key, storage_config_id, size, mime FROM media
      WHERE scope = 'document' AND variant = 'thumb' AND status = 'ready'
        AND id > ${after} ${familyFilter}
      ORDER BY id LIMIT ${BATCH}`;
    if (rows.length === 0) break;
    after = rows.at(-1)!.id;
    for (const row of rows) {
      if (limit !== undefined && report.shrunk >= limit) break;
      if (row.storage_config_id && !customStorage) {
        report.waitingForSecret += 1;
        continue;
      }
      report.examined += 1;
      try {
        await shrinkOne(sql, row, await storageFor(row), dryRun, report);
      } catch (error) {
        fail(failureReason(error));
      }
    }
  }
  return report;
}

async function shrinkOne(
  sql: Sql,
  row: ThumbRow,
  storage: ResolvedStorage,
  dryRun: boolean,
  report: ShrinkReport,
): Promise<void> {
  const bytes = await readObjectBytes(storage, row.object_key, MAX_THUMB_BYTES);
  if (bytes === null) {
    report.missing += 1;
    return;
  }
  const size = bytes === 'tooLarge' ? null : jpegDimensions(bytes);
  if (bytes === 'tooLarge' || !size) {
    report.unsupported += 1;
    return;
  }
  if (Math.max(size.width, size.height) <= DOCUMENT_THUMB_MAX_SIDE) {
    if (Number(row.size) === bytes.length && row.mime === 'image/jpeg') {
      report.alreadySmall += 1;
      return;
    }
    // 上次写完对象就断了：以存储里的实际大小为准。配额和下载校验都看这一列。
    if (!dryRun) {
      await sql`UPDATE media SET size = ${bytes.length}, mime = 'image/jpeg'
        WHERE id = ${row.id} AND variant = 'thumb' AND object_key = ${row.object_key}`;
    }
    report.repaired += 1;
    return;
  }
  const orientation = jpegOrientation(bytes);
  if (orientation !== null && orientation !== 1) {
    report.unsupported += 1;
    return;
  }
  let shrunk: Buffer;
  try {
    shrunk = shrinkJpeg(bytes);
  } catch {
    // 解不开（坏图、超过分辨率或内存上限）：不是存储的问题，留着原样。
    report.unsupported += 1;
    return;
  }
  if (!dryRun) {
    const written = await sql.begin(async (tx) => {
      // 和同步、定时清理同一把锁，顺序也一样（先家庭后文件）。拿到锁以后这一行不会被清理删掉，
      // 也就不会出现清理删了对象、我们又写回去，留下一个没有记录的文件。
      await tx`SELECT 1 FROM families WHERE id = ${row.family_id} FOR UPDATE`;
      const [current] = await tx<{ size: string; object_key: string }[]>`
        SELECT size, object_key FROM media
        WHERE id = ${row.id} AND variant = 'thumb' AND status = 'ready' FOR UPDATE`;
      if (!current || current.object_key !== row.object_key || current.size !== row.size) {
        return false;
      }
      await putObjectBytes(storage, row.object_key, shrunk, 'image/jpeg');
      await tx`UPDATE media SET size = ${shrunk.length}, mime = 'image/jpeg'
        WHERE id = ${row.id} AND variant = 'thumb'`;
      return true;
    });
    if (!written) {
      // 读完之后这一行被删了或者变了，这次不动，重跑时以那时的状态为准。
      report.missing += 1;
      return;
    }
  }
  report.shrunk += 1;
  report.bytesBefore += bytes.length;
  report.bytesAfter += shrunk.length;
}
