import { DAYS_PER_MONTH, referenceCurves } from '@xiaodouya/shared';
import { describe, expect, it } from 'vitest';
import { layoutGrowthChart, monthTicks, spreadLabels } from '../src/lib/growthChart';

const SIX = 6 * DAYS_PER_MONTH;

describe('生长曲线的几何', () => {
  it('纵轴同时容下参考线和宝宝的点，刻度是整齐的数', () => {
    const layout = layoutGrowthChart({
      width: 320,
      height: 200,
      endDays: SIX,
      curves: referenceCurves('weight', 'female', SIX),
      points: [{ ageDays: 30, value: 11 }],
    });
    const values = layout.yTicks.map((t) => t.value);
    expect(Math.min(...values)).toBeLessThanOrEqual(2.4);
    expect(Math.max(...values)).toBeGreaterThanOrEqual(11);
    expect(values.every((v) => Number.isInteger(v))).toBe(true);
    // 点在画布里
    for (const dot of layout.dots) {
      expect(dot.y).toBeGreaterThanOrEqual(layout.plot.top);
      expect(dot.y).toBeLessThanOrEqual(layout.plot.bottom);
    }
  });

  it('没有参考线时只按宝宝的点定范围，只有一个点也画得出来', () => {
    const layout = layoutGrowthChart({
      width: 320,
      height: 200,
      endDays: SIX,
      curves: [],
      points: [{ ageDays: 0, value: 3.2 }],
    });
    expect(layout.bands).toEqual([]);
    expect(layout.curves).toEqual([]);
    expect(layout.line).toBe('');
    expect(layout.dots).toHaveLength(1);
    expect(layout.yTicks.length).toBeGreaterThan(1);
  });

  it('身长跨过 2 岁时底色和每条线都是两段', () => {
    const end = 36 * DAYS_PER_MONTH;
    const layout = layoutGrowthChart({
      width: 320,
      height: 200,
      endDays: end,
      curves: referenceCurves('length', 'male', end),
      points: [],
    });
    expect(layout.bands).toHaveLength(2);
    for (const c of layout.curves) expect(c.d.match(/M/g)).toHaveLength(2);
  });

  it('月龄刻度按范围变稀', () => {
    expect(monthTicks(SIX)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(monthTicks(12 * DAYS_PER_MONTH)).toEqual([0, 2, 4, 6, 8, 10, 12]);
    expect(monthTicks(24 * DAYS_PER_MONTH)).toEqual([0, 3, 6, 9, 12, 15, 18, 21, 24]);
    expect(monthTicks(60 * DAYS_PER_MONTH)).toEqual([0, 12, 24, 36, 48, 60]);
  });

  it('右边的百分位标签不叠在一起', () => {
    const ys = spreadLabels([100, 96, 90, 60, 58], 11);
    const sorted = [...ys].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      expect((sorted[i] as number) - (sorted[i - 1] as number)).toBeGreaterThanOrEqual(11);
    }
    expect(ys[0]).toBe(100);
  });
});
