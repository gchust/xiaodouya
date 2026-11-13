import { afterEach, describe, expect, it } from 'vitest';
import { FORGOTTEN_SLEEP_MS } from '../src/domain/feeding';
import { isNursingFeed, trendAverage, trendDays } from '../src/domain/trends';
import { EventData } from '../src/schemas';

const HOUR = 3_600_000;
const originalTz = process.env.TZ;

afterEach(() => {
  // 赋值 undefined 会变成字符串 "undefined"，那就是 UTC 了。
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

/** 2026-06-15 星期一 15:00（手机时区），今天还没过完。 */
const now = new Date(2026, 5, 15, 15, 0).getTime();
const at = (day: number, hour: number, minute = 0) =>
  new Date(2026, 5, day, hour, minute).getTime();

const feed = (time: number, ml: number, extra: Record<string, unknown> = {}): EventData =>
  EventData.parse({ type: 'feed', at: time, ml, ...extra });
const diaper = (time: number, kind: 'wee' | 'poo' | 'both'): EventData => ({
  type: 'diaper',
  at: time,
  kind,
});
const sleep = (from: number, to?: number): EventData =>
  to === undefined ? { type: 'sleep', at: from } : { type: 'sleep', at: from, endAt: to };
const temp = (time: number, celsius: number): EventData => ({ type: 'temp', at: time, celsius });

describe('趋势的日期', () => {
  it('7 天是今天和前 6 天，旧的在前，只有今天没过完', () => {
    const days = trendDays([], now, 7);
    expect(days).toHaveLength(7);
    expect(days[0]?.start).toBe(new Date(2026, 5, 9).getTime());
    expect(days[6]?.start).toBe(new Date(2026, 5, 15).getTime());
    expect(days[6]?.end).toBe(new Date(2026, 5, 16).getTime());
    expect(days.map((d) => d.partial)).toEqual([false, false, false, false, false, false, true]);
    expect(days[5]?.elapsed).toBe(1);
    expect(days[6]?.elapsed).toBeCloseTo(15 / 24, 5);
  });

  it('30 天跨月也是连续的日历日', () => {
    const days = trendDays([], now, 30);
    expect(days).toHaveLength(30);
    expect(new Date(days[0]?.start ?? 0).getMonth()).toBe(4);
    expect(new Date(days[0]?.start ?? 0).getDate()).toBe(17);
    for (let i = 1; i < days.length; i++) expect(days[i]?.start).toBe(days[i - 1]?.end);
  });

  it('按手机时区的日历日分：同一个时刻在新加坡和纽约落在不同的天', () => {
    const moment = Date.UTC(2026, 5, 14, 20);
    const events = [feed(moment, 90)];
    const nowUtc = Date.UTC(2026, 5, 15, 12);
    process.env.TZ = 'Asia/Singapore';
    const sg = trendDays(events, nowUtc, 7);
    // 新加坡是 15 日凌晨 4 点，纽约是 14 日下午 4 点。
    expect(sg[6]?.feeds).toBe(1);
    process.env.TZ = 'America/New_York';
    const ny = trendDays(events, nowUtc, 7);
    expect(ny[6]?.feeds).toBe(0);
    expect(ny[5]?.feeds).toBe(1);
  });

  it('夏令时那天是 23 小时，不会把下一天挤掉', () => {
    process.env.TZ = 'America/New_York';
    const nowNy = new Date(2026, 2, 10, 12).getTime();
    // 确认时区真的换了，不然这个测试什么也没测。
    expect(new Date(2026, 2, 8, 12).getTimezoneOffset()).not.toBe(
      new Date(2026, 2, 7, 12).getTimezoneOffset(),
    );
    const days = trendDays([feed(new Date(2026, 2, 9, 0, 30).getTime(), 60)], nowNy, 7);
    const dst = days.find((d) => new Date(d.start).getDate() === 8);
    expect(dst ? dst.end - dst.start : 0).toBe(23 * HOUR);
    expect(days.find((d) => new Date(d.start).getDate() === 9)?.feeds).toBe(1);
    expect(days.find((d) => new Date(d.start).getDate() === 8)?.feeds).toBe(0);
  });
});

describe('喂奶', () => {
  it('每天的次数和奶量，现在以后的不算，范围以前的不算', () => {
    const days = trendDays(
      [
        feed(at(15, 9), 90),
        feed(at(15, 12), 120),
        feed(at(15, 16), 100), // 还没到
        feed(at(14, 23, 59), 80),
        feed(at(8, 23), 70), // 7 天以前
      ],
      now,
      7,
    );
    expect(days[6]).toMatchObject({ feeds: 2, ml: 210, amountFeeds: 2 });
    expect(days[5]).toMatchObject({ feeds: 1, ml: 80 });
    expect(days[0]).toMatchObject({ feeds: 0, ml: null });
  });

  it('亲喂（#104 的 method: breast）只算次数，0ml 不算进奶量', () => {
    const nursing = feed(at(15, 10), 0, { method: 'breast', side: 'left', durationSec: 600 });
    expect(isNursingFeed(nursing)).toBe(true);
    const days = trendDays([nursing, feed(at(15, 11), 90)], now, 7);
    expect(days[6]).toMatchObject({ feeds: 2, nursingFeeds: 1, amountFeeds: 1, ml: 90 });
  });

  it('只有亲喂的那天没有奶量，不是 0ml', () => {
    const days = trendDays([feed(at(15, 10), 0, { method: 'breast' })], now, 7);
    expect(days[6]).toMatchObject({ feeds: 1, nursingFeeds: 1, amountFeeds: 0, ml: null });
  });

  it('以前只能填 0ml 的母乳也不当成摄入了 0ml', () => {
    const days = trendDays([feed(at(15, 10), 0, { milkType: 'breast' })], now, 7);
    expect(days[6]).toMatchObject({ feeds: 1, amountFeeds: 0, ml: null });
  });

  it('亲喂带了奶量也不算进瓶喂的奶量', () => {
    const days = trendDays([feed(at(15, 10), 50, { method: 'breast' })], now, 7);
    expect(days[6]).toMatchObject({ feeds: 1, ml: null });
  });

  it('瓶喂和不认识的 method 照常算奶量', () => {
    expect(isNursingFeed(feed(at(15, 10), 90, { method: 'bottle' }))).toBe(false);
    expect(isNursingFeed(feed(at(15, 10), 90, { method: 'spoon' }))).toBe(false);
    expect(isNursingFeed(feed(at(15, 10), 90))).toBe(false);
  });
});

describe('尿布', () => {
  it('都有算一次尿尿也算一次便便，换的次数照实算', () => {
    const days = trendDays(
      [diaper(at(15, 8), 'wee'), diaper(at(15, 9), 'both'), diaper(at(15, 10), 'poo')],
      now,
      7,
    );
    expect(days[6]).toMatchObject({ diapers: 3, wee: 2, poo: 2 });
    expect(days[5]).toMatchObject({ diapers: 0, wee: 0, poo: 0 });
  });
});

describe('睡眠', () => {
  it('跨午夜的睡眠分到两天', () => {
    const days = trendDays([sleep(at(13, 22), at(14, 6))], now, 7);
    expect(days[4]?.sleepMs).toBe(2 * HOUR);
    expect(days[5]?.sleepMs).toBe(6 * HOUR);
    expect(days[4]?.sleeps).toEqual([{ from: 22 / 24, to: 1 }]);
    expect(days[5]?.sleeps).toEqual([{ from: 0, to: 6 / 24 }]);
  });

  it('一天里分开的几段都算上，按先后排', () => {
    const days = trendDays(
      [
        sleep(at(14, 13, 5), at(14, 14, 20)),
        sleep(at(14, 0), at(14, 5, 30)),
        sleep(at(14, 9, 10), at(14, 10, 40)),
      ],
      now,
      7,
    );
    expect(days[5]?.sleepMs).toBe(5.5 * HOUR + 1.5 * HOUR + 1.25 * HOUR);
    const round = (n: number) => Number(n.toFixed(9));
    expect(days[5]?.sleeps.map((s) => round(s.from))).toEqual(
      [0, (9 + 10 / 60) / 24, (13 + 5 / 60) / 24].map(round),
    );
  });

  it('没有睡眠记录的那天是 null，不是 0', () => {
    const days = trendDays([sleep(at(15, 1), at(15, 3))], now, 7);
    expect(days[6]?.sleepMs).toBe(2 * HOUR);
    expect(days[5]?.sleepMs).toBeNull();
    expect(days[5]?.sleeps).toEqual([]);
  });

  it('两个人重复记的同一段睡眠只算一次', () => {
    const days = trendDays(
      [sleep(at(15, 1), at(15, 3)), sleep(at(15, 2), at(15, 4)), sleep(at(15, 2), at(15, 3))],
      now,
      7,
    );
    expect(days[6]?.sleepMs).toBe(3 * HOUR);
    expect(days[6]?.sleeps).toEqual([{ from: 1 / 24, to: 4 / 24 }]);
  });

  it('正在睡的算到现在', () => {
    const days = trendDays([sleep(at(15, 13))], now, 7);
    expect(days[6]?.sleepMs).toBe(2 * HOUR);
  });

  it('忘了结束的计时不算，即使开始那天已经过完了', () => {
    // 12 日晚上开始、一直没点醒了：按那天的 24 点截断的话，那天会多出一段没发生过的睡眠。
    const forgotten = sleep(at(12, 20));
    expect(now - at(12, 20)).toBeGreaterThan(FORGOTTEN_SLEEP_MS);
    const days = trendDays([forgotten], now, 7);
    expect(days.every((d) => d.sleepMs === null)).toBe(true);
  });

  it('醒来早于睡着的坏数据不算', () => {
    const days = trendDays([sleep(at(15, 3), at(15, 1))], now, 7);
    expect(days[6]?.sleepMs).toBeNull();
  });

  it('还没开始的睡眠不算', () => {
    const days = trendDays([sleep(at(15, 16), at(15, 17))], now, 7);
    expect(days[6]?.sleepMs).toBeNull();
  });

  it('夏令时那天的节奏条按 23 小时算比例', () => {
    process.env.TZ = 'America/New_York';
    const nowNy = new Date(2026, 2, 10, 12).getTime();
    const from = new Date(2026, 2, 8, 0).getTime();
    const to = from + 23 * HOUR;
    const days = trendDays([sleep(from, to)], nowNy, 7);
    const dst = days.find((d) => new Date(d.start).getDate() === 8);
    expect(dst?.sleeps).toEqual([{ from: 0, to: 1 }]);
    expect(dst?.sleepMs).toBe(23 * HOUR);
  });
});

describe('体温', () => {
  it('按时间先后记下当天的每一次', () => {
    const days = trendDays([temp(at(15, 9), 37.9), temp(at(15, 7), 37.2)], now, 7);
    expect(days[6]?.temps).toEqual([37.2, 37.9]);
    expect(days[5]?.temps).toEqual([]);
  });
});

describe('日均', () => {
  it('只算过完的、有记录的天，并说明是几天', () => {
    const days = trendDays(
      [
        feed(at(15, 9), 500), // 今天不算
        feed(at(14, 9), 100),
        feed(at(14, 12), 100),
        feed(at(13, 9), 60),
        // 12 日没有记录，不能当 0 拉低平均
      ],
      now,
      7,
    );
    expect(trendAverage(days, (d) => (d.feeds > 0 ? d.feeds : null))).toEqual({
      value: 1.5,
      days: 2,
    });
    expect(trendAverage(days, (d) => d.ml)).toEqual({ value: 130, days: 2 });
  });

  it('没有过完的、有记录的天就没有日均', () => {
    const days = trendDays([feed(at(15, 9), 90)], now, 7);
    expect(trendAverage(days, (d) => d.ml)).toBeNull();
  });
});
