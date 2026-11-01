import { describe, expect, it } from 'vitest';
import { uploadCardStatus } from '../src/lib/uploadStatus';

describe('上传卡片', () => {
  const base = {
    total: 0,
    fraction: 1,
    active: false,
    waitingForWifi: false,
    failedCount: 0,
    failedReason: null,
    doneInBatch: 0,
  };
  it('文案和原来一致', () => {
    expect(uploadCardStatus({ ...base, failedCount: 2 }).text).toBe('2 个文件上传失败');
    expect(uploadCardStatus({ ...base, total: 1, waitingForWifi: true }).text).toBe(
      '1 个视频等 Wi-Fi 再上传',
    );
    expect(uploadCardStatus({ ...base, total: 3 }).text).toBe('3 个文件等待上传');
    expect(uploadCardStatus({ ...base, total: 3, active: true }).text).toBe('正在上传 3 个文件');
  });
  it('传输中数量减少不算状态变化，关掉后不会反复弹出', () => {
    expect(uploadCardStatus({ ...base, total: 3, active: true }).key).toBe(
      uploadCardStatus({ ...base, total: 2, active: true }).key,
    );
  });
  it('多了一个等 Wi-Fi 的视频或失败的文件，要重新显示', () => {
    const wifi = { ...base, total: 1, waitingForWifi: true };
    expect(uploadCardStatus(wifi).key).not.toBe(uploadCardStatus({ ...wifi, total: 2 }).key);
    expect(uploadCardStatus({ ...base, failedCount: 1 }).key).not.toBe(
      uploadCardStatus({ ...base, failedCount: 2 }).key,
    );
  });
  it('传输中又有文件失败，要重新显示', () => {
    const uploading = { ...base, total: 2, active: true };
    expect(uploadCardStatus(uploading).key).not.toBe(
      uploadCardStatus({ ...uploading, failedCount: 1 }).key,
    );
  });
  it('从等 Wi-Fi 变成传输中，要重新显示', () => {
    expect(uploadCardStatus({ ...base, total: 1, waitingForWifi: true }).key).not.toBe(
      uploadCardStatus({ ...base, total: 1, active: true }).key,
    );
  });
});
