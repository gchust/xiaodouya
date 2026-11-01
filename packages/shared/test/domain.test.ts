import { describe, expect, it } from 'vitest';
import {
  ageParts,
  ageText,
  assessTemperature,
  canReadCollection,
  canReadMediaScope,
  canWriteCollection,
  dayNumber,
  describeEvent,
  type EventData,
  estimateNextFeed,
  formatBytes,
  formatDuration,
  formatHoursMinutes,
  isAllowedMime,
  isNewerVersion,
  knowledgeForAge,
  nextVaccine,
  parseCollectionData,
  summarize24h,
  todayInsight,
  vaccineSchedule,
  vaccineStatuses,
  vaccinesToOffer,
} from '../src';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).getTime();

describe('年龄', () => {
  const birth = at(2026, 1, 15, 3);
  it('出生当天是第 1 天', () => expect(dayNumber(birth, at(2026, 1, 15, 23))).toBe(1));
  it('按日历日而不是 24 小时计算', () => expect(dayNumber(birth, at(2026, 1, 16, 1))).toBe(2));
  it('满月和零头天数', () => {
    expect(ageParts(birth, at(2026, 2, 16))).toEqual({ months: 1, days: 1 });
    expect(ageText(birth, at(2026, 2, 16))).toBe('1 个月零 1 天');
  });
  it('整月不显示零头', () => expect(ageText(birth, at(2026, 2, 15))).toBe('1 个月'));
  it('不满月显示天数', () => expect(ageText(birth, at(2026, 1, 25))).toBe('10 天'));
  it('31 号出生，短月份的满月日取月末', () => {
    const jan31 = at(2026, 1, 31);
    expect(ageParts(jan31, at(2026, 2, 28))).toEqual({ months: 1, days: 0 });
    expect(ageParts(jan31, at(2026, 2, 27)).months).toBe(0);
    expect(ageParts(jan31, at(2026, 3, 1))).toEqual({ months: 1, days: 1 });
  });
  it('两岁以上按年显示', () => expect(ageText(birth, at(2028, 3, 15))).toBe('2 岁 2 个月'));
});

describe('时长格式', () => {
  it('小时和分钟', () => {
    expect(formatDuration(69 * 60_000)).toBe('1小时9分');
    expect(formatDuration(2 * HOUR)).toBe('2小时');
    expect(formatDuration(25 * 60_000)).toBe('25分钟');
  });
  it('计时器补零', () => expect(formatHoursMinutes(121 * 60_000)).toBe('2:01'));
});

describe('文件大小', () => {
  it('0 字节不能显示成 1 KB', () => expect(formatBytes(0)).toBe('0'));
  it('很小的文件至少显示 1 KB', () => expect(formatBytes(100)).toBe('1 KB'));
  it('按单位换算', () => {
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatBytes(3.2 * 1024 ** 3)).toBe('3.2 GB');
  });
});

describe('下次喂奶估算', () => {
  const now = at(2026, 3, 1);
  const feed = (hoursAgo: number, ml = 90): EventData => ({
    type: 'feed',
    at: now - hoursAgo * HOUR,
    ml,
  });
  it('没有记录时不会崩溃', () => {
    const e = estimateNextFeed([], now);
    expect(e.last).toBeNull();
    expect(e.isLearned).toBe(false);
  });
  it('只有一次记录时用默认间隔并标记未学习', () => {
    const e = estimateNextFeed([feed(1)], now);
    expect(e.isLearned).toBe(false);
    expect(e.intervalMs).toBe(3 * HOUR);
    expect(e.remainingMs).toBe(2 * HOUR);
  });
  it('用最近的真实间隔计算', () => {
    const e = estimateNextFeed([feed(0.5), feed(3), feed(5.5), feed(8)], now);
    expect(e.isLearned).toBe(true);
    expect(e.intervalMs).toBeCloseTo(2.5 * HOUR);
    expect(e.remainingMs).toBeCloseTo(2 * HOUR);
  });
  it('超过间隔时剩余时间为负', () => {
    const e = estimateNextFeed([feed(4), feed(6), feed(8)], now);
    expect(e.remainingMs).toBeLessThan(0);
  });
  it('漏记造成的超长间隔不计入平均值', () => {
    const e = estimateNextFeed([feed(1), feed(3), feed(5), feed(20)], now);
    expect(e.intervalMs).toBeCloseTo(2 * HOUR);
  });
  it('未来时间的记录不算上次喂奶', () => {
    const e = estimateNextFeed([feed(-1), feed(1)], now);
    expect(e.sinceMs).toBeCloseTo(HOUR);
  });
});

