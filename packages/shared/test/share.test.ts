import { describe, expect, it } from 'vitest';
import { FORGOTTEN_SLEEP_MS } from '../src/domain/feeding';
import { metricUnits } from '../src/domain/units';
import { withLocale } from '../src/i18n';
import { EventData } from '../src/schemas';
import {
  CreateShareRequest,
  countShareDay,
  defaultShareInclude,
  hasShareContent,
  isValidTimeZone,
  pendingShareFiles,
  pickEventForShare,
  pickMomentForShare,
  SHARE_MAX_RANGE_MS,
  shareDayAge,
  shareEventGroup,
  shareEventText,
  shareIncludesEvent,
  zonedCalendarDate,
  zonedClock,
} from '../src/share';

const HOUR = 3_600_000;

describe('分组', () => {
  it('日常和健康的分法是定下来的，每种记录都有归属', () => {
    expect(
      ['feed', 'diaper', 'sleep', 'solids', 'bath'].map((t) => shareEventGroup(t as 'feed')),
    ).toEqual(Array(5).fill('daily'));
    expect(['temp', 'med', 'growth', 'vaccine'].map((t) => shareEventGroup(t as 'temp'))).toEqual(
      Array(4).fill('health'),
    );
  });

  it('健康记录默认不包含', () => {
    expect(defaultShareInclude.health).toBe(false);
    expect(shareIncludesEvent('temp', defaultShareInclude)).toBe(false);
    expect(shareIncludesEvent('feed', defaultShareInclude)).toBe(true);
  });
});

describe('白名单', () => {
  const junk = {
    extra: '虚构',
    formula: { name: '虚构奶粉', per100ml: {} },
    email: 'a@example.test',
  };

  it('每种记录都只留显示要用的字段，结果还是合法的记录', () => {
    const at = 1000;
    const cases: [Record<string, unknown>, Record<string, unknown>][] = [
      [
        { type: 'feed', ml: 90, milkType: 'formula', formulaId: 'x' },
        { type: 'feed', ml: 90 },
      ],
      [
        { type: 'diaper', kind: 'both' },
        { type: 'diaper', kind: 'both' },
      ],
      [
        { type: 'sleep', endAt: 2000 },
        { type: 'sleep', endAt: 2000 },
      ],
      [{ type: 'sleep' }, { type: 'sleep' }],
      [
        { type: 'temp', celsius: 37.5 },
        { type: 'temp', celsius: 37.5 },
      ],
      [
        { type: 'med', name: '虚构药', dose: '1 滴' },
        { type: 'med', name: '虚构药', dose: '1 滴' },
      ],
      [
        { type: 'med', name: '虚构药' },
        { type: 'med', name: '虚构药' },
      ],
      [{ type: 'bath' }, { type: 'bath' }],
      [
        { type: 'solids', food: '虚构米糊' },
        { type: 'solids', food: '虚构米糊' },
      ],
      [
        { type: 'growth', weightKg: 4, lengthCm: 55 },
        { type: 'growth', weightKg: 4, lengthCm: 55 },
      ],
      [
        { type: 'vaccine', vaccineId: 'sg:bcg', name: '卡介苗' },
        { type: 'vaccine', vaccineId: 'sg:bcg', name: '卡介苗' },
      ],
    ];
    for (const [input, expected] of cases) {
      const event = EventData.parse({ ...input, ...junk, at, note: '备注', byName: '妈妈' });
      const picked = pickEventForShare(event);
      expect(picked).toEqual({ ...expected, at, note: '备注', byName: '妈妈' });
      expect(EventData.safeParse(picked).success).toBe(true);
    }
  });

  it('没有备注和记录人时不写空字段', () => {
    expect(pickEventForShare({ type: 'bath', at: 5 })).toEqual({ type: 'bath', at: 5 });
  });

  it('自己加的疫苗去掉 id 里的 UUID', () => {
    const picked = pickEventForShare({
      type: 'vaccine',
      at: 5,
      vaccineId: 'custom:11111111-1111-4111-8111-111111111111',
      name: '虚构疫苗',
    });
    expect(JSON.stringify(picked)).not.toContain('11111111');
  });

  it('回忆只留标题、正文、时间和记录人，文件由调用方给', () => {
    const moment = pickMomentForShare(
      {
        title: '标题',
        text: '正文',
        at: 5,
        milestone: true,
        byName: '爸爸',
        media: [{ id: 'x', kind: 'image', mime: 'image/jpeg', size: 1 }],
        extra: '虚构',
      } as Parameters<typeof pickMomentForShare>[0],
      [],
    );
    expect(moment).toEqual({
      at: 5,
      title: '标题',
      text: '正文',
      milestone: true,
      byName: '爸爸',
      media: [],
    });
  });

  it('什么都显示不了的回忆算没有内容', () => {
    const empty = { at: 1, title: ' ', text: '', milestone: true, media: [] };
    expect(hasShareContent(empty)).toBe(false);
    expect(hasShareContent({ ...empty, title: '有标题' })).toBe(true);
    expect(
      hasShareContent({
        ...empty,
        media: [{ id: 'x', kind: 'image', url: 'https://x.test/a', thumbUrl: null }],
      }),
    ).toBe(true);
  });
});

