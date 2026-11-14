import { afterEach, describe, expect, it } from 'vitest';
import {
  assessDayNutrition,
  buildWidgetView,
  describeEvent,
  type EventData,
  EventData as EventDataSchema,
  estimateNextFeed,
  eventMatchesSearch,
  lastFeedDefaults,
  lastPumpDefaults,
  metricUnits,
  parseSearchQuery,
  regions,
  setLocale,
  shareIncludesEvent,
  summarize24h,
  summarizeDay,
  todayInsight,
  trendDays,
  widgetDayline,
  withLocale,
} from '../src';

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = new Date(2026, 10, 14, 12).getTime();
const DAY_START = new Date(2026, 10, 14).getTime();

type Pump = Extract<EventData, { type: 'pump' }>;

const pump = (at: number, ml: number, side?: Pump['side']): Pump => ({
  type: 'pump',
  at,
  ml,
  ...(side ? { side } : {}),
});

const bottle = (at: number, ml: number): EventData => ({ type: 'feed', at, ml });

afterEach(() => setLocale('zh'));

describe('吸奶的数据结构', () => {
  it('吸了多少、哪一侧', () => {
    const parsed = EventDataSchema.safeParse({ type: 'pump', at: NOW, ml: 120, side: 'both' });
    expect(parsed.success && parsed.data).toEqual({
      type: 'pump',
      at: NOW,
      ml: 120,
      side: 'both',
    });
  });

  it('不认识的一侧只丢这一项，记录还在', () => {
    const parsed = EventDataSchema.safeParse({ type: 'pump', at: NOW, ml: 80, side: 'middle' });
    expect(parsed.success && parsed.data).toEqual({ type: 'pump', at: NOW, ml: 80 });
  });

  it('没有奶量或奶量不对不收', () => {
    expect(EventDataSchema.safeParse({ type: 'pump', at: NOW }).success).toBe(false);
    expect(EventDataSchema.safeParse({ type: 'pump', at: NOW, ml: -5 }).success).toBe(false);
    expect(EventDataSchema.safeParse({ type: 'pump', at: NOW, ml: 1.5 }).success).toBe(false);
  });
});

describe('吸奶的文字', () => {
  it('写奶量和哪一侧，两种语言', () => {
    expect(describeEvent(pump(NOW, 120, 'left'), NOW)).toBe('吸奶 120ml · 左侧');
    expect(describeEvent(pump(NOW, 120, 'both'), NOW)).toBe('吸奶 120ml · 两侧');
    expect(describeEvent(pump(NOW, 90), NOW)).toBe('吸奶 90ml');
    withLocale('en', () => {
      expect(describeEvent(pump(NOW, 120, 'right'), NOW)).toBe('Pumped 120ml · right');
      expect(describeEvent(pump(NOW, 120, 'both'), NOW)).toBe('Pumped 120ml · both sides');
    });
  });

  it('按单位写奶量', () => {
    expect(describeEvent(pump(NOW, 120), NOW, { ...metricUnits, volume: 'oz' })).toBe('吸奶 4.1oz');
  });

  it('搜“吸奶”能找到', () => {
    expect(
      eventMatchesSearch(pump(NOW, 120, 'left'), parseSearchQuery('吸奶'), NOW, metricUnits),
    ).toBe(true);
    expect(
      eventMatchesSearch(pump(NOW, 120, 'left'), parseSearchQuery('喂奶'), NOW, metricUnits),
    ).toBe(false);
  });
});