describe('24 小时统计', () => {
  const now = at(2026, 3, 1);
  it('统计窗口内的喂奶和尿布', () => {
    const s = summarize24h(
      [
        { type: 'feed', at: now - HOUR, ml: 90 },
        { type: 'feed', at: now - 25 * HOUR, ml: 90 },
        { type: 'diaper', at: now - HOUR, kind: 'poo' },
        { type: 'diaper', at: now - HOUR, kind: 'both' },
      ],
      now,
    );
    expect(s).toMatchObject({ feeds: 1, ml: 90, diapers: 2, wetDiapers: 1 });
  });
  it('跨窗口的睡眠只算窗口内的部分，进行中的算到现在', () => {
    const s = summarize24h(
      [
        { type: 'sleep', at: now - 25 * HOUR, endAt: now - 23 * HOUR },
        { type: 'sleep', at: now - 2 * HOUR },
      ],
      now,
    );
    expect(s.sleepMs).toBe(3 * HOUR);
  });
});

describe('体温判断', () => {
  it('3 个月以下 38℃ 必须建议尽快就医', () => {
    const r = assessTemperature(38, 1);
    expect(r.level).toBe('urgent');
    expect(r.hint).toContain('尽快就医');
  });
  it('37.5 偏高，37.4 正常', () => {
    expect(assessTemperature(37.5, 1).level).toBe('elevated');
    expect(assessTemperature(37.4, 1).level).toBe('normal');
  });
  it('体温过低不能显示正常', () => expect(assessTemperature(35.5, 1).level).not.toBe('normal'));
});

describe('今日提示', () => {
  const birth = at(2026, 1, 1);
  const now = at(2026, 2, 5);
  const fullDay = (feeds: number, wet: number): EventData[] => [
    { type: 'bath', at: now - 30 * HOUR },
    ...Array.from({ length: feeds }, (_, i) => ({
      type: 'feed' as const,
      at: now - (i + 1) * 2 * HOUR,
      ml: 90,
    })),
    ...Array.from({ length: wet }, (_, i) => ({
      type: 'diaper' as const,
      at: now - (i + 1) * HOUR,
      kind: 'wee' as const,
    })),
  ];

  it('记录偏少时必须提示留意，不能说吃够了', () => {
    const r = todayInsight(fullDay(4, 3), birth, now);
    expect(r?.tone).toBe('attention');
    expect(r?.text).toContain('比常见的少');
    expect(r?.text).toContain('问问医生');
    expect(r?.text).not.toContain('吃够了');
  });
  it('记录不满一天时不下判断', () => {
    const r = todayInsight([{ type: 'feed', at: now - HOUR, ml: 90 }], birth, now);
    expect(r?.tone).toBe('neutral');
    expect(r?.text).toContain('记满一天');
  });
  it('数量充足时也不做“吃够了”的保证', () => {
    const r = todayInsight(fullDay(8, 7), birth, now);
    expect(r?.tone).toBe('neutral');
    expect(r?.text).not.toContain('吃够了');
  });
  it('出生头几天不按湿尿布数量提示', () => {
    const newborn = now - 2 * DAY;
    const events = fullDay(8, 1).filter((e) => e.at >= newborn);
    expect(todayInsight(events, newborn, now)?.text).not.toContain('湿尿布 1 片比常见的少');
  });
  it('睡眠中提示已睡多久', () => {
    const r = todayInsight([{ type: 'sleep', at: now - HOUR }], birth, now);
    expect(r?.text).toContain('1小时');
    expect(r?.text).not.toContain('他');
  });
  it('没有记录时不显示', () => expect(todayInsight([], birth, now)).toBeNull());
});

