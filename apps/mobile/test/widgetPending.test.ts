import { TAP_STUCK_MS, type WidgetAction } from '@xiaodouya/shared';
import { describe, expect, it } from 'vitest';
import { buttonOf, createPendingTaps, idsWithPending } from '../src/widgets/pending';

const ids = { feed: 'f-new', sleep: 's-new', wee: 'w-new', poo: 'p-new', both: 'b-new' };

describe('idsWithPending', () => {
  it('“记录中…”的按钮还是原来那次点击的 id，再点只会落在同一条记录上', () => {
    const feed: WidgetAction = { type: 'feed', id: 'f-tapped' };
    expect(idsWithPending(ids, feed)).toEqual({ ...ids, feed: 'f-tapped' });
    const poo: WidgetAction = { type: 'diaper', id: 'p-tapped', kind: 'poo' };
    expect(idsWithPending(ids, poo)).toEqual({ ...ids, poo: 'p-tapped' });
    const sleep: WidgetAction = { type: 'sleepStart', id: 's-tapped' };
    expect(idsWithPending(ids, sleep)).toEqual({ ...ids, sleep: 's-tapped' });
  });

  it('开始亲喂沿用这次点击的 id，结束亲喂用记录本身的 id', () => {
    const start: WidgetAction = { type: 'breastStart', id: 'b-tapped', side: 'left' };
    expect(idsWithPending(ids, start)).toEqual({ ...ids, feed: 'b-tapped' });
    expect(idsWithPending(ids, { type: 'breastEnd', feedId: 'feed-1' })).toBe(ids);
  });

  it('结束睡眠和没有点击时不改 id', () => {
    expect(idsWithPending(ids, { type: 'sleepEnd', sleepId: 'sleep-1' })).toBe(ids);
    expect(idsWithPending(ids, undefined)).toBe(ids);
  });

  it('按钮对应关系', () => {
    expect(buttonOf({ type: 'feed', id: 'x' })).toBe('feed');
    expect(buttonOf({ type: 'sleepStart', id: 'x' })).toBe('sleep');
    expect(buttonOf({ type: 'sleepEnd', sleepId: 'x' })).toBe('sleep');
    expect(buttonOf({ type: 'diaper', id: 'x', kind: 'both' })).toBe('both');
    expect(buttonOf({ type: 'breastStart', id: 'x', side: 'right' })).toBe('feed');
    expect(buttonOf({ type: 'breastEnd', feedId: 'x' })).toBe('feed');
  });
});

describe('createPendingTaps', () => {
  const feed: WidgetAction = { type: 'feed', id: 'f-1' };
  const wee: WidgetAction = { type: 'diaper', id: 'w-1', kind: 'wee' };

  it('点了以后到写完之前是“记录中…”，写完就清掉', () => {
    const taps = createPendingTaps();
    taps.start('FeedWidget', feed, 0);
    expect(taps.get('FeedWidget', 100)).toEqual(feed);
    expect(taps.get('QuickWidget', 100)).toBeUndefined();
    taps.finish('FeedWidget', { ...feed });
    expect(taps.get('FeedWidget', 200)).toBeUndefined();
  });

  it('只清掉自己那次：后点的按钮还在写，不能把它的“记录中…”也清掉', () => {
    const taps = createPendingTaps();
    taps.start('QuickWidget', feed, 0);
    taps.start('QuickWidget', wee, 50);
    taps.finish('QuickWidget', feed);
    expect(taps.get('QuickWidget', 100)).toEqual(wee);
  });

  it('任务异常结束、一直没清掉时，过一会儿不再显示“记录中…”', () => {
    const taps = createPendingTaps();
    taps.start('FeedWidget', feed, 0);
    expect(taps.get('FeedWidget', TAP_STUCK_MS - 1)).toEqual(feed);
    expect(taps.get('FeedWidget', TAP_STUCK_MS)).toBeUndefined();
  });
});
