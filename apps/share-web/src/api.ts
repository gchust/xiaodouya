import {
  PublicShareResponse,
  PublicTimelineMomentResponse,
  PublicTimelineResponse,
} from '@xiaodouya/shared';
import type { z } from 'zod';

export interface ApiTarget {
  url: string;
  region: string;
}

export type Loaded<T> =
  | { kind: 'ok'; data: T }
  | { kind: 'invalid' }
  | { kind: 'busy' }
  | { kind: 'error' };

export type LoadResult = Loaded<PublicShareResponse>;

const TIMEOUT_MS = 20_000;
/** 和 App 一样只给 Supabase 函数发地区头。Edge Function 默认就近执行，不一定和数据库在同一个地区。 */
const SUPABASE_FUNCTION_URL = /^https:\/\/[a-z0-9-]+\.supabase\.co\/functions\/v1\//;

/** 三个公开接口都是 POST JSON，令牌在请求体里，不带凭据和 Referer。 */
async function post<T>(
  api: ApiTarget,
  path: string,
  body: Record<string, string>,
  schema: z.ZodType<T>,
  fetcher: typeof fetch,
): Promise<Loaded<T>> {
  const base = api.url.replace(/\/$/, '');
  let response: Response;
  try {
    response = await fetcher(`${base}${path}`, {
      method: 'POST',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        'content-type': 'application/json',
        ...(api.region && SUPABASE_FUNCTION_URL.test(`${base}/`) ? { 'x-region': api.region } : {}),
      },
      body: JSON.stringify(body),
    });
  } catch {
    return { kind: 'error' };
  }
  if (response.status === 429) return { kind: 'busy' };
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return { kind: 'error' };
  }
  if (response.status === 404) {
    // 只信接口明确的回答：公共 Wi-Fi 的登录页、还没部署的后端也可能是 404，
    // 这时告诉对方“链接已撤销”是错的。
    const code = (json as { error?: { code?: unknown } } | null)?.error?.code;
    return code === 'share_unavailable' ? { kind: 'invalid' } : { kind: 'error' };
  }
  if (!response.ok) return { kind: 'error' };
  const parsed = schema.safeParse(json);
  return parsed.success ? { kind: 'ok', data: parsed.data } : { kind: 'error' };
}

export function loadShare(
  api: ApiTarget,
  token: string,
  fetcher: typeof fetch = fetch,
): Promise<LoadResult> {
  return post(api, '/v1/public/share', { token }, PublicShareResponse, fetcher);
}

/** 时间线的一页。没有游标是第一页（最新的）。 */
export function loadTimelinePage(
  api: ApiTarget,
  token: string,
  cursor: string | undefined,
  fetcher: typeof fetch = fetch,
): Promise<Loaded<PublicTimelineResponse>> {
  return post(
    api,
    '/v1/public/share/timeline',
    cursor === undefined ? { token } : { token, cursor },
    PublicTimelineResponse,
    fetcher,
  );
}

/** 点开时间线上的一条回忆，取它的全部文件。 */
export function loadTimelineMoment(
  api: ApiTarget,
  token: string,
  momentId: string,
  fetcher: typeof fetch = fetch,
): Promise<Loaded<PublicTimelineMomentResponse>> {
  return post(
    api,
    '/v1/public/share/timeline/moment',
    { token, momentId },
    PublicTimelineMomentResponse,
    fetcher,
  );
}
