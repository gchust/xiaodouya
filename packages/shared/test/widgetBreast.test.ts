import { describe, expect, it } from 'vitest';
import {
  breastFeedState,
  buildWidgetView,
  type EventData,
  finishBreastFeed,
  metricUnits,
  parseWidgetAction,
  planWidgetAction,
  startBreastFeed,
  switchBreastSide,
  type WidgetEntry,
  type WidgetSession,
} from '../src';

const MIN = 60_000;
const HOUR = 60 * MIN;
const now = new Date(2026, 10, 14, 12).getTime();
const dayStart = new Date(2026, 10, 14).getTime();

type Feed = Extract<EventData, { type: 'feed' }>;

const member: WidgetSession = { signedIn: true, hasFamily: true, role: 'caregiver', label: '妈妈' };
const entry = (id: string, data: EventData): WidgetEntry => ({ id, data });
const bottle = (id: string, at: number, ml: number) => entry(id, { type: 'feed', at, ml });
/** 喂完的一次亲喂，最后一侧是 `side`。 */
const nursed = (id: string, at: number, side: 'left' | 'right') =>
  entry(id, finishBreastFeed(startBreastFeed(side, at), at + 10 * MIN));
const running = (id: string, at: number, side: 'left' | 'right') =>
  entry(id, startBreastFeed(side, at));

const plan = (
  action: Parameters<typeof planWidgetAction>[0],
  entries: WidgetEntry[],
  known: string[] = [],
) =>
  planWidgetAction(action, {
    session: member,
    hasBaby: true,
    entries,
    formulas: [],
    isKnownId: (id) => known.includes(id) || entries.some((e) => e.id === id),
    now,
  });

const view = (entries: WidgetEntry[]) => {
  const built = buildWidgetView({
    session: member,
    baby: { name: '测试豆', birthAt: now - 30 * 24 * HOUR },
    entries,
    units: metricUnits,
    now,
    dayStart,
    syncedAt: now,
  });
  if (built.kind !== 'ready') throw new Error('应该是 ready');
  return built;
};

describe('小工具上的亲喂：显示什么', () => {
  it('上一次是瓶喂：照旧一键记瓶喂，不提亲喂', () => {
    expect(
      view([nursed('n', now - 5 * HOUR, 'left'), bottle('b', now - 2 * HOUR, 90)]).breast,
    ).toEqual({
      status: 'none',
    });
  });

  it('上一次是喂完的亲喂：从另一侧开始', () => {
    expect(
      view([bottle('b', now - 5 * HOUR, 90), nursed('n', now - 2 * HOUR, 'left')]).breast,
    ).toEqual({
      status: 'next',
      side: 'right',
    });
  });

  it('正在计时：是哪一条、从几点开始、正在喂哪一侧', () => {
    const switched = switchBreastSide(
      startBreastFeed('left', now - 20 * MIN),
      'right',
      now - 5 * MIN,
    );
    expect(view([entry('r', switched as Feed)]).breast).toEqual({
      status: 'running',
      id: 'r',
      since: now - 20 * MIN,
      side: 'right',
    });
  });

  it('开了 2 小时以上算忘了关，要到 App 里结束', () => {
    expect(view([running('r', now - 3 * HOUR, 'left')]).breast).toEqual({
      status: 'forgotten',
      id: 'r',
      since: now - 3 * HOUR,
    });
  });

  it('没有喂奶记录时不提亲喂', () => {
    expect(view([]).breast).toEqual({ status: 'none' });
  });
});

describe('小工具上的亲喂：点了写什么', () => {
  it('开始：写一条没有结束时间的亲喂，和 App 里点一侧一样，记录人是自己', () => {
    const result = plan({ type: 'breastStart', id: 'new', side: 'right' }, [
      nursed('n', now - 2 * HOUR, 'left'),
    ]);
    expect(result).toEqual({
      kind: 'write',
      id: 'new',
      data: { ...startBreastFeed('right', now), byName: '妈妈' },
    });
    // 写下去的就是 App 认的计时：今天页、喂奶弹层看到的是同一条。
    if (result.kind !== 'write') throw new Error('应该写入');
    const state = breastFeedState([result.data], now + MIN);
    expect(state.status).toBe('running');
  });

  it('同一个 id 点两次只开一条，撤销过的也不会复活', () => {
    expect(plan({ type: 'breastStart', id: 'new', side: 'right' }, [], ['new'])).toEqual({
      kind: 'noop',
    });
  });

  it('已经有人在计时（包括忘了关的）就不再开一条', () => {
    expect(
      plan({ type: 'breastStart', id: 'new', side: 'right' }, [
        running('r', now - 10 * MIN, 'left'),
      ]),
    ).toEqual({ kind: 'noop' });
    expect(
      plan({ type: 'breastStart', id: 'new', side: 'right' }, [
        running('r', now - 3 * HOUR, 'left'),
      ]),
    ).toEqual({ kind: 'noop' });
  });

  it('结束：把正在喂的这一段记进去，留下最后一侧，和 App 里点结束一样', () => {
    const open = startBreastFeed('left', now - 12 * MIN);
    const result = plan({ type: 'breastEnd', feedId: 'r' }, [
      entry('r', { ...open, byName: '爸爸' }),
    ]);
    expect(result).toEqual({
      kind: 'write',
      id: 'r',
      data: { ...finishBreastFeed(open, now), byName: '爸爸' },
    });
    if (result.kind !== 'write') throw new Error('应该写入');
    expect(result.data).toMatchObject({ leftSec: 12 * 60, side: 'left', endAt: now });
  });

  it('已经结束、被删或者换成了别的一条，再点结束什么都不改', () => {
    expect(plan({ type: 'breastEnd', feedId: 'n' }, [nursed('n', now - HOUR, 'left')])).toEqual({
      kind: 'noop',
    });
    expect(
      plan({ type: 'breastEnd', feedId: 'gone' }, [running('r', now - 5 * MIN, 'left')]),
    ).toEqual({ kind: 'noop' });
  });

  it('忘了关的计时不能一点就结束：会把开着的几个小时都算成没喂，要到 App 里改时长', () => {
    expect(
      plan({ type: 'breastEnd', feedId: 'r' }, [running('r', now - 3 * HOUR, 'left')]),
    ).toEqual({
      kind: 'noop',
    });
  });

  it('只接受合法的动作', () => {
    expect(parseWidgetAction({ type: 'breastStart', id: 'x', side: 'right' })).toEqual({
      type: 'breastStart',
      id: 'x',
      side: 'right',
    });
    expect(parseWidgetAction({ type: 'breastStart', id: 'x', side: 'both' })).toBeNull();
    expect(parseWidgetAction({ type: 'breastStart', id: 'x' })).toBeNull();
    expect(parseWidgetAction({ type: 'breastEnd', feedId: 'r' })).toEqual({
      type: 'breastEnd',
      feedId: 'r',
    });
    expect(parseWidgetAction({ type: 'breastEnd' })).toBeNull();
  });

  it('旧画面上的“＋ 奶量”还是记瓶喂', () => {
    const result = plan({ type: 'feed', id: 'new' }, [
      bottle('b', now - 5 * HOUR, 90),
      nursed('n', now - 2 * HOUR, 'left'),
    ]);
    expect(result).toMatchObject({ kind: 'write', data: { type: 'feed', ml: 90 } });
  });
});
