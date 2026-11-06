import { describe, expect, it } from 'vitest';
import {
  collectionSchemas,
  defaultResourceTitle,
  deleteConfirmText,
  EventData,
  type FavoriteData,
  type FavoriteFolderData,
  favoriteFolderCounts,
  favoriteIdFor,
  favoriteItems,
  isFavoriteData,
  isFavoriteFolderData,
  isLibraryData,
  isResourceData,
  MAX_RESOURCE_URL,
  normalizeResourceUrl,
  parseCollectionData,
  parseSharedText,
  type ResourceData,
  resourceSource,
  resourceSourceLabel,
  resourceSources,
  sortedFolders,
  withFolderToggled,
  withLocale,
} from '../src/index';

const resource = (extra: Partial<ResourceData> = {}): ResourceData => ({
  type: 'resource',
  url: 'https://b23.tv/AbC1234',
  title: '虚构的睡眠视频',
  addedAt: 1000,
  ...extra,
});
const favorite = (targetId: string, extra: Partial<FavoriteData> = {}): FavoriteData => ({
  type: 'favorite',
  target: 'resource',
  targetId,
  addedAt: 1000,
  ...extra,
});
const folder = (name: string, createdAt = 1000): FavoriteFolderData => ({
  type: 'favorite-folder',
  name,
  createdAt,
});

const ID = {
  r1: '0b6f2a8e-1c3d-4e5f-8a9b-0c1d2e3f4a5b',
  r2: '1c7a3b9f-2d4e-4f60-9bac-1d2e3f4a5b6c',
  m1: '2d8b4cae-3e5f-4071-acbd-2e3f4a5b6c7d',
  f1: '3e9c5dbf-4f60-4182-bdce-3f4a5b6c7d8e',
  f2: '4fad6ec0-5071-4293-8edf-4a5b6c7d8e9f',
};

describe('记录的格式', () => {
  it('资料、收藏、收藏夹都放在 event 集合里，不带 at', () => {
    for (const data of [resource({ note: '虚构的备注' }), favorite(ID.r1), folder('辅食')]) {
      expect(parseCollectionData('event', data)).toEqual(data);
      expect('at' in data).toBe(false);
      expect(isLibraryData(data)).toBe(true);
    }
    expect(isResourceData(resource())).toBe(true);
    expect(isFavoriteData(favorite(ID.r1))).toBe(true);
    expect(isFavoriteFolderData(folder('辅食'))).toBe(true);
  });

  it('不是照护记录：EventData 不认识它们，旧版的时间线、提示、推送都会跳过', () => {
    for (const data of [resource(), favorite(ID.r1), folder('辅食')]) {
      expect(EventData.safeParse(data).success).toBe(false);
      // 就算以后的版本带上 at，也不能被当成照护记录
      expect(EventData.safeParse({ ...data, at: 1000 }).success).toBe(false);
    }
    expect(isLibraryData({ type: 'feed', at: 1, ml: 90 })).toBe(false);
    expect(isLibraryData(null)).toBe(false);
  });

  it('链接只收 http 和 https，长度有上限', () => {
    for (const url of [
      'javascript:alert(1)',
      'file:///data/data/x',
      'intent://x#Intent;end',
      'not a url',
      `https://example.com/${'a'.repeat(MAX_RESOURCE_URL)}`,
    ]) {
      expect(parseCollectionData('event', resource({ url }))).toBeNull();
    }
    expect(
      parseCollectionData('event', resource({ url: 'http://xhslink.com/a/x' })),
    ).not.toBeNull();
  });

  it('标题不能是空的；可选项格式不对只丢这一项，未知字段原样保留', () => {
    expect(parseCollectionData('event', resource({ title: '' }))).toBeNull();
    const loose = { ...resource(), note: 42, future: 'kept' };
    expect(parseCollectionData('event', loose)).toEqual({ ...resource(), future: 'kept' });
    const fav = { ...favorite(ID.r1), folders: 'oops' };
    expect(parseCollectionData('event', fav)).toEqual(favorite(ID.r1));
  });

  it('收藏的目标格式不对整条不显示；不认识的目标类型保留但界面跳过', () => {
    expect(parseCollectionData('event', favorite('not-a-uuid'))).toBeNull();
    expect(parseCollectionData('event', { ...favorite(ID.r1), target: 'letter' })).not.toBeNull();
  });

  it('收藏夹名字不能是空的', () => {
    expect(parseCollectionData('event', folder(''))).toBeNull();
    expect(collectionSchemas.event.safeParse(folder('睡眠')).success).toBe(true);
  });
});

