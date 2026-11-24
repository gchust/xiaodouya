/**
 * 小工具按实际大小缩放（不依赖 React Native，可以直接写单元测试）。
 *
 * 原来字号和按钮高度是写死的，按 168dp 见方的格子设计：格子小一点的桌面（有的手机 2×2 只有
 * 150dp 上下）、或者手机字体调大了（库默认按 sp 算字号），下面的按钮就被挤出卡片。现在字号不再跟
 * 手机的字体大小，统一跟小工具的大小：想要字大一点，把小工具拉大。
 */
export interface WidgetSize {
  width: number;
  height: number;
}

/** 各种样子在 1 倍时刚好放下的大小（dp）。`quickRow` 是快捷记录只有一排按钮时。 */
const BASES = {
  small: { width: 156, height: 164 },
  wide: { width: 320, height: 150 },
  quickRow: { width: 320, height: 62 },
} as const;
export type WidgetShape = keyof typeof BASES;

const MIN_SCALE = 0.6;
const MAX_SCALE = 1.6;

/** 按放得下的那一边算，所以只拉宽或只拉高都不会把内容撑出去。 */
export function widgetScale(shape: WidgetShape, size: WidgetSize): number {
  const base = BASES[shape];
  const ratio = Math.min(size.width / base.width, size.height / base.height);
  if (!Number.isFinite(ratio) || ratio <= 0) return 1;
  return Math.round(Math.min(MAX_SCALE, Math.max(MIN_SCALE, ratio)) * 100) / 100;
}

/** 字号、间距、圆角都过这一个函数。保留半个点，小尺寸下 11 和 12 号字还分得开。 */
export function scaler(scale: number): (n: number) => number {
  return (n) => Math.round(n * scale * 2) / 2;
}

/** 快捷记录不高于这个数（一格高）时只画一排按钮。 */
export const QUICK_ROW_MAX_HEIGHT = 104;

export function quickLayout(size: WidgetSize): 'row' | 'full' {
  return size.height <= QUICK_ROW_MAX_HEIGHT ? 'row' : 'full';
}
