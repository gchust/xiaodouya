import { describe, expect, it } from 'vitest';
import { summarizeDay } from '../src/domain/events';
import { FORGOTTEN_SLEEP_MS, sleepState } from '../src/domain/feeding';
import { metricUnits } from '../src/domain/units';
import {
  buildWidgetView,
  formatSyncedAt,
  parseWidgetAction,
  planWidgetAction,
  type WidgetEntry,
  type WidgetSession,
} from '../src/domain/widget';
import type { BabyData, EventData } from '../src/schemas';

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
  options: { session?: WidgetSession; hasBaby?: boolean; known?: string[] } = {},
) =>
  planWidgetAction(action, {
    session: options.session ?? member,
    hasBaby: options.hasBaby ?? true,
    entries,
    isKnownId: (id) => (options.known ?? []).includes(id),
    now,
  });

describe('小工具记录喂奶', () => {
  it('沿用上一次的奶量和其他字段，不带备注，时间用现在', () => {
    const result = plan({ type: 'feed', id: 'new' }, [
      feed('old', now - HOUR, 90, { note: '吐奶了', formula: 'fictional-brand', byName: '妈妈' }),
      feed('older', now - 3 * HOUR, 60),
    ]);
    expect(result).toEqual({
      kind: 'write',
      id: 'new',
      data: { type: 'feed', at: now, ml: 90, formula: 'fictional-brand', byName: '爸爸' },
    });
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

describe('formatSyncedAt', () => {
  it('当天显示时间，之前的显示日期，从没同步过也如实说', () => {
    expect(formatSyncedAt(dayStart + HOUR, dayStart)).toBe('01:00 同步');
    expect(formatSyncedAt(dayStart - HOUR, dayStart)).toBe('6月14日同步');
    expect(formatSyncedAt(null, dayStart)).toBe('未同步');
  });
});
