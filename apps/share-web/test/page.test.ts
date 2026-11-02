import { setLocale } from '@xiaodouya/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadShare } from '../src/api';
import { createSharePage } from '../src/page';
import { FROM, flush, media, share } from './fixtures';

const TOKEN = 'A'.repeat(43);
const API = { url: 'https://abc.supabase.co/functions/v1/api', region: 'ap-southeast-1' };

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
const miss = () =>
  new Response(JSON.stringify({ error: { code: 'share_unavailable', message: 'x' } }), {
    status: 404,
  });

beforeEach(() => {
  setLocale('zh');
});

describe('请求', () => {
  it('令牌只在请求体里，不带凭据和 Referer，固定地区', async () => {
    const fetcher = vi.fn(async () => ok(share()));
    const result = await loadShare(API, TOKEN, fetcher as unknown as typeof fetch);
    expect(result.kind).toBe('ok');
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${API.url}/v1/public/share`);
    expect(url).not.toContain(TOKEN);
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ token: TOKEN }));
    expect(init.credentials).toBe('omit');
    expect(init.referrerPolicy).toBe('no-referrer');
    expect((init.headers as Record<string, string>)['x-region']).toBe('ap-southeast-1');
  });

  it('不是 Supabase 函数的地址不发地区头：预检和别的服务端用不上', async () => {
    const fetcher = vi.fn(async () => ok(share()));
    await loadShare(
      { url: 'https://api.fictional.test', region: 'ap-southeast-1' },
      TOKEN,
      fetcher as unknown as typeof fetch,
    );
    const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)['x-region']).toBeUndefined();
  });

  it('只有接口明确说失效才算失效；别的 404、429、断网、内容不对各走各的', async () => {
    const load = (fetcher: () => Promise<Response>) =>
      loadShare(API, TOKEN, fetcher as unknown as typeof fetch);
    expect((await load(async () => miss())).kind).toBe('invalid');
    // 公共 Wi-Fi 的登录页、后端还没部署，不能告诉对方“链接已撤销”。
    expect((await load(async () => new Response('<html>', { status: 404 }))).kind).toBe('error');
    expect((await load(async () => new Response('{}', { status: 429 }))).kind).toBe('busy');
    expect((await load(async () => new Response('{}', { status: 500 }))).kind).toBe('error');
    expect(
      (
        await load(async () => {
          throw new TypeError('offline');
        })
      ).kind,
    ).toBe('error');
    expect((await load(async () => ok({ nope: true }))).kind).toBe('error');
    expect((await load(async () => new Response('<html>', { status: 200 }))).kind).toBe('error');
  });
});

describe('三种状态', () => {
  const start = (fetcher: () => Promise<Response>, token: string | null = TOKEN) => {
    const root = document.createElement('main');
    const page = createSharePage({
      root,
      token,
      api: API,
      allowLocalHttp: false,
      fetcher: fetcher as unknown as typeof fetch,
      now: () => Date.now(),
    });
    return { root, page };
  };

  it('加载中，然后内容', async () => {
    const { root, page } = start(async () => ok(share()));
    const done = page.load();
    expect(root.querySelector('.skeleton')).not.toBeNull();
    await done;
    expect(root.querySelector('h1')?.textContent).toBe('测试豆的第 15 天');
  });

  it('链接失效只说这一句，不说是过期还是撤销', async () => {
    const { root, page } = start(async () => miss());
    await page.load();
    expect(root.querySelector('h1')?.textContent).toBe('这个链接已失效或已撤销');
    expect(root.querySelector('button')).toBeNull();
    expect(root.textContent).not.toContain('过期');
  });

  it('地址里没有令牌时也是失效，不发请求', async () => {
    const fetcher = vi.fn(async () => ok(share()));
    const { root, page } = start(fetcher, null);
    await page.load();
    expect(fetcher).not.toHaveBeenCalled();
    expect(root.querySelector('h1')?.textContent).toBe('这个链接已失效或已撤销');
  });

  it('网络错误能重试，重试后显示内容', async () => {
    let online = false;
    const { root, page } = start(async () => {
      if (!online) throw new TypeError('offline');
      return ok(share());
    });
    await page.load();
    expect(root.querySelector('h1')?.textContent).toBe('暂时打不开');
    online = true;
    (root.querySelector('button') as HTMLButtonElement).click();
    await flush();
    expect(root.querySelector('h1')?.textContent).toBe('测试豆的第 15 天');
  });

  it('打开太频繁时说明情况，也能重试', async () => {
    const { root, page } = start(async () => new Response('{}', { status: 429 }));
    await page.load();
    expect(root.textContent).toContain('打开的次数有点多');
    expect(root.querySelector('button')).not.toBeNull();
  });
});

describe('页面开了很久，链接过期', () => {
  const setup = (responses: (() => Response | Promise<Response>)[], start = 1_000_000) => {
    let clock = start;
    const fetcher = vi.fn(async () => {
      const next = responses.shift();
      if (!next) throw new Error('没有更多响应');
      return next();
    });
    const root = document.createElement('main');
    const page = createSharePage({
      root,
      token: TOKEN,
      api: API,
      allowLocalHttp: false,
      fetcher: fetcher as unknown as typeof fetch,
      now: () => clock,
    });
    return {
      root,
      page,
      fetcher,
      advance: (ms: number) => {
        clock += ms;
      },
    };
  };
  const HOUR = 3_600_000;
  const signed = (generation: number) =>
    media({
      url: `https://files.fictional.test/original.jpg?gen=${generation}`,
      thumbUrl: `https://files.fictional.test/thumb.jpg?gen=${generation}`,
    });
  const withFile = (generation: number, file = signed(generation)) =>
    share({ moments: [{ at: FROM, title: '虚构', text: '', milestone: false, media: [file] }] });

  const breakImage = (img: HTMLImageElement) => {
    img.dispatchEvent(new Event('error'));
    img.dispatchEvent(new Event('error'));
  };

  it('图片加载失败时重新取一次数据，换上新链接，不再请求第二次', async () => {
    const { root, page, fetcher, advance } = setup([() => ok(withFile(1)), () => ok(withFile(2))]);
    await page.load();
    advance(HOUR + 1000);
    const img = root.querySelector('.gallery img') as HTMLImageElement;
    breakImage(img);
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(img.getAttribute('src')).toContain('gen=2');
    expect(root.textContent).not.toContain('暂时打不开');
  });

  it('好几张同时失败只取一次', async () => {
    const two = () =>
      share({
        moments: [
          {
            at: FROM,
            title: '',
            text: '',
            milestone: false,
            media: [media({ id: 'a' }), media({ id: 'b' })],
          },
        ],
      });
    const { root, page, fetcher, advance } = setup([() => ok(two()), () => ok(two())]);
    await page.load();
    advance(HOUR);
    for (const img of root.querySelectorAll('.gallery img')) breakImage(img as HTMLImageElement);
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('刚取过还打不开，就是文件本身的问题：不反复请求，显示可重试的提示，点了能恢复', async () => {
    const { root, page, fetcher, advance } = setup([() => ok(withFile(1)), () => ok(withFile(2))]);
    await page.load();
    const img = root.querySelector('.gallery img') as HTMLImageElement;
    breakImage(img);
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(root.textContent).toContain('这个文件暂时打不开');
    advance(60_000);
    (root.querySelector('.media-broken') as HTMLElement).click();
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(root.querySelector('.media-broken')).toBeNull();
    expect((root.querySelector('.gallery img') as HTMLImageElement).getAttribute('src')).toContain(
      'gen=2',
    );
  });

  it('重新取的时候发现链接被撤销了，页面说明失效，内容不再留着', async () => {
    const { root, page, advance } = setup([() => ok(withFile(1)), () => miss()]);
    await page.load();
    advance(HOUR);
    breakImage(root.querySelector('.gallery img') as HTMLImageElement);
    await flush();
    expect(root.querySelector('h1')?.textContent).toBe('这个链接已失效或已撤销');
    expect(root.textContent).not.toContain('测试豆');
  });

  it('重新取的时候断网：内容还在，文件显示可重试', async () => {
    const { root, page, advance } = setup([
      () => ok(withFile(1)),
      () => {
        throw new TypeError('offline');
      },
    ]);
    await page.load();
    advance(HOUR);
    breakImage(root.querySelector('.gallery img') as HTMLImageElement);
    await flush();
    expect(root.querySelector('h1')?.textContent).toBe('测试豆的第 15 天');
    expect(root.textContent).toContain('这个文件暂时打不开');
  });

  it('视频过期：换上新链接', async () => {
    const video = (generation: number) =>
      withFile(generation, { ...signed(generation), kind: 'video' });
    const { root, page, advance } = setup([() => ok(video(1)), () => ok(video(2))]);
    await page.load();
    advance(HOUR);
    const element = root.querySelector('video') as HTMLVideoElement;
    element.load = () => {};
    element.dispatchEvent(new Event('error'));
    await flush();
    expect(element.getAttribute('src')).toContain('gen=2');
  });

  it('放大看图时链接快过期：先换一批新链接再打开', async () => {
    const opened: string[] = [];
    const root = document.createElement('main');
    const responses = [() => ok(withFile(1)), () => ok(withFile(2))];
    let clock = 1_000_000;
    const page = createSharePage({
      root,
      token: TOKEN,
      api: API,
      allowLocalHttp: false,
      now: () => clock,
      fetcher: (async () => responses.shift()?.()) as unknown as typeof fetch,
      photo: (items) => {
        opened.push(items[0]?.url ?? '');
        return () => {};
      },
    });
    await page.load();
    (root.querySelector('.gallery button') as HTMLButtonElement).click();
    expect(opened[0]).toContain('gen=1');
    clock += 56 * 60_000;
    (root.querySelector('.gallery button') as HTMLButtonElement).click();
    await flush();
    expect(opened[1]).toContain('gen=2');
  });

  it('并排的两张删掉一张，另一张还在', async () => {
    const pair = (ids: string[]) =>
      share({
        moments: [
          {
            at: FROM,
            title: '',
            text: '虚构',
            milestone: false,
            media: ids.map((id) => media({ id, width: 300, height: 400 })),
          },
        ],
      });
    const { root, page, advance } = setup([() => ok(pair(['a', 'b'])), () => ok(pair(['b']))]);
    await page.load();
    advance(HOUR);
    breakImage(root.querySelectorAll('.gallery img')[0] as HTMLImageElement);
    await flush();
    expect(root.querySelectorAll('.gallery img')).toHaveLength(1);
  });

  it('文件在这期间被删了：那一格去掉，其他内容不动', async () => {
    const { root, page, advance } = setup([
      () => ok(withFile(1)),
      () =>
        ok(
          share({ moments: [{ at: FROM, title: '虚构', text: '', milestone: false, media: [] }] }),
        ),
    ]);
    await page.load();
    advance(HOUR);
    breakImage(root.querySelector('.gallery img') as HTMLImageElement);
    await flush();
    expect(root.querySelector('.gallery img')).toBeNull();
    expect(root.textContent).toContain('虚构');
  });
});
