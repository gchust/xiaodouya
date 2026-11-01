/** 不依赖 React Native 的布局计算，方便单元测试。 */

/**
 * 网格每一项的精确宽度。百分比宽度加上固定 gap 在部分屏宽下会超出一点点，最后一项就换行了。
 * 向下取整到 0.01，保证加起来不会超过容器。
 */
export function gridItemWidth(containerWidth: number, columns: number, gap: number): number {
  const width = (containerWidth - gap * (columns - 1)) / columns;
  return Math.max(0, Math.floor(width * 100) / 100);
}

/**
 * 弹层还要再往上抬多少才不被键盘挡住。
 * softwareKeyboardLayoutMode 是 resize，但 edge-to-edge 时系统不一定缩小 App 的窗口。
 * 所以不假设，按实际量到的高度算：窗口已经缩小了多少，就少抬多少，不会重复计算。
 */
export function keyboardLift(
  keyboardHeight: number,
  fullHeight: number,
  currentHeight: number,
): number {
  if (keyboardHeight <= 0) return 0;
  return Math.max(0, keyboardHeight - Math.max(0, fullHeight - currentHeight));
}

/** 弹层最大高度：平时占 88%；键盘打开时不能超出可见区域，否则顶部的「取消」会跑出屏幕。 */
export function sheetMaxHeight(currentHeight: number, lift: number, topInset: number): number {
  return Math.max(0, Math.min(currentHeight * 0.88, currentHeight - lift - topInset));
}