describe('健康规则（审查回归）', () => {
  const birth = at(2026, 1, 1);
  const now = at(2026, 1, 15);
  const sparse: EventData[] = [
    { type: 'bath', at: now - 30 * HOUR },
    { type: 'feed', at: now - 2 * HOUR, ml: 90 },
    { type: 'feed', at: now - 5 * HOUR, ml: 90 },
    { type: 'feed', at: now - 8 * HOUR, ml: 90 },
    { type: 'diaper', at: now - 3 * HOUR, kind: 'wee' },
  ];
  it('睡眠计时开着，也不能盖住偏少的提醒', () => {
    const r = todayInsight([...sparse, { type: 'sleep', at: now - HOUR }], birth, now);
    expect(r?.tone).toBe('attention');
  });
  it('忘记结束的睡眠不能显示成“已经睡了 72 小时”', () => {
    const r = todayInsight(
      [
        { type: 'sleep', at: now - 72 * HOUR },
        ...Array.from({ length: 8 }, (_, i) => ({
          type: 'feed' as const,
          at: now - (i + 1) * 2 * HOUR,
          ml: 90,
        })),
        ...Array.from({ length: 7 }, (_, i) => ({
          type: 'diaper' as const,
          at: now - (i + 1) * HOUR,
          kind: 'wee' as const,
        })),
      ],
      birth,
      now,
    );
    expect(r?.text).not.toContain('已经睡了');
    expect(r?.text).toContain('忘');
  });
  it('正在睡的时候仍然显示睡眠提示', () => {
    const r = todayInsight([{ type: 'sleep', at: now - HOUR }], birth, now);
    expect(r?.text).toContain('已经睡了');
  });
  it('36.0–36.4℃ 不能说正常，提示要和范围一致', () => {
    const r = assessTemperature(36.2, 1);
    expect(r.level).not.toBe('normal');
    expect(r.note).not.toBe('正常');
  });
  it('36.5℃ 是正常', () => expect(assessTemperature(36.5, 1).level).toBe('normal'));
  it('3 个月以下低于 36℃ 要尽快联系医生', () => {
    const r = assessTemperature(35, 0);
    expect(r.level).toBe('urgent');
    expect(r.hint).toContain('尽快');
  });
  it('3–6 个月 39℃ 及以上要尽快联系医生', () => {
    expect(assessTemperature(39.5, 4).hint).toContain('尽快');
    expect(assessTemperature(38.5, 4).hint).not.toContain('尽快');
    expect(assessTemperature(38.5, 8).hint).not.toContain('尽快');
  });
});

describe('疫苗表', () => {
  const birth = at(2026, 1, 1);
  it('乙肝第 2 剂随六合一在 2 个月，不再有单独的 1 个月剂', () => {
    expect(vaccineSchedule.find((v) => v.months === 1)).toBeUndefined();
    const dose = vaccineSchedule.find((v) => v.id === '6in1-1');
    expect(dose?.months).toBe(2);
    expect(dose?.note).toContain('乙肝');
  });
  it('肺炎球菌第 1 剂在 4 个月', () => {
    expect(vaccineSchedule.find((v) => v.id === 'pcv-1')?.months).toBe(4);
  });
  it('id 不重复', () => {
    expect(new Set(vaccineSchedule.map((v) => v.id)).size).toBe(vaccineSchedule.length);
  });
  it('按月龄和接种记录计算状态', () => {
    const now = at(2026, 1, 25);
    const statuses = vaccineStatuses(
      birth,
      [{ type: 'vaccine', at: birth, vaccineId: 'bcg', name: '卡介苗 BCG' }],
      now,
    );
    expect(statuses.find((v) => v.id === 'bcg')?.state).toBe('done');
    expect(statuses.find((v) => v.id === 'hepb-1')?.state).toBe('due');
    expect(statuses.find((v) => v.id === '6in1-1')?.state).toBe('upcoming');
    expect(nextVaccine(statuses)?.id).toBe('hepb-1');
  });
  it('到期前两周开始提示', () => {
    const statuses = vaccineStatuses(birth, [], at(2026, 2, 20));
    expect(statuses.find((v) => v.id === '6in1-1')?.state).toBe('due');
  });
});

