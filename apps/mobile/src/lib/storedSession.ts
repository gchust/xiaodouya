import type { MeResponse } from '@xiaodouya/shared';
import * as SecureStore from 'expo-secure-store';
import { z } from 'zod';

export const TOKEN_KEY = 'session.token';
export const SERVER_KEY = 'session.server';
export const ME_KEY = 'session.me';
export const OWNER_KEY = 'session.owner';

/** 后台任务只用到这几项，别的字段变了也不影响它。 */
const StoredMe = z.looseObject({
  family: z.looseObject({ id: z.string() }).nullish(),
  role: z.string().nullish(),
  label: z.string().nullish(),
  user: z.looseObject({ displayName: z.string() }),
  prefs: z.looseObject({}).optional(),
});

export interface StoredSession {
  token: string | null;
  serverUrl: string | null;
  me: MeResponse | null;
}

/** 读不出来（比如存储内容损坏）就当没登录：小工具宁可让人点开 App，也不能乱写数据。 */
export async function readStoredSession(): Promise<StoredSession> {
  try {
    const [token, serverUrl, savedMe] = await Promise.all([
      SecureStore.getItemAsync(TOKEN_KEY),
      SecureStore.getItemAsync(SERVER_KEY),
      SecureStore.getItemAsync(ME_KEY),
    ]);
    const parsed = savedMe ? StoredMe.safeParse(JSON.parse(savedMe)) : null;
    return {
      token,
      serverUrl,
      me: parsed?.success ? (parsed.data as unknown as MeResponse) : null,
    };
  } catch {
    return { token: null, serverUrl: null, me: null };
  }
}
