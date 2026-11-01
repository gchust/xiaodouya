import { describe, expect, it } from 'vitest';
import { buildBookHtml } from '../src/lib/bookHtml';
import { formatLastSeen } from '../src/lib/dates';
import {
  downsamplePeaks,
  escapeHtml,
  fallbackPeaks,
  isUrlFresh,
  pickDurationMs,
} from '../src/lib/mediaUtils';

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