describe('接种弹层', () => {
  const birth = at(2026, 1, 1);
  it('只列前几剂，不把按钮挤出屏幕', () => {
    expect(vaccinesToOffer(vaccineStatuses(birth, [], birth))).toHaveLength(4);
  });
  it('到期的都要列出来，即使超过上限', () => {
    const offered = vaccinesToOffer(vaccineStatuses(birth, [], at(2026, 9, 1)));
    expect(offered.filter((v) => v.state === 'due').length).toBe(offered.length);
    expect(offered.length).toBeGreaterThan(4);
  });
  it('从疫苗本点开的后面某一剂也要在列表里', () => {
    const ids = vaccinesToOffer(vaccineStatuses(birth, [], birth), '5in1-4').map((v) => v.id);
    expect(ids).toContain('5in1-4');
  });
  it('已接种的不再列出', () => {
    const statuses = vaccineStatuses(
      birth,
      [{ type: 'vaccine', at: birth, vaccineId: 'bcg', name: 'BCG' }],
      birth,
    );
    expect(vaccinesToOffer(statuses).map((v) => v.id)).not.toContain('bcg');
  });
});

describe('权限', () => {
  it('viewer 只能读回忆，不能读记录和证件', () => {
    expect(canReadCollection('viewer', 'moment')).toBe(true);
    expect(canReadCollection('viewer', 'letter')).toBe(true);
    expect(canReadCollection('viewer', 'event')).toBe(false);
    expect(canReadCollection('viewer', 'document')).toBe(false);
    expect(canReadMediaScope('viewer', 'document')).toBe(false);
    expect(canReadMediaScope('viewer', 'memory')).toBe(true);
  });
  it('viewer 不能写，其他角色可以', () => {
    expect(canWriteCollection('viewer', 'moment')).toBe(false);
    expect(canWriteCollection('caregiver', 'document')).toBe(true);
  });
  it('上传类型白名单', () => {
    expect(isAllowedMime('image/heic', 'memory')).toBe(true);
    expect(isAllowedMime('application/pdf', 'memory')).toBe(false);
    expect(isAllowedMime('application/pdf', 'document')).toBe(true);
    expect(isAllowedMime('video/mp4', 'document')).toBe(false);
    expect(isAllowedMime('text/html', 'memory')).toBe(false);
    expect(isAllowedMime('video/mp4', 'avatar')).toBe(false);
  });
});

describe('数据校验', () => {
  it('合法记录通过，未知字段保留（向前兼容）', () => {
    const r = parseCollectionData('event', { type: 'feed', at: 1, ml: 90, future: 'x' });
    expect(r).toMatchObject({ type: 'feed', ml: 90, future: 'x' });
  });
  it('非法记录返回 null', () => {
    expect(parseCollectionData('event', { type: 'feed', at: 1 })).toBeNull();
    expect(parseCollectionData('event', { type: 'nope', at: 1 })).toBeNull();
    expect(parseCollectionData('baby', { name: '' })).toBeNull();
  });
});

describe('后写胜出', () => {
  it('时间新的胜出', () => {
    expect(isNewerVersion({ updatedAt: 2, tiebreak: 'a' }, { updatedAt: 1, tiebreak: 'z' })).toBe(
      true,
    );
  });
  it('时间相同时结果确定', () => {
    const a = { updatedAt: 1, tiebreak: 'a' };
    const b = { updatedAt: 1, tiebreak: 'b' };
    expect(isNewerVersion(b, a)).toBe(true);
    expect(isNewerVersion(a, b)).toBe(false);
  });
});

describe('描述和常识', () => {
  it('不假定宝宝性别', () => {
    for (const months of [0, 3, 6, 12]) {
      for (const card of knowledgeForAge(months)) {
        expect(card.body).not.toMatch(/[他她]/);
      }
    }
  });
  it('进行中的睡眠显示已睡时长', () => {
    expect(describeEvent({ type: 'sleep', at: 0 }, HOUR)).toBe('睡觉中 · 已 1小时');
  });
});
