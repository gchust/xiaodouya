import type { PublicTimelineEntry, PublicTimelineResponse } from '@xiaodouya/shared';
import { setLocale } from '@xiaodouya/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openShareLink } from '../src/route';
import { createTimelinePage } from '../src/timeline';
import { flush, media, share } from './fixtures';

/** 分享回忆（F-136）的网页：和时间线同一个页面，标题和结尾按选中的回忆写。数据都是虚构的。 */

const TOKEN = 'M'.repeat(43);
const API = { url: 'https://abc.supabase.co/functions/v1/api', region: 'ap-southeast-1' };
const HOUR = 3_600_000;
const TZ = 'America/New_York';
// 纽约 2026-06-15 00:30。
const DAY1 = Date.UTC(2026, 5, 15, 4, 30);

const entry = (overrides: Partial<PublicTimelineEntry> = {}): PublicTimelineEntry => ({
  id: '00000000-0000-4000-8000-0000000000aa',
  at: DAY1,
  title: '第一次翻身',
  text: '虚构的一段话',
  milestone: false,
  dayNumber: 15,
  age: { months: 0, days: 14 },
  cover: media(),
  visualCount: 1,
  audioCount: 0,
  ...overrides,
});

const page = (overrides: Partial<PublicTimelineResponse> = {}): PublicTimelineResponse => ({
  kind: 'moments',
  baby: { name: '测试豆', age: { months: 0, days: 14 } },
  range: { fromAt: DAY1, toAt: DAY1 + 1, timezone: TZ },
  entries: [entry()],
  nextCursor: null,
  mediaExpiresIn: 3600,
  ...overrides,
});

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

function start(body: PublicTimelineResponse) {
  const root = document.createElement('main');
  document.body.append(root);
  const timeline = createTimelinePage({
    root,
    token: TOKEN,
    api: API,
    allowLocalHttp: false,
    fetcher: (async () => ok(body)) as unknown as typeof fetch,
    now: () => Date.UTC(2026, 10, 5),
    photo: () => () => {},
    watch: () => () => {},
  });
  return { root, timeline };
}

beforeEach(() => {
  setLocale('zh');
});
afterEach(() => {
  document.body.replaceChildren();
});

describe('页面', () => {
  it('一段回忆：标题写回忆，日期是那一天，没有“没有更早的回忆了”', async () => {
    const { root, timeline } = start(page());
    await timeline.load();
    expect(root.querySelector('h1')?.textContent).toBe('测试豆的回忆');
    expect(root.querySelector('.hero-date')?.textContent).toBe('6月15日');
    expect(root.querySelectorAll('.tl-entry')).toHaveLength(1);
    expect(root.querySelector('.moment-title')?.textContent).toBe('第一次翻身');
    expect(root.querySelector('.tl-more')?.textContent).toBe('');
  });

  it('几段回忆：范围是头尾两天，按日期分组', async () => {
    const { root, timeline } = start(
      page({
        range: { fromAt: DAY1 - 30 * 24 * HOUR, toAt: DAY1 + 1, timezone: TZ },
        entries: [
          entry(),
          entry({
            id: '00000000-0000-4000-8000-0000000000bb',
            at: DAY1 - 30 * 24 * HOUR,
            title: '更早的',
            dayNumber: null,
          }),
        ],
      }),
    );
    await timeline.load();
    expect(root.querySelector('.hero-date')?.textContent).toBe('5月16日 – 6月15日');
    expect(root.querySelectorAll('.tl-day')).toHaveLength(2);
  });

  it('选中的都不在了：说清楚', async () => {
    const { root, timeline } = start(page({ entries: [] }));
    await timeline.load();
    expect(root.textContent).toContain('这些回忆已经不在了');
    expect(root.textContent).not.toContain('这段时间还没有回忆');
  });

  it('英文', async () => {
    setLocale('en');
    const { root, timeline } = start(page());
    await timeline.load();
    expect(root.querySelector('h1')?.textContent).toBe('Moments with 测试豆');
  });
});

describe('按链接片段打开哪个页面', () => {
  const routeWith = (hash: string, body: unknown) => {
    const root = document.createElement('main');
    document.body.append(root);
    const fetcher = vi.fn(async () => ok(body));
    void openShareLink(hash, {
      root,
      api: API,
      allowLocalHttp: false,
      fetcher: fetcher as unknown as typeof fetch,
    });
    return { root, fetcher };
  };
  const pathOf = (fetcher: ReturnType<typeof vi.fn>) =>
    new URL(String(fetcher.mock.calls[0]?.[0])).pathname.replace('/functions/v1/api', '');

  it('#m/令牌 走时间线的接口，#t/令牌 也是，#令牌 是一天', async () => {
    const moments = routeWith(`#m/${TOKEN}`, page());
    await flush();
    expect(pathOf(moments.fetcher)).toBe('/v1/public/share/timeline');
    expect(moments.root.querySelector('h1')?.textContent).toBe('测试豆的回忆');

    const timeline = routeWith(`#t/${TOKEN}`, page({ kind: 'timeline' }));
    await flush();
    expect(pathOf(timeline.fetcher)).toBe('/v1/public/share/timeline');

    const day = routeWith(`#${TOKEN}`, share());
    await flush();
    expect(pathOf(day.fetcher)).toBe('/v1/public/share');
  });

  it('坏的片段不请求，直接说链接失效', async () => {
    const { root, fetcher } = routeWith('#m/abc', page());
    await flush();
    expect(fetcher).not.toHaveBeenCalled();
    expect(root.querySelector('h1')?.textContent).toBe('这个链接已失效或已撤销');
  });
});
