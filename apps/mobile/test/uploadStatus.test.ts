import { setLocale } from '@xiaodouya/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import type { UploadCounts, UploadProgress } from '../src/data/uploadQueue';
import {
  formatEta,
  formatSpeed,
  uploadCardStatus,
  uploadCountsText,
  uploadSpeedText,
} from '../src/lib/uploadStatus';

const counts = (over: Partial<UploadCounts> = {}): UploadCounts => ({
  image: 0,
  video: 0,
  audio: 0,
  pdf: 0,
  ...over,
});

describe('上传卡片', () => {
  beforeEach(() => setLocale('zh'));
  const base: UploadProgress = {
    total: 0,
    counts: counts(),
    fraction: 1,
    sentBytes: 0,
    totalBytes: 0,
    active: false,
    waitingForWifi: false,
    offline: false,
    failedCount: 0,
    failedCounts: counts(),
    failedReason: null,
    finishedInBatch: 0,
    speed: null,
    etaSeconds: null,
    items: [],
  };
  const three = { total: 3, counts: counts({ image: 3 }) };
  const mixed = { total: 4, counts: counts({ image: 3, video: 1 }) };

  it('按媒体说，用户看得懂', () => {
    expect(uploadCardStatus({ ...base, ...mixed, active: true }).text).toBe(
      '正在上传 3 张照片、1 个视频',
    );
    expect(
      uploadCardStatus({ ...base, failedCount: 2, failedCounts: counts({ image: 2 }) }).text,
    ).toBe('2 张照片上传失败');
    expect(
      uploadCardStatus({
        ...base,
        total: 1,
        counts: counts({ video: 1 }),
        waitingForWifi: true,
      }).text,
    ).toBe('1 个视频等 Wi-Fi 再上传');
    expect(uploadCardStatus({ ...base, ...three }).text).toBe('3 张照片等待上传');
    expect(uploadCardStatus({ ...base, ...three, offline: true }).text).toBe(
      '3 张照片等网络恢复后上传',
    );
  });
  it('英文的单复数', () => {
    setLocale('en');
    expect(uploadCountsText(counts({ image: 1, video: 2, audio: 1, pdf: 3 }))).toBe(
      '1 photo, 2 videos, 1 recording, 3 files',
    );
  });
  it('传输中数量减少不算状态变化，关掉后不会反复弹出', () => {
    expect(uploadCardStatus({ ...base, ...three, active: true }).key).toBe(
      uploadCardStatus({ ...base, total: 2, counts: counts({ image: 2 }), active: true }).key,
    );
  });
  it('多了一个等 Wi-Fi 的视频或失败的文件，要重新显示', () => {
    const wifi = { ...base, total: 1, counts: counts({ video: 1 }), waitingForWifi: true };
    expect(uploadCardStatus(wifi).key).not.toBe(uploadCardStatus({ ...wifi, total: 2 }).key);
    const oneFailed = { ...base, failedCount: 1, failedCounts: counts({ image: 1 }) };
    expect(uploadCardStatus(oneFailed).key).not.toBe(
      uploadCardStatus({ ...oneFailed, failedCount: 2 }).key,
    );
  });
  it('传输中又有文件失败，要重新显示', () => {
    const uploading = { ...base, ...three, active: true };
    expect(uploadCardStatus(uploading).key).not.toBe(
      uploadCardStatus({ ...uploading, failedCount: 1 }).key,
    );
  });
  it('从等 Wi-Fi 变成传输中，要重新显示', () => {
    expect(uploadCardStatus({ ...base, ...three, waitingForWifi: true }).key).not.toBe(
      uploadCardStatus({ ...base, ...three, active: true }).key,
    );
  });
});

describe('速度文案', () => {
  beforeEach(() => setLocale('zh'));
  it('单位随大小变化，大的不留小数', () => {
    expect(formatSpeed(1.2 * 1024 * 1024)).toBe('1.2 MB/s');
    expect(formatSpeed(300 * 1024)).toBe('300 KB/s');
    expect(formatSpeed(12 * 1024)).toBe('12.0 KB/s');
  });
  it('剩余时间说到分钟，不读秒', () => {
    expect(formatEta(20)).toBe('不到 1 分钟');
    expect(formatEta(170)).toBe('约 3 分钟');
    expect(formatEta(3 * 3600)).toBe('约 3 小时');
  });
  it('合起来是“速度 · 剩余时间”，没有速度时不显示', () => {
    expect(uploadSpeedText({ speed: 1.2 * 1024 * 1024, etaSeconds: 170 })).toBe(
      '1.2 MB/s · 约 3 分钟',
    );
    expect(uploadSpeedText({ speed: null, etaSeconds: null })).toBeNull();
  });
  it('英文', () => {
    setLocale('en');
    expect(uploadSpeedText({ speed: 1.2 * 1024 * 1024, etaSeconds: 170 })).toBe(
      '1.2 MB/s · about 3 min',
    );
  });
});
