import { CLIENT_LEVEL_HEADER, type MeResponse, MULTI_BABY_CLIENT_LEVEL } from '@xiaodouya/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  consentSegments,
  exportFileName,
  HTTP_CACHE_DIRECTORY,
  isPersonalCacheDirectory,
  shouldOfferVerifyStep,
} from '../src/lib/accountLogic';
import { Api, ApiFailure } from '../src/lib/api';

const me = (overrides: Partial<MeResponse> = {}): MeResponse =>
  ({
    user: { id: 'u1', email: 'a@example.test', displayName: '虚构' },
    emailVerified: false,
    family: null,
    role: null,
    label: null,
    members: [],
    invites: [],
    prefs: {},
    ...overrides,
  }) as MeResponse;

describe('邮箱验证这一步什么时候出现', () => {
  it('还没有家庭、没验证、没跳过：出现', () => {
    expect(shouldOfferVerifyStep(me(), null)).toBe(true);
  });
  it('服务器没配邮件时 emailVerified 是 true：不出现', () => {
    expect(shouldOfferVerifyStep(me({ emailVerified: true }), null)).toBe(false);
  });
  it('已经有家庭的老账号：不挡，到设置里验证', () => {
    expect(shouldOfferVerifyStep(me({ family: { id: 'f', name: '家' } }), null)).toBe(false);
  });
  it('这个人跳过了：不再出现', () => {
    expect(shouldOfferVerifyStep(me(), 'u1')).toBe(false);
  });
  it('别人跳过的不算数', () => {
    expect(shouldOfferVerifyStep(me(), 'u2')).toBe(true);
  });
  it('v0.1.0 缓存的身份没有这个字段：不出现，等刷新后再说', () => {
    const cached = me();
    delete (cached as Partial<MeResponse>).emailVerified;
    expect(shouldOfferVerifyStep(cached, null)).toBe(false);
  });
});

describe('注册页的同意说明', () => {
  const terms = 'https://example.test/terms';
  const privacy = 'https://example.test/privacy';
  it('两个地址都有', () => {
    expect(consentSegments(terms, privacy)).toEqual([
      { text: '注册即表示同意' },
      { text: '《用户协议》', url: terms, testID: 'consent-terms' },
      { text: '和' },
      { text: '《隐私政策》', url: privacy, testID: 'consent-privacy' },
    ]);
  });
  it('只有一个地址，只提这一个', () => {
    expect(consentSegments(null, privacy)).toEqual([
      { text: '注册即表示同意' },
      { text: '《隐私政策》', url: privacy, testID: 'consent-privacy' },
    ]);
  });
  it('都没有时不显示：不能让人同意一份打不开的文件', () => {
    expect(consentSegments(null, null)).toBeNull();
  });
});

describe('导出文件', () => {
  it('文件名带日期，不带宝宝名字', () => {
    expect(exportFileName(new Date('2026-11-01T08:00:00Z'))).toBe('xiaodouya-export-20261101.json');
  });
});

describe('清除手机上的数据', () => {
  it('系统选择器和打印留下的目录要清', () => {
    for (const name of ['ImagePicker', 'DocumentPicker', 'Print']) {
      expect(isPersonalCacheDirectory(name)).toBe(true);
    }
  });
  it('别的库的缓存目录不动', () => {
    expect(isPersonalCacheDirectory('image_manager_disk_cache')).toBe(false);
  });
  it('RN 网络库的 HTTP 缓存要清：里面有 /v1/me 的响应', () => {
    expect(HTTP_CACHE_DIRECTORY).toBe('http-cache');
    expect(isPersonalCacheDirectory(HTTP_CACHE_DIRECTORY)).toBe(true);
  });
});

describe('账号接口', () => {
  afterEach(() => vi.unstubAllGlobals());

  function stub(status: number, body: unknown) {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
      return new Response(JSON.stringify(body), { status });
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }
  const api = () => {
    const client = new Api();
    client.baseUrl = 'http://x';
    client.token = 't';
    return client;
  };

  it('删除账号时密码错误不算登录失效，留在原地让人重填', async () => {
    const client = api();
    const onUnauthorized = vi.fn();
    client.onUnauthorized = onUnauthorized;
    const fetchMock = stub(403, { error: { code: 'wrong_password', message: '密码不正确' } });
    const failure = await client.deleteAccount('nope').catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ApiFailure);
    expect((failure as ApiFailure).code).toBe('wrong_password');
    expect(onUnauthorized).not.toHaveBeenCalled();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://x/v1/me/delete');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({ password: 'nope' });
  });

  it('找回密码走不带令牌的公开接口', async () => {
    const client = new Api();
    client.baseUrl = 'http://x';
    const fetchMock = stub(200, { ok: true });
    await client.forgotPassword('a@example.test');
    await client.resetPassword({
      email: 'a@example.test',
      code: '123456',
      newPassword: '12345678',
    });
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      'http://x/v1/auth/password/forgot',
      'http://x/v1/auth/password/reset',
    ]);
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
  });

  it('每个请求都说明这个版本按宝宝过滤，服务端才让有第二个宝宝的家庭同步（issue #106）', async () => {
    const fetchMock = stub(200, { cursor: 0, hasMore: false, records: [], rejected: [] });
    const client = api();
    await client.sync({ cursor: 0, changes: [] });
    await client.me().catch(() => {});
    await client.forgotPassword('a@example.test');
    for (const call of fetchMock.mock.calls) {
      const headers = call[1]?.headers as Record<string, string>;
      expect(headers[CLIENT_LEVEL_HEADER]).toBe(String(MULTI_BABY_CLIENT_LEVEL));
    }
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('服务器开了邮件才显示忘记密码', async () => {
    stub(200, { allowCustomStorage: false, passwordReset: true, emailVerification: true });
    await expect(api().passwordResetEnabled()).resolves.toBe(true);
  });

  it('旧服务器的 /v1/config 没有这个字段：当作没开邮件', async () => {
    stub(200, { allowCustomStorage: true });
    await expect(api().passwordResetEnabled()).resolves.toBe(false);
  });

  it('旧服务器没有 /v1/config：当作没开邮件，不报错', async () => {
    stub(404, { error: { code: 'not_found', message: '接口不存在' } });
    await expect(api().passwordResetEnabled()).resolves.toBe(false);
  });

  it('连不上服务器：同样当作没开，登录页不能因此出错', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network');
      }),
    );
    await expect(api().passwordResetEnabled()).resolves.toBe(false);
  });

  it('验证和重发走已登录的接口', async () => {
    const fetchMock = stub(200, {});
    await api().sendEmailCode();
    await api().verifyEmail('123456');
    await api().exportFamily();
    expect(fetchMock.mock.calls.map((c) => [c[0], c[1]?.method])).toEqual([
      ['http://x/v1/me/email/send-code', 'POST'],
      ['http://x/v1/me/email/verify', 'POST'],
      ['http://x/v1/family/export', 'GET'],
    ]);
  });

  it('每个请求都要求不缓存响应：旧服务器没有 no-store 时也不写进 http-cache', async () => {
    const fetchMock = stub(200, {});
    await api().me();
    await api().storageUsage();
    await new Api().publicConfig();
    for (const call of fetchMock.mock.calls) {
      const headers = call[1]?.headers as Record<string, string>;
      expect(headers['cache-control'], call[0]).toBe('no-store');
    }
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
