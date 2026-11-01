/** 不依赖 React Native 的布局计算，方便单元测试。 */

/**
 * 网格每一项的精确宽度。百分比宽度加上固定 gap 在部分屏宽下会超出一点点，最后一项就换行了。
 * 向下取整到 0.01，保证加起来不会超过容器。
 */
export function gridItemWidth(containerWidth: number, columns: number, gap: number): number {
  const width = (containerWidth - gap * (columns - 1)) / columns;
  return Math.max(0, Math.floor(width * 100) / 100);
}
