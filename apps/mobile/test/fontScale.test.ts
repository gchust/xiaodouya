import { describe, expect, it } from 'vitest';
import { maxFontScaleFor, quickActionColumns } from '../src/lib/fontScale';

describe('系统大字体', () => {
  it('正文、按钮、分区标题和弹层标题跟着系统放大，不设上限（0），嵌套时也不继承外层的上限', () => {
    for (const size of [10, 12, 13, 14, 16, 18, 20, 22]) {
      expect(maxFontScaleFor(size)).toBe(0);
    }
  });
  it('没写字号的文字（默认 14）也不设上限', () => {
    expect(maxFontScaleFor(undefined)).toBe(0);
  });
  it('页面标题、计时器、弹层大数字、余额最多放大到 1.2 倍', () => {
    for (const size of [24, 26, 32, 40, 52]) {
      expect(maxFontScaleFor(size)).toBe(1.2);
    }
  });
  it('快捷按钮在 1.3 倍时还是一排四个，1.5 倍起两行两列', () => {
    expect(quickActionColumns(1)).toBe(4);
    expect(quickActionColumns(1.3)).toBe(4);
    expect(quickActionColumns(1.5)).toBe(2);
    expect(quickActionColumns(2)).toBe(2);
  });
});
