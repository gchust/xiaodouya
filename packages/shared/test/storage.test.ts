import { describe, expect, it } from 'vitest';
import { mediaCategory, quotaStatus } from '../src';

const GB = 1024 ** 3;
const usage = (quotaUsed: number, quota: number | null = 10 * GB) => ({
  total: quotaUsed,
  quota,
  quotaUsed,
});

describe('文件分类', () => {
  it('证件不管什么格式都算证件', () => {
    expect(mediaCategory('image/jpeg', 'document')).toBe('document');
    expect(mediaCategory('application/pdf', 'document')).toBe('document');
  });
  it('其他按类型，大小写不敏感', () => {
    expect(mediaCategory('VIDEO/mp4', 'memory')).toBe('video');
    expect(mediaCategory('audio/m4a', 'memory')).toBe('audio');
    expect(mediaCategory('image/heic', 'memory')).toBe('image');
    expect(mediaCategory('image/jpeg', 'avatar')).toBe('image');
  });
});

describe('配额提醒', () => {
  it('没到 80% 不打扰', () => {
    const status = quotaStatus(usage(7.99 * GB));
    expect(status.level).toBe('ok');
    expect(status.warning).toBeNull();
  });
  it('到 80% 提醒快满了，并说明后果', () => {
    const status = quotaStatus(usage(8 * GB));
    expect(status.level).toBe('warn');
    expect(status.warning).toContain('80%');
    expect(status.warning).toContain('传不上去');
  });
  it('99.9% 也只说 99%，不能显示成已满', () => {
    const status = quotaStatus(usage(9.999 * GB));
    expect(status.level).toBe('warn');
    expect(status.warning).toContain('99%');
  });
  it('满了要说清楚怎么办', () => {
    const status = quotaStatus(usage(10 * GB));
    expect(status.level).toBe('full');
    expect(status.warning).toContain('10.0 GB');
    expect(status.warning).toContain('删除');
    expect(status.warning).toContain('重试');
  });
  it('撤销删除后可能超出，进度条封顶', () => {
    const status = quotaStatus(usage(12 * GB));
    expect(status.level).toBe('full');
    expect(status.fraction).toBe(1);
  });
  it('不限量和旧版服务端都不提醒', () => {
    expect(quotaStatus(usage(100 * GB, null)).level).toBe('none');
    expect(quotaStatus({ total: 100 * GB }).level).toBe('none');
  });
});
