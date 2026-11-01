import { describe, expect, it } from 'vitest';
import {
  activeSleep,
  checkRecordTime,
  dayLabel,
  type EventData,
  estimateNextFeed,
  eventsByDay,
  feedReminderDelayMs,
  type MediaRef,
  mergeEdit,
  mergeMediaEdit,
  parseCollectionData,
  summarize24h,
  timelineEntries,
  todayInsight,
} from '../src';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).getTime();

describe('记录时间校验', () => {
  const now = at(2026, 3, 10, 12);
  const birthAt = at(2026, 1, 15, 15);

  it('过去和现在的时间可以，未来的不行', () => {
    expect(checkRecordTime({ at: now - DAY, birthAt, now }).error).toBeNull();
    expect(checkRecordTime({ at: now, birthAt, now }).error).toBeNull();
    const future = checkRecordTime({ at: now + 1, birthAt, now });
    expect(future.error?.code).toBe('future');
    expect(future.error?.message).toContain('还没到');
  });

  it('睡眠结束不能早于开始，相同可以', () => {
    expect(checkRecordTime({ at: now - HOUR, endAt: now - 2 * HOUR, now }).error?.code).toBe(
      'end-before-start',
    );
    expect(checkRecordTime({ at: now - HOUR, endAt: now - HOUR, now }).error).toBeNull();
    expect(checkRecordTime({ at: now - 2 * HOUR, endAt: now - HOUR, now }).error).toBeNull();
  });

  it('睡眠结束不能是未来', () => {
    expect(checkRecordTime({ at: now - HOUR, endAt: now + 1, now }).error?.code).toBe('end-future');
  });

  it('开始已经是未来时，只报开始的错误', () => {
    expect(checkRecordTime({ at: now + 2, endAt: now + 1, now }).error?.code).toBe('future');
  });

  it('早于出生只提示，不拦截', () => {
    const before = checkRecordTime({ at: birthAt - 1, birthAt, now });
    expect(before.error).toBeNull();
    expect(before.notice).toContain('出生');
    expect(checkRecordTime({ at: birthAt, birthAt, now }).notice).toBeNull();
    expect(checkRecordTime({ at: birthAt + 1, birthAt, now }).notice).toBeNull();
  });

  it('只有日期的记录按日历日比较：出生当天中午的接种不算早于下午的出生', () => {
    const noon = at(2026, 1, 15, 12);
    expect(checkRecordTime({ at: noon, birthAt, now, dateOnly: true }).notice).toBeNull();
    expect(checkRecordTime({ at: noon, birthAt, now }).notice).not.toBeNull();
    expect(
      checkRecordTime({ at: at(2026, 1, 14, 12), birthAt, now, dateOnly: true }).notice,
    ).not.toBeNull();
  });

  it('回忆可以早于出生，语气不一样', () => {
    const r = checkRecordTime({ at: birthAt - 30 * DAY, birthAt, now, subject: 'memory' });
    expect(r.error).toBeNull();
    expect(r.notice).toContain('出生前');
    expect(r.notice).not.toContain('确认');
  });

  it('不知道出生时间时不提示', () => {
    expect(checkRecordTime({ at: 0, now }).notice).toBeNull();
  });
});

describe('出生前的回忆不能显示负数天', () => {
  const birth = at(2026, 1, 15, 3);
  it('出生当天和之后', () => {
    expect(dayLabel(birth, at(2026, 1, 15, 23))).toBe('第 1 天');
    expect(dayLabel(birth, at(2026, 1, 16))).toBe('第 2 天');
  });
  it('出生前', () => {
    expect(dayLabel(birth, at(2026, 1, 14))).toBe('出生前 1 天');
    expect(dayLabel(birth, at(2026, 1, 5))).toBe('出生前 10 天');
  });
});

