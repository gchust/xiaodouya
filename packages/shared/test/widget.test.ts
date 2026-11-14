import { describe, expect, it } from 'vitest';
import { summarizeDay } from '../src/domain/events';
import { FORGOTTEN_SLEEP_MS, sleepState } from '../src/domain/feeding';
import { metricUnits } from '../src/domain/units';
import {
  buildWidgetView,
  formatSyncedAt,
  normalizeWidgetLabel,
  parseWidgetAction,
  parseWidgetPrefs,
  planWidgetAction,
  shortBabyName,
  WIDGET_LABEL_MAX,
  type WidgetEntry,
  type WidgetSession,
  widgetAvatarKey,
  widgetBabyId,
  widgetLabel,
} from '../src/domain/widget';
import { formulaSnapshot } from '../src/health/nutrition';
import type { BabyData, EventData, FormulaData, MediaRef } from '../src/schemas';

const HOUR = 3_600_000;
const now = new Date(2026, 5, 15, 12, 0, 0).getTime();
const dayStart = new Date(2026, 5, 15, 0, 0, 0).getTime();

const member: WidgetSession = { signedIn: true, hasFamily: true, role: 'caregiver', label: '爸爸' };
const baby: BabyData = { name: '测试豆', birthAt: now - 30 * 24 * HOUR };

const entry = (id: string, data: EventData): WidgetEntry => ({ id, data });
const feed = (id: string, at: number, ml: number, extra: Record<string, unknown> = {}) =>
  entry(id, { type: 'feed', at, ml, ...extra });
const sleep = (id: string, at: number, endAt?: number) =>
  entry(id, endAt ? { type: 'sleep', at, endAt } : { type: 'sleep', at });

const plan = (
  action: Parameters<typeof planWidgetAction>[0],
  entries: WidgetEntry[],
  options: {
    session?: WidgetSession;
    hasBaby?: boolean;
    known?: string[];
    formulas?: { id: string; data: FormulaData }[];
  } = {},
) =>
  planWidgetAction(action, {
    session: options.session ?? member,
    hasBaby: options.hasBaby ?? true,
    entries,
    formulas: options.formulas ?? [],
    isKnownId: (id) => (options.known ?? []).includes(id),
    now,
  });

describe('小工具记录喂奶', () => {
  it('沿用上一次的奶量，不带备注和记录人，时间用现在', () => {
    const result = plan({ type: 'feed', id: 'new' }, [
      feed('old', now - HOUR, 90, { note: '吐奶了', byName: '妈妈' }),
      feed('older', now - 3 * HOUR, 60),
    ]);
    expect(result).toEqual({
      kind: 'write',
      id: 'new',
      data: { type: 'feed', at: now, ml: 90, byName: '爸爸' },
    });
  });

  const brand: FormulaData = {
    type: 'formula',
    name: '虚构奶粉',
    basis: 'per100ml',
    values: { energyKcal: 67 },
  };
  const oldSnapshot = { name: '虚构奶粉', per100ml: { energyKcal: 60 } };

  it('沿用奶类型，快照用奶粉现在的数值', () => {
    const result = plan(
      { type: 'feed', id: 'new' },
      [feed('old', now - HOUR, 90, { milkType: 'formula', formulaId: 'f1', formula: oldSnapshot })],
      { formulas: [{ id: 'f1', data: brand }] },
    );
    expect(result).toEqual({
      kind: 'write',
      id: 'new',
      data: {
        type: 'feed',
        at: now,
        ml: 90,
        milkType: 'formula',
        formulaId: 'f1',
        formula: formulaSnapshot(brand),
        byName: '爸爸',
      },
    });
  });

  it('奶粉被删了就不再沿用，也不用旧快照', () => {
    const result = plan({ type: 'feed', id: 'new' }, [
      feed('old', now - HOUR, 90, { milkType: 'formula', formulaId: 'f1', formula: oldSnapshot }),
    ]);
    expect(result).toEqual({
      kind: 'write',
      id: 'new',
      data: { type: 'feed', at: now, ml: 90, milkType: 'formula', byName: '爸爸' },
    });
  });

  it('家人用旧版记的没有奶类型，奶量跟最新的，奶类型跟最近标过的', () => {
    const result = plan({ type: 'feed', id: 'new' }, [
      feed('newest', now - HOUR, 120),
      feed('marked', now - 2 * HOUR, 90, { milkType: 'breast' }),
    ]);
    expect(result).toMatchObject({ data: { ml: 120, milkType: 'breast' } });
  });

  it('没有喂奶记录时不编奶量，要去 App 里选', () => {
    expect(plan({ type: 'feed', id: 'new' }, [])).toEqual({ kind: 'needsAmount' });
    expect(plan({ type: 'feed', id: 'new' }, [sleep('s', now - HOUR, now - 1)])).toEqual({
      kind: 'needsAmount',
    });
  });

  it('上一次奶量是 0 时也不沿用', () => {
    expect(plan({ type: 'feed', id: 'new' }, [feed('old', now - HOUR, 0)])).toEqual({
      kind: 'needsAmount',
    });
  });

  it('不把未来时间的记录当成上一次', () => {
    expect(plan({ type: 'feed', id: 'new' }, [feed('future', now + HOUR, 120)])).toEqual({
      kind: 'needsAmount',
    });
  });

  it('同一个 id 点两次只记一条，撤销过的也不会复活', () => {
    expect(
      plan({ type: 'feed', id: 'same' }, [feed('old', now - HOUR, 90)], { known: ['same'] }),
    ).toEqual({ kind: 'noop' });
  });
});

