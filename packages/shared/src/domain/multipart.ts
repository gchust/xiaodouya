/** 超过这个大小走分片上传。小文件一次 PUT 更省请求，断了重传也不贵。 */
export const MULTIPART_THRESHOLD_BYTES = 16 * 1024 * 1024;
/** R2 要求除最后一片外每片一样大，S3 和 R2 都要求至少 5 MiB。 */
export const MULTIPART_PART_BYTES = 8 * 1024 * 1024;
/** S3 和 R2 的上限都是 10000 片。 */
const MAX_PARTS = 10_000;
/** 一次最多取多少片的链接。太多的话慢网传不完就过期了，太少又要多跑请求。 */
export const MULTIPART_URL_BATCH = 8;

export function usesMultipart(size: number): boolean {
  return size > MULTIPART_THRESHOLD_BYTES;
}

export function multipartPartSize(size: number): number {
  return Math.max(MULTIPART_PART_BYTES, Math.ceil(size / MAX_PARTS));
}

export function multipartPartCount(size: number, partSize: number): number {
  return Math.max(1, Math.ceil(size / partSize));
}

/** 第 partNumber 片（从 1 开始）应有的字节数。 */
export function multipartPartBytes(partNumber: number, size: number, partSize: number): number {
  const count = multipartPartCount(size, partSize);
  if (partNumber < 1 || partNumber > count) return 0;
  return partNumber < count ? partSize : size - partSize * (count - 1);
}

export interface UploadedPart {
  partNumber: number;
  size: number;
}

/** 大小不对的片算没传：重传同一个片号会覆盖它。 */
export function validParts(
  parts: readonly UploadedPart[],
  size: number,
  partSize: number,
): UploadedPart[] {
  return parts.filter((p) => p.size === multipartPartBytes(p.partNumber, size, partSize));
}

export function missingParts(
  parts: readonly UploadedPart[],
  size: number,
  partSize: number,
): number[] {
  const have = new Set(validParts(parts, size, partSize).map((p) => p.partNumber));
  const missing: number[] = [];
  for (let n = 1; n <= multipartPartCount(size, partSize); n++) {
    if (!have.has(n)) missing.push(n);
  }
  return missing;
}

export function confirmedPartBytes(
  parts: readonly UploadedPart[],
  size: number,
  partSize: number,
): number {
  return validParts(parts, size, partSize).reduce((sum, p) => sum + p.size, 0);
}
