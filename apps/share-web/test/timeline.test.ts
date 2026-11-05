import type {
  PublicMedia,
  PublicTimelineEntry,
  PublicTimelineMomentResponse,
  PublicTimelineResponse,
} from '@xiaodouya/shared';
import { setLocale } from '@xiaodouya/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadTimelineMoment, loadTimelinePage } from '../src/api';
import { readToken } from '../src/media';
import { createTimelinePage } from '../src/timeline';
import { flush, media } from './fixtures';

/** 分享时间线（F-133）的网页。数据都是虚构的。 */

const TOKEN = 'T'.repeat(43);
const API = { url: 'https://abc.supabase.co/functions/v1/api', region: 'ap-southeast-1' };
const HOUR = 3_600_000;
// 纽约时区：和跑测试的机器（UTC 或东八区）都不一样，日期分组按它算才看得出来。
const TZ = 'America/New_York';
// 纽约 2026-06-15 00:30，UTC 已经是 04:30。
const DAY1 = Date.UTC(2026, 5, 15, 4, 30);
const CURSOR_1 = `${DAY1}.00000000-0000-4000-8000-000000000001`;

const XSS_NAME = '<img src=x onerror="window.__pwned=1">';
const XSS_NOTE = '<script>window.__pwned=1</script><a href="javascript:alert(1)">点</a>';

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
  kind: 'timeline',
  baby: { name: '测试豆', age: { months: 1, days: 2 } },
  range: { fromAt: Date.UTC(2026, 5, 1, 4), toAt: Date.UTC(2026, 6, 1, 4), timezone: TZ },
  entries: [entry()],
  nextCursor: null,
  mediaExpiresIn: 3600,
  ...overrides,
});

const momentFiles = (overrides: Partial<PublicTimelineMomentResponse> = {}) => ({
  media: [
    media({ id: 'p1' }),
    media({ id: 'p2', width: 300, height: 400 }),
    media({ id: 'a1', kind: 'audio', url: 'https://files.fictional.test/a.m4a', thumbUrl: null }),
  ],
  omittedMedia: 0,
  mediaExpiresIn: 3600,
  ...overrides,
});

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
const miss = () =>
  new Response(JSON.stringify({ error: { code: 'share_unavailable', message: 'x' } }), {
    status: 404,
  });

/** 记下放大看图时拿到的文件。 */
const record = (sink: PublicMedia[][]) => (items: PublicMedia[]) => {
  sink.push(items);
  return () => {};
};

type Route = (body: Record<string, string>) => Response | Promise<Response>;

/** 按路径回答的假接口，记下每次请求的地址和请求体。 */
function fakeApi(routes: { page: Route[]; moment?: Route[] }) {
  const calls: { path: string; body: Record<string, string> }[] = [];
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname.replace('/functions/v1/api', '');
    const body = JSON.parse(String(init.body)) as Record<string, string>;
    calls.push({ path, body });
    const queue = path.endsWith('/moment') ? routes.moment : routes.page;
    const next = queue?.shift();
    if (!next) throw new Error(`没有更多响应：${path}`);
    return next(body);
  });
  return { fetcher: fetcher as unknown as typeof fetch, calls };
}

function start(
  routes: { page: Route[]; moment?: Route[] },
  options: {
    clock?: { now: number };
    photo?: (items: PublicMedia[], index: number) => () => void;
  } = {},
) {
  const root = document.createElement('main');
  document.body.append(root);
  const api = fakeApi(routes);
  const watchers: (() => void)[] = [];
  const timeline = createTimelinePage({
    root,
    token: TOKEN,
    api: API,
    allowLocalHttp: false,
    fetcher: api.fetcher,
    now: () => options.clock?.now ?? Date.UTC(2026, 10, 5),
    photo: options.photo ?? (() => () => {}),
    // 测试里由按钮翻页；记下底部进入视野时要做什么，需要时手动触发。
    watch: (_target, onVisible) => {
      watchers.push(onVisible);
      return () => {};
    },
  });
  return { root, timeline, calls: api.calls, watchers };
}

beforeEach(() => {
  setLocale('zh');
});
afterEach(() => {
  document.body.replaceChildren();
  document.documentElement.className = '';
});