describe('小工具记录睡眠', () => {
  it('开始睡眠写一条没有结束时间的记录', () => {
    expect(plan({ type: 'sleepStart', id: 'new' }, [])).toEqual({
      kind: 'write',
      id: 'new',
      data: { type: 'sleep', at: now, byName: '爸爸' },
    });
  });

  it('已经有人开始了睡眠，不再开一条', () => {
    expect(plan({ type: 'sleepStart', id: 'new' }, [sleep('s', now - HOUR)])).toEqual({
      kind: 'noop',
    });
  });

  it('结束睡眠保留原来的字段', () => {
    const s = entry('s', { type: 'sleep', at: now - HOUR, byName: '妈妈', note: '小床' });
    expect(plan({ type: 'sleepEnd', sleepId: 's' }, [s])).toEqual({
      kind: 'write',
      id: 's',
      data: { type: 'sleep', at: now - HOUR, byName: '妈妈', note: '小床', endAt: now },
    });
  });

  it('已经结束或被删除的睡眠，再点“醒了”不改任何东西', () => {
    expect(plan({ type: 'sleepEnd', sleepId: 's' }, [sleep('s', now - HOUR, now - 1)])).toEqual({
      kind: 'noop',
    });
    expect(plan({ type: 'sleepEnd', sleepId: 'gone' }, [])).toEqual({ kind: 'noop' });
  });

  it('忘记结束的睡眠不能用现在当醒来时间，那会记成一次超长睡眠', () => {
    const stale = sleep('s', now - FORGOTTEN_SLEEP_MS - 1);
    expect(plan({ type: 'sleepEnd', sleepId: 's' }, [stale])).toEqual({ kind: 'noop' });
    expect(plan({ type: 'sleepStart', id: 'new' }, [stale])).toEqual({ kind: 'noop' });
  });
});

describe('小工具的权限', () => {
  const cases: [string, WidgetSession, boolean][] = [
    ['未登录', { signedIn: false, hasFamily: false, role: null, label: '' }, true],
    ['没有家庭', { signedIn: true, hasFamily: false, role: null, label: '爸爸' }, true],
    ['只看回忆的家人', { ...member, role: 'viewer' }, true],
    ['没有宝宝', member, false],
  ];

  it.each(cases)('%s：不写数据', (_name, session, hasBaby) => {
    const entries = [feed('old', now - HOUR, 90), sleep('s', now - HOUR)];
    for (const action of [
      { type: 'feed', id: 'n' },
      { type: 'sleepStart', id: 'n' },
      { type: 'sleepEnd', sleepId: 's' },
    ] as const) {
      expect(plan(action, entries, { session, hasBaby })).toEqual({ kind: 'blocked' });
    }
  });

  it.each(cases)('%s：不显示名字和记录', (_name, session, hasBaby) => {
    const view = buildWidgetView({
      session,
      baby: hasBaby ? baby : null,
      entries: [feed('old', now - HOUR, 90)],
      units: metricUnits,
      now,
      dayStart,
      syncedAt: now,
    });
    expect(view.kind).toBe('blocked');
    expect(JSON.stringify(view)).not.toContain('测试豆');
    expect(JSON.stringify(view)).not.toContain('90');
  });

  it('角色未知时按没有权限处理', () => {
    expect(plan({ type: 'feed', id: 'n' }, [], { session: { ...member, role: null } })).toEqual({
      kind: 'blocked',
    });
  });
});

