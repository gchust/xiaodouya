export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function xmlResponse(status: number, body: string, headers?: HeadersInit): Response {
  const h = new Headers(headers);
  h.set('content-type', 'application/xml');
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n${body}`, { status, headers: h });
}

/** S3 风格的错误。AWS SDK 按 Code 生成错误名（NoSuchUpload、NoSuchKey……），服务端靠它判断。 */
export function s3Error(
  status: number,
  code: string,
  message: string,
  headers?: HeadersInit,
): Response {
  return xmlResponse(
    status,
    `<Error><Code>${escapeXml(code)}</Code><Message>${escapeXml(message)}</Message></Error>`,
    headers,
  );
}

/** 只解析 CompleteMultipartUpload 的请求体：按出现顺序取出每个 Part 的片号和 ETag。 */
export function parseCompleteParts(body: string): { partNumber: number; etag: string }[] | null {
  if (!/<CompleteMultipartUpload[\s>]/.test(body)) return null;
  const parts: { partNumber: number; etag: string }[] = [];
  for (const m of body.matchAll(/<Part>([\s\S]*?)<\/Part>/g)) {
    const inner = m[1] ?? '';
    const n = /<PartNumber>\s*(\d+)\s*<\/PartNumber>/.exec(inner);
    const e = /<ETag>([\s\S]*?)<\/ETag>/.exec(inner);
    if (!n || !e) return null;
    parts.push({ partNumber: Number(n[1]), etag: unescapeXml(e[1]!.trim()) });
  }
  return parts;
}

function unescapeXml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}