describe('按域名认来源', () => {
  const cases: [string, string][] = [
    ['https://v.douyin.com/iRNBqXyz/', 'douyin'],
    ['https://www.douyin.com/video/7300000000000000000', 'douyin'],
    ['https://www.iesdouyin.com/share/video/1/', 'douyin'],
    ['https://b23.tv/AbC1234', 'bilibili'],
    ['https://www.bilibili.com/video/BV1xx411c7mD', 'bilibili'],
    ['https://m.bilibili.com/video/BV1xx411c7mD', 'bilibili'],
    ['https://youtu.be/dQw4w9WgXcQ?si=abc', 'youtube'],
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'youtube'],
    ['https://m.youtube.com/shorts/abc', 'youtube'],
    ['http://xhslink.com/a/AbCdEf', 'xiaohongshu'],
    ['https://www.xiaohongshu.com/explore/64f0', 'xiaohongshu'],
    ['https://WWW.YOUTUBE.COM/watch?v=x', 'youtube'],
    ['https://www.who.int/health-topics/breastfeeding', 'other'],
    // 只按主机名的结尾认，并且要在点的边界上
    ['https://notyoutube.com/watch', 'other'],
    ['https://youtu.be.evil.example/x', 'other'],
    ['https://evil.example/?u=https://youtu.be/x', 'other'],
    ['https://b23.tv.example.com/x', 'other'],
    ['https://user:pass@xhslink.com.evil.example/', 'other'],
    ['not a url', 'other'],
  ];
  for (const [url, source] of cases) {
    it(`${url} → ${source}`, () => {
      expect(resourceSource(url)).toBe(source);
    });
  }

  it('每个来源都有中英文名字和默认标题', () => {
    for (const source of resourceSources) {
      for (const locale of ['zh', 'en'] as const) {
        withLocale(locale, () => {
          expect(resourceSourceLabel(source).length).toBeGreaterThan(0);
          expect(defaultResourceTitle(source).length).toBeGreaterThan(0);
        });
      }
    }
    expect(withLocale('zh', () => resourceSourceLabel('bilibili'))).toBe('B站');
    expect(withLocale('en', () => resourceSourceLabel('bilibili'))).toBe('Bilibili');
  });
});

describe('整理用户输入的链接', () => {
  it('去掉首尾空白，没写协议的补上 https', () => {
    expect(normalizeResourceUrl('  https://b23.tv/AbC  ')).toBe('https://b23.tv/AbC');
    expect(normalizeResourceUrl('b23.tv/AbC')).toBe('https://b23.tv/AbC');
    expect(normalizeResourceUrl('www.who.int')).toBe('https://www.who.int');
  });
  it('不是网页链接的不收', () => {
    for (const input of ['', '   ', 'hello', 'javascript:alert(1)', 'ftp://x.com/a', '宝宝辅食']) {
      expect(normalizeResourceUrl(input)).toBeNull();
    }
  });
  it('一整段分享文字也能取出链接', () => {
    expect(normalizeResourceUrl('【睡眠-哔哩哔哩】 https://b23.tv/AbC1234')).toBe(
      'https://b23.tv/AbC1234',
    );
  });
});

