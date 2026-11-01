import type { StorageConfigView, StorageUsage } from '@xiaodouya/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Api } from '../src/lib/api';
import { canOpenStorage, storagePageMode, storageSummaryText } from '../src/lib/storagePage';

const GB = 1024 ** 3;
const usage = (over: Partial<StorageUsage> = {}): StorageUsage => ({
  image: GB,
  video: 0,
  audio: 0,
  document: 0,
  total: GB,
  quota: 5 * GB,
  quotaUsed: GB,
  pending: 0,
  trash: 0,
  trashDays: 30,
  ...over,
});
const view = (over: Partial<StorageConfigView> = {}): StorageConfigView => ({
  source: 'server',
  provider: null,
  accountId: null,
  endpoint: null,
  region: null,
  bucket: null,
  accessKeyId: null,
  hasSecret: true,
  publicBaseUrl: null,
  ...over,
});

describe('存储页显示什么', () => {
  it('只有服务器允许时，管理员才看到 S3 表单', () => {
    expect(storagePageMode('admin', true)).toBe('form');
    expect(storagePageMode('admin', false)).toBe('usage');
  });
  it('一起记录的家人只看用量：表单的接口他们也调不了', () => {
    expect(storagePageMode('caregiver', true)).toBe('usage');
    expect(storagePageMode('caregiver', false)).toBe('usage');
  });
  it('只看回忆的家人没有入口', () => {
    expect(canOpenStorage('viewer')).toBe(false);
    expect(canOpenStorage(null)).toBe(false);
    expect(canOpenStorage('caregiver')).toBe(true);
    expect(canOpenStorage('admin')).toBe(true);
  });
});

describe('家人页的存储摘要', () => {
  it('托管存储只说用了多少，不提服务商', () => {
    expect(storageSummaryText(usage(), view())).toBe('已用 1.0 GB，共 5.0 GB');
    expect(storageSummaryText(usage(), null)).toBe('已用 1.0 GB，共 5.0 GB');
  });
  it('快满和满了要在这里就看得到', () => {
    expect(storageSummaryText(usage({ quotaUsed: 4.5 * GB }), null)).toBe(
      '快满了 · 已用 4.5 GB，共 5.0 GB',
    );
    expect(storageSummaryText(usage({ quotaUsed: 5 * GB }), null)).toBe(
      '已满 · 已用 5.0 GB，共 5.0 GB',
    );
  });
  it('已用的数字是算进配额的用量，不是分类之和', () => {
    expect(storageSummaryText(usage({ total: GB, quotaUsed: 2 * GB }), null)).toBe(
      '已用 2.0 GB，共 5.0 GB',
    );
  });
  it('用自己的存储时显示服务商，没有上限', () => {
    expect(
      storageSummaryText(usage({ quota: null }), view({ source: 'family', provider: 'r2' })),
    ).toBe('Cloudflare R2 · 已用 1.0 GB');
  });
  it('没有配置存储时提醒管理员', () => {
    expect(storageSummaryText(usage({ quota: null }), view({ source: 'none' }))).toBe(
      '还没有配置，上传前需要先设置',
    );
  });
  it('旧版服务端不返回配额，也不能出错', () => {
    const old = { image: GB, video: 0, audio: 0, document: 0, total: GB } as StorageUsage;
    expect(storageSummaryText(old, view())).toBe('服务器默认存储 · 已用 1.0 GB');
  });
});

describe('服务器是否允许自定义存储', () => {
  const respond = (status: number, body: unknown) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(body), { status })),
    );
  afterEach(() => vi.unstubAllGlobals());

  it('按服务器的回答', async () => {
    respond(200, { allowCustomStorage: false });
    expect(await new Api().allowCustomStorage()).toBe(false);
    respond(200, { allowCustomStorage: true });
    expect(await new Api().allowCustomStorage()).toBe(true);
  });
  it('旧版服务端没有这个接口，当时都能自定义', async () => {
    respond(404, { error: { code: 'not_found', message: '接口不存在' } });
    expect(await new Api().allowCustomStorage()).toBe(true);
  });
  it('多了别的字段也不影响', async () => {
    respond(200, { allowCustomStorage: false, mailEnabled: true });
    expect(await new Api().allowCustomStorage()).toBe(false);
  });
  it('连不上时报错，不能猜：猜错了会给普通用户看 S3 表单', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network');
      }),
    );
    await expect(new Api().allowCustomStorage()).rejects.toThrow();
  });
});