describe('创建请求', () => {
  const valid = {
    fromAt: 1000,
    toAt: 1000 + 24 * HOUR,
    timezone: 'Asia/Singapore',
    units: metricUnits,
  };

  it('默认健康关、7 天', () => {
    const parsed = CreateShareRequest.parse(valid);
    expect(parsed.ttlDays).toBe(7);
    expect(parsed.include).toEqual({ moments: true, daily: true, health: false });
  });

  it('25 小时可以，再多一毫秒不行；结束不能早于开始', () => {
    expect(
      CreateShareRequest.safeParse({ ...valid, toAt: 1000 + SHARE_MAX_RANGE_MS }).success,
    ).toBe(true);
    expect(
      CreateShareRequest.safeParse({ ...valid, toAt: 1000 + SHARE_MAX_RANGE_MS + 1 }).success,
    ).toBe(false);
    expect(CreateShareRequest.safeParse({ ...valid, toAt: 1000 }).success).toBe(false);
  });

  it('时区和单位要认识', () => {
    expect(isValidTimeZone('America/New_York')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(CreateShareRequest.safeParse({ ...valid, timezone: 'Mars/Olympus' }).success).toBe(
      false,
    );
    expect(
      CreateShareRequest.safeParse({ ...valid, units: { ...metricUnits, volume: 'cup' } }).success,
    ).toBe(false);
  });

  it('全部关掉不行', () => {
    expect(
      CreateShareRequest.safeParse({
        ...valid,
        include: { moments: false, daily: false, health: false },
      }).success,
    ).toBe(false);
  });
});

describe('按分享者的时区显示', () => {
  // 新加坡 6 月 15 日 01:30，纽约还是 6 月 14 日 13:30。
  const at = Date.UTC(2026, 5, 14, 17, 30);

  it('钟点和日期跟时区走，不跟运行环境走', () => {
    expect(zonedClock(at, 'Asia/Singapore')).toBe('01:30');
    expect(zonedClock(at, 'America/New_York')).toBe('13:30');
    expect(zonedCalendarDate(at, 'Asia/Singapore').getDate()).toBe(15);
    expect(zonedCalendarDate(at, 'America/New_York').getDate()).toBe(14);
  });

  it('午夜读作 00 点，不是 24 点', () => {
    expect(zonedClock(Date.UTC(2026, 5, 14, 16, 0), 'Asia/Singapore')).toBe('00:00');
  });

  it('时区不认识时退回运行环境，不抛错：页面不能因此打不开', () => {
    expect(zonedClock(at, 'Mars/Olympus')).toMatch(/^\d\d:\d\d$/);
  });

  it('夏令时那天的钟点也对', () => {
    // 纽约 2026-03-08 02:00 拨到 03:00。
    expect(zonedClock(Date.UTC(2026, 2, 8, 6, 59), 'America/New_York')).toBe('01:59');
    expect(zonedClock(Date.UTC(2026, 2, 8, 7, 0), 'America/New_York')).toBe('03:00');
  });
});

describe('第几天和月龄', () => {
  const SG = 'Asia/Singapore';
  // 新加坡 6 月 1 日 23:30 出生。
  const birthAt = Date.UTC(2026, 5, 1, 15, 30);
  const dayEnd = (month: number, day: number) => Date.UTC(2026, month, day, 16);

  it('按分享者的日历算', () => {
    expect(shareDayAge(birthAt, dayEnd(5, 15), SG)).toEqual({
      dayNumber: 15,
      age: { months: 0, days: 14 },
    });
    expect(shareDayAge(birthAt, dayEnd(6, 3), SG)).toEqual({
      dayNumber: 33,
      age: { months: 1, days: 2 },
    });
  });

  it('出生当天是第 1 天，0 天大；那一天的开始虽然早于出生时间，也算已经出生', () => {
    expect(shareDayAge(birthAt, dayEnd(5, 1), SG)).toEqual({
      dayNumber: 1,
      age: { months: 0, days: 0 },
    });
  });

  it('出生前的日子不算第几天大，也没有月龄', () => {
    const result = shareDayAge(birthAt, dayEnd(4, 30), SG);
    expect(result.age).toBeNull();
    expect(result.dayNumber).toBeLessThan(1);
  });

  it('过夏令时也不差一天', () => {
    const NY = 'America/New_York';
    const born = Date.UTC(2026, 2, 7, 15); // 纽约 3 月 7 日
    const nextDayEnd = Date.UTC(2026, 2, 9, 4); // 纽约 3 月 8 日结束，只有 23 小时
    expect(shareDayAge(born, nextDayEnd, NY).dayNumber).toBe(2);
  });
});

describe('记录文字', () => {
  const at = 1_000_000_000;

  it('用 describeEvent 的文字和分享者选的单位', () => {
    withLocale('zh', () => {
      expect(
        shareEventText({ type: 'feed', at, ml: 90 }, at, { ...metricUnits, volume: 'ml' }),
      ).toBe('喂奶 90ml');
      expect(
        shareEventText({ type: 'feed', at, ml: 90 }, at, { ...metricUnits, volume: 'oz' }),
      ).toContain('oz');
    });
  });

  it('刚开始的睡眠写已经睡了多久', () => {
    withLocale('zh', () => {
      expect(shareEventText({ type: 'sleep', at }, at + HOUR, metricUnits)).toContain('1小时');
    });
  });

  it('忘记结束的睡眠不写时长，页面几天后打开也不会变成睡了 72 小时', () => {
    for (const locale of ['zh', 'en'] as const) {
      withLocale(locale, () => {
        const text = shareEventText(
          { type: 'sleep', at },
          at + FORGOTTEN_SLEEP_MS + 1,
          metricUnits,
        );
        expect(text).not.toMatch(/\d/);
      });
    }
  });
});

describe('弹层的条数', () => {
  const range = { fromAt: 1000, toAt: 2000 };
  const event = (data: Record<string, unknown>) => ({ data: data as unknown as EventData });
  const events = [
    event({ type: 'feed', at: 999, ml: 1 }),
    event({ type: 'feed', at: 1000, ml: 1 }),
    event({ type: 'diaper', at: 1999, kind: 'wee' }),
    event({ type: 'temp', at: 1500, celsius: 37 }),
    event({ type: 'bath', at: 2000 }),
  ];
  const file = (id: string) => ({ id, kind: 'image' as const, mime: 'image/jpeg', size: 1 });
  const moments = [
    { data: { at: 1500, media: [file('a'), file('b')] } },
    { data: { at: 2000, media: [file('c')] } },
  ];

  it('和服务端一样的范围，按选项算', () => {
    expect(countShareDay(events, moments, range, defaultShareInclude)).toEqual({
      records: 2,
      moments: 1,
      files: 2,
    });
    expect(
      countShareDay(events, moments, range, { moments: false, daily: false, health: true }),
    ).toEqual({ records: 1, moments: 0, files: 0 });
  });

  it('只数这一天里没传完的文件', () => {
    expect(pendingShareFiles(moments, range, new Set(['a', 'c']))).toBe(1);
    expect(pendingShareFiles(moments, range, new Set())).toBe(0);
  });
});