describe('小工具显示的内容', () => {
  const build = (
    entries: WidgetEntry[],
    over: Partial<Parameters<typeof buildWidgetView>[0]> = {},
  ) =>
    buildWidgetView({
      session: member,
      baby,
      entries,
      units: metricUnits,
      now,
      dayStart,
      syncedAt: now - 60_000,
      ...over,
    });

  const ready = (view: ReturnType<typeof buildWidgetView>) => {
    if (view.kind !== 'ready') throw new Error('应该是 ready');
    return view;
  };

  it('用真实名字和上一次奶量', () => {
    const view = ready(build([feed('a', now - HOUR, 90)]));
    expect(view.babyName).toBe('测试豆');
    expect(view.lastFeed).toEqual({ id: 'a', at: now - HOUR, ml: 90 });
  });

  it('奶量按用户单位显示，不写死 ml', () => {
    const view = ready(
      build([feed('a', now - HOUR, 90)], { units: { ...metricUnits, volume: 'oz' } }),
    );
    expect(view.lastFeedAmount).toBe('3oz');
    expect(view.todayAmount).toBe('3oz');
  });

  it('上一次奶量不能沿用时，界面也不提供一键记录', () => {
    expect(ready(build([])).lastFeed).toBeNull();
    expect(ready(build([feed('a', now - HOUR, 0)])).canQuickFeed).toBe(false);
    expect(ready(build([feed('a', now - HOUR, 60)])).canQuickFeed).toBe(true);
  });

  it('区分睡觉中、忘了结束和没在睡', () => {
    expect(ready(build([sleep('s', now - HOUR)])).sleep).toEqual({
      status: 'asleep',
      id: 's',
      since: now - HOUR,
    });
    expect(ready(build([sleep('s', now - FORGOTTEN_SLEEP_MS - 1)])).sleep).toEqual({
      status: 'forgotten',
      id: 's',
      since: now - FORGOTTEN_SLEEP_MS - 1,
    });
    expect(ready(build([sleep('s', now - 2 * HOUR, now - HOUR)])).sleep).toEqual({
      status: 'awake',
      lastEnd: now - HOUR,
    });
    expect(ready(build([])).sleep).toEqual({ status: 'awake', lastEnd: null });
  });

  it('今日汇总按当天 0 点算，昨天的记录不算进来', () => {
    const view = ready(build([feed('today', dayStart + HOUR, 90), feed('y', dayStart - 1, 120)]));
    expect(view.today.feeds).toBe(1);
    expect(view.today.ml).toBe(90);
  });

  it('跨过午夜后汇总归零', () => {
    const entries = [feed('a', now - HOUR, 90)];
    const nextDay = dayStart + 24 * HOUR;
    const view = ready(build(entries, { now: nextDay + 60_000, dayStart: nextDay }));
    expect(view.today).toMatchObject({ feeds: 0, ml: 0, diapers: 0, sleepMs: 0 });
  });
});

describe('summarizeDay', () => {
  it('跨午夜的睡眠只算今天的部分', () => {
    const summary = summarizeDay(
      [{ type: 'sleep', at: dayStart - HOUR, endAt: dayStart + 2 * HOUR }],
      dayStart,
      now,
    );
    expect(summary.sleepMs).toBe(2 * HOUR);
  });

  it('正在睡的算到现在，忘记结束的不算', () => {
    expect(summarizeDay([{ type: 'sleep', at: now - HOUR }], dayStart, now).sleepMs).toBe(HOUR);
    expect(
      summarizeDay([{ type: 'sleep', at: now - FORGOTTEN_SLEEP_MS - 1 }], dayStart, now).sleepMs,
    ).toBe(0);
  });

  it('正好 0 点的记录算今天，未来时间的不算', () => {
    const summary = summarizeDay(
      [
        { type: 'feed', at: dayStart, ml: 60 },
        { type: 'feed', at: now + 1, ml: 60 },
        { type: 'diaper', at: now - 1, kind: 'poo' },
        { type: 'diaper', at: now - 2, kind: 'both' },
      ],
      dayStart,
      now,
    );
    expect(summary).toMatchObject({ feeds: 1, ml: 60, diapers: 2, wetDiapers: 1 });
  });
});

