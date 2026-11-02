import { describe, expect, it } from 'vitest';
import {
  canDecodeFull,
  mediaJobs,
  type PhotoFacts,
  PREVIEW_MAX_SIDE,
  PREVIEW_QUALITY,
  photoPlan,
  wantsPreview,
} from '../src/lib/photoPreview';

const facts = (over: Partial<PhotoFacts> = {}): PhotoFacts => ({
  answered: true,
  localOriginal: false,
  preview: false,
  original: false,
  wantOriginal: false,
  originalLoaded: false,
  originalFailed: false,
  ...over,
});

describe('查看器显示哪个变体', () => {
  it('有预览时默认显示预览，原图等用户点', () => {
    const plan = photoPlan(facts({ preview: true, original: true }));
    expect(plan).toEqual({ base: 'preview', overlayOriginal: false, control: 'view' });
  });

  it('旧照片没有预览：回退原图，不报错，也没有按钮', () => {
    const plan = photoPlan(facts({ original: true }));
    expect(plan).toEqual({ base: 'original', overlayOriginal: false, control: 'shown' });
  });

  it('本机有原图副本：直接用本机的，不管服务端有什么', () => {
    for (const answered of [true, false]) {
      const plan = photoPlan(facts({ localOriginal: true, answered, preview: true }));
      expect(plan).toEqual({ base: 'original', overlayOriginal: false, control: 'shown' });
    }
  });

  it('预览传好、原图没传完：显示预览，按钮说明原因', () => {
    const plan = photoPlan(facts({ preview: true }));
    expect(plan).toEqual({ base: 'preview', overlayOriginal: false, control: 'uploading' });
  });

  it('点了也不会去加载没传完的原图', () => {
    const plan = photoPlan(facts({ preview: true, wantOriginal: true }));
    expect(plan.overlayOriginal).toBe(false);
    expect(plan.control).toBe('uploading');
  });

  it('只有缩略图：先显示缩略图，不能显示打不开', () => {
    const plan = photoPlan(facts());
    expect(plan).toEqual({ base: 'thumb', overlayOriginal: false, control: 'uploading' });
  });

  it('还没问到服务端（离线、刚打开）：不说“没传完”，按钮不出现', () => {
    const plan = photoPlan(facts({ answered: false }));
    expect(plan).toEqual({ base: 'thumb', overlayOriginal: false, control: 'none' });
  });

  it('离线但本机还有预览（上传中）时照样显示预览', () => {
    const plan = photoPlan(facts({ answered: false, preview: true }));
    expect(plan.base).toBe('preview');
    expect(plan.control).toBe('none');
  });

  it('点了查看原图：预览留在下面，加载中、加载好、失败都看得出来', () => {
    const base = { preview: true, original: true, wantOriginal: true };
    expect(photoPlan(facts(base))).toEqual({
      base: 'preview',
      overlayOriginal: true,
      control: 'loading',
    });
    expect(photoPlan(facts({ ...base, originalLoaded: true })).control).toBe('shown');
    expect(photoPlan(facts({ ...base, originalFailed: true }))).toEqual({
      base: 'preview',
      overlayOriginal: false,
      control: 'failed',
    });
  });
});

describe('哪些文件做预览', () => {
  it('只有回忆里的照片', () => {
    expect(wantsPreview({ kind: 'image', mime: 'image/jpeg' }, 'memory')).toBe(true);
    expect(wantsPreview({ kind: 'image', mime: 'image/heic' }, 'memory')).toBe(true);
    expect(wantsPreview({ kind: 'video', mime: 'video/mp4' }, 'memory')).toBe(false);
    expect(wantsPreview({ kind: 'audio', mime: 'audio/m4a' }, 'memory')).toBe(false);
    expect(wantsPreview({ kind: 'pdf', mime: 'application/pdf' }, 'document')).toBe(false);
    expect(wantsPreview({ kind: 'image', mime: 'image/jpeg' }, 'document')).toBe(false);
    expect(wantsPreview({ kind: 'image', mime: 'image/jpeg' }, 'avatar')).toBe(false);
  });

  it('GIF 不做：JPEG 会让动图变成一张静止的画', () => {
    expect(wantsPreview({ kind: 'image', mime: 'image/gif' }, 'memory')).toBe(false);
    expect(wantsPreview({ kind: 'image', mime: 'IMAGE/GIF' }, 'memory')).toBe(false);
  });

  it('常量：长边约 2048，质量约 0.8', () => {
    expect(PREVIEW_MAX_SIDE).toBe(2048);
    expect(PREVIEW_QUALITY).toBe(0.8);
  });
});

describe('上传任务', () => {
  const uris = { original: 'file:///o', thumb: 'file:///t', preview: 'file:///p' };
  const build = (file: { kind: 'image' | 'video' | 'audio' | 'pdf'; mime: string }) =>
    mediaJobs({
      id: 'x',
      file: { ...file, size: 900, name: '虚构.jpg' },
      scope: 'memory',
      wifiOnly: false,
      uris,
    });

  it('照片：缩略图 → 预览 → 原图，前两个现场生成，原图文件不动', () => {
    const jobs = build({ kind: 'image', mime: 'image/png' });
    expect(jobs.map((j) => j.variant)).toEqual(['thumb', 'preview', 'original']);
    const [thumb, preview, original] = jobs;
    expect(thumb).toMatchObject({ localUri: uris.thumb, mime: 'image/jpeg', size: 0 });
    expect(preview).toMatchObject({
      localUri: uris.preview,
      mime: 'image/jpeg',
      size: 0,
      wifiOnly: false,
      mediaKind: 'image',
      thumbSource: { uri: uris.original, kind: 'image' },
    });
    expect(original).toMatchObject({ localUri: uris.original, mime: 'image/png', size: 900 });
    expect(original?.thumbSource).toBeUndefined();
  });

  it('视频保持现状：没有预览', () => {
    const jobs = build({ kind: 'video', mime: 'video/mp4' });
    expect(jobs.map((j) => j.variant)).toEqual(['thumb', 'original']);
  });

  it('录音和 PDF 只有原图', () => {
    expect(build({ kind: 'audio', mime: 'audio/m4a' }).map((j) => j.variant)).toEqual(['original']);
    expect(build({ kind: 'pdf', mime: 'application/pdf' }).map((j) => j.variant)).toEqual([
      'original',
    ]);
  });
});

describe('原图能不能完整解码', () => {
  it('2400 万像素以内可以，尺寸不知道或更大时交给系统按屏幕缩小', () => {
    expect(canDecodeFull({ width: 4000, height: 3000 })).toBe(true);
    expect(canDecodeFull({ width: 6000, height: 4000 })).toBe(true);
    expect(canDecodeFull({ width: 8160, height: 6120 })).toBe(false);
    expect(canDecodeFull({})).toBe(false);
    expect(canDecodeFull({ width: 4000 })).toBe(false);
  });
});
