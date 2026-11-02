const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

/** 令牌在 URL 片段里，不会发给托管网页的服务器。这里只读，不写日志，也不放进别的地方。 */
export function readToken(hash: string): string | null {
  const token = hash.replace(/^#/, '');
  return TOKEN.test(token) ? token : null;
}

/**
 * 文件地址来自接口，接口又来自家庭的存储配置。写进 src 之前要确认是 https：
 * 配错的 http 地址会让签名链接明文传输，别的协议更不该出现。
 * `allowLocalHttp` 只在 API 也是本机地址的走查构建里打开。
 */
export function safeMediaUrl(
  url: string | null | undefined,
  allowLocalHttp: boolean,
): string | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol === 'https:') return url;
  if (allowLocalHttp && parsed.protocol === 'http:' && LOCAL_HOSTS.has(parsed.hostname)) return url;
  return null;
}
