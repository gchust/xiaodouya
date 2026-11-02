import { PublicShareResponse } from '@xiaodouya/shared';

export interface ApiTarget {
  url: string;
  region: string;
}

export type LoadResult =
  | { kind: 'ok'; data: PublicShareResponse }
  | { kind: 'invalid' }
  | { kind: 'busy' }
  | { kind: 'error' };

const TIMEOUT_MS = 20_000;
/** 和 App 一样只给 Supabase 函数发地区头。Edge Function 默认就近执行，不一定和数据库在同一个地区。 */
const SUPABASE_FUNCTION_URL = /^https:\/\/[a-z0-9-]+\.supabase\.co\/functions\/v1\//;

export async function loadShare(
  api: ApiTarget,
  token: string,
  fetcher: typeof fetch = fetch,
): Promise<LoadResult> {
  const base = api.url.replace(/\/$/, '');
  let response: Response;
  try {
    response = await fetcher(`${base}/v1/public/share`, {
      method: 'POST',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        'content-type': 'application/json',
        ...(api.region && SUPABASE_FUNCTION_URL.test(`${base}/`) ? { 'x-region': api.region } : {}),
      },
      body: JSON.stringify({ token }),
    });
  } catch {
    return { kind: 'error' };
  }
  if (response.status === 429) return { kind: 'busy' };
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { kind: 'error' };
  }
  if (response.status === 404) {
    // 只信接口明确的回答：公共 Wi-Fi 的登录页、还没部署的后端也可能是 404，
    // 这时告诉对方“链接已撤销”是错的。
    const code = (body as { error?: { code?: unknown } } | null)?.error?.code;
    return code === 'share_unavailable' ? { kind: 'invalid' } : { kind: 'error' };
  }
  if (!response.ok) return { kind: 'error' };
  const parsed = PublicShareResponse.safeParse(body);
  return parsed.success ? { kind: 'ok', data: parsed.data } : { kind: 'error' };
}
