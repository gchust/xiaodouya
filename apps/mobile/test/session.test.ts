import { afterEach, describe, expect, it, vi } from 'vitest';
import { Api, ApiFailure } from '../src/lib/api';
import { sessionOwner, shouldClearLocalData, timezoneToSync } from '../src/lib/sessionLogic';

describe('夜间安静跟随手机的时区', () => {
  it('新用户的默认时区要换成手机的', () => {
    expect(timezoneToSync('UTC', 'America/New_York')).toBe('America/New_York');
  });
  it('出门换了时区也要跟上', () => {
    expect(timezoneToSync('Asia/Singapore', 'Asia/Tokyo')).toBe('Asia/Tokyo');
  });
  it('一样就不用再写，否则每次刷新都会多一次请求', () => {
    expect(timezoneToSync('Asia/Tokyo', 'Asia/Tokyo')).toBeNull();
  });
  it('读不到手机的时区时保持原样，不能写空值', () => {
    expect(timezoneToSync('Asia/Tokyo', null)).toBeNull();
    expect(timezoneToSync('Asia/Tokyo', '')).toBeNull();
  });
});

function stubFetch(status: number, body: string) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(body, { status })),
  );
}

const unauthenticated = JSON.stringify({ error: { code: 'unauthenticated', message: '过期' } });

describe('401 处理：不能因为一次 401 丢数据', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('服务端明确说未登录，才算登录失效', async () => {
    const api = new Api();
    api.baseUrl = 'http://x';
    api.token = 't';
    const onUnauthorized = vi.fn();
    api.onUnauthorized = onUnauthorized;
    stubFetch(401, unauthenticated);
    await expect(api.me()).rejects.toBeInstanceOf(ApiFailure);
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it('公共 Wi-Fi 登录页或代理返回的 401 不算', async () => {
    const api = new Api();
    api.baseUrl = 'http://x';
    api.token = 't';
    const onUnauthorized = vi.fn();
    api.onUnauthorized = onUnauthorized;
    stubFetch(401, '<html>请先登录这个 Wi-Fi</html>');
    await expect(api.me()).rejects.toBeInstanceOf(ApiFailure);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('旧令牌的响应晚到，不能踢掉刚登录的新会话', async () => {
    const api = new Api();
    api.baseUrl = 'http://x';
    api.token = 'old';
    const onUnauthorized = vi.fn();
    api.onUnauthorized = onUnauthorized;
    let respond: (r: Response) => void = () => {};
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((resolve) => (respond = resolve))),
    );
    const pending = api.me();
    api.token = 'new';
    respond(new Response(unauthenticated, { status: 401 }));
    await expect(pending).rejects.toBeInstanceOf(ApiFailure);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});

describe('什么时候清除本地数据', () => {
  it('同一个人在同一个家庭重新登录：保留未同步的记录', () => {
    expect(shouldClearLocalData('u1/f1', sessionOwner('u1', 'f1'))).toBe(false);
  });
  it('换了账号：必须清除', () => {
    expect(shouldClearLocalData('u1/f1', sessionOwner('u2', 'f1'))).toBe(true);
  });
  it('同一账号换了家庭（被移出后加入别家）：必须清除', () => {
    expect(shouldClearLocalData('u1/f1', sessionOwner('u1', 'f2'))).toBe(true);
    expect(shouldClearLocalData('u1/f1', sessionOwner('u1', null))).toBe(true);
  });
  it('第一次登录：没有东西要清', () => {
    expect(shouldClearLocalData(null, sessionOwner('u1', 'f1'))).toBe(false);
  });
});

describe('Supabase 请求区域', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('构建时指定新加坡后，只给 Supabase 函数请求附加区域标头', async () => {
    vi.stubEnv('EXPO_PUBLIC_API_REGION', 'ap-southeast-1');
    const fetcher = vi.fn(async (_url: string, _options?: RequestInit) => new Response('{}'));
    vi.stubGlobal('fetch', fetcher);
    const api = new Api();

    api.baseUrl = 'https://example.supabase.co/functions/v1/api';
    await api.me();
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({ 'x-region': 'ap-southeast-1' });

    api.baseUrl = 'https://baby.example.com';
    await api.me();
    expect(fetcher.mock.calls[1]?.[1]?.headers).not.toHaveProperty('x-region');
  });
});
