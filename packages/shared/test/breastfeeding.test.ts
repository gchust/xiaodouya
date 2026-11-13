import { afterEach, describe, expect, it } from 'vitest';
import {
  assessDayNutrition,
  breastFeedState,
  breastSeconds,
  buildWidgetView,
  describeEvent,
  type EventData,
  EventData as EventDataSchema,
  estimateNextFeed,
  FORGOTTEN_BREASTFEED_MS,
  feedDefaultsAt,
  finishBreastFeed,
  lastFeedDefaults,
  metricUnits,
  nextBreastSide,
  pickEventForShare,
  planWidgetAction,
  regions,
  setLocale,
  startBreastFeed,
  summarize24h,
  summarizeDay,
  summaryText,
  switchBreastSide,
  withLocale,
} from '../src';

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = new Date(2026, 10, 13, 12).getTime();

type Feed = Extract<EventData, { type: 'feed' }>;

const bottle = (at: number, ml: number, extra: Partial<Feed> = {}): Feed => ({
  type: 'feed',
  at,
  ml,
  ...extra,
});

/** 喂完的一次亲喂：先左后右（或只喂一侧），最后一侧是 `side`。 */
const nursed = (at: number, leftMin: number, rightMin: number, side: 'left' | 'right'): Feed => ({
  type: 'feed',
  at,
  ml: 0,
  method: 'breast',
  side,
  leftSec: leftMin * 60,
  rightSec: rightMin * 60,
  endAt: at + (leftMin + rightMin) * MIN,
});

afterEach(() => setLocale('zh'));

describe('亲喂的数据结构', () => {
  it('新字段都能存下来，旧版只认 ml 也能读', () => {
    const data = { ...nursed(NOW - HOUR, 12, 8, 'right') };
    const parsed = EventDataSchema.parse(data);
    expect(parsed).toMatchObject({ method: 'breast', side: 'right', leftSec: 720, rightSec: 480 });
    expect(parsed.type === 'feed' && parsed.ml).toBe(0);
  });

  it('不认识的值只丢这一项，喂奶不能从时间线消失', () => {
    const parsed = EventDataSchema.parse({
      type: 'feed',
      at: NOW,
      ml: 0,
      method: 'spoon',
      side: 'middle',
      leftSec: -5,
      endAt: 'soon',
    });
    expect(parsed).toMatchObject({ type: 'feed', at: NOW, ml: 0 });
    expect(parsed).not.toHaveProperty('method', 'spoon');
    expect((parsed as Feed).method).toBeUndefined();
    expect((parsed as Feed).side).toBeUndefined();
    expect((parsed as Feed).leftSec).toBeUndefined();
    expect((parsed as Feed).endAt).toBeUndefined();
  });
});

describe('左右侧计时', () => {
  it('点一侧开始，换边时把这一段记进去，结束时留下最后一侧', () => {
    const start = NOW - 20 * MIN;
    const started = startBreastFeed('left', start);
    expect(started).toMatchObject({ type: 'feed', ml: 0, method: 'breast', side: 'left' });
    expect(started.endAt).toBeUndefined();
    expect(breastSeconds(started, start + 5 * MIN)).toEqual({ left: 300, right: 0 });

    const switched = switchBreastSide(started, 'right', start + 12 * MIN);
    expect(switched).toMatchObject({ side: 'right', leftSec: 720, rightSec: 0 });
    expect(breastSeconds(switched!, start + 15 * MIN)).toEqual({ left: 720, right: 180 });

    const done = finishBreastFeed(switched!, start + 20 * MIN);
    expect(done).toMatchObject({ side: 'right', leftSec: 720, rightSec: 480, endAt: NOW });
    expect(done.sideSince).toBeUndefined();
    // 结束之后不再随时间增加。
    expect(breastSeconds(done, NOW + HOUR)).toEqual({ left: 720, right: 480 });
  });

  it('点正在喂的这一侧什么都不做，已经结束的不能再换边', () => {
    const started = startBreastFeed('left', NOW - 5 * MIN);
    expect(switchBreastSide(started, 'left', NOW)).toBeNull();
    expect(switchBreastSide(finishBreastFeed(started, NOW), 'right', NOW + MIN)).toBeNull();
  });

  it('“15 分钟前”开始的，这一侧从那时算起', () => {
    const started = startBreastFeed('right', NOW - 15 * MIN);
    expect(started.at).toBe(NOW - 15 * MIN);
    expect(breastSeconds(started, NOW)).toEqual({ left: 0, right: 900 });
  });

  it('另一台手机的钟快一点时不出现负数', () => {
    const started = startBreastFeed('left', NOW + 30_000);
    expect(breastSeconds(started, NOW)).toEqual({ left: 0, right: 0 });
    expect(finishBreastFeed(started, NOW).endAt).toBeGreaterThanOrEqual(started.at);
  });

  it('App 被杀后重新打开：按记录和现在的时间算，不靠内存', () => {
    const started = startBreastFeed('left', NOW - 8 * MIN - 12_000);
    const fromDisk = EventDataSchema.parse(JSON.parse(JSON.stringify(started))) as Feed;
    expect(breastSeconds(fromDisk, NOW)).toEqual({ left: 492, right: 0 });
  });
});

