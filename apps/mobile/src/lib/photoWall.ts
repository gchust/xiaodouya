import { type MediaRef, visualMedia } from '@xiaodouya/shared';

/**
 * 照片墙按行虚拟化（issue #112）：每段回忆一行标题，下面每 columns 个一行。
 * 一整组放进一项的话，一段 100 张的回忆还是一次画完。
 */
export type PhotoWallRow<T> =
  | { key: string; kind: 'head'; moment: T; count: number; first: boolean }
  | {
      key: string;
      kind: 'cells';
      moment: T;
      /** index 是这一张在这段回忆的照片和视频里的位置，全屏查看从它开始。 */
      cells: { media: MediaRef; index: number }[];
      /** 这一组的第一行，紧跟标题。 */
      first: boolean;
    };

export function photoWallRows<T extends { id: string; data: { media: readonly MediaRef[] } }>(
  moments: readonly T[],
  columns: number,
): PhotoWallRow<T>[] {
  const rows: PhotoWallRow<T>[] = [];
  for (const moment of moments) {
    const media = visualMedia(moment.data.media);
    if (media.length === 0) continue;
    rows.push({
      key: `head-${moment.id}`,
      kind: 'head',
      moment,
      count: media.length,
      first: rows.length === 0,
    });
    for (let start = 0; start < media.length; start += columns) {
      rows.push({
        key: `cells-${moment.id}-${start}`,
        kind: 'cells',
        moment,
        cells: media.slice(start, start + columns).map((m, i) => ({ media: m, index: start + i })),
        first: start === 0,
      });
    }
  }
  return rows;
}
