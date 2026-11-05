import { describe, expect, it } from 'vitest';
import { DOCUMENT_THUMB_MAX_SIDE, documentCover, type MediaRef, thumbnailSize } from '../src';

const ids = {
  pdf: '00000000-0000-4000-8000-0000000000a1',
  photo: '00000000-0000-4000-8000-0000000000a2',
  photo2: '00000000-0000-4000-8000-0000000000a3',
};

const pdf: MediaRef = {
  id: ids.pdf,
  kind: 'pdf',
  mime: 'application/pdf',
  size: 1,
  name: 'birth.pdf',
};
const photo = (id: string, hasThumb?: boolean): MediaRef => ({
  id,
  kind: 'image',
  mime: 'image/jpeg',
  size: 1,
  ...(hasThumb === undefined ? {} : { hasThumb }),
});

describe('证件卡片的封面', () => {
  it('没有文件时什么都不显示', () => {
    expect(documentCover([])).toBeNull();
  });

  it('PDF 排在前面时也用第一张照片的缩略图，照片才看得出是哪张证件', () => {
    const files = [pdf, photo(ids.photo, true), photo(ids.photo2, true)];
    expect(documentCover(files)).toEqual({ kind: 'thumb', media: files[1] });
  });

  it('只有 PDF 时显示 PDF 的标记', () => {
    expect(documentCover([pdf])).toEqual({ kind: 'badge', media: pdf });
  });

  it('照片没有缩略图时不去拿原图，退回标记', () => {
    // 原图是证件的全尺寸照片，不能为了卡片上的一小块下载下来。
    const noThumb = photo(ids.photo, false);
    expect(documentCover([noThumb])).toEqual({ kind: 'badge', media: noThumb });
    const unknown = photo(ids.photo2);
    expect(documentCover([pdf, unknown])).toEqual({ kind: 'badge', media: pdf });
  });

  it('跳过没有缩略图的照片，用后面有缩略图的', () => {
    const files = [photo(ids.photo, false), photo(ids.photo2, true)];
    expect(documentCover(files)).toEqual({ kind: 'thumb', media: files[1] });
  });
});

describe('缩略图的尺寸', () => {
  it('证件的缩略图长边不超过 256，小图不放大', () => {
    expect(DOCUMENT_THUMB_MAX_SIDE).toBeLessThanOrEqual(256);
    expect(thumbnailSize('document')).toEqual({ maxSide: DOCUMENT_THUMB_MAX_SIDE });
  });

  it('回忆和头像不变：宽 720', () => {
    expect(thumbnailSize('memory')).toEqual({ maxSide: 1440, width: 720 });
    expect(thumbnailSize('avatar')).toEqual({ maxSide: 1440, width: 720 });
  });
});
