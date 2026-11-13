// 系统大字体（issue #110）。长辈常把手机字体开到 1.3 倍甚至 2 倍：正文和按钮跟着放大，
// 这是他们真正需要的；本来就很大的标题和数字（计时器 32、弹层 52、余额 32、页面标题 26）
// 再放大会把一行撑破，也不会更好读，只放大到 LARGE_TEXT_MAX_SCALE。

/** 从这个字号起算“大字”。分区标题 15、弹层标题 20 仍然跟着系统放大。 */
export const LARGE_TEXT_SIZE = 24;
export const LARGE_TEXT_MAX_SCALE = 1.2;

/**
 * 交给 `maxFontSizeMultiplier`。写了小字号时传 0（不限制、跟着系统走），不能不传：嵌套的 Text
 * 不传时继承外层，身高体重弹层里 `3.4` 后面的 `kg` 就会跟着大数字只放大 1.2 倍。
 * 没写字号时不传（undefined）：嵌套的字号也是继承外层的，上限跟着外层走才一致。
 */
export function maxFontScaleFor(fontSize: number | undefined): number | undefined {
  if (fontSize === undefined) return undefined;
  return fontSize >= LARGE_TEXT_SIZE ? LARGE_TEXT_MAX_SCALE : 0;
}

/**
 * 今天页的四个快捷按钮在大字体下改成两行两列。一排四个时每个只有约 80 宽，
 * 2 倍字体下 `Diaper` 这样的词就要断开；两列每个有一半宽，按钮也更大、更好按。
 */
export const QUICK_ACTIONS_WRAP_SCALE = 1.5;

export function quickActionColumns(fontScale: number): 2 | 4 {
  return fontScale >= QUICK_ACTIONS_WRAP_SCALE ? 2 : 4;
}
