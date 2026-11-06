import type { PublicShareResponse, PublicTimelineResponse } from '@xiaodouya/shared';
import { setLocale } from '@xiaodouya/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type RenderContext, renderShare } from '../src/render';
import { createTimelinePage } from '../src/timeline';
import { share, TO } from './fixtures';

/**
 * 分享设置（F-141）：名字由服务端按链接的设置换好（隐藏时是空字符串），头像只有选了才有链接。
 * 页面要把这些如实显示出来：隐藏时写“宝宝”，称呼当普通文字，头像只收 https。数据都是虚构的。
 */

const AVATAR = 'https://s3.example/families/f/avatar/a/thumb?X-Amz-Signature=1';
const XSS = '<img src=x onerror="window.__pwned=1">';

const context = (overrides: Partial<RenderContext> = {}): RenderContext => ({
  now: TO + 3_600_000,
  allowLocalHttp: false,
  onPhoto: () => {},
  onMediaFailed: () => {},
  onMediaRetry: () => {},
  ...overrides,
});

const day = (baby: Partial<PublicShareResponse['baby']>) =>
  share({ baby: { name: '测试豆', dayNumber: 15, age: { months: 0, days: 14 }, ...baby } });

function renderDay(baby: Partial<PublicShareResponse['baby']>, allowLocalHttp = false) {
  const root = document.createElement('div');
  renderShare(root, day(baby), context({ allowLocalHttp }));
  return root;
}

const timelinePage = (
  baby: Partial<PublicTimelineResponse['baby']>,
  kind: PublicTimelineResponse['kind'] = 'timeline',
): PublicTimelineResponse => ({
  kind,
  baby: { name: '测试豆', age: null, ...baby },
  range: { fromAt: Date.UTC(2026, 5, 1), toAt: Date.UTC(2026, 5, 15), timezone: 'Asia/Singapore' },
  entries: [],
  nextCursor: null,
  mediaExpiresIn: 3600,
});

async function renderTimeline(body: PublicTimelineResponse) {
  const root = document.createElement('main');
  document.body.append(root);
  const page = createTimelinePage({
    root,
    token: 'T'.repeat(43),
    api: { url: 'https://abc.supabase.co/functions/v1/api', region: 'ap-southeast-1' },
    allowLocalHttp: false,
    fetcher: (async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch,
    now: () => Date.UTC(2026, 10, 5),
    photo: () => () => {},
    watch: () => () => {},
  });
  await page.load();
  return root;
}

beforeEach(() => {
  setLocale('zh');
});
afterEach(() => {
  document.body.replaceChildren();
});

describe('一天的页面', () => {
  it('不显示名字时写“宝宝”，第几天照样写', () => {
    expect(renderDay({ name: '' }).querySelector('h1')?.textContent).toBe('宝宝的第 15 天');
    expect(renderDay({ name: '', dayNumber: -2 }).querySelector('h1')?.textContent).toBe(
      '宝宝，出生前 3 天',
    );
  });

  it('英文同样换成 Baby', () => {
    setLocale('en');
    expect(renderDay({ name: '' }).querySelector('h1')?.textContent).toBe('Day 15 with Baby');
  });

  it('称呼原样当文字显示', () => {
    expect(renderDay({ name: '小宝' }).querySelector('h1')?.textContent).toBe('小宝的第 15 天');
    const hostile = renderDay({ name: XSS });
    expect(hostile.querySelector('[onerror]')).toBeNull();
    expect(hostile.querySelector('h1')?.textContent).toContain(XSS);
  });

  it('有头像链接时在顶上显示，alt 不写名字', () => {
    const root = renderDay({ avatarUrl: AVATAR });
    const img = root.querySelector<HTMLImageElement>('header img.hero-avatar');
    expect(img?.getAttribute('src')).toBe(AVATAR);
    expect(img?.alt).toBe('宝宝的头像');
  });

  it('没有头像（旧服务端、没选、没设置）时不放图片', () => {
    for (const avatarUrl of [undefined, null]) {
      expect(renderDay({ avatarUrl }).querySelector('.hero-avatar')).toBeNull();
    }
  });

  it('头像只收 https；本机走查构建才收本机的 http', () => {
    for (const bad of ['http://s3.example/a', 'javascript:alert(1)', 'data:image/png;base64,AA']) {
      expect(renderDay({ avatarUrl: bad }).querySelector('.hero-avatar')).toBeNull();
    }
    const local = renderDay({ avatarUrl: 'http://localhost:59000/a' }, true);
    expect(local.querySelector('.hero-avatar')).not.toBeNull();
  });

  it('头像打不开时去掉，不留破图', () => {
    const root = renderDay({ avatarUrl: AVATAR });
    const img = root.querySelector('.hero-avatar');
    expect(img).not.toBeNull();
    img?.dispatchEvent(new Event('error'));
    expect(root.querySelector('.hero-avatar')).toBeNull();
    expect(root.querySelector('h1')?.textContent).toBe('测试豆的第 15 天');
  });
});

describe('时间线和回忆的页面', () => {
  it('不显示名字时写“宝宝”', async () => {
    const timeline = await renderTimeline(timelinePage({ name: '' }));
    expect(timeline.querySelector('h1')?.textContent).toBe('宝宝的成长时间线');
    const moments = await renderTimeline(timelinePage({ name: '' }, 'moments'));
    expect(moments.querySelector('h1')?.textContent).toBe('宝宝的回忆');
  });

  it('称呼和头像', async () => {
    const root = await renderTimeline(timelinePage({ name: '小宝', avatarUrl: AVATAR }));
    expect(root.querySelector('h1')?.textContent).toBe('小宝的成长时间线');
    expect(root.querySelector('header img.hero-avatar')?.getAttribute('src')).toBe(AVATAR);
  });

  it('没有头像时不放图片', async () => {
    const root = await renderTimeline(timelinePage({ avatarUrl: null }));
    expect(root.querySelector('.hero-avatar')).toBeNull();
  });
});
