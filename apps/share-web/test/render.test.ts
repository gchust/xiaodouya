import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setLocale } from '@xiaodouya/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { layoutGallery } from '../src/gallery';
import { readToken, safeMediaUrl } from '../src/media';
import { type RenderContext, renderShare } from '../src/render';
import { FROM, media, share, TO } from './fixtures';

const context = (overrides: Partial<RenderContext> = {}): RenderContext => ({
  now: TO + 3_600_000,
  allowLocalHttp: false,
  onPhoto: () => {},
  onMediaFailed: () => {},
  onMediaRetry: () => {},
  ...overrides,
});

const root = () => document.createElement('div');

beforeEach(() => {
  setLocale('zh');
});

const XSS_NAME = '<img src=x onerror="window.__pwned=1">';
const XSS_NOTE = '<script>window.__pwned=1</script><a href="javascript:alert(1)">点</a>';

describe('安全：用户写的内容只能是文字', () => {
  const hostile = () =>
    share({
      baby: { name: XSS_NAME, dayNumber: 15, age: null },
      events: [
        { type: 'feed', at: FROM + 1, ml: 90, note: XSS_NOTE, byName: XSS_NAME },
        { type: 'med', at: FROM + 2, name: XSS_NAME, dose: XSS_NOTE },
        { type: 'solids', at: FROM + 3, food: XSS_NAME },
        { type: 'vaccine', at: FROM + 4, vaccineId: 'custom', name: XSS_NOTE },
      ],
      moments: [
        {
          at: FROM + 5,
          title: XSS_NAME,
          text: XSS_NOTE,
          milestone: false,
          byName: XSS_NOTE,
          media: [],
        },
      ],
    });

  it('宝宝名、备注、药名、回忆里的标签不会变成元素', () => {
    const page = root();
    renderShare(page, hostile(), context());
    expect(page.querySelector('img[onerror]')).toBeNull();
    expect(page.querySelector('[onerror]')).toBeNull();
    expect(page.querySelector('script')).toBeNull();
    expect(page.querySelector('a')).toBeNull();
    expect(page.querySelector('img')).toBeNull();
    // 原文一个字不少地显示出来。
    expect(page.textContent).toContain(XSS_NAME);
    expect(page.textContent).toContain(XSS_NOTE);
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it('媒体地址只收 https', () => {
    expect(safeMediaUrl('https://a.test/x.jpg', false)).toBe('https://a.test/x.jpg');
    for (const bad of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      ' javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'data:image/svg+xml,<svg onload=alert(1)>',
      'blob:https://a.test/1',
      'http://a.test/x.jpg',
      'file:///etc/passwd',
      '//a.test/x.jpg',
      '/x.jpg',
      '',
      null,
    ]) {
      expect(safeMediaUrl(bad, false), String(bad)).toBeNull();
    }
  });

  it('本地走查的开关也只放行本机的 http，不放行别的', () => {
    expect(safeMediaUrl('http://localhost:59000/x.jpg', true)).toBe('http://localhost:59000/x.jpg');
    expect(safeMediaUrl('http://127.0.0.1:59000/x.jpg', true)).not.toBeNull();
    expect(safeMediaUrl('http://evil.test/x.jpg', true)).toBeNull();
    expect(safeMediaUrl('javascript:alert(1)', true)).toBeNull();
    expect(safeMediaUrl('http://localhost:59000/x.jpg', false)).toBeNull();
  });

  it('不安全的地址不会进 DOM，文件显示成打不开，页面不空白', () => {
    const page = root();
    const data = share({
      moments: [
        {
          at: FROM,
          title: '虚构',
          text: '',
          milestone: false,
          media: [
            media({ id: 'a', url: 'javascript:alert(1)', thumbUrl: 'javascript:alert(2)' }),
            media({ id: 'b', kind: 'video', url: 'javascript:alert(3)', thumbUrl: 'data:x,y' }),
            media({ id: 'c', kind: 'audio', url: 'javascript:alert(4)', thumbUrl: null }),
          ],
        },
      ],
    });
    renderShare(page, data, context());
    expect(page.outerHTML).not.toContain('javascript:');
    expect(page.outerHTML).not.toContain('data:x');
    expect(page.textContent).toContain('这个文件暂时打不开');
  });

  it('源码里没有拼 HTML 的写法', () => {
    const dir = resolve(import.meta.dirname, '../src');
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.ts')) continue;
      const source = readFileSync(resolve(dir, file), 'utf8');
      for (const banned of [
        'innerHTML',
        'outerHTML',
        'insertAdjacentHTML',
        'document.write',
        'eval(',
      ]) {
        expect(source.includes(banned), `${file} 用了 ${banned}`).toBe(false);
      }
      // 第三方资源和统计。
      expect(source, file).not.toMatch(/https?:\/\/(?!localhost)[a-z]/i);
    }
  });
});

