import { describe, expect, it } from 'vitest';
import { t, withLocale } from '../src/i18n';
import {
  CreateMomentsShareRequest,
  MAX_SHARE_MOMENTS,
  PublicTimelineResponse,
  parseShareFragment,
  shareFragment,
} from '../src/share';

/** 分享回忆（F-136）：选一段或几段回忆。数据都是虚构的。 */

const SG = 'Asia/Singapore';
const TOKEN = 'A'.repeat(43);
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('创建的请求', () => {
  const base = {
    momentIds: [uuid(1)],
    fromAt: Date.UTC(2026, 5, 1),
    toAt: Date.UTC(2026, 5, 1) + 1,
    timezone: SG,
  };

  it('一段或几段回忆都可以，有效期默认 7 天', () => {
    expect(CreateMomentsShareRequest.parse(base).ttlDays).toBe(7);
    const many = { ...base, momentIds: [uuid(1), uuid(2), uuid(3)], ttlDays: 30 };
    expect(CreateMomentsShareRequest.parse(many).momentIds).toHaveLength(3);
  });

  it('至少一段，最多 MAX_SHARE_MOMENTS 段，不能重复，要是 UUID', () => {
    expect(CreateMomentsShareRequest.safeParse({ ...base, momentIds: [] }).success).toBe(false);
    const max = Array.from({ length: MAX_SHARE_MOMENTS }, (_, i) => uuid(i + 1));
    expect(CreateMomentsShareRequest.safeParse({ ...base, momentIds: max }).success).toBe(true);
    expect(
      CreateMomentsShareRequest.safeParse({ ...base, momentIds: [...max, uuid(999)] }).success,
    ).toBe(false);
    expect(
      CreateMomentsShareRequest.safeParse({ ...base, momentIds: [uuid(1), uuid(1)] }).success,
    ).toBe(false);
    expect(CreateMomentsShareRequest.safeParse({ ...base, momentIds: ['abc'] }).success).toBe(
      false,
    );
  });

  it('结束要晚于开始，时区要是真的，有效期只能是 1、7、30 天', () => {
    expect(CreateMomentsShareRequest.safeParse({ ...base, toAt: base.fromAt }).success).toBe(false);
    expect(CreateMomentsShareRequest.safeParse({ ...base, timezone: 'Mars/Olympus' }).success).toBe(
      false,
    );
    expect(CreateMomentsShareRequest.safeParse({ ...base, ttlDays: 2 }).success).toBe(false);
  });

  it('不收内容选项：只有选中的回忆', () => {
    const parsed = CreateMomentsShareRequest.parse({
      ...base,
      include: { moments: true, daily: true, health: true },
    });
    expect(parsed).not.toHaveProperty('include');
  });
});

describe('链接片段', () => {
  it('回忆的链接是 #m/令牌，一天和时间线的不变', () => {
    expect(shareFragment('moments', TOKEN)).toBe(`m/${TOKEN}`);
    expect(shareFragment('timeline', TOKEN)).toBe(`t/${TOKEN}`);
    expect(shareFragment('day', TOKEN)).toBe(TOKEN);
    expect(parseShareFragment(`#m/${TOKEN}`)).toEqual({ kind: 'moments', token: TOKEN });
    expect(parseShareFragment(`#t/${TOKEN}`)).toEqual({ kind: 'timeline', token: TOKEN });
    expect(parseShareFragment(`#${TOKEN}`)).toEqual({ kind: 'day', token: TOKEN });
    expect(parseShareFragment('#m/abc')).toBeNull();
    expect(parseShareFragment(`#x/${TOKEN}`)).toBeNull();
  });
});

describe('公开的回答', () => {
  const body = {
    kind: 'moments',
    baby: { name: '测试豆', age: null },
    range: { fromAt: 1, toAt: 2, timezone: SG },
    entries: [],
    nextCursor: null,
    mediaExpiresIn: 3600,
  };

  it('时间线的回答也用来放选中的回忆，用 kind 区分', () => {
    expect(PublicTimelineResponse.safeParse(body).success).toBe(true);
    expect(PublicTimelineResponse.safeParse({ ...body, kind: 'timeline' }).success).toBe(true);
    expect(PublicTimelineResponse.safeParse({ ...body, kind: 'day' }).success).toBe(false);
  });
});

describe('文案', () => {
  it('两种语言都有，不假定性别', () => {
    for (const locale of ['zh', 'en'] as const) {
      withLocale(locale, () => {
        const text = t();
        const lines = [
          text.share.momentsPageTitle('Bean'),
          text.share.momentsEmptyTitle,
          text.share.momentsWhat,
          text.share.linkTitleMoments('x'),
          text.share.momentsCount(3),
          text.share.shareMomentA11y('x'),
        ];
        for (const line of lines) {
          expect(line).toBeTruthy();
          expect(line).not.toMatch(/\b(he|she|his|her|him)\b/i);
        }
      });
    }
  });
});