describe('sleepState', () => {
  it('正好 12 小时还算睡着，超过就不当真', () => {
    const at = now - FORGOTTEN_SLEEP_MS;
    expect(sleepState([{ type: 'sleep', at }], now).status).toBe('asleep');
    expect(sleepState([{ type: 'sleep', at: at - 1 }], now).status).toBe('forgotten');
  });
});

describe('parseWidgetAction', () => {
  it('只接受合法的动作', () => {
    expect(parseWidgetAction({ type: 'feed', id: 'a' })).toEqual({ type: 'feed', id: 'a' });
    expect(parseWidgetAction({ type: 'sleepEnd', sleepId: 'a' })).toEqual({
      type: 'sleepEnd',
      sleepId: 'a',
    });
    expect(parseWidgetAction({ type: 'feed' })).toBeNull();
    expect(parseWidgetAction({ type: 'nuke', id: 'a' })).toBeNull();
    expect(parseWidgetAction(null)).toBeNull();
  });
});

describe('shortBabyName', () => {
  it('放得下时不动', () => {
    expect(shortBabyName('小禾', 10)).toBe('小禾');
    expect(shortBabyName('Sprout Lee', 10)).toBe('Sprout Lee');
  });

  it('放不下时截短，中文按两格算', () => {
    expect(shortBabyName('一个特别特别长的虚构小名字', 11)).toBe('一个特别特…');
    expect(shortBabyName('Bartholomew the Second', 11)).toBe('Bartholome…');
  });

  it('不切断表情符号', () => {
    expect(shortBabyName('🌱🌱🌱🌱🌱🌱🌱', 5)).toBe('🌱🌱…');
  });
});

describe('formatSyncedAt', () => {
  it('当天显示时间，之前的显示日期，从没同步过也如实说', () => {
    expect(formatSyncedAt(dayStart + HOUR, dayStart)).toBe('01:00 同步');
    expect(formatSyncedAt(dayStart - HOUR, dayStart)).toBe('6月14日同步');
    expect(formatSyncedAt(null, dayStart)).toBe('未同步');
  });
});

const diaper = (id: string, at: number, kind: 'wee' | 'poo' | 'both') =>
  entry(id, { type: 'diaper', at, kind });

describe('小工具记录尿布', () => {
  it('按点的按钮写一条尿布，时间用现在，记录人是自己', () => {
    expect(
      plan({ type: 'diaper', id: 'd1', kind: 'poo' }, [diaper('old', now - HOUR, 'wee')]),
    ).toEqual({
      kind: 'write',
      id: 'd1',
      data: { type: 'diaper', at: now, kind: 'poo', byName: '爸爸' },
    });
  });

  it('同一个 id 点两次只记一条，撤销过的也不会复活', () => {
    expect(plan({ type: 'diaper', id: 'd1', kind: 'wee' }, [], { known: ['d1'] })).toEqual({
      kind: 'noop',
    });
  });

  it('只看回忆的家人和没有宝宝时都不写', () => {
    const viewer: WidgetSession = { ...member, role: 'viewer' };
    expect(plan({ type: 'diaper', id: 'd1', kind: 'wee' }, [], { session: viewer })).toEqual({
      kind: 'blocked',
    });
    expect(plan({ type: 'diaper', id: 'd1', kind: 'wee' }, [], { hasBaby: false })).toEqual({
      kind: 'blocked',
    });
  });

  it('只接受三种尿布', () => {
    expect(parseWidgetAction({ type: 'diaper', id: 'a', kind: 'both' })).toEqual({
      type: 'diaper',
      id: 'a',
      kind: 'both',
    });
    expect(parseWidgetAction({ type: 'diaper', id: 'a', kind: 'blood' })).toBeNull();
    expect(parseWidgetAction({ type: 'diaper', kind: 'wee' })).toBeNull();
  });
});