describe('令牌', () => {
  const good = 'A'.repeat(43);

  it('从片段里读，格式不对就当没有', () => {
    expect(readToken(`#${good}`)).toBe(good);
    expect(readToken('')).toBeNull();
    expect(readToken('#')).toBeNull();
    expect(readToken('#short')).toBeNull();
    expect(readToken(`#${good}&x=1`)).toBeNull();
    expect(readToken(`#${'<'.repeat(43)}`)).toBeNull();
  });
});

describe('内容', () => {
  it('标题、第几天、日期按分享者的时区，钟点也是', () => {
    const page = root();
    // FROM 是新加坡 6 月 15 日 0 点，浏览器在哪里都该这样显示。
    renderShare(page, share(), context());
    expect(page.querySelector('h1')?.textContent).toBe('测试豆的第 15 天');
    expect(page.textContent).toContain('6月15日');
    expect(page.textContent).toContain('14 天');
    expect(page.textContent).toContain('01:00');
    expect(page.textContent).toContain('喂奶 90ml');
    expect(page.textContent).toContain('喝得快');
    expect(page.textContent).toContain('妈妈');
    expect(page.textContent).toContain('第一次抬头');
    expect(page.textContent).toContain('里程碑');
    expect(page.textContent).toContain('爸爸写');
  });

  it('换一个时区，钟点和日期跟着换', () => {
    const page = root();
    renderShare(
      page,
      share({ range: { fromAt: FROM, toAt: TO, timezone: 'America/New_York' } }),
      context(),
    );
    expect(page.textContent).toContain('6月14日');
    expect(page.textContent).toContain('13:00');
  });

  it('数量用分享者选的单位，英文用英文，内置疫苗换成英文名', () => {
    setLocale('en');
    const page = root();
    renderShare(
      page,
      share({
        units: { volume: 'oz', temperature: 'f', weight: 'lb', length: 'in' },
        events: [
          { type: 'feed', at: FROM + 1, ml: 90 },
          { type: 'temp', at: FROM + 2, celsius: 38 },
          { type: 'vaccine', at: FROM + 3, vaccineId: 'sg:bcg', name: '卡介苗' },
        ],
        moments: [],
      }),
      context(),
    );
    expect(page.querySelector('h1')?.textContent).toBe('Day 15 with 测试豆');
    expect(page.textContent).toContain('oz');
    expect(page.textContent).toContain('100.4');
    expect(page.textContent).not.toContain('卡介苗');
    expect(page.textContent).toContain('BCG');
  });

  it('小结只说事实：不判断够不够，也不出现任何健康提示', () => {
    const page = root();
    const data = share({
      events: [
        { type: 'temp', at: FROM + 1, celsius: 39.5 },
        { type: 'feed', at: FROM + 2, ml: 10 },
      ],
    });
    renderShare(page, data, context());
    expect(page.textContent).toContain('体温 39.5');
    for (const hint of ['就医', '偏高', '偏少', '正常', '吃够']) {
      expect(page.textContent).not.toContain(hint);
    }
    setLocale('en');
    const english = root();
    renderShare(english, data, context());
    for (const hint of ['doctor', 'medical', 'normal', 'enough', 'seek']) {
      expect(english.textContent?.toLowerCase()).not.toContain(hint);
    }
  });

  it('小结：喂奶、尿布、睡眠的数字；只分享回忆时没有小结', () => {
    const page = root();
    renderShare(page, share(), context());
    const summary = page.querySelector('.summary');
    expect(summary?.textContent).toContain('1 次');
    expect(summary?.textContent).toContain('90ml');
    expect(summary?.textContent).toContain('2.0 小时');
    const momentsOnly = root();
    renderShare(momentsOnly, share({ events: [] }), context());
    expect(momentsOnly.querySelector('.summary')).toBeNull();
  });

  it('忘记结束的睡眠不写时长，也不算进小结', () => {
    const page = root();
    renderShare(
      page,
      share({ events: [{ type: 'sleep', at: FROM + 1 }], moments: [] }),
      context({ now: TO + 72 * 3_600_000 }),
    );
    expect(page.textContent).toContain('没有记结束时间');
    expect(page.textContent).not.toContain('已 ');
    expect(page.querySelector('.summary')).toBeNull();
  });

  it('空的一天有说明，不是一片空白', () => {
    const page = root();
    renderShare(page, share({ events: [], moments: [] }), context());
    expect(page.textContent).toContain('这一天还没有内容');
    expect(page.querySelector('h1')?.textContent).toBe('测试豆的第 15 天');
  });

  it('没有档案、出生前的日子也有像样的标题', () => {
    const noBaby = root();
    renderShare(noBaby, share({ baby: { name: '', dayNumber: null, age: null } }), context());
    expect(noBaby.querySelector('h1')?.textContent).toBe('宝宝');
    const before = root();
    renderShare(before, share({ baby: { name: '测试豆', dayNumber: -2, age: null } }), context());
    expect(before.querySelector('h1')?.textContent).toBe('测试豆，出生前 3 天');
  });

  it('放不下的文件如实说明', () => {
    const page = root();
    renderShare(page, share({ omittedMedia: 3 }), context());
    expect(page.textContent).toContain('还有 3 个文件');
  });
});