describe('请求', () => {
  it('令牌和游标只在请求体里，不带凭据，固定地区', async () => {
    const fetcher = vi.fn(async () => ok(page()));
    await loadTimelinePage(API, TOKEN, CURSOR_1, fetcher as unknown as typeof fetch);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${API.url}/v1/public/share/timeline`);
    expect(url).not.toContain(TOKEN);
    expect(init.body).toBe(JSON.stringify({ token: TOKEN, cursor: CURSOR_1 }));
    expect(init.credentials).toBe('omit');
    expect(init.referrerPolicy).toBe('no-referrer');
    expect((init.headers as Record<string, string>)['x-region']).toBe('ap-southeast-1');
  });

  it('第一页不带游标；点开一条回忆带它的 id', async () => {
    const fetcher = vi.fn(async (url: string) =>
      ok(url.endsWith('/moment') ? momentFiles() : page()),
    );
    expect(
      (await loadTimelinePage(API, TOKEN, undefined, fetcher as unknown as typeof fetch)).kind,
    ).toBe('ok');
    const momentId = '00000000-0000-4000-8000-0000000000aa';
    expect(
      (await loadTimelineMoment(API, TOKEN, momentId, fetcher as unknown as typeof fetch)).kind,
    ).toBe('ok');
    const calls = fetcher.mock.calls as unknown as [string, RequestInit][];
    expect(calls[0]?.[1].body).toBe(JSON.stringify({ token: TOKEN }));
    expect(calls[1]?.[0]).toBe(`${API.url}/v1/public/share/timeline/moment`);
    expect(calls[1]?.[1].body).toBe(JSON.stringify({ token: TOKEN, momentId }));
  });

  it('时间线的回答不能当成一天来用，一天的也不能当时间线', async () => {
    const asTimeline = await loadTimelinePage(API, TOKEN, undefined, (async () =>
      ok({ ...page(), kind: 'day' })) as unknown as typeof fetch);
    expect(asTimeline.kind).toBe('error');
  });

  it('时间线的链接 #t/令牌 不会被当成一天的令牌', () => {
    expect(readToken(`#t/${TOKEN}`)).toBeNull();
  });
});

describe('页面', () => {
  it('标题、范围和月龄；按分享者的时区分日期，同一天的放在一起，新的在前', async () => {
    const { root, timeline } = start({
      page: [
        () =>
          ok(
            page({
              entries: [
                entry({
                  id: '00000000-0000-4000-8000-000000000003',
                  at: DAY1 + 20 * HOUR,
                  title: '晚上',
                }),
                entry({
                  id: '00000000-0000-4000-8000-000000000002',
                  at: DAY1 + HOUR,
                  title: '凌晨',
                }),
                // 纽约 6 月 14 日 23:00，UTC 已经是 15 日。
                entry({
                  id: '00000000-0000-4000-8000-000000000001',
                  at: DAY1 - 90 * 60_000,
                  title: '前一天',
                  dayNumber: 14,
                }),
              ],
            }),
          ),
      ],
    });
    await timeline.load();
    expect(root.querySelector('h1')?.textContent).toBe('测试豆的成长时间线');
    expect(root.querySelector('.hero-date')?.textContent).toBe('6月1日 – 6月30日');
    expect(root.querySelector('.hero-age')?.textContent).toBe('1 个月零 2 天');
    const days = [...root.querySelectorAll('.tl-day')];
    expect(days.map((d) => d.querySelector('.tl-date')?.textContent)).toEqual([
      '6月15日 · 星期一',
      '6月14日 · 星期日',
    ]);
    expect(days[0]?.querySelector('.tl-daynum')?.textContent).toBe('第 15 天');
    expect([...days[0]!.querySelectorAll('.moment-title')].map((n) => n.textContent)).toEqual([
      '晚上',
      '凌晨',
    ]);
    expect(days[1]?.querySelector('.tl-time')?.textContent).toBe('23:00');
    expect(root.querySelector('.tl-more')?.textContent).toBe('没有更早的回忆了');
  });

  it('“全部”写着截至哪一天', async () => {
    const { root, timeline } = start({
      page: [
        () => ok(page({ range: { fromAt: 0, toAt: Date.UTC(2026, 10, 6, 5), timezone: TZ } })),
      ],
    });
    await timeline.load();
    expect(root.querySelector('.hero-date')?.textContent).toBe('全部回忆，截至 11月5日');
  });

  it('这段时间没有回忆时说清楚', async () => {
    const { root, timeline } = start({ page: [() => ok(page({ entries: [] }))] });
    await timeline.load();
    expect(root.textContent).toContain('这段时间还没有回忆');
    expect(root.querySelector('.more-button')).toBeNull();
  });

  it('链接失效只说这一句', async () => {
    const { root, timeline } = start({ page: [() => miss()] });
    await timeline.load();
    expect(root.querySelector('h1')?.textContent).toBe('这个链接已失效或已撤销');
  });

  it('英文', async () => {
    setLocale('en');
    const { root, timeline } = start({
      page: [() => ok(page({ entries: [entry({ visualCount: 3 })], nextCursor: CURSOR_1 }))],
    });
    await timeline.load();
    expect(root.querySelector('h1')?.textContent).toBe("测试豆's timeline");
    expect(root.querySelector('.hero-date')?.textContent).toBe('Jun 1 – Jun 30');
    expect(root.querySelector('.tl-count')?.textContent).toBe('3 items');
    expect(root.querySelector('.more-button')?.textContent).toBe('Load more');
  });
});

