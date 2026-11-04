/**
 * 小工具头像缓存的纯逻辑，不依赖 React Native，能直接写单元测试。读写文件在 `avatarCache.ts`。
 */

/**
 * 缓存的边长（像素）。小工具上最大画 22dp，xxxhdpi 是 88 px，128 留一点余量；
 * 这样一张 JPEG 只有几 KB，每次重画都整张传给原生也不碍事。
 */
export const WIDGET_AVATAR_PX = 128;

/** 键就是头像文件的 id（UUID），可以直接当文件名。 */
export function avatarFileName(key: string): string {
  return `${key}.jpg`;
}

/** 目录里除了现在这张头像的文件都该删：旧头像、关了开关、上次没写完的临时文件。 */
export function staleAvatarFiles(names: readonly string[], key: string | null): string[] {
  const keep = key ? avatarFileName(key) : null;
  return names.filter((name) => name !== keep);
}

/**
 * 居中裁成正方形。`ImageWidget` 在原生里先把图拉伸成指定的宽高再缩放，
 * 不是正方形的图会被压扁，所以存进缓存前就要裁好。
 */
export function squareCrop(
  width: number,
  height: number,
): { originX: number; originY: number; width: number; height: number } {
  const side = Math.min(width, height);
  return {
    originX: Math.floor((width - side) / 2),
    originY: Math.floor((height - side) / 2),
    width: side,
    height: side,
  };
}
