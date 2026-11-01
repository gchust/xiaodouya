import { describe, expect, it } from 'vitest';
import { gridItemWidth } from '../src/lib/layout';

describe('网格宽度', () => {
  it('360dp 屏上每行的总宽不超过容器', () => {
    const container = 360 - 44;
    expect(3 * gridItemWidth(container, 3, 10) + 2 * 10).toBeLessThanOrEqual(container);
    expect(2 * gridItemWidth(container, 2, 8) + 8).toBeLessThanOrEqual(container);
  });
  it('常见屏宽下都排得下，最多只差 0.05dp', () => {
    for (let width = 280; width <= 900; width += 1) {
      for (const [columns, gap] of [
        [2, 8],
        [3, 4],
        [3, 10],
      ] as const) {
        const total = columns * gridItemWidth(width, columns, gap) + (columns - 1) * gap;
        expect(total).toBeLessThanOrEqual(width);
        expect(width - total).toBeLessThan(0.05);
      }
    }
  });
  it('容器比 gap 还窄时不返回负数', () => {
    expect(gridItemWidth(4, 3, 10)).toBe(0);
  });
});
