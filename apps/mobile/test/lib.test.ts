import { describe, expect, it } from 'vitest';
import { bookFileName, bookPage, buildBookHtml } from '../src/lib/bookHtml';
import {
  doseTimestamp,
  editedDoseTimestamp,
  formatLastSeen,
  isBirthInFuture,
  isDaysAgo,
  plannedDaysLater,
  plannedDayTimestamp,
  plannedNextMonth,
  resolveTimeChoice,
  withClock,
  withDate,
  withDaysAgo,
} from '../src/lib/dates';
import {
  createExclusivePlayback,
  downsamplePeaks,
  escapeHtml,
  fallbackPeaks,
  fileBadge,
  isUrlFresh,
  mediaRetryDelayMs,
  pickDurationMs,
} from '../src/lib/mediaUtils';

describe('出生时间', () => {
  it('晚于现在的不接受，现在和过去的可以', () => {
    expect(isBirthInFuture(1001, 1000)).toBe(true);
    expect(isBirthInFuture(1000, 1000)).toBe(false);
    expect(isBirthInFuture(999, 1000)).toBe(false);
  });
});

describe('选记录时间', () => {
  const now = new Date(2026, 2, 10, 14, 30, 20).getTime();

  it('偏移保存时才按当时的时间算，确定的时刻不变', () => {
    expect(resolveTimeChoice({ kind: 'offset', minutes: 15 }, now)).toBe(now - 15 * 60_000);
    expect(resolveTimeChoice({ kind: 'exact', at: 123 }, now)).toBe(123);
  });

  it('换日期保留时刻', () => {
    const at = new Date(2026, 2, 10, 9, 5).getTime();
    expect(withDate(at, new Date(2026, 1, 28), now)).toBe(new Date(2026, 1, 28, 9, 5).getTime());
  });

  it('换到今天时，比现在晚的时刻退回现在', () => {
    const at = new Date(2026, 2, 8, 23, 0).getTime();
    expect(withDate(at, new Date(2026, 2, 10), now)).toBe(now);
  });

  it('换时刻保留日期，选到未来也不改，由校验提示', () => {
    const at = new Date(2026, 2, 10, 9, 5, 33).getTime();
    expect(withClock(at, new Date(2000, 0, 1, 20, 15))).toBe(
      new Date(2026, 2, 10, 20, 15).getTime(),
    );
  });

  it('今天、昨天、前天', () => {
    const at = new Date(2026, 2, 10, 9, 5).getTime();
    expect(withDaysAgo(at, 1, now)).toBe(new Date(2026, 2, 9, 9, 5).getTime());
    expect(withDaysAgo(at, 2, now)).toBe(new Date(2026, 2, 8, 9, 5).getTime());
    expect(isDaysAgo(new Date(2026, 2, 9, 23, 59).getTime(), 1, now)).toBe(true);
    expect(isDaysAgo(new Date(2026, 2, 9, 23, 59).getTime(), 0, now)).toBe(false);
  });

  it('跨月的昨天', () => {
    const first = new Date(2026, 2, 1, 8).getTime();
    expect(withDaysAgo(first, 1, first)).toBe(new Date(2026, 1, 28, 8).getTime());
  });
});

describe('改接种日期', () => {
  const now = new Date(2026, 2, 10, 14, 30).getTime();
  it('日期没变就保留原来的时刻', () => {
    const at = new Date(2026, 2, 1, 9, 5).getTime();
    expect(editedDoseTimestamp(at, new Date(2026, 2, 1, 22), now)).toBe(at);
  });
  it('换了日期放在那天中午', () => {
    const at = new Date(2026, 2, 1, 9, 5).getTime();
    expect(editedDoseTimestamp(at, new Date(2026, 1, 20), now)).toBe(
      new Date(2026, 1, 20, 12).getTime(),
    );
  });
  it('换到今天用现在', () => {
    const at = new Date(2026, 2, 1, 9, 5).getTime();
    expect(editedDoseTimestamp(at, new Date(2026, 2, 10), now)).toBe(now);
  });
});

describe('取不到链接时的重试间隔', () => {
  it('逐步变长，最多 60 秒', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 20].map(mediaRetryDelayMs)).toEqual([
      2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000,
    ]);
  });
  it('次数非常大也不会溢出', () => {
    expect(mediaRetryDelayMs(5000)).toBe(60_000);
  });
});

