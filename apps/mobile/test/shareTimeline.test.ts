import { type EventData, type MomentData, type ShareSummary, withLocale } from '@xiaodouya/shared';
import { afterEach, describe, expect, it } from 'vitest';
import {
  shareLinkTitle,
  shareLinkUrl,
  shareTimelinePending,
  shareTimelineRange,
} from '../src/lib/share';

/** 分享时间线（F-133）：范围、链接、已分享的链接里的标题。数据都是虚构的。 */

const HOUR = 3_600_000;
const TOKEN = 'A'.repeat(43);
const originalTz = process.env.TZ;

afterEach(() => {
  process.env.TZ = originalTz;
});

function inZone<T>(zone: string, run: () => T): T {
  process.env.TZ = zone;
  return run();
}

describe('时间线的范围', () => {
  // 新加坡 2026-11-05 10:00。
  const now = Date.UTC(2026, 10, 5, 2);
  const sgMidnight = (month: number, day: number) => Date.UTC(2026, month, day) - 8 * HOUR;

  it('最近 7 天：含今天往前 7 个日历日，到今天结束', () => {
    inZone('Asia/Singapore', () => {
      expect(shareTimelineRange('week', now)).toEqual({
        fromAt: sgMidnight(9, 30),
        toAt: sgMidnight(10, 6),
      });
    });
  });

  it('最近 30 天', () => {
    inZone('Asia/Singapore', () => {
      expect(shareTimelineRange('month', now)).toEqual({
        fromAt: sgMidnight(9, 7),
        toAt: sgMidnight(10, 6),
      });
    });
  });

  it('跨过夏令时结束的一周按日历算，多出的那一小时也在里面', () => {
    inZone('America/New_York', () => {
      // 纽约 2026-11-05 12:00（EST），11 月 1 日结束夏令时。
      const range = shareTimelineRange('week', Date.UTC(2026, 10, 5, 17));
      expect(range).toEqual({
        fromAt: Date.UTC(2026, 9, 30, 4),
        toAt: Date.UTC(2026, 10, 6, 5),
      });
      expect(range!.toAt - range!.fromAt).toBe(7 * 24 * HOUR + HOUR);
    });
  });

  it('全部：从 0 开始，到今天结束', () => {
    inZone('Asia/Singapore', () => {
      expect(shareTimelineRange('all', now)).toEqual({ fromAt: 0, toAt: sgMidnight(10, 6) });
    });
  });

  it('自定义：按选的两天的开始和结束，选的时刻不影响', () => {
    inZone('Asia/Singapore', () => {
      const custom = { from: sgMidnight(9, 1) + 15 * HOUR, to: sgMidnight(9, 3) + 2 * HOUR };
      expect(shareTimelineRange('custom', now, custom)).toEqual({
        fromAt: sgMidnight(9, 1),
        toAt: sgMidnight(9, 4),
      });
      // 同一天也可以。
      expect(shareTimelineRange('custom', now, { from: custom.from, to: custom.from })).toEqual({
        fromAt: sgMidnight(9, 1),
        toAt: sgMidnight(9, 2),
      });
    });
  });

  it('自定义：开始晚于结束不行；结束在未来时只到今天', () => {
    inZone('Asia/Singapore', () => {
      expect(
        shareTimelineRange('custom', now, { from: sgMidnight(9, 5), to: sgMidnight(9, 3) }),
      ).toBeNull();
      expect(
        shareTimelineRange('custom', now, { from: sgMidnight(9, 5), to: sgMidnight(10, 20) }),
      ).toEqual({ fromAt: sgMidnight(9, 5), toAt: sgMidnight(10, 6) });
      expect(shareTimelineRange('custom', now)).toBeNull();
    });
  });
});

describe('链接', () => {
  it('时间线的链接是 #t/令牌，一天的还是 #令牌', () => {
    expect(shareLinkUrl('https://share.example.test/', TOKEN, 'timeline')).toBe(
      `https://share.example.test/#t/${TOKEN}`,
    );
    expect(shareLinkUrl('https://share.example.test', TOKEN)).toBe(
      `https://share.example.test/#${TOKEN}`,
    );
  });
});

describe('已分享的链接里的标题', () => {
  const summary = (overrides: Partial<ShareSummary>): ShareSummary => ({
    id: 'x',
    fromAt: Date.UTC(2026, 5, 14, 16),
    toAt: Date.UTC(2026, 5, 15, 16),
    timezone: 'Asia/Singapore',
    include: { moments: true, daily: true, health: false },
    expiresAt: 0,
    createdAt: 0,
    byLabel: '爸爸',
    canRevoke: true,
    ...overrides,
  });
  const now = Date.UTC(2026, 10, 5, 2);

  it('分得清是一天还是时间线；旧服务端没有 kind 时当成一天', () => {
    inZone('Asia/Singapore', () => {
      withLocale('zh', () => {
        expect(shareLinkTitle(summary({ kind: 'day' }), now)).toBe('一天 · 6月15日 · 星期一');
        expect(shareLinkTitle(summary({}), now)).toBe('一天 · 6月15日 · 星期一');
        expect(
          shareLinkTitle(
            summary({
              kind: 'timeline',
              fromAt: Date.UTC(2026, 4, 31, 16),
              toAt: Date.UTC(2026, 5, 30, 16),
            }),
            now,
          ),
        ).toBe('时间线 · 6月1日 – 6月30日');
        expect(
          shareLinkTitle(
            summary({ kind: 'timeline', fromAt: 0, toAt: Date.UTC(2026, 10, 5, 16) }),
            now,
          ),
        ).toBe('时间线 · 全部回忆，截至 11月5日');
      });
      withLocale('en', () => {
        expect(shareLinkTitle(summary({ kind: 'day' }), now)).toBe('Day · Jun 15 · Monday');
      });
    });
  });

  it('时间线的日期按创建时的时区算，手机换了时区也一样', () => {
    inZone('America/New_York', () => {
      withLocale('zh', () => {
        expect(
          shareLinkTitle(
            summary({
              kind: 'timeline',
              fromAt: Date.UTC(2026, 4, 31, 16),
              toAt: Date.UTC(2026, 5, 30, 16),
            }),
            now,
          ),
        ).toBe('时间线 · 6月1日 – 6月30日');
      });
    });
  });
});

describe('还没传上去的内容', () => {
  it('只算这段时间里的回忆和它们的文件，不算记录', () => {
    const range = { fromAt: 1000, toAt: 2000 };
    const moment = (at: number, ids: string[], dirty: boolean) => ({
      dirty,
      data: {
        title: '',
        text: '',
        at,
        milestone: false,
        media: ids.map((id) => ({ id, kind: 'image' as const })),
      } as MomentData,
    });
    const event = (at: number) => ({
      dirty: true,
      data: { type: 'feed', at, ml: 90 } as EventData,
    });
    const result = shareTimelinePending(
      {
        events: [event(1500)],
        moments: [
          moment(1500, ['a', 'b'], true),
          moment(1600, ['c'], false),
          moment(2500, ['d'], true),
        ],
      },
      range,
      new Set(['a', 'c', 'd']),
    );
    expect(result).toEqual({ records: 1, files: 2 });
  });
});