describe('加载更多', () => {
  it('点按钮带着游标取下一页，接在后面；同一天不重复标题；到底后说没有更早的了', async () => {
    const { root, timeline, calls } = start({
      page: [
        () => ok(page({ entries: [entry({ title: '第一页' })], nextCursor: CURSOR_1 })),
        () =>
          ok(
            page({
              entries: [
                entry({
                  id: '00000000-0000-4000-8000-0000000000bb',
                  at: DAY1 - HOUR * 0.25,
                  title: '同一天',
                }),
                entry({
                  id: '00000000-0000-4000-8000-0000000000cc',
                  at: DAY1 - 3 * 24 * HOUR,
                  title: '更早',
                }),
              ],
            }),
          ),
      ],
    });
    await timeline.load();
    expect(root.querySelector('.tl-more')?.textContent).toBe('加载更多');
    (root.querySelector('.more-button') as HTMLButtonElement).click();
    expect(root.querySelector('.more-button')?.textContent).toBe('正在加载…');
    await flush();
    expect(calls[1]).toEqual({
      path: '/v1/public/share/timeline',
      body: { token: TOKEN, cursor: CURSOR_1 },
    });
    expect([...root.querySelectorAll('.moment-title')].map((n) => n.textContent)).toEqual([
      '第一页',
      '同一天',
      '更早',
    ]);
    expect(root.querySelectorAll('.tl-day')).toHaveLength(2);
    expect(root.querySelector('.tl-more')?.textContent).toBe('没有更早的回忆了');
  });

  it('滑到底部时自动加载；整页都是空的回忆也接着往下取', async () => {
    const { root, timeline, watchers } = start({
      page: [
        () => ok(page({ entries: [], nextCursor: CURSOR_1 })),
        () => ok(page({ entries: [entry({ title: '后面才有' })] })),
      ],
    });
    await timeline.load();
    expect(watchers).toHaveLength(1);
    watchers[0]?.();
    await flush();
    expect(root.textContent).toContain('后面才有');
    expect(root.textContent).not.toContain('这段时间还没有回忆');
  });

  it('取下一页失败：已有的内容还在，按钮变成重试，点了能接上', async () => {
    const { root, timeline } = start({
      page: [
        () => ok(page({ nextCursor: CURSOR_1 })),
        () => {
          throw new TypeError('offline');
        },
        () => ok(page({ entries: [entry({ title: '接上了' })] })),
      ],
    });
    await timeline.load();
    (root.querySelector('.more-button') as HTMLButtonElement).click();
    await flush();
    expect(root.querySelector('.more-button')?.textContent).toBe('没能加载，点一下重试');
    expect(root.textContent).toContain('第一次翻身');
    (root.querySelector('.more-button') as HTMLButtonElement).click();
    await flush();
    expect(root.textContent).toContain('接上了');
  });

  it('翻页时链接被撤销了：整页说明失效，内容不再留着', async () => {
    const { root, timeline } = start({
      page: [() => ok(page({ nextCursor: CURSOR_1 })), () => miss()],
    });
    await timeline.load();
    (root.querySelector('.more-button') as HTMLButtonElement).click();
    await flush();
    expect(root.querySelector('h1')?.textContent).toBe('这个链接已失效或已撤销');
    expect(root.textContent).not.toContain('第一次翻身');
  });
});

