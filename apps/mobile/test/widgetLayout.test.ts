import { describe, expect, it } from 'vitest';
import { QUICK_ROW_MAX_HEIGHT, quickLayout, scaler, widgetScale } from '../src/widgets/layout';

describe('小工具按大小缩放', () => {
  it('设计尺寸是 1 倍，拉大变大，缩小变小', () => {
    expect(widgetScale('small', { width: 156, height: 164 })).toBe(1);
    expect(widgetScale('small', { width: 234, height: 246 })).toBe(1.5);
    expect(widgetScale('small', { width: 125, height: 131 })).toBeCloseTo(0.8, 1);
  });

  it('按放得下的那一边算：只拉宽不会把字撑出卡片', () => {
    expect(widgetScale('small', { width: 400, height: 164 })).toBe(1);
    expect(widgetScale('small', { width: 156, height: 400 })).toBe(1);
    expect(widgetScale('wide', { width: 320, height: 300 })).toBe(1);
  });

  it('有上下限：再小也看得清，再大也不夸张', () => {
    expect(widgetScale('small', { width: 40, height: 40 })).toBe(0.6);
    expect(widgetScale('small', { width: 2000, height: 2000 })).toBe(1.6);
  });

  it('尺寸读不到时按 1 倍', () => {
    expect(widgetScale('small', { width: 0, height: 0 })).toBe(1);
    expect(widgetScale('wide', { width: Number.NaN, height: 100 })).toBe(1);
  });

  it('字号和间距都乘同一个倍数，保留半个点', () => {
    const s = scaler(1.25);
    expect(s(12)).toBe(15);
    expect(s(11)).toBe(14);
    expect(s(7)).toBe(9);
    expect(scaler(0.6)(34)).toBe(20.5);
  });
});

describe('快捷记录的两种样子', () => {
  it('一格高只有一排按钮，两格高才有标题和最近的记录', () => {
    expect(quickLayout({ width: 352, height: 70 })).toBe('row');
    expect(quickLayout({ width: 352, height: QUICK_ROW_MAX_HEIGHT })).toBe('row');
    expect(quickLayout({ width: 352, height: QUICK_ROW_MAX_HEIGHT + 1 })).toBe('full');
    expect(quickLayout({ width: 352, height: 168 })).toBe('full');
  });

  it('一排按钮时也是两边都放得下才变大', () => {
    expect(widgetScale('quickRow', { width: 352, height: 62 })).toBe(1);
    expect(widgetScale('quickRow', { width: 480, height: 93 })).toBe(1.5);
  });
});
