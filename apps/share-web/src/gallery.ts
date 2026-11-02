import type { PublicMedia } from '@xiaodouya/shared';

export interface GalleryRow {
  kind: 'full' | 'pair' | 'grid';
  items: PublicMedia[];
}

/** 超过这么多张就不再一张张铺满，手机上要滑太久。 */
const MANY = 12;
const GRID_COLUMNS = 3;

const isPortrait = (item: PublicMedia) =>
  Boolean(item.width && item.height && item.height > item.width);

/**
 * 照片排成一本相册：横图一整行，两张竖图并排，这样竖图不会大得要滑好几屏，横图也不会被裁成方块。
 * 不调换顺序：这是一天的先后。视频总是一整行，小格子里控件点不到。
 */
export function layoutGallery(items: readonly PublicMedia[]): GalleryRow[] {
  const rows: GalleryRow[] = [];
  const many = items.length > MANY;
  let pending: PublicMedia[] = [];
  const flush = () => {
    if (pending.length === 0) return;
    if (many) rows.push({ kind: 'grid', items: pending });
    else if (pending.length === 2) rows.push({ kind: 'pair', items: pending });
    else rows.push({ kind: 'full', items: pending });
    pending = [];
  };
  items.forEach((item, index) => {
    if (item.kind === 'video' || (many && index === 0) || (!many && !isPortrait(item))) {
      flush();
      rows.push({ kind: 'full', items: [item] });
      return;
    }
    pending.push(item);
    if (pending.length === (many ? GRID_COLUMNS : 2)) flush();
  });
  flush();
  return rows;
}

/** 一整行时图片框的宽高比。太高的竖图要滑半天，限制在 4:5。 */
export function fullRowAspect(item: PublicMedia): number {
  if (!item.width || !item.height) return item.kind === 'video' ? 16 / 9 : 4 / 3;
  return Math.max(4 / 5, Math.min(item.width / item.height, 2));
}