describe('从分享的文字里取链接和标题', () => {
  it('B站：标题在【】里，去掉“-哔哩哔哩”', () => {
    expect(parseSharedText('【宝宝睡眠训练的方法-哔哩哔哩】 https://b23.tv/AbC1234')).toEqual({
      url: 'https://b23.tv/AbC1234',
      title: '宝宝睡眠训练的方法',
    });
  });

  it('抖音：取作品描述，去掉口令和结尾的话题', () => {
    const text =
      '7.94 复制打开抖音，看看【小豆芽的作品】6个月宝宝第一口辅食怎么做 # 辅食 # 育儿 https://v.douyin.com/iRNBqXyz/ 08/16 Kjc:/ g@O.Kj ';
    expect(parseSharedText(text)).toEqual({
      url: 'https://v.douyin.com/iRNBqXyz/',
      title: '6个月宝宝第一口辅食怎么做',
    });
  });

  it('抖音：没有描述时用【】里的', () => {
    const text = '3.02 复制打开抖音，看看【小豆芽的作品】 https://v.douyin.com/iABC/ ';
    expect(parseSharedText(text)?.title).toBe('小豆芽的作品');
  });

  it('小红书：链接后面的提示不算标题，链接后的中文逗号不算链接', () => {
    const text =
      '宝宝辅食添加顺序 一定要收藏 http://xhslink.com/a/AbCdEf，复制本条信息，打开【小红书】App查看精彩内容！';
    expect(parseSharedText(text)).toEqual({
      url: 'http://xhslink.com/a/AbCdEf',
      title: '宝宝辅食添加顺序 一定要收藏',
    });
  });

  it('小红书：去掉表情包着的口令', () => {
    const text =
      '【宝宝湿疹护理】😆 AbCd1234 😆 http://xhslink.com/a/xyz，复制本条信息，打开【小红书】App查看精彩内容！';
    expect(parseSharedText(text)?.title).toBe('宝宝湿疹护理');
  });

  it('YouTube：只有链接，标题在分享的主题里', () => {
    expect(parseSharedText('https://youtu.be/dQw4w9WgXcQ?si=abc', 'Baby sleep tips')).toEqual({
      url: 'https://youtu.be/dQw4w9WgXcQ?si=abc',
      title: 'Baby sleep tips',
    });
    expect(parseSharedText('https://youtu.be/dQw4w9WgXcQ')).toEqual({
      url: 'https://youtu.be/dQw4w9WgXcQ',
    });
  });

  it('主题本身是链接时不当标题', () => {
    expect(parseSharedText('https://youtu.be/x', 'https://youtu.be/x')).toEqual({
      url: 'https://youtu.be/x',
    });
  });

  it('链接结尾的标点不算链接', () => {
    expect(parseSharedText('看看这个 https://www.who.int/x.')?.url).toBe('https://www.who.int/x');
    expect(parseSharedText('(https://www.who.int/x)')?.url).toBe('https://www.who.int/x');
  });

  it('没有链接时返回 null', () => {
    expect(parseSharedText('宝宝辅食')).toBeNull();
    expect(parseSharedText('')).toBeNull();
  });

  it('标题太长时截断', () => {
    const title = parseSharedText(`${'很'.repeat(300)} https://b23.tv/x`)?.title ?? '';
    expect(title.length).toBeLessThanOrEqual(100);
  });
});