describe('现在有没有在亲喂', () => {
  it('没结束的亲喂是正在喂，超过 2 小时算忘了关', () => {
    const open = startBreastFeed('left', NOW - 10 * MIN);
    expect(breastFeedState([open], NOW)).toEqual({ status: 'running', feed: open });
    const old = startBreastFeed('left', NOW - FORGOTTEN_BREASTFEED_MS - MIN);
    expect(breastFeedState([old], NOW)).toEqual({ status: 'forgotten', feed: old });
  });

  it('喂完的、瓶喂、睡眠和未来时间的都不算', () => {
    expect(
      breastFeedState(
        [
          nursed(NOW - HOUR, 10, 5, 'right'),
          bottle(NOW - 30 * MIN, 90),
          { type: 'sleep', at: NOW - 10 * MIN },
          startBreastFeed('left', NOW + 10 * MIN),
        ],
        NOW,
      ),
    ).toEqual({ status: 'none' });
  });
});

describe('下次从哪侧开始', () => {
  it('取最近一次亲喂最后喂的一侧的另一侧，中间的瓶喂不影响', () => {
    const events = [
      nursed(NOW - 5 * HOUR, 10, 10, 'left'),
      nursed(NOW - 3 * HOUR, 12, 8, 'right'),
      bottle(NOW - HOUR, 90),
    ];
    expect(nextBreastSide(events, NOW)).toBe('left');
  });

  it('正在喂的那一侧也算最后一侧；没亲喂过不猜', () => {
    expect(nextBreastSide([startBreastFeed('right', NOW - MIN)], NOW)).toBe('left');
    expect(nextBreastSide([bottle(NOW - HOUR, 90)], NOW)).toBeNull();
  });
});

describe('亲喂怎么写', () => {
  it('喂完的写两侧各几分钟，正在喂的写“亲喂中”', () => {
    expect(describeEvent(nursed(NOW - HOUR, 12, 8, 'right'), NOW)).toBe('亲喂 左 12 分 · 右 8 分');
    expect(describeEvent(nursed(NOW - HOUR, 0, 15, 'right'), NOW)).toBe('亲喂 右 15 分');
    expect(describeEvent(startBreastFeed('left', NOW), NOW)).toBe('亲喂中 · 左侧');
    const running = switchBreastSide(
      startBreastFeed('left', NOW - 10 * MIN),
      'right',
      NOW - 2 * MIN,
    );
    expect(describeEvent(running!, NOW)).toBe('亲喂中 · 左 8 分 · 右 2 分');
  });

  it('不到一分钟写 1 分，不写 0；没计时的补记只写“亲喂”', () => {
    expect(describeEvent({ ...nursed(NOW - HOUR, 0, 0, 'left'), leftSec: 20 }, NOW)).toBe(
      '亲喂 左 1 分',
    );
    expect(describeEvent(nursed(NOW - HOUR, 0, 0, 'left'), NOW)).toBe('亲喂');
  });

  it('瓶喂和以前一样', () => {
    expect(describeEvent(bottle(NOW, 90), NOW)).toBe('喂奶 90ml');
  });

  it('英文意思一样', () => {
    withLocale('en', () => {
      expect(describeEvent(nursed(NOW - HOUR, 12, 8, 'right'), NOW)).toBe(
        'Breastfed · L 12 min · R 8 min',
      );
      expect(describeEvent(startBreastFeed('left', NOW), NOW)).toBe('Breastfeeding · left side');
    });
  });
});