describe('修改时合并最新版本', () => {
  const base = { type: 'feed' as const, at: 1000, ml: 90, note: '旧备注', byName: '妈妈' };

  it('改过的字段用修改值，没改的用家人刚写的值', () => {
    const latest = { ...base, note: '家人的备注' };
    const merged = mergeEdit(base, latest, { ...base, ml: 120 });
    expect(merged).toMatchObject({ ml: 120, note: '家人的备注', at: 1000 });
  });

  it('不在修改值里的字段（比如新版本写的）不会丢', () => {
    const latest = { ...base, milkKind: 'formula', future: { a: 1 } };
    const merged = mergeEdit<EventData>(base, latest, { type: 'feed', at: 2000, ml: 90 });
    expect(merged).toMatchObject({ milkKind: 'formula', future: { a: 1 }, at: 2000 });
    expect(merged.byName).toBe('妈妈');
  });

  it('清空字段算修改', () => {
    const merged = mergeEdit(base, base, { ...base, note: undefined });
    expect(merged.note).toBeUndefined();
  });

  it('记录人不会被修改者覆盖', () => {
    const merged = mergeEdit(base, base, { ...base, ml: 100 });
    expect(merged.byName).toBe('妈妈');
  });

  it('修改后的数据过了校验，未知字段还在', () => {
    const stored = parseCollectionData('event', { ...base, unknownField: 'keep' }) as EventData;
    const parsed = parseCollectionData('event', mergeEdit(stored, stored, { ...stored, at: 5 }));
    expect(parsed).toMatchObject({ at: 5, unknownField: 'keep' });
  });
});

describe('修改回忆的媒体', () => {
  const ref = (id: string, extra: object = {}): MediaRef => ({
    id,
    kind: 'image',
    mime: 'image/png',
    size: 1,
    ...extra,
  });

  it('移除的摘掉，新增的放后面，其他不变', () => {
    const base = [ref('a'), ref('b')];
    expect(mergeMediaEdit(base, base, [ref('b'), ref('c')]).map((m) => m.id)).toEqual(['b', 'c']);
  });

  it('修改期间家人新加的不会丢', () => {
    const base = [ref('a')];
    const latest = [ref('a'), ref('family')];
    expect(mergeMediaEdit(base, latest, [ref('a'), ref('mine')]).map((m) => m.id)).toEqual([
      'a',
      'family',
      'mine',
    ]);
  });

  it('保留引用里的未知字段', () => {
    const base = [ref('a', { futureField: 1 })];
    expect(mergeMediaEdit(base, base, base)[0]).toMatchObject({ futureField: 1 });
  });
});

describe('补记和改时间之后的计算', () => {
  const now = at(2026, 3, 1);
  const feed = (hoursAgo: number, ml = 90): EventData => ({
    type: 'feed',
    at: now - hoursAgo * HOUR,
    ml,
  });

  it('补记早于最后一次的喂奶，距上次喂奶不变', () => {
    const before = estimateNextFeed([feed(1, 100), feed(4)], now);
    const after = estimateNextFeed([feed(1, 100), feed(4), feed(2.5, 60)], now);
    expect(after.last?.ml).toBe(100);
    expect(after.sinceMs).toBe(before.sinceMs);
  });

  it('把最后一次改到更早，距上次喂奶跟着变', () => {
    const edited = estimateNextFeed([feed(6, 100), feed(4)], now);
    expect(edited.last?.at).toBe(now - 4 * HOUR);
    expect(edited.sinceMs).toBe(4 * HOUR);
  });

  it('改到未来的记录不算上次喂奶', () => {
    expect(estimateNextFeed([feed(-1), feed(2)], now).sinceMs).toBe(2 * HOUR);
  });

  it('补记落在两次之间，平均间隔按实际顺序算', () => {
    const e = estimateNextFeed([feed(1), feed(3), feed(7), feed(5)], now);
    expect(e.isLearned).toBe(true);
    expect(e.intervalMs).toBe(2 * HOUR);
  });

  it('很久以前补记的喂奶不能用来估算现在的间隔', () => {
    const old = [feed(30 * 24), feed(30 * 24 + 2), feed(30 * 24 + 4)];
    const e = estimateNextFeed([feed(1), ...old], now);
    expect(e.last?.at).toBe(now - HOUR);
    expect(e.isLearned).toBe(false);
  });

  it('提醒时间按最新数据重算', () => {
    const regular = [feed(1), feed(3), feed(5)];
    expect(feedReminderDelayMs(regular, now)).toBe(HOUR);
    // 把最后一次改早了，已经过了平时的间隔，不再安排提醒。
    expect(feedReminderDelayMs([feed(3.5), feed(5.5), feed(7.5)], now)).toBeNull();
    // 数据不足时不提醒。
    expect(feedReminderDelayMs([feed(1)], now)).toBeNull();
    expect(feedReminderDelayMs([feed(1), feed(3)], now)).toBeNull();
  });

  it('摘要只算过去 24 小时，改到窗口外就不算了', () => {
    expect(summarize24h([feed(1), feed(2)], now).feeds).toBe(2);
    expect(summarize24h([feed(1), feed(25)], now).feeds).toBe(1);
    expect(summarize24h([feed(1), feed(-1)], now).feeds).toBe(1);
  });

  it('补记跨窗口的睡眠只算窗口内的部分', () => {
    const sleep: EventData = { type: 'sleep', at: now - 26 * HOUR, endAt: now - 22 * HOUR };
    expect(summarize24h([sleep], now).sleepMs).toBe(2 * HOUR);
  });

  it('给开着的睡眠补上结束时间后，不再算睡着', () => {
    const open: EventData = { type: 'sleep', at: now - HOUR };
    expect(activeSleep([open])).not.toBeNull();
    expect(activeSleep([{ ...open, endAt: now - 60_000 }])).toBeNull();
  });
});

