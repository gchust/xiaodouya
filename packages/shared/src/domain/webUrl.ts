/**
 * 网页链接的协议和主机名。只认 `http(s)://主机/…`，不带账号密码（`user@host`），没有空白、控制字符和反斜杠：
 * 浏览器把 `https://evil.example\@youtube.com` 当成 evil.example，按字符串认来源就会认错。
 * 不能解析时返回 null。
 *
 * 不用 `URL`：React Native 的 `URL` 是几条正则，和 Node 的解析结果不一样，同一条记录在手机上和服务端
 * 一边算合法一边不算，就会卡在手机上。手机和服务端都用这一份。
 */
const WEB_URL = /^(https?):\/\/([^\s/?#:@\\[\]]+)(?::(\d{1,5}))?([/?#][^\s\\]*)?$/i;
// biome-ignore lint/suspicious/noControlCharactersInRegex: 就是要挡住控制字符
const CONTROL = /[\u0000-\u001f\u007f]/;

export function parseWebUrl(value: string): { scheme: 'http' | 'https'; host: string } | null {
  if (CONTROL.test(value)) return null;
  const match = WEB_URL.exec(value);
  if (!match?.[1] || !match[2]) return null;
  const host = match[2].toLowerCase().replace(/\.$/, '');
  if (!host || host.startsWith('.') || host.includes('..')) return null;
  return { scheme: match[1].toLowerCase() as 'http' | 'https', host };
}