describe('24 小时摘要', () => {
  const events: EventData[] = [
    bottle(NOW - 6 * HOUR, 150),
    bottle(NOW - 3 * HOUR, 180),
    nursed(NOW - 9 * HOUR, 30, 20, 'right'),
    nursed(NOW - 2 * HOUR, 12, 8, 'right'),
  ];

  it('瓶喂和亲喂分开写，亲喂不写 0ml', () => {
    const summary = summarize24h(events, NOW);
    expect(summary).toMatchObject({ feeds: 4, ml: 330, breastFeeds: 2, breastMs: 70 * MIN });
    expect(summaryText(summary)).toBe('喂奶 4 次 · 瓶喂 330ml · 亲喂 1小时10分　尿布 0　睡 0.0h');
    expect(withLocale('en', () => summaryText(summary))).toBe(
      '4 feeds · Bottle 330ml · Breast 1 hr 10 min   0 diapers   Slept 0.0h',
    );
  });

  it('只有亲喂时不写瓶喂', () => {
    const summary = summarize24h([nursed(NOW - 2 * HOUR, 12, 8, 'right')], NOW);
    expect(summaryText(summary)).toBe('喂奶 1 次 · 亲喂 20分钟　尿布 0　睡 0.0h');
    expect(summaryText(summary)).not.toContain('0ml');
  });

  it('时长四舍五入到分钟，不到 1 分钟写 1 分钟，刚开始还没计到时不写时长', () => {
    const short = { ...nursed(NOW - HOUR, 0, 0, 'left'), leftSec: 25 };
    expect(summaryText(summarize24h([short], NOW))).toBe('喂奶 1 次 · 亲喂 1分钟　尿布 0　睡 0.0h');
    const long = { ...nursed(NOW - HOUR, 0, 0, 'left'), leftSec: 12 * 60 + 40, rightSec: 8 * 60 };
    expect(summaryText(summarize24h([long], NOW))).toBe('喂奶 1 次 · 亲喂 21分钟　尿布 0　睡 0.0h');
    expect(summaryText(summarize24h([startBreastFeed('left', NOW)], NOW))).toBe(
      '喂奶 1 次 · 亲喂　尿布 0　睡 0.0h',
    );
  });

  it('只有瓶喂时和以前一字不差', () => {
    const summary = summarize24h([bottle(NOW - HOUR, 90), bottle(NOW - 4 * HOUR, 120)], NOW);
    expect(summaryText(summary)).toBe('喂奶 2 次 · 210ml　尿布 0　睡 0.0h');
  });

  it('正在喂的算到现在，忘了关的计时只算已经喂完的段落', () => {
    const running = switchBreastSide(
      startBreastFeed('left', NOW - 15 * MIN),
      'right',
      NOW - 5 * MIN,
    )!;
    expect(summarize24h([running], NOW).breastMs).toBe(15 * MIN);
    const forgotten = switchBreastSide(
      startBreastFeed('left', NOW - 5 * HOUR),
      'right',
      NOW - 5 * HOUR + 10 * MIN,
    )!;
    expect(summarize24h([forgotten], NOW).breastMs).toBe(10 * MIN);
    expect(summarizeDay([forgotten], NOW - 12 * HOUR, NOW).breastMs).toBe(10 * MIN);
  });
});

describe('下次喂奶估算', () => {
  it('亲喂按开始时间算间隔，正在喂的也是“上次喂奶”', () => {
    const events = [
      nursed(NOW - 7 * HOUR, 15, 10, 'right'),
      nursed(NOW - 4 * HOUR, 15, 10, 'left'),
      startBreastFeed('right', NOW - 1 * HOUR),
    ];
    const estimate = estimateNextFeed(events, NOW);
    expect(estimate.last).toBe(events[2]);
    expect(estimate.isLearned).toBe(true);
    expect(estimate.intervalMs).toBe(3 * HOUR);
  });

  it('亲喂完不到 20 分钟又喂的算同一顿，不把间隔算短', () => {
    const events = [
      nursed(NOW - 9 * HOUR, 20, 10, 'right'),
      nursed(NOW - 6 * HOUR, 20, 10, 'left'),
      // 上一顿 30 分钟才喂完，10 分钟后补了一点奶：开始时间隔了 40 分钟，其实是同一顿。
      bottle(NOW - 6 * HOUR + 40 * MIN, 30),
      nursed(NOW - 3 * HOUR, 20, 10, 'right'),
    ];
    const estimate = estimateNextFeed(events, NOW);
    expect(estimate.isLearned).toBe(true);
    // 只有 9→6 小时那一段是真的间隔；6 小时 40 分 → 3 小时是 3 小时 20 分。
    expect(estimate.intervalMs).toBe((3 * HOUR + (3 * HOUR - 40 * MIN)) / 2);
  });
});

