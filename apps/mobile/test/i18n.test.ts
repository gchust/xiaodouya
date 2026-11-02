import {
  apiErrorMessage,
  defaultPrefs,
  type EventData,
  getLocale,
  setLocale,
  storageTestMessage,
  withLocale,
} from '@xiaodouya/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatLastSeen } from '../src/lib/dates';
import { downloadMessage } from '../src/lib/downloadCore';
import { summarizeRemote } from '../src/lib/remoteSummary';
import { uploadCardStatus } from '../src/lib/uploadStatus';

const locales = vi.hoisted(() => ({
  list: [{ languageTag: 'en-US' }] as { languageTag: string }[],
}));
vi.mock('expo-localization', () => ({ getLocales: () => locales.list }));
vi.mock('../src/lib/config', () => ({ IS_E2E: false, DEFAULT_API_URL: '' }));

const { applyLocale } = await import('../src/lib/locale');

afterEach(() => {
  setLocale('zh');
  locales.list = [{ languageTag: 'en-US' }];
});

describe('语言来源', () => {
  it('没选过时跟随手机：zh 开头的中文，其他英文', () => {
    locales.list = [{ languageTag: 'zh-Hans-SG' }];
    expect(applyLocale(undefined)).toBe('zh');
    expect(getLocale()).toBe('zh');
    locales.list = [{ languageTag: 'fr-FR' }];
    expect(applyLocale(undefined)).toBe('en');
    expect(getLocale()).toBe('en');
  });

  it('选过的优先于手机语言，读不到手机语言时用英文', () => {
    locales.list = [{ languageTag: 'en-US' }];
    expect(applyLocale('zh')).toBe('zh');
    locales.list = [];
    expect(applyLocale(undefined)).toBe('en');
  });

  it('登录前的默认偏好里没有语言', () => {
    expect(defaultPrefs.locale).toBeUndefined();
  });
});

describe('服务端错误', () => {
  it('中文直接用 message，英文按 code 查，查不到才显示 message', () => {
    expect(apiErrorMessage('bad_credentials', undefined, '邮箱或密码不正确')).toBe(
      '邮箱或密码不正确',
    );
    withLocale('en', () => {
      expect(apiErrorMessage('bad_credentials', undefined, '邮箱或密码不正确')).toBe(
        'Incorrect email or password.',
      );
      expect(apiErrorMessage('brand_new_code', undefined, '新的错误')).toBe('新的错误');
      expect(apiErrorMessage('constructor', undefined, '原文')).toBe('原文');
    });
  });

  it('带参数的消息按参数格式化', () => {
    withLocale('en', () => {
      expect(apiErrorMessage('too_large', { maxBytes: 5 * 1024 ** 3 }, 'x')).toContain('5.0 GB');
      expect(apiErrorMessage('quota_exceeded', { quota: 1024 ** 3 }, 'x')).toContain('1.0 GB');
      expect(apiErrorMessage('too_many_attempts', { minutes: 15 }, 'x')).toContain('15 minutes');
      expect(apiErrorMessage('forbidden', { reason: 'viewer' }, 'x')).toContain('memories');
      expect(apiErrorMessage('too_many_attempts', undefined, 'x')).toContain('later');
    });
  });

  it('存储测试的结果按原因显示', () => {
    expect(storageTestMessage('badKey', '密钥不正确')).toBe('密钥不正确');
    expect(withLocale('en', () => storageTestMessage('ok', '读写正常'))).toBe('Read and write OK');
    // v0.1.0 时代的服务端没有 reason。
    expect(withLocale('en', () => storageTestMessage(undefined, '连接失败'))).toContain('failed');
  });
});

describe('家人的称呼不翻译', () => {
  const record = (data: EventData, createdBy: string) => ({
    id: createdBy + data.at,
    collection: 'event' as const,
    data,
    createdBy,
    updatedAt: data.at,
    deleted: false,
    seq: 1,
  });

  it('横幅里的称呼原样显示，别的文字跟随语言', () => {
    const records = [record({ type: 'feed', at: 1000, ml: 90, byName: '妈妈' }, 'u2')];
    const summary = withLocale('en', () =>
      summarizeRemote(records as never, {
        selfId: 'u1',
        members: [{ userId: 'u2', label: '妈妈' }] as never,
        units: { volume: 'ml', temperature: 'c', weight: 'kg', length: 'cm' },
        now: 2000,
      }),
    );
    expect(summary).toEqual({ initial: '妈', message: '妈妈 recorded Feed 90ml' });
  });
});

describe('界面文字跟随语言', () => {
  it('成员状态', () => {
    const now = new Date(2026, 9, 31, 12).getTime();
    expect(withLocale('en', () => formatLastSeen(null, now).text)).toBe('Not online yet');
    expect(withLocale('en', () => formatLastSeen(now - 10 * 60_000, now).text)).toBe('10 min ago');
    expect(formatLastSeen(new Date(2026, 8, 3).getTime(), now).text).toBe('9月3日');
    expect(withLocale('en', () => formatLastSeen(new Date(2026, 8, 3).getTime(), now).text)).toBe(
      'Sep 3',
    );
  });

  it('上传状态处理单复数', () => {
    expect(
      withLocale(
        'en',
        () =>
          uploadCardStatus({
            failedCount: 1,
            failedCounts: { image: 0, video: 0, audio: 0, pdf: 1 },
            counts: { image: 0, video: 0, audio: 0, pdf: 0 },
            waitingForWifi: false,
            total: 0,
            active: false,
          } as never).text,
      ),
    ).toContain('1 file failed');
  });

  it('下载的提示', () => {
    expect(
      withLocale('en', () => downloadMessage({ status: 'failed', reason: 'network' } as never)),
    ).toContain('network');
    expect(downloadMessage({ status: 'failed', reason: 'network' } as never)).toContain('网络');
  });
});