describe('收藏', () => {
  it('收藏的 id 由目标算出：两台手机离线收藏同一条，是同一条记录', () => {
    const id = favoriteIdFor(ID.r1);
    expect(favoriteIdFor(ID.r1)).toBe(id);
    expect(favoriteIdFor(ID.r2)).not.toBe(id);
    // 不能和目标同一个 id：服务端不接受一个 id 换集合
    expect(id).not.toBe(ID.r1);
    // 还是合法的 UUID（zod 检查版本和变体位）
    expect(parseCollectionData('event', favorite(ID.r1))).not.toBeNull();
    expect(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id),
    ).toBe(true);
    expect(favoriteIdFor(ID.r1.toUpperCase())).toBe(id);
  });

  const entry = <T>(id: string, data: T, updatedAt = 1000) => ({ id, data, updatedAt });

  it('收藏列表：新收藏的在前，目标删掉了就不显示，不认识的目标类型跳过', () => {
    const items = favoriteItems({
      favorites: [
        entry(favoriteIdFor(ID.r1), favorite(ID.r1, { addedAt: 1000 })),
        entry(favoriteIdFor(ID.m1), favorite(ID.m1, { target: 'moment', addedAt: 3000 })),
        entry(favoriteIdFor(ID.r2), favorite(ID.r2, { addedAt: 2000 })),
        entry(favoriteIdFor(ID.f1), { ...favorite(ID.f1), target: 'letter' } as FavoriteData),
      ],
      resourceIds: new Set([ID.r1]),
      momentIds: new Set([ID.m1]),
    });
    expect(items.map((i) => [i.target, i.targetId])).toEqual([
      ['moment', ID.m1],
      ['resource', ID.r1],
    ]);
  });

  it('按收藏夹筛选，删掉的收藏夹不算', () => {
    const favorites = [
      entry(favoriteIdFor(ID.r1), favorite(ID.r1, { folders: [ID.f1, ID.f2] })),
      entry(favoriteIdFor(ID.r2), favorite(ID.r2, { folders: [ID.f2], addedAt: 500 })),
    ];
    const input = {
      favorites,
      resourceIds: new Set([ID.r1, ID.r2]),
      momentIds: new Set<string>(),
    };
    expect(favoriteItems({ ...input, folderId: ID.f1 }).map((i) => i.targetId)).toEqual([ID.r1]);
    expect(favoriteItems({ ...input, folderId: ID.f2 }).map((i) => i.targetId)).toEqual([
      ID.r1,
      ID.r2,
    ]);
    const counts = favoriteFolderCounts(favoriteItems(input), new Set([ID.f2]));
    expect(counts.get(ID.f2)).toBe(2);
    expect(counts.get(ID.f1)).toBeUndefined();
  });

  it('放进和拿出收藏夹，不重复，不动别的字段', () => {
    const base = { ...favorite(ID.r1, { folders: [ID.f1] }), future: 'kept' };
    const added = withFolderToggled(base, ID.f2);
    expect(added.folders).toEqual([ID.f1, ID.f2]);
    expect((added as typeof base).future).toBe('kept');
    expect(withFolderToggled(added, ID.f1).folders).toEqual([ID.f2]);
    expect(withFolderToggled(favorite(ID.r1), ID.f1).folders).toEqual([ID.f1]);
  });

  it('收藏夹按建的先后排', () => {
    const list = sortedFolders([
      entry(ID.f2, folder('睡眠', 2000)),
      entry(ID.f1, folder('辅食', 1000)),
    ]);
    expect(list.map((f) => f.data.name)).toEqual(['辅食', '睡眠']);
  });
});

describe('删除前确认', () => {
  it('资料和收藏夹的确认写清楚删的是什么，收藏夹里的内容不跟着删', () => {
    withLocale('zh', () => {
      const r = deleteConfirmText({ kind: 'resource', title: '虚构的睡眠视频' });
      expect(r.title).toBe('删除资料“虚构的睡眠视频”？');
      expect(r.body).toContain('撤销');
      const f = deleteConfirmText({ kind: 'favoriteFolder', name: '辅食' });
      expect(f.title).toBe('删除收藏夹“辅食”？');
      expect(f.body).toContain('还在收藏里');
    });
    withLocale('en', () => {
      expect(deleteConfirmText({ kind: 'favoriteFolder', name: 'Solids' }).title).toBe(
        'Delete the "Solids" folder?',
      );
    });
  });
});
