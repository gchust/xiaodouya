/** 小工具点进 App 的链接。不依赖 React Native，便于测试。 */
export type WidgetLink = { kind: 'event'; id: string } | { kind: 'feed' };

export const TODAY_LINK = 'xiaodouya://today';
export const FEED_LINK = `${TODAY_LINK}?sheet=feed`;

export function eventLink(id: string): string {
  return `${TODAY_LINK}?event=${encodeURIComponent(id)}`;
}

export function linkFromParams(params: { event?: string; sheet?: string }): WidgetLink | null {
  if (params.event) return { kind: 'event', id: params.event };
  return params.sheet === 'feed' ? { kind: 'feed' } : null;
}

/** 解析完整的链接。不是小工具的链接时返回 null。 */
export function parseWidgetLink(url: string | null): WidgetLink | null {
  const query = url?.startsWith(`${TODAY_LINK}?`) ? url.slice(TODAY_LINK.length + 1) : null;
  if (!query) return null;
  const params: { event?: string; sheet?: string } = {};
  for (const pair of query.split('&')) {
    const [key, value] = pair.split('=');
    if (!value) continue;
    try {
      if (key === 'event') params.event = decodeURIComponent(value);
      if (key === 'sheet') params.sheet = decodeURIComponent(value);
    } catch {
      return null;
    }
  }
  return linkFromParams(params);
}

export const linkKey = (link: WidgetLink): string =>
  link.kind === 'event' ? `event:${link.id}` : 'feed';