describe('小工具显示的新内容', () => {
  const build = (
    entries: WidgetEntry[],
    over: Partial<Parameters<typeof buildWidgetView>[0]> = {},
  ) => {
    const view = buildWidgetView({
      session: member,
      baby,
      entries,
      units: metricUnits,
      now,
      dayStart,
      syncedAt: now - 60_000,
      ...over,
    });
    if (view.kind !== 'ready') throw new Error('应该是 ready');
    return view;
  };
  const threeFeeds = (lastAgo: number) => [
    feed('c', now - lastAgo, 90),
    feed('b', now - lastAgo - 3 * HOUR, 90),
    feed('a', now - lastAgo - 6 * HOUR, 90),
  ];

  it('第几天和今天页一样，出生当天是第 1 天', () => {
    expect(build([]).dayNumber).toBe(31);
  });

  it('不到 3 次喂奶不估算下次时间，不能拿默认间隔吓人或安慰人', () => {
    expect(build([]).nextFeed).toBeNull();
    expect(build([feed('b', now - HOUR, 90), feed('a', now - 4 * HOUR, 90)]).nextFeed).toBeNull();
  });

  it('下次喂奶写成具体时刻，30 分钟内算快到了，过了就是到时间了', () => {
    expect(build(threeFeeds(HOUR)).nextFeed).toEqual({ at: now + 2 * HOUR, status: 'later' });
    expect(build(threeFeeds(2.75 * HOUR)).nextFeed).toEqual({
      at: now + 0.25 * HOUR,
      status: 'near',
    });
    expect(build(threeFeeds(3 * HOUR)).nextFeed).toEqual({ at: now, status: 'due' });
  });

  it('上次换尿布取最新的一条，未来时间的不算', () => {
    const view = build([
      diaper('future', now + HOUR, 'wee'),
      diaper('new', now - HOUR, 'poo'),
      diaper('old', now - 2 * HOUR, 'wee'),
    ]);
    expect(view.lastDiaper).toEqual({ id: 'new', at: now - HOUR, kind: 'poo' });
    expect(build([]).lastDiaper).toBeNull();
  });

  it('同步时间平时不显示，超过 30 分钟没同步或者从没同步过才显示', () => {
    expect(build([]).showSync).toBe(false);
    expect(build([], { syncedAt: now - 30 * 60_000 }).showSync).toBe(false);
    expect(build([], { syncedAt: now - 31 * 60_000 }).showSync).toBe(true);
    expect(build([], { syncedAt: null }).showSync).toBe(true);
  });
});

describe('一天的节奏', () => {
  const build = (entries: WidgetEntry[]) => {
    const view = buildWidgetView({
      session: member,
      baby,
      entries,
      units: metricUnits,
      now,
      dayStart,
      syncedAt: now,
    });
    if (view.kind !== 'ready') throw new Error('应该是 ready');
    return view.dayline;
  };

  it('按一天里的位置放喂奶和尿布，昨天和未来的不放', () => {
    const line = build([
      feed('a', dayStart + 6 * HOUR, 90),
      feed('y', dayStart - HOUR, 90),
      feed('f', now + HOUR, 90),
      diaper('d', dayStart + 3 * HOUR, 'wee'),
    ]);
    expect(line.feeds).toEqual([0.25]);
    expect(line.diapers).toEqual([0.125]);
    expect(line.now).toBe(0.5);
  });

  it('跨午夜的睡眠从 0 点画起，正在睡的画到现在，忘了结束的不画', () => {
    expect(build([sleep('s', dayStart - HOUR, dayStart + 3 * HOUR)]).sleeps).toEqual([
      { from: 0, to: 0.125 },
    ]);
    expect(build([sleep('s', now - 3 * HOUR)]).sleeps).toEqual([{ from: 0.375, to: 0.5 }]);
    expect(build([sleep('s', now - FORGOTTEN_SLEEP_MS - 1)]).sleeps).toEqual([]);
  });

  it('按时间先后排好', () => {
    const line = build([
      feed('b', dayStart + 9 * HOUR, 90),
      feed('a', dayStart + 3 * HOUR, 90),
      sleep('t', dayStart + 6 * HOUR, dayStart + 7 * HOUR),
      sleep('s', dayStart + HOUR, dayStart + 2 * HOUR),
    ]);
    expect(line.feeds).toEqual([0.125, 0.375]);
    expect(line.sleeps.map((s) => s.from)).toEqual([1 / 24, 0.25]);
  });
});

