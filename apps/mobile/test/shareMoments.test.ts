import { type MomentData, type ShareSummary, withLocale } from '@xiaodouya/shared';
import { describe, expect, it } from 'vitest';
import {
  shareLinkTitle,
  shareLinkUrl,
  shareMomentsPending,
  shareMomentsRange,
  shareMomentsTitle,
  toggleSelection,
} from '../src/lib/share';

/** 分享回忆（F-136）：选中的回忆、链接、标题、还没传完的。数据都是虚构的。 */

const TOKEN = 'A'.repeat(43);

const moment = (id: string, at: number, title = '', media: string[] = [], dirty = false) => ({
  id,
  dirty,
  data: {
    title,
    text: '',
    at,
    milestone: false,
    media: media.map((file) => ({ id: file, kind: 'image' as const })),
  } as MomentData,
});

describe('链接', () => {
  it('回忆的链接是 #m/令牌', () => {
    expect(shareLinkUrl('https://share.example.test/', TOKEN, 'moments')).toBe(
      `https://share.example.test/#m/${TOKEN}`,
    );
  });
});

describe('范围', () => {
  it('从最早一段的时刻到最晚一段之后 1 毫秒，顺序不影响', () => {
    expect(shareMomentsRange([moment('b', 5000), moment('a', 1000), moment('c', 3000)])).toEqual({
      fromAt: 1000,
      toAt: 5001,
    });
    expect(shareMomentsRange([moment('a', 1000)])).toEqual({ fromAt: 1000, toAt: 1001 });
  });
});

describe('标题', () => {
  const moments = [moment('a', 1000, '第一次笑'), moment('b', 2000, ''), moment('c', 3000, 'x')];

  it('一段写它的标题，没有标题写“这一刻”；几段写段数', () => {
    withLocale('zh', () => {
      expect(shareMomentsTitle(['a'], moments)).toBe('第一次笑');
      expect(shareMomentsTitle(['b'], moments)).toBe('这一刻');
      expect(shareMomentsTitle(['a', 'c'], moments)).toBe('2 段回忆');
      // 手机上找不到（别的家人刚删掉）也不出错。
      expect(shareMomentsTitle(['zzz'], moments)).toBe('1 段回忆');
    });
    withLocale('en', () => {
      expect(shareMomentsTitle(['a', 'b', 'c'], moments)).toBe('3 moments');
      expect(shareMomentsTitle(['b'], moments)).toBe('This moment');
    });
  });

  it('已分享的链接里写“回忆 · …”；旧服务端没有选中的 id 时只写回忆', () => {
    const summary = (overrides: Partial<ShareSummary>): ShareSummary => ({
      id: 'x',
      kind: 'moments',
      fromAt: 1000,
      toAt: 1001,
      timezone: 'Asia/Singapore',
      include: { moments: true, daily: false, health: false },
      expiresAt: 0,
      createdAt: 0,
      byLabel: '爸爸',
      canRevoke: true,
      ...overrides,
    });
    withLocale('zh', () => {
      expect(shareLinkTitle(summary({ momentIds: ['a'] }), 0, moments)).toBe('回忆 · 第一次笑');
      expect(shareLinkTitle(summary({ momentIds: ['a', 'b'] }), 0, moments)).toBe(
        '回忆 · 2 段回忆',
      );
      expect(shareLinkTitle(summary({}), 0, moments)).toBe('回忆');
    });
    withLocale('en', () => {
      expect(shareLinkTitle(summary({ momentIds: ['a'] }), 0, moments)).toBe('Moments · 第一次笑');
    });
  });
});

describe('还没传上去的', () => {
  it('只算选中的回忆和它们的文件', () => {
    const source = {
      events: [],
      moments: [
        moment('a', 1000, '', ['f1', 'f2'], true),
        moment('b', 1000, '', ['f3'], false),
        moment('c', 1000, '', ['f4'], true),
      ],
    };
    expect(shareMomentsPending(source, ['a', 'b'], new Set(['f1', 'f3', 'f4']))).toEqual({
      records: 1,
      files: 2,
    });
  });
});

describe('选择', () => {
  it('点一下选上，再点一下取消；顺序按点的先后', () => {
    expect(toggleSelection([], 'a')).toEqual(['a']);
    expect(toggleSelection(['a'], 'b')).toEqual(['a', 'b']);
    expect(toggleSelection(['a', 'b'], 'a')).toEqual(['b']);
  });

  it('选满了不再加', () => {
    const full = Array.from({ length: 100 }, (_, i) => String(i));
    expect(toggleSelection(full, 'x')).toBe(full);
    expect(toggleSelection(full, '5')).toHaveLength(99);
  });
});