describe('封面和点开', () => {
  it('只有一张照片：点封面直接放大这一张，不再请求', async () => {
    const opened: PublicMedia[][] = [];
    const { root, timeline, calls } = start(
      { page: [() => ok(page())] },
      { photo: record(opened) },
    );
    await timeline.load();
    const img = root.querySelector('.tl-cover img') as HTMLImageElement;
    expect(img.getAttribute('src')).toContain('thumb.jpg');
    (root.querySelector('.tl-cover button') as HTMLButtonElement).click();
    await flush();
    expect(opened[0]?.map((m) => m.id)).toEqual([media().id]);
    expect(calls).toHaveLength(1);
  });

  it('只有一个视频：就在时间线上播放，封面是缩略图', async () => {
    const video = media({
      kind: 'video',
      url: 'https://files.fictional.test/v.mp4',
      durationMs: 65_000,
    });
    const { root, timeline } = start({
      page: [() => ok(page({ entries: [entry({ cover: video })] }))],
    });
    await timeline.load();
    const element = root.querySelector('.tl-cover video') as HTMLVideoElement;
    expect(element.getAttribute('src')).toBe(video.url);
    expect(element.getAttribute('poster')).toBe(video.thumbUrl);
    expect(root.querySelector('.tl-cover .duration')?.textContent).toBe('▶ 1:05');
  });

  it('好几项：封面写着共几项，点开整条回忆，照片排成相册，录音能播放；Esc 和关闭按钮都能关', async () => {
    const opened: PublicMedia[][] = [];
    const { root, timeline, calls } = start(
      {
        page: [() => ok(page({ entries: [entry({ visualCount: 2, audioCount: 1 })] }))],
        moment: [() => ok(momentFiles()), () => ok(momentFiles())],
      },
      { photo: record(opened) },
    );
    await timeline.load();
    expect(root.querySelector('.tl-count')?.textContent).toBe('共 2 项');
    expect(root.querySelector('.tl-audio')?.textContent).toBe('▶ 1 段录音');
    (root.querySelector('.tl-cover button') as HTMLButtonElement).click();
    await flush();
    expect(calls[1]).toEqual({
      path: '/v1/public/share/timeline/moment',
      body: { token: TOKEN, momentId: entry().id },
    });
    const sheet = document.querySelector('.sheet') as HTMLElement;
    expect(sheet.getAttribute('role')).toBe('dialog');
    expect(sheet.querySelector('.moment-title')?.textContent).toBe('第一次翻身');
    expect(sheet.querySelectorAll('.gallery img')).toHaveLength(2);
    expect(sheet.querySelector('audio')?.getAttribute('src')).toBe(
      'https://files.fictional.test/a.m4a',
    );
    expect(document.documentElement.classList.contains('sheet-open')).toBe(true);
    (sheet.querySelectorAll('.gallery button')[1] as HTMLButtonElement).click();
    await flush();
    expect(opened[0]?.map((m) => m.id)).toEqual(['p1', 'p2']);

    const audio = sheet.querySelector('audio') as HTMLAudioElement;
    const paused = vi.fn();
    audio.pause = paused;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.querySelector('.sheet')).toBeNull();
    // 拿掉的录音要先停下，不然在浏览器里还会接着放。
    expect(paused).toHaveBeenCalled();
    expect(document.documentElement.classList.contains('sheet-open')).toBe(false);

    (root.querySelector('.tl-audio') as HTMLButtonElement).click();
    await flush();
    (document.querySelector('.sheet-close') as HTMLButtonElement).click();
    expect(document.querySelector('.sheet')).toBeNull();
  });

  it('点开时链接已经失效：关掉这一层，整页说明失效', async () => {
    const { root, timeline } = start({
      page: [() => ok(page({ entries: [entry({ visualCount: 2 })] }))],
      moment: [() => miss()],
    });
    await timeline.load();
    (root.querySelector('.tl-cover button') as HTMLButtonElement).click();
    await flush();
    expect(document.querySelector('.sheet')).toBeNull();
    expect(root.querySelector('h1')?.textContent).toBe('这个链接已失效或已撤销');
  });

  it('点开时断网：这一层里能重试', async () => {
    const { root, timeline } = start({
      page: [() => ok(page({ entries: [entry({ visualCount: 2 })] }))],
      moment: [
        () => {
          throw new TypeError('offline');
        },
        () => ok(momentFiles()),
      ],
    });
    await timeline.load();
    (root.querySelector('.tl-cover button') as HTMLButtonElement).click();
    await flush();
    const retry = document.querySelector('.sheet .more-button') as HTMLButtonElement;
    expect(retry.textContent).toBe('没能加载，点一下重试');
    retry.click();
    await flush();
    expect(document.querySelectorAll('.sheet .gallery img')).toHaveLength(2);
  });

  it('文件放不下时如实说', async () => {
    const { root, timeline } = start({
      page: [() => ok(page({ entries: [entry({ visualCount: 2 })] }))],
      moment: [() => ok(momentFiles({ omittedMedia: 3 }))],
    });
    await timeline.load();
    (root.querySelector('.tl-cover button') as HTMLButtonElement).click();
    await flush();
    expect(document.querySelector('.sheet')?.textContent).toContain('还有 3 个文件这里放不下');
  });
});