describe('小工具上的称呼和头像', () => {
  const avatar: MediaRef = {
    id: '6f1c2a4e-1111-4c3b-9a55-0d2c7e9b1a01',
    kind: 'image',
    mime: 'image/jpeg',
    size: 2048,
  };
  const base = {
    session: member,
    baby,
    entries: [],
    units: metricUnits,
    now,
    dayStart,
    syncedAt: now,
  };

  it('没设置、空白时用宝宝的名字', () => {
    expect(widgetLabel({}, '测试豆')).toBe('测试豆');
    expect(widgetLabel({ label: '' }, '测试豆')).toBe('测试豆');
    expect(widgetLabel({ label: '   ' }, '测试豆')).toBe('测试豆');
  });

  it('设置了就用设置的，去掉首尾空白，中间的空白合成一个', () => {
    expect(widgetLabel({ label: '  豆豆 ' }, '测试豆')).toBe('豆豆');
    expect(normalizeWidgetLabel('Little \n  Bean')).toBe('Little Bean');
    expect(normalizeWidgetLabel('  ')).toBeNull();
    expect(normalizeWidgetLabel(undefined)).toBeNull();
  });

  it('超过上限按字截短，不切断表情符号', () => {
    const long = '🌱'.repeat(WIDGET_LABEL_MAX + 3);
    expect(normalizeWidgetLabel(long)).toBe('🌱'.repeat(WIDGET_LABEL_MAX));
  });

  it('小工具显示设置的称呼，没设置时显示名字', () => {
    const named = buildWidgetView({ ...base, label: '豆豆' });
    const plain = buildWidgetView({ ...base, label: '  ' });
    const unset = buildWidgetView(base);
    expect(named.kind === 'ready' && named.babyName).toBe('豆豆');
    expect(plain.kind === 'ready' && plain.babyName).toBe('测试豆');
    expect(unset.kind === 'ready' && unset.babyName).toBe('测试豆');
  });

  it('看不了记录时也不显示设置的称呼', () => {
    const view = buildWidgetView({
      ...base,
      session: { ...member, role: 'viewer' },
      label: '豆豆',
    });
    expect(view.kind).toBe('blocked');
    expect(JSON.stringify(view)).not.toContain('豆豆');
  });

  it('存的设置读不出来时回到默认：用名字，不显示头像', () => {
    for (const raw of [
      null,
      '',
      'not json',
      '[]',
      '"x"',
      'null',
      '{"label":5,"showAvatar":"yes"}',
    ]) {
      const prefs = parseWidgetPrefs(raw);
      expect(widgetLabel(prefs, '测试豆')).toBe('测试豆');
      expect(widgetAvatarKey(prefs, avatar)).toBeNull();
    }
    expect(parseWidgetPrefs('{"label":"豆豆","showAvatar":true}')).toEqual({
      label: '豆豆',
      showAvatar: true,
    });
  });

  it('小工具固定的宝宝还在就记给它，否则跟着当前宝宝（issue #106）', () => {
    const first = '11111111-1111-4111-8111-111111111111';
    const second = '22222222-2222-4222-8222-222222222222';
    const babies = [{ id: first }, { id: second }];
    expect(widgetBabyId({}, babies, first)).toBe(first);
    expect(widgetBabyId({ babyId: second }, babies, first)).toBe(second);
    // 固定的宝宝删了（不在能显示的宝宝里）：回到当前宝宝。
    expect(widgetBabyId({ babyId: second }, [{ id: first }], first)).toBe(first);
    expect(parseWidgetPrefs(`{"babyId":"${second}"}`)).toEqual({ babyId: second });
    expect(parseWidgetPrefs('{"babyId":"not-a-uuid","label":"豆豆"}')).toEqual({ label: '豆豆' });
  });

  it('打开开关、宝宝有图片头像时才显示，缓存按头像的文件 id 区分', () => {
    expect(widgetAvatarKey({}, avatar)).toBeNull();
    expect(widgetAvatarKey({ showAvatar: false }, avatar)).toBeNull();
    expect(widgetAvatarKey({ showAvatar: true }, undefined)).toBeNull();
    expect(widgetAvatarKey({ showAvatar: true }, { ...avatar, kind: 'video' })).toBeNull();
    expect(widgetAvatarKey({ showAvatar: true }, avatar)).toBe(avatar.id);
    const next = { ...avatar, id: '6f1c2a4e-2222-4c3b-9a55-0d2c7e9b1a02' };
    expect(widgetAvatarKey({ showAvatar: true }, next)).toBe(next.id);
  });
});
