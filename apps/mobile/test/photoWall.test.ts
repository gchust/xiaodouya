import type { MediaRef } from '@xiaodouya/shared';
import { describe, expect, it } from 'vitest';
import { photoWallRows } from '../src/lib/photoWall';

let n = 0;
const media = (kind: MediaRef['kind']): MediaRef => {
  n += 1;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    kind,
    mime: kind === 'audio' ? 'audio/mp4' : 'image/jpeg',
    size: 1,
  };
};
const moment = (id: string, items: MediaRef[]) => ({ id, data: { media: items } });

describe('照片墙的行', () => {
  it('每段回忆一行标题，下面每 3 个一行，最后一行可以不满', () => {
    const a = moment(
      'a',
      Array.from({ length: 7 }, () => media('image')),
    );
    const rows = photoWallRows([a], 3);
    expect(rows.map((r) => r.kind)).toEqual(['head', 'cells', 'cells', 'cells']);
    expect(rows.map((r) => (r.kind === 'cells' ? r.cells.length : r.count))).toEqual([7, 3, 3, 1]);
  });

  it('序号是这一张在这段回忆的照片和视频里的位置，录音不算', () => {
    const items = [media('image'), media('audio'), media('video'), media('image'), media('image')];
    const rows = photoWallRows([moment('a', items)], 3);
    const cells = rows.flatMap((r) => (r.kind === 'cells' ? r.cells : []));
    expect(cells.map((c) => c.index)).toEqual([0, 1, 2, 3]);
    expect(cells.map((c) => c.media.id)).toEqual(
      [items[0], items[2], items[3], items[4]].map((m) => m?.id),
    );
  });

  it('没有照片和视频的回忆不出现，只有第一组标记为第一组', () => {
    const rows = photoWallRows(
      [
        moment('text', []),
        moment('audio', [media('audio')]),
        moment('b', [media('image')]),
        moment('c', [media('image'), media('image'), media('image'), media('image')]),
      ],
      3,
    );
    expect(rows.map((r) => `${r.kind}:${r.moment.id}:${r.first}`)).toEqual([
      'head:b:true',
      'cells:b:true',
      'head:c:false',
      'cells:c:true',
      'cells:c:false',
    ]);
  });

  it('键不重复，数据变了也稳定', () => {
    const c = moment(
      'c',
      Array.from({ length: 10 }, () => media('image')),
    );
    const keys = photoWallRows([c], 3).map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(photoWallRows([moment('new', [media('image')]), c], 3).map((r) => r.key)).toEqual([
      'head-new',
      'cells-new-0',
      ...keys,
    ]);
  });
});
