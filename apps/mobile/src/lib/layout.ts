/** 不依赖 React Native 的布局计算，方便单元测试。 */

/**
 * 网格每一项的精确宽度。百分比宽度加上固定 gap 在部分屏宽下会超出一点点，最后一项就换行了。
 * 向下取整到 0.01，保证加起来不会超过容器。
 */
export function gridItemWidth(containerWidth: number, columns: number, gap: number): number {
  const width = (containerWidth - gap * (columns - 1)) / columns;
  return Math.max(0, Math.floor(width * 100) / 100);
}

/** 图片按 contain 放进容器后的实际显示尺寸。不知道原图尺寸时按占满容器算。 */
export function containedSize(
  containerWidth: number,
  containerHeight: number,
  mediaWidth?: number,
  mediaHeight?: number,
): { width: number; height: number } {
  if (!mediaWidth || !mediaHeight) return { width: containerWidth, height: containerHeight };
  const fit = Math.min(containerWidth / mediaWidth, containerHeight / mediaHeight);
  return { width: mediaWidth * fit, height: mediaHeight * fit };
}

/** 放大后的平移量限制在图片边缘刚好贴到容器边缘，既能看到四个角，也不会拖出一片黑。 */
export function clampPan(
  offset: number,
  scale: number,
  containerSize: number,
  contentSize: number,
): number {
  'worklet';
  const limit = Math.max(0, (contentSize * scale - containerSize) / 2);
  return Math.min(limit, Math.max(-limit, offset));
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

/**
 * 正方形裁剪框里实际看到的是原图的哪一块。
 * 图片先按短边铺满框（zoom = 1），再放大 zoom 倍、平移 (x, y)，平移量和 clampPan 一样以框的中心为原点。
 */
export function cropRect({
  frame,
  imageWidth,
  imageHeight,
  zoom,
  x,
  y,
}: {
  frame: number;
  imageWidth: number;
  imageHeight: number;
  zoom: number;
  x: number;
  y: number;
}): { originX: number; originY: number; width: number; height: number } {
  const shortSide = Math.min(imageWidth, imageHeight);
  const dpPerPixel = (frame / shortSide) * zoom;
  const side = Math.max(1, Math.min(shortSide, Math.round(frame / dpPerPixel)));
  // 原生裁剪只接受整数，也不接受超出图片的范围。
  const origin = (imageSize: number, offset: number) =>
    Math.min(
      imageSize - side,
      Math.max(0, Math.round(imageSize / 2 - offset / dpPerPixel - side / 2)),
    );
  return {
    originX: origin(imageWidth, x),
    originY: origin(imageHeight, y),
    width: side,
    height: side,
  };
}