describe('同一时间只放一段录音', () => {
  const player = () => {
    const p = { paused: 0, pause: () => (p.paused += 1) };
    return p;
  };
  it('新的开始时暂停旧的', () => {
    const playback = createExclusivePlayback<ReturnType<typeof player>>();
    const a = player();
    const b = player();
    playback.claim(a);
    playback.claim(b);
    expect(a.paused).toBe(1);
    expect(b.paused).toBe(0);
  });
  it('同一段继续播放不会暂停自己', () => {
    const playback = createExclusivePlayback<ReturnType<typeof player>>();
    const a = player();
    playback.claim(a);
    playback.claim(a);
    expect(a.paused).toBe(0);
  });
  it('已释放的播放器不再被暂停', () => {
    const playback = createExclusivePlayback<ReturnType<typeof player>>();
    const a = player();
    playback.claim(a);
    playback.release(a);
    playback.claim(player());
    expect(a.paused).toBe(0);
  });
  it('释放别的播放器不影响正在放的', () => {
    const playback = createExclusivePlayback<ReturnType<typeof player>>();
    const a = player();
    playback.claim(a);
    playback.release(player());
    playback.claim(player());
    expect(a.paused).toBe(1);
  });
  it('暂停时报错也能接着放新的', () => {
    const playback = createExclusivePlayback<{ pause(): void }>();
    playback.claim({
      pause() {
        throw new Error('已释放');
      },
    });
    expect(() => playback.claim({ pause() {} })).not.toThrow();
  });
});

describe('证件卡片标记', () => {
  it('用扩展名并转成大写', () => {
    expect(fileBadge({ name: '出生证明.pdf', mime: 'application/pdf', kind: 'pdf' })).toBe('PDF');
    expect(fileBadge({ name: 'scan.png', mime: 'image/png', kind: 'image' })).toBe('PNG');
  });
  it('JPEG 统一写成 JPG', () => {
    expect(fileBadge({ name: 'a.jpeg', mime: 'image/jpeg', kind: 'image' })).toBe('JPG');
    expect(fileBadge({ mime: 'image/jpeg', kind: 'image' })).toBe('JPG');
  });
  it('拍照没有文件名时看 MIME', () => {
    expect(fileBadge({ mime: 'image/heic', kind: 'image' })).toBe('HEIC');
  });
  it('名字里没有点时不把整个名字当扩展名', () => {
    expect(fileBadge({ name: 'passport', mime: 'image/png', kind: 'image' })).toBe('PNG');
  });
  it('看不出来时退回通用标记', () => {
    expect(fileBadge({ kind: 'image' })).toBe('IMG');
    expect(fileBadge({ name: 'a.很长的扩展名', kind: 'pdf' })).toBe('PDF');
    expect(fileBadge({ mime: 'application/vnd.oasis.document', kind: 'image' })).toBe('IMG');
  });
});

describe('波形', () => {
  it('把电平压缩到固定数量，范围 0–1', () => {
    const peaks = downsamplePeaks(
      Array.from({ length: 400 }, (_, i) => -60 + (i % 60)),
      40,
    );
    expect(peaks).toHaveLength(40);
    for (const p of peaks) {
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
    }
  });
  it('录音很短时也不会崩溃', () => {
    expect(downsamplePeaks([])).toEqual([]);
    expect(downsamplePeaks([-10, -20], 40).length).toBeGreaterThan(0);
  });
  it('异常的电平值被限制在范围内', () => {
    expect(downsamplePeaks([-200, 10], 2)).toEqual([0, 1]);
  });
  it('装饰波形对同一个 id 是稳定的，不同 id 不同', () => {
    expect(fallbackPeaks('a')).toEqual(fallbackPeaks('a'));
    expect(fallbackPeaks('a')).not.toEqual(fallbackPeaks('b'));
  });
});

describe('签名链接缓存', () => {
  it('快过期的链接不再使用', () => {
    const now = 1_000_000;
    expect(isUrlFresh(undefined, now)).toBe(false);
    expect(isUrlFresh({ url: 'u', expiresAt: now + 30_000 }, now)).toBe(false);
    expect(isUrlFresh({ url: 'u', expiresAt: now + 120_000 }, now)).toBe(true);
  });
});

describe('视频时长', () => {
  it('没有时长时返回 undefined', () => {
    expect(pickDurationMs(null)).toBeUndefined();
    expect(pickDurationMs(0)).toBeUndefined();
    expect(pickDurationMs(1500.4)).toBe(1500);
  });
});