describe('吸奶不是喂奶', () => {
  const events: EventData[] = [
    pump(NOW - HOUR, 150, 'both'),
    bottle(NOW - 2 * HOUR, 90),
    pump(NOW - 3 * HOUR, 100, 'left'),
    bottle(NOW - 5 * HOUR, 80),
  ];

  it('24 小时摘要和今日汇总不算次数也不算奶量', () => {
    expect(summarize24h(events, NOW)).toMatchObject({ feeds: 2, ml: 170 });
    expect(summarizeDay(events, DAY_START, NOW)).toMatchObject({ feeds: 2, ml: 170 });
  });

  it('下次喂奶从最近一次喂奶算，吸奶不算', () => {
    const estimate = estimateNextFeed(events, NOW);
    expect(estimate.last?.at).toBe(NOW - 2 * HOUR);
    expect(estimateNextFeed(events, NOW)).toEqual(
      estimateNextFeed(
        events.filter((e) => e.type !== 'pump'),
        NOW,
      ),
    );
  });

  it('下次瓶喂的默认奶量不用吸奶的量', () => {
    expect(lastFeedDefaults(events, [], NOW).ml).toBe(90);
  });

  it('奶粉营养不把吸奶当成一次喂奶', () => {
    const result = assessDayNutrition({
      events: [pump(DAY_START + 3 * HOUR, 150), bottle(DAY_START + 2 * HOUR, 90)],
      dayStart: DAY_START,
      dayEnd: DAY_START + 24 * HOUR,
      now: NOW,
      ageMonths: 2,
      reference: regions.US.nutrition,
    });
    expect(result.feeds).toBe(1);
  });

  it('趋势页不算喂奶', () => {
    const today = trendDays([pump(NOW - HOUR, 150)], NOW, 7).at(-1);
    expect(today?.feeds ?? 0).toBe(0);
    expect(today?.ml ?? 0).toBe(0);
    const mixed = trendDays(events, NOW, 7).at(-1);
    expect(mixed).toMatchObject({ feeds: 2, ml: 170 });
  });

  it('小工具的上次喂奶、今日汇总和节奏条都不算', () => {
    const view = buildWidgetView({
      session: { signedIn: true, hasFamily: true, role: 'caregiver', label: '爸爸' },
      baby: { name: '测试豆', birthAt: NOW - 30 * 24 * HOUR },
      entries: events.map((data, i) => ({ id: `e${i}`, data })),
      units: metricUnits,
      now: NOW,
      dayStart: DAY_START,
      syncedAt: NOW,
    });
    expect(view.kind === 'ready' && view.lastFeed).toMatchObject({ at: NOW - 2 * HOUR, ml: 90 });
    expect(view.kind === 'ready' && view.today).toMatchObject({ feeds: 2, ml: 170 });
    expect(view.kind === 'ready' && view.quickFeedAmount).toBe('90ml');
    expect(widgetDayline(events, DAY_START, NOW).feeds).toHaveLength(2);
  });

  it('只有吸奶记录不能说明一直在记宝宝的日常，不下判断', () => {
    const birth = NOW - 60 * 24 * HOUR;
    const insight = todayInsight(
      [pump(NOW - 30 * HOUR, 120), pump(NOW - 2 * HOUR, 120), bottle(NOW - HOUR, 90)],
      birth,
      NOW,
    );
    expect(insight?.tone).toBe('neutral');
    expect(insight?.text).toContain('记满一天');
  });

  it('分享页不发吸奶：记的是大人，不是宝宝的一天', () => {
    expect(shareIncludesEvent('pump', { daily: true, health: true, moments: true })).toBe(false);
  });
});

describe('吸奶弹层的默认值', () => {
  it('跟上一次吸奶，不跟喂奶', () => {
    expect(
      lastPumpDefaults([bottle(NOW - HOUR, 60), pump(NOW - 3 * HOUR, 130, 'left')], NOW),
    ).toEqual({ ml: 130, side: 'left' });
  });

  it('补记的旧吸奶不算“上一次”之后的：按时间取最近的', () => {
    expect(
      lastPumpDefaults([pump(NOW - 5 * HOUR, 100, 'both'), pump(NOW - HOUR, 140, 'right')], NOW),
    ).toEqual({ ml: 140, side: 'right' });
  });

  it('没吸过时什么都不猜', () => {
    expect(lastPumpDefaults([bottle(NOW - HOUR, 60)], NOW)).toEqual({});
  });
});