describe('文件', () => {
  const withMedia = (items: ReturnType<typeof media>[]) =>
    share({
      moments: [{ at: FROM, title: '虚构', text: '', milestone: false, media: items }],
    });

  it('图片懒加载，优先缩略图；点开走回调', () => {
    const page = root();
    const opened: number[] = [];
    renderShare(
      page,
      withMedia([media()]),
      context({ onPhoto: (_items, index) => void opened.push(index) }),
    );
    const img = page.querySelector('.gallery img') as HTMLImageElement;
    expect(img.getAttribute('loading')).toBe('lazy');
    expect(img.getAttribute('src')).toContain('thumb.jpg');
    (page.querySelector('.gallery button') as HTMLButtonElement).click();
    expect(opened).toEqual([0]);
  });

  it('视频带 controls、playsinline、preload=none，缩略图做封面', () => {
    const page = root();
    renderShare(
      page,
      withMedia([media({ id: 'v', kind: 'video', durationMs: 12_000 })]),
      context(),
    );
    const video = page.querySelector('video') as HTMLVideoElement;
    expect(video.hasAttribute('controls')).toBe(true);
    expect(video.hasAttribute('playsinline')).toBe(true);
    expect(video.getAttribute('preload')).toBe('none');
    expect(video.getAttribute('poster')).toContain('thumb.jpg');
    expect(video.getAttribute('src')).toContain('original.jpg');
    expect(page.textContent).toContain('0:12');
  });

  it('录音在时间线上，不进照片区', () => {
    const page = root();
    renderShare(
      page,
      withMedia([media({ id: 'a', kind: 'audio', thumbUrl: null, durationMs: 5000 })]),
      context(),
    );
    expect(page.querySelector('.gallery')).toBeNull();
    const audio = page.querySelector('.timeline audio') as HTMLAudioElement;
    expect(audio.hasAttribute('controls')).toBe(true);
    expect(audio.getAttribute('preload')).toBe('none');
  });

  it('缩略图打不开时先换原图，都打不开才算失败', () => {
    const page = root();
    const failed: string[] = [];
    renderShare(
      page,
      withMedia([media()]),
      context({ onMediaFailed: (slot) => void failed.push(slot.id) }),
    );
    const img = page.querySelector('.gallery img') as HTMLImageElement;
    img.dispatchEvent(new Event('error'));
    expect(img.getAttribute('src')).toContain('original.jpg');
    expect(failed).toEqual([]);
    img.dispatchEvent(new Event('error'));
    expect(failed).toEqual([media().id]);
  });
});

describe('照片排版', () => {
  const landscape = (id: string) => media({ id, width: 400, height: 300 });
  const portrait = (id: string) => media({ id, width: 300, height: 400 });
  const video = (id: string) => media({ id, kind: 'video' });
  const shape = (items: ReturnType<typeof media>[]) =>
    layoutGallery(items).map((row) => `${row.kind}:${row.items.map((i) => i.id).join('')}`);

  it('横图占一整行，竖图两张一行，落单的竖图占一整行', () => {
    expect(shape([landscape('a'), portrait('b'), portrait('c'), portrait('d')])).toEqual([
      'full:a',
      'pair:bc',
      'full:d',
    ]);
  });

  it('横竖混合不打乱时间顺序', () => {
    expect(shape([portrait('a'), landscape('b'), portrait('c')])).toEqual([
      'full:a',
      'full:b',
      'full:c',
    ]);
  });

  it('视频总是一整行，控件才点得到', () => {
    expect(shape([portrait('a'), video('v'), portrait('b'), portrait('c')])).toEqual([
      'full:a',
      'full:v',
      'pair:bc',
    ]);
  });

  it('很多张时第一张大图，其余三列；视频还是一整行', () => {
    const many = Array.from({ length: 14 }, (_, i) => landscape(String.fromCharCode(97 + i)));
    const rows = layoutGallery([...many.slice(0, 7), video('V'), ...many.slice(7)]);
    expect(rows[0]).toMatchObject({ kind: 'full' });
    expect(rows.find((r) => r.items[0]?.id === 'V')?.kind).toBe('full');
    const grid = rows.filter((r) => r.kind === 'grid');
    expect(grid.length).toBeGreaterThan(0);
    for (const row of grid) expect(row.items.length).toBeLessThanOrEqual(3);
    expect(rows.flatMap((r) => r.items).length).toBe(15);
  });

  it('没有尺寸的文件也能排', () => {
    expect(shape([media({ id: 'a', width: undefined, height: undefined })])).toEqual(['full:a']);
  });
});