describe('成员状态', () => {
  const now = new Date(2026, 2, 15, 12).getTime();
  it('按活跃时间显示', () => {
    expect(formatLastSeen(null, now).text).toBe('还没上线');
    expect(formatLastSeen(now - 60_000, now)).toEqual({ text: '在线', online: true });
    expect(formatLastSeen(now - 30 * 60_000, now).text).toBe('30 分钟前');
    expect(formatLastSeen(now - 3 * 3_600_000, now).text).toBe('今天');
    expect(formatLastSeen(now - 24 * 3_600_000, now).text).toBe('昨天');
    expect(formatLastSeen(new Date(2026, 1, 3).getTime(), now).text).toBe('2月3日');
  });
});

describe('接种日期', () => {
  const now = new Date(2026, 5, 10, 15, 30).getTime();
  it('今天就用现在的时间，时间线的顺序才对', () => {
    expect(doseTimestamp(new Date(2026, 5, 10, 8, 0), now)).toBe(now);
  });
  it('补记以前的就放在那天中午，不受时区边缘影响', () => {
    expect(doseTimestamp(new Date(2024, 1, 3, 23, 59), now)).toBe(
      new Date(2024, 1, 3, 12, 0).getTime(),
    );
  });
  it('不能晚于现在', () => {
    expect(doseTimestamp(new Date(2026, 5, 11, 9, 0), now)).toBe(now);
    expect(doseTimestamp(new Date(2027, 0, 1), now)).toBe(now);
  });
});

describe('成长册纸张', () => {
  it('按地区的纸张（单位是点）', () => {
    expect(bookPage('A4')).toEqual({ width: 595, height: 842 });
    expect(bookPage('Letter')).toEqual({ width: 612, height: 792 });
  });
});

describe('成长册文件名', () => {
  it('用宝宝的名字，去掉文件系统不允许的字符', () => {
    expect(bookFileName('小豆芽')).toBe('小豆芽的成长册.pdf');
    expect(bookFileName('a/b:c?')).toBe('abc的成长册.pdf');
  });
  it('名字为空时有默认值', () => expect(bookFileName(' / ')).toBe('宝宝的成长册.pdf'));
});

describe('成长册', () => {
  const baby = { name: '小<豆>芽', birthAt: new Date(2026, 0, 1).getTime() };
  it('转义用户内容，防止破坏排版', () => {
    expect(escapeHtml('<b>&"\'')).toBe('&lt;b&gt;&amp;&quot;&#39;');
    const html = buildBookHtml(baby, [], []);
    expect(html).toContain('小&lt;豆&gt;芽的成长册');
    expect(html).not.toContain('小<豆>芽');
  });
  it('回忆按时间正序排列，包含天数和图片', () => {
    const moment = (title: string, at: number) => ({
      data: { title, text: '正文', at, milestone: true, media: [], byName: '妈妈' },
      photos: [{ src: 'data:image/jpeg;base64,AAAA' }],
    });
    const html = buildBookHtml(
      baby,
      [
        moment('后面', new Date(2026, 0, 20).getTime()),
        moment('前面', new Date(2026, 0, 2).getTime()),
      ],
      [{ title: '信', text: '想对你说', at: 1, byName: '爸爸' }],
    );
    expect(html.indexOf('前面')).toBeLessThan(html.indexOf('后面'));
    expect(html).toContain('第 2 天');
    expect(html).toContain('里程碑');
    expect(html).toContain('data:image/jpeg;base64,AAAA');
    expect(html).toContain('想对你说');
    expect(html).toContain('爸爸写');
  });
});

describe('计划接种日期', () => {
  it('存成那天的中午，选的是未来的日期也不改', () => {
    const picked = new Date(2027, 2, 5, 23, 40);
    expect(plannedDayTimestamp(picked)).toBe(new Date(2027, 2, 5, 12).getTime());
  });

  it('下周和下个月都从今天算，月底不会跳过一个月', () => {
    const now = new Date(2026, 0, 31, 8).getTime();
    expect(plannedDaysLater(7, now).getTime()).toBe(new Date(2026, 1, 7, 12).getTime());
    expect(plannedNextMonth(now).getTime()).toBe(new Date(2026, 1, 28, 12).getTime());
    expect(plannedNextMonth(new Date(2026, 11, 15, 8).getTime()).getTime()).toBe(
      new Date(2027, 0, 15, 12).getTime(),
    );
  });
});
