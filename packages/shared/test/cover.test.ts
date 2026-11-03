import { describe, expect, it } from 'vitest';
import { type MediaRef, MomentData, momentCover, parseCollectionData } from '../src';

const ids = {
  audio: '00000000-0000-4000-8000-00000000000a',
  photo1: '00000000-0000-4000-8000-000000000001',
  video: '00000000-0000-4000-8000-000000000002',
  photo3: '00000000-0000-4000-8000-000000000003',
  gone: '00000000-0000-4000-8000-0000000000ff',
};

const ref = (id: string, kind: MediaRef['kind']): MediaRef => ({
  id,
  kind,
  mime: kind === 'video' ? 'video/mp4' : kind === 'audio' ? 'audio/mp4' : 'image/jpeg',
  size: 1,
});

// 录音排在最前面：封面只能是照片或视频。
const media = [
  ref(ids.audio, 'audio'),
  ref(ids.photo1, 'image'),
  ref(ids.video, 'video'),
  ref(ids.photo3, 'image'),
];

describe('回忆的封面', () => {
  it('没有设置时用第一个照片或视频', () => {
    expect(momentCover(media)).toEqual({ media: media[1], index: 0, count: 3 });
  });

  it('设置了就用设置的，序号是在照片和视频里的位置', () => {
    expect(momentCover(media, ids.photo3)).toEqual({ media: media[3], index: 2, count: 3 });
    expect(momentCover(media, ids.video)?.media.kind).toBe('video');
  });

  it('封面被移除了，回到第一个', () => {
    expect(momentCover(media, ids.gone)?.media.id).toBe(ids.photo1);
  });

  it('指向录音时不当封面，回到第一个', () => {
    expect(momentCover(media, ids.audio)?.media.id).toBe(ids.photo1);
  });

  it('没有照片和视频就没有封面', () => {
    expect(momentCover([ref(ids.audio, 'audio')], ids.audio)).toBeNull();
    expect(momentCover([])).toBeNull();
  });
});

describe('回忆的封面字段', () => {
  const base = { title: '', text: '', at: 1, milestone: false, media };

  it('能存下来', () => {
    expect(parseCollectionData('moment', { ...base, coverMediaId: ids.photo3 })).toEqual({
      ...base,
      coverMediaId: ids.photo3,
    });
  });

  // 旧版本和新版本都要能读：格式不对只丢这一项，整条回忆照常显示。
  it('格式不对只丢掉这一项', () => {
    const parsed = MomentData.parse({ ...base, coverMediaId: 'not-a-uuid' });
    expect(parsed.coverMediaId).toBeUndefined();
    expect(parsed.media).toHaveLength(4);
    expect(MomentData.parse({ ...base, coverMediaId: 42 }).coverMediaId).toBeUndefined();
  });

  it('没有这个字段的旧记录照常解析', () => {
    expect(parseCollectionData('moment', base)).toEqual(base);
  });
});
