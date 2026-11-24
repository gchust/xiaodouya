import { describe, expect, it } from 'vitest';
import { metricUnits } from '../src/domain/units';
import {
  buildWidgetView,
  WIDGET_ELAPSED_MAX_MS,
  type WidgetEntry,
  type WidgetSession,
  widgetElapsedClock,
} from '../src/domain/widget';
import type { BabyData } from '../src/schemas';

const MIN = 60_000;
const HOUR = 60 * MIN;

/** 桌面上的时钟控件做的事：按给它的时区读出现在几点几分。 */
function clockReads(timeZone: string, at: number): string {
  const zone = timeZone === 'GMT' ? 'UTC' : timeZone.replace('GMT', '');
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(new Date(at));
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return `${part('hour')}:${part('minute')}`;
}

describe('小工具上“过了多久”的时钟', () => {
  const fedAt = Date.UTC(2026, 10, 24, 13, 37, 42);

  it('时钟读出来的就是过了几小时几分，之后不用重画也一直对', () => {
    const clock = widgetElapsedClock(fedAt, fedAt + 5 * MIN);
    expect(clock).not.toBeNull();
    const zone = clock?.timeZone ?? '';
    expect(zone).toBe('GMT-13:37');
    expect(clockReads(zone, fedAt + 10_000)).toBe('0:0');
    // 时区只能精确到分钟，记录的秒数被舍掉：读数在整分钟跳，最多早跳不到 1 分钟，不会少算。
    expect(clockReads(zone, fedAt + 20_000)).toBe('0:1');
    expect(clockReads(zone, fedAt + 5 * MIN)).toBe('0:5');
    expect(clockReads(zone, fedAt + 2 * HOUR + 15 * MIN)).toBe('2:15');
    // 跨过 UTC 的午夜也不变。
    expect(clockReads(zone, fedAt + 12 * HOUR + 59 * MIN)).toBe('12:59');
  });

  it('整点和 0 点的记录', () => {
    expect(widgetElapsedClock(Date.UTC(2026, 10, 24, 0, 0, 5), Date.UTC(2026, 10, 24, 1))).toEqual({
      timeZone: 'GMT',
    });
    expect(widgetElapsedClock(Date.UTC(2026, 10, 24, 9, 5), Date.UTC(2026, 10, 24, 10))).toEqual({
      timeZone: 'GMT-09:05',
    });
  });

  it('时钟过了 24 小时会从 0 重新走，所以太久以前和将来的记录不用它', () => {
    expect(widgetElapsedClock(fedAt, fedAt + WIDGET_ELAPSED_MAX_MS)).toBeNull();
    expect(widgetElapsedClock(fedAt, fedAt + WIDGET_ELAPSED_MAX_MS - 1)).not.toBeNull();
    expect(widgetElapsedClock(fedAt, fedAt - MIN)).toBeNull();
    // 留出的余量要比系统最长的重画间隔大得多：到下一次重画前不会绕回 0。
    expect(24 * HOUR - WIDGET_ELAPSED_MAX_MS).toBeGreaterThanOrEqual(3 * HOUR);
  });
});

describe('小工具不写上次喂了多少，只分瓶喂和亲喂', () => {
  const now = new Date(2026, 5, 15, 12, 0, 0).getTime();
  const member: WidgetSession = { signedIn: true, hasFamily: true, role: 'caregiver', label: '' };
  const baby: BabyData = { name: '测试豆', birthAt: now - 30 * 24 * HOUR };
  const view = (entries: WidgetEntry[]) => {
    const v = buildWidgetView({
      session: member,
      baby,
      entries,
      units: metricUnits,
      now,
      dayStart: new Date(2026, 5, 15).getTime(),
      syncedAt: now,
    });
    if (v.kind !== 'ready') throw new Error('blocked');
    return v;
  };

  it('瓶喂', () => {
    expect(view([{ id: 'a', data: { type: 'feed', at: now - HOUR, ml: 90 } }]).lastFeedBreast).toBe(
      false,
    );
  });

  it('亲喂', () => {
    const v = view([
      {
        id: 'a',
        data: {
          type: 'feed',
          at: now - HOUR,
          ml: 0,
          method: 'breast',
          side: 'left',
          leftMs: 10 * MIN,
          endAt: now - 50 * MIN,
        },
      },
    ]);
    expect(v.lastFeedBreast).toBe(true);
  });
});