describe('链接过期', () => {
  const signed = (generation: number) =>
    media({
      url: `https://files.fictional.test/p.jpg?gen=${generation}`,
      thumbUrl: `https://files.fictional.test/t.jpg?gen=${generation}`,
    });
  const breakImage = (img: HTMLImageElement) => {
    img.dispatchEvent(new Event('error'));
    img.dispatchEvent(new Event('error'));
  };

  it('第二页的封面打不开：用那一页的游标重新取，只换这一批', async () => {
    const clock = { now: 1_000_000 };
    const second = (generation: number) =>
      ok(page({ entries: [entry({ title: '第二页', cover: signed(generation) })] }));
    const { root, timeline, calls } = start(
      {
        page: [
          () =>
            ok(
              page({
                entries: [entry({ id: '00000000-0000-4000-8000-0000000000dd' })],
                nextCursor: CURSOR_1,
              }),
            ),
          () => second(1),
          () => second(2),
        ],
      },
      { clock },
    );
    await timeline.load();
    (root.querySelector('.more-button') as HTMLButtonElement).click();
    await flush();
    clock.now += HOUR;
    const img = root.querySelectorAll('.tl-cover img')[1] as HTMLImageElement;
    breakImage(img);
    await flush();
    expect(calls[2]).toEqual({
      path: '/v1/public/share/timeline',
      body: { token: TOKEN, cursor: CURSOR_1 },
    });
    expect(img.getAttribute('src')).toContain('gen=2');
  });

  it('放大前链接快过期：先换一批新的再打开', async () => {
    const clock = { now: 1_000_000 };
    const urls: PublicMedia[][] = [];
    const { root, timeline } = start(
      {
        page: [
          () => ok(page({ entries: [entry({ cover: signed(1) })] })),
          () => ok(page({ entries: [entry({ cover: signed(2) })] })),
        ],
      },
      { clock, photo: record(urls) },
    );
    await timeline.load();
    clock.now += 56 * 60_000;
    (root.querySelector('.tl-cover button') as HTMLButtonElement).click();
    await flush();
    expect(urls[0]?.[0]?.url).toContain('gen=2');
  });
});

describe('安全：用户写的内容只能是文字', () => {
  it('名字、标题、正文、记录人不会变成元素，打开的那一层也一样', async () => {
    const hostile = entry({
      title: XSS_NAME,
      text: XSS_NOTE,
      byName: XSS_NOTE,
      visualCount: 2,
    });
    const { root, timeline } = start({
      page: [() => ok(page({ baby: { name: XSS_NAME, age: null }, entries: [hostile] }))],
      moment: [() => ok(momentFiles({ media: [] }))],
    });
    await timeline.load();
    (root.querySelector('.tl-cover button') as HTMLButtonElement).click();
    await flush();
    for (const scope of [root, document.querySelector('.sheet') as HTMLElement]) {
      expect(scope.querySelector('[onerror]')).toBeNull();
      expect(scope.querySelector('script')).toBeNull();
      expect(scope.querySelector('a')).toBeNull();
      expect(scope.textContent).toContain(XSS_NOTE);
    }
    expect(root.textContent).toContain(XSS_NAME);
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it('封面和文件的地址只收 https：javascript:、data:、http 都不会写进页面', async () => {
    const bad = [
      'javascript:alert(1)',
      'data:image/svg+xml,<svg onload=alert(1)>',
      'http://files.fictional.test/x.jpg',
    ];
    const { root, timeline } = start({
      page: [
        () =>
          ok(
            page({
              entries: bad.map((url, index) =>
                entry({
                  id: `00000000-0000-4000-8000-00000000000${index}`,
                  cover: media({ id: `c${index}`, url, thumbUrl: url }),
                  visualCount: 2,
                }),
              ),
            }),
          ),
      ],
      moment: [
        () =>
          ok(
            momentFiles({
              media: bad.flatMap((url, index) => [
                media({ id: `m${index}`, url, thumbUrl: url }),
                media({ id: `v${index}`, kind: 'video', url, thumbUrl: url }),
                media({ id: `a${index}`, kind: 'audio', url, thumbUrl: null }),
              ]),
            }),
          ),
      ],
    });
    await timeline.load();
    (root.querySelector('.tl-cover button') as HTMLButtonElement).click();
    await flush();
    const html = `${root.innerHTML}${document.querySelector('.sheet')?.innerHTML ?? ''}`;
    for (const url of bad) expect(html).not.toContain(url.slice(0, 20));
    expect(root.textContent).toContain('这个文件暂时打不开');
  });
});