describe('过去 24 小时的时间线', () => {
  const now = at(2026, 3, 1);
  const entry = (id: string, data: EventData) => ({ id, data });
  const feed = (id: string, hoursAgo: number) =>
    entry(id, { type: 'feed', at: now - hoursAgo * HOUR, ml: 90 });

  it('补记的旧记录不能混进来，否则只显示钟点，看起来像今天的', () => {
    const list = timelineEntries([feed('new', 1), feed('old', 30)], now);
    expect(list.map((e) => e.id)).toEqual(['new']);
  });

  it('身高体重和未来的不显示', () => {
    const list = timelineEntries(
      [
        feed('future', -1),
        entry('growth', { type: 'growth', at: now - HOUR, weightKg: 4, lengthCm: 50 }),
        feed('feed', 2),
      ],
      now,
    );
    expect(list.map((e) => e.id)).toEqual(['feed']);
  });

  it('最多 8 条', () => {
    const list = timelineEntries(
      Array.from({ length: 12 }, (_, i) => feed(`f${i}`, i + 1)),
      now,
    );
    expect(list).toHaveLength(8);
  });

  it('跨过窗口起点的睡眠和没结束的睡眠要能点到', () => {
    const list = timelineEntries(
      [
        entry('crossing', { type: 'sleep', at: now - 26 * HOUR, endAt: now - 22 * HOUR }),
        entry('open', { type: 'sleep', at: now - 40 * HOUR }),
        entry('done', { type: 'sleep', at: now - 40 * HOUR, endAt: now - 38 * HOUR }),
      ],
      now,
    );
    expect(list.map((e) => e.id).sort()).toEqual(['crossing', 'open']);
  });
});

describe('全部记录按天分组', () => {
  const entry = (id: string, when: number) => ({
    id,
    data: { type: 'bath', at: when } as EventData,
  });

  it('新的日子在前，同一天的新的在前', () => {
    const days = eventsByDay([
      entry('a', at(2026, 3, 1, 8)),
      entry('b', at(2026, 3, 2, 8)),
      entry('c', at(2026, 3, 1, 20)),
    ]);
    expect(days.map((d) => d.data.map((e) => e.id))).toEqual([['b'], ['c', 'a']]);
    expect(days[0]?.dayStart).toBe(at(2026, 3, 2, 0));
  });
});

describe('补记不能让提示误判已经记满一天', () => {
  const birth = at(2026, 1, 1);
  const now = at(2026, 2, 1);
  const today: EventData[] = [{ type: 'feed', at: now - HOUR, ml: 90 }];

  it('今天才开始记，补了以前的疫苗，不能说喂奶偏少', () => {
    const r = todayInsight(
      [...today, { type: 'vaccine', at: now - 20 * DAY, vaccineId: 'bcg', name: 'BCG' }],
      birth,
      now,
    );
    expect(r?.tone).toBe('neutral');
    expect(r?.text).toContain('记满一天');
  });

  it('今天才开始记，补了很久以前的一次喂奶，也不能这样判断', () => {
    const r = todayInsight([...today, { type: 'feed', at: now - 7 * DAY, ml: 90 }], birth, now);
    expect(r?.tone).toBe('neutral');
  });

  it('身高体重也不算在记录日常', () => {
    const r = todayInsight(
      [...today, { type: 'growth', at: now - 30 * HOUR, weightKg: 4, lengthCm: 50 }],
      birth,
      now,
    );
    expect(r?.tone).toBe('neutral');
  });

  it('一直在记的家庭，偏少的提醒不能被挡住', () => {
    const r = todayInsight([...today, { type: 'feed', at: now - 30 * HOUR, ml: 90 }], birth, now);
    expect(r?.tone).toBe('attention');
    expect(r?.text).toContain('比常见的少');
  });
});
