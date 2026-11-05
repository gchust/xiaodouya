import { describe, expect, it } from 'vitest';
import { withLocale } from '../src/i18n';
import {
  CreateTimelineShareRequest,
  PublicTimelineRequest,
  parseShareFragment,
  shareCoverId,
  shareFragment,
  shareMomentAge,
  timelineRangeText,
  zonedCalendarDate,
} from '../src/share';

/** 分享时间线（F-133）。数据都是虚构的。 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const SG = 'Asia/Singapore';
const TOKEN = 'A'.repeat(43);
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('创建时间线的请求', () => {
  const base = { fromAt: Date.UTC(2026, 5, 1), toAt: Date.UTC(2026, 6, 1), timezone: SG };

  it('一段日期、全部（从 0 开始）都可以，有效期默认 7 天', () => {
    expect(CreateTimelineShareRequest.parse(base).ttlDays).toBe(7);
    expect(CreateTimelineShareRequest.safeParse({ ...base, fromAt: 0 }).success).toBe(true);
    expect(CreateTimelineShareRequest.safeParse({ ...base, ttlDays: 30 }).success).toBe(true);
  });

  it('结束要晚于开始，时区要是真的，有效期只能是 1、7、30 天', () => {
    expect(CreateTimelineShareRequest.safeParse({ ...base, toAt: base.fromAt }).success).toBe(
      false,
    );
    expect(
      CreateTimelineShareRequest.safeParse({ ...base, timezone: 'Mars/Olympus' }).success,
    ).toBe(false);
    expect(CreateTimelineShareRequest.safeParse({ ...base, ttlDays: 2 }).success).toBe(false);
    expect(CreateTimelineShareRequest.safeParse({ ...base, fromAt: -1 }).success).toBe(false);
  });

  it('不收内容选项：时间线只有回忆，传了日常和健康也不会进到请求里', () => {
    const parsed = CreateTimelineShareRequest.parse({
      ...base,
      include: { moments: true, daily: true, health: true },
    });
    expect(parsed).not.toHaveProperty('include');
  });
});

describe('公开请求的游标', () => {
  it('游标是时间加回忆 id，别的写法不收', () => {
    expect(PublicTimelineRequest.safeParse({ token: TOKEN }).success).toBe(true);
    expect(
      PublicTimelineRequest.safeParse({ token: TOKEN, cursor: `1781000000000.${uuid(1)}` }).success,
    ).toBe(true);
    for (const cursor of [
      '',
      'abc',
      `-1.${uuid(1)}`,
      `1.5.${uuid(1)}`,
      `1.not-a-uuid`,
      'x'.repeat(200),
    ]) {
      expect(PublicTimelineRequest.safeParse({ token: TOKEN, cursor }).success, cursor).toBe(false);
    }
  });
});

describe('链接的片段', () => {
  it('一天的链接还是 #令牌，旧链接照常打开；时间线是 #t/令牌', () => {
    expect(shareFragment('day', TOKEN)).toBe(TOKEN);
    expect(shareFragment('timeline', TOKEN)).toBe(`t/${TOKEN}`);
    expect(parseShareFragment(`#${TOKEN}`)).toEqual({ kind: 'day', token: TOKEN });
    expect(parseShareFragment(`#t/${TOKEN}`)).toEqual({ kind: 'timeline', token: TOKEN });
    expect(parseShareFragment(TOKEN)).toEqual({ kind: 'day', token: TOKEN });
  });

  it('别的写法都不认', () => {
    for (const hash of [
      '',
      '#',
      '#t/',
      `#x/${TOKEN}`,
      `#t/${TOKEN}x`,
      `#${TOKEN.slice(1)}`,
      '#t/<script>',
    ]) {
      expect(parseShareFragment(hash), hash).toBeNull();
    }
  });
});

describe('每条回忆是第几天、多大', () => {
  // 新加坡 6 月 1 日 23:30 出生。
  const birthAt = Date.UTC(2026, 5, 1, 15, 30);

  it('按分享者的时区算那一天', () => {
    // UTC 6 月 14 日 17:00 是新加坡 6 月 15 日 01:00。
    expect(shareMomentAge(birthAt, Date.UTC(2026, 5, 14, 17), SG)).toEqual({
      dayNumber: 15,
      age: { months: 0, days: 14 },
    });
    expect(shareMomentAge(birthAt, Date.UTC(2026, 6, 2, 4), SG)).toEqual({
      dayNumber: 32,
      age: { months: 1, days: 1 },
    });
  });

  it('出生当天早于出生时间的回忆也算第 1 天、0 天大', () => {
    expect(shareMomentAge(birthAt, Date.UTC(2026, 5, 1, 1), SG)).toEqual({
      dayNumber: 1,
      age: { months: 0, days: 0 },
    });
  });

  it('孕期的回忆没有月龄', () => {
    const result = shareMomentAge(birthAt, Date.UTC(2026, 4, 20), SG);
    expect(result.age).toBeNull();
    expect(result.dayNumber).toBeLessThan(1);
  });
});

describe('封面', () => {
  const media = [{ id: uuid(1) }, { id: uuid(2) }, { id: uuid(3) }];

  it('设置的封面能显示就用它', () => {
    expect(shareCoverId(media, uuid(2), new Set([uuid(1), uuid(2)]))).toBe(uuid(2));
  });

  it('设置的封面没传完、是录音或者被移除了，回到第一个能显示的', () => {
    expect(shareCoverId(media, uuid(2), new Set([uuid(3)]))).toBe(uuid(3));
    expect(shareCoverId(media, uuid(9), new Set([uuid(2), uuid(3)]))).toBe(uuid(2));
    expect(shareCoverId(media, undefined, new Set([uuid(3), uuid(1)]))).toBe(uuid(1));
  });

  it('一个能显示的都没有时没有封面', () => {
    expect(shareCoverId(media, uuid(1), new Set())).toBeNull();
    expect(shareCoverId([], undefined, new Set([uuid(1)]))).toBeNull();
  });
});

describe('范围的文字', () => {
  const now = Date.UTC(2026, 10, 5, 4);
  // 新加坡的日历。
  const calendar = (ms: number) => zonedCalendarDate(ms, SG).getTime();
  const sgDay = (month: number, day: number) => Date.UTC(2026, month, day) - 8 * HOUR;

  it('今年的一段只写月日，最后一天按结束前一刻算', () => {
    const range = { fromAt: sgDay(5, 1), toAt: sgDay(6, 1) };
    expect(withLocale('zh', () => timelineRangeText(range, now, calendar))).toBe(
      '6月1日 – 6月30日',
    );
    expect(withLocale('en', () => timelineRangeText(range, now, calendar))).toBe('Jun 1 – Jun 30');
  });

  it('只有一天时写一个日期', () => {
    const range = { fromAt: sgDay(5, 1), toAt: sgDay(5, 2) };
    expect(withLocale('zh', () => timelineRangeText(range, now, calendar))).toBe('6月1日');
  });

  it('不在今年时带上年份', () => {
    const range = { fromAt: Date.UTC(2025, 11, 20) - 8 * HOUR, toAt: sgDay(0, 10) };
    expect(withLocale('zh', () => timelineRangeText(range, now, calendar))).toBe(
      '2025.12.20 – 2026.01.09',
    );
  });

  it('全部：从 0 开始，写截至哪一天', () => {
    const range = { fromAt: 0, toAt: sgDay(10, 6) };
    expect(withLocale('zh', () => timelineRangeText(range, now, calendar))).toBe(
      '全部回忆，截至 11月5日',
    );
    expect(withLocale('en', () => timelineRangeText(range, now, calendar))).toBe(
      'All moments, up to Nov 5',
    );
  });

  it('用传进来的日历，不用运行环境的时区', () => {
    // 新加坡 6 月 1 日 0 点在 UTC 还是 5 月 31 日。
    const range = { fromAt: sgDay(5, 1), toAt: sgDay(5, 1) + DAY };
    expect(withLocale('zh', () => timelineRangeText(range, now, calendar))).toBe('6月1日');
  });
});