describe('沿用上一次', () => {
  const formulaEvents: EventData[] = [
    bottle(NOW - 5 * HOUR, 120, { milkType: 'formula' }),
    nursed(NOW - 2 * HOUR, 12, 8, 'right'),
  ];

  it('瓶喂还是亲喂跟最新的一条；奶量和奶类型只从瓶喂沿用，不会变成 0ml', () => {
    expect(lastFeedDefaults(formulaEvents, [], NOW)).toEqual({
      ml: 120,
      method: 'breast',
      milkType: 'formula',
    });
    expect(lastFeedDefaults([...formulaEvents, bottle(NOW - HOUR, 90)], [], NOW).method).toBe(
      'bottle',
    );
  });

  it('补记更早的时间时，方式跟那之前最近的一条', () => {
    const at = NOW - 3 * HOUR;
    expect(feedDefaultsAt(formulaEvents, [], at, NOW)).toMatchObject({
      ml: 120,
      method: 'bottle',
    });
  });

  it('小工具一键记喂奶用上一次瓶喂的奶量，不记 0ml', () => {
    const result = planWidgetAction(
      { type: 'feed', id: 'new' },
      {
        session: { signedIn: true, hasFamily: true, role: 'caregiver', label: '爸爸' },
        hasBaby: true,
        entries: formulaEvents.map((data, i) => ({ id: `e${i}`, data })),
        formulas: [],
        isKnownId: () => false,
        now: NOW,
      },
    );
    expect(result).toMatchObject({ kind: 'write', data: { type: 'feed', ml: 120 } });
    expect(result.kind === 'write' && (result.data as Feed).method).toBeFalsy();
  });
});

describe('小工具显示', () => {
  const view = (events: EventData[]) => {
    const built = buildWidgetView({
      session: { signedIn: true, hasFamily: true, role: 'caregiver', label: '爸爸' },
      baby: { name: '测试豆', birthAt: NOW - 30 * 24 * HOUR },
      entries: events.map((data, i) => ({ id: `e${i}`, data })),
      units: metricUnits,
      now: NOW,
      dayStart: new Date(2026, 10, 13).getTime(),
      syncedAt: NOW,
    });
    if (built.kind !== 'ready') throw new Error('not ready');
    return built;
  };

  it('上次是亲喂时写“亲喂”，按钮上还是上一次瓶喂的奶量', () => {
    const v = view([bottle(NOW - 5 * HOUR, 120), nursed(NOW - 2 * HOUR, 12, 8, 'right')]);
    expect(v.lastFeedAmount).toBe('亲喂');
    expect(v.quickFeedAmount).toBe('120ml');
    expect(v.canQuickFeed).toBe(true);
  });

  it('正在喂写“亲喂中”；只有亲喂时今天的量不写 0ml', () => {
    const v = view([startBreastFeed('left', NOW - 5 * MIN)]);
    expect(v.lastFeedAmount).toBe('亲喂中');
    expect(v.quickFeedAmount).toBeNull();
    expect(v.todayAmount).toBe('亲喂');
  });
});

describe('奶粉营养', () => {
  const dayStart = new Date(2026, 10, 12).getTime();
  const dayEnd = new Date(2026, 10, 13).getTime();

  it('亲喂算作“数据不足”的原因，不当成 0 摄入', () => {
    const per100ml = { energyKcal: 68, proteinG: 1.4 };
    const result = assessDayNutrition({
      events: [
        ...[2, 6, 10, 14, 18].map((h) =>
          bottle(dayStart + h * HOUR, 120, {
            milkType: 'formula',
            formula: { name: '虚构奶粉', per100ml },
          }),
        ),
        nursed(dayStart + 22 * HOUR, 12, 8, 'right'),
      ],
      dayStart,
      dayEnd,
      now: NOW,
      ageMonths: 2,
      reference: regions.US.nutrition,
    });
    expect(result.feeds).toBe(6);
    expect(result.uncountedFeeds).toBe(1);
    expect(result.reasons).toContain('有 1 次是亲喂，吃了多少没法知道，没算进去');
    expect(result.reasons.join()).not.toContain('没有标注奶类型');
    expect(result.nutrients.every((n) => n.status === 'insufficient')).toBe(true);
  });
});

describe('分享页', () => {
  it('亲喂发出哪一侧和时长，不发别的字段', () => {
    const data = {
      ...nursed(NOW - HOUR, 12, 8, 'right'),
      note: '很顺利',
      formula: { name: '不该发', per100ml: {} },
      secret: 'x',
    } as Feed;
    const picked = pickEventForShare(data);
    expect(picked).toEqual({
      type: 'feed',
      at: NOW - HOUR,
      note: '很顺利',
      ml: 0,
      method: 'breast',
      side: 'right',
      leftSec: 720,
      rightSec: 480,
      endAt: NOW - 40 * MIN,
    });
    expect(describeEvent(picked, NOW)).toBe('亲喂 左 12 分 · 右 8 分');
  });

  it('瓶喂和以前一样只发奶量', () => {
    expect(pickEventForShare(bottle(NOW, 90, { method: 'bottle' }))).toEqual({
      type: 'feed',
      at: NOW,
      ml: 90,
    });
  });
});
