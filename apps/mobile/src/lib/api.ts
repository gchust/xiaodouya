import type {
  ApiError,
  AuthResponse,
  MediaUrlsResponse,
  MediaVariant,
  MeResponse,
  Prefs,
  PublicConfig,
  Role,
  StorageConfigInput,
  StorageConfigView,
  StorageTestResult,
  StorageUsage,
  SyncRequest,
  SyncResponse,
  UploadUrlRequest,
  UploadUrlResponse,
} from '@xiaodouya/shared';

export class ApiFailure extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export const NETWORK_ERROR = '连不上服务器，请检查网络或服务器地址';

const SUPABASE_FUNCTION_URL = /^https:\/\/[a-z0-9-]+\.supabase\.co\/functions\/v1\//;

/** 只有 token 和 baseUrl 是可变的，其他都是无状态的请求封装。 */
export class Api {
  baseUrl = '';
  token: string | null = null;
  onUnauthorized?: () => void;

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const tokenAtStart = this.token;
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl.replace(/\/$/, '')}${path}`, {
        method,
        signal,
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
          ...(process.env.EXPO_PUBLIC_API_REGION && SUPABASE_FUNCTION_URL.test(this.baseUrl)
            ? { 'x-region': process.env.EXPO_PUBLIC_API_REGION }
            : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new ApiFailure(0, 'network', NETWORK_ERROR);
    }
    const text = await response.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // 代理返回的 HTML 错误页之类，统一走下面的错误分支。
    }
    if (!response.ok) {
      const error = (json as ApiError | null)?.error;
      // 只认服务端明确的未登录，公共 Wi-Fi 的登录页或代理也可能返回 401。
      // 令牌已经换过的话，这是旧请求的响应，不能影响新会话。
      if (error?.code === 'unauthenticated' && tokenAtStart && tokenAtStart === this.token) {
        this.onUnauthorized?.();
      }
      throw new ApiFailure(
        response.status,
        error?.code ?? 'http_error',
        error?.message ?? `服务器返回错误（${response.status}）`,
      );
    }
    return json as T;
  }

  register(body: { email: string; password: string; displayName: string; inviteCode?: string }) {
    return this.request<AuthResponse>('POST', '/v1/auth/register', body);
  }
  login(body: { email: string; password: string }) {
    return this.request<AuthResponse>('POST', '/v1/auth/login', body);
  }
  logout() {
    return this.request('POST', '/v1/auth/logout');
  }
  me() {
    return this.request<MeResponse>('GET', '/v1/me');
  }
  updatePrefs(prefs: Prefs) {
    return this.request<Prefs>('PUT', '/v1/me/prefs', prefs);
  }
  registerPushToken(token: string, deviceId: string) {
    return this.request('POST', '/v1/me/push-token', { token, deviceId });
  }
  unregisterPushToken(deviceId: string) {
    return this.request('DELETE', `/v1/me/push-token/${encodeURIComponent(deviceId)}`);
  }
  createFamily(name: string, label: string) {
    return this.request<MeResponse>('POST', '/v1/families', { name, label });
  }
  createInvite(role: Role, label: string) {
    return this.request<{ id: string; code: string; expiresAt: number }>('POST', '/v1/invites', {
      role,
      label,
    });
  }
  deleteInvite(id: string) {
    return this.request('DELETE', `/v1/invites/${id}`);
  }
  acceptInvite(code: string) {
    return this.request<MeResponse>('POST', '/v1/invites/accept', { code });
  }
  updateMember(userId: string, body: { role?: Role; label?: string }) {
    return this.request('PATCH', `/v1/family/members/${userId}`, body);
  }
  removeMember(userId: string) {
    return this.request('DELETE', `/v1/family/members/${userId}`);
  }
  sync(body: SyncRequest) {
    return this.request<SyncResponse>('POST', '/v1/sync', body);
  }
  syncWait(cursor: number, signal: AbortSignal) {
    return this.request<{ changed: boolean }>(
      'GET',
      `/v1/sync/wait?cursor=${cursor}`,
      undefined,
      signal,
    );
  }
  uploadUrl(body: UploadUrlRequest) {
    return this.request<UploadUrlResponse>('POST', '/v1/media/upload-url', body);
  }
  completeUpload(id: string, variant: MediaVariant) {
    return this.request('POST', `/v1/media/${id}/complete`, { variant });
  }
  mediaUrls(items: { id: string; variant: MediaVariant }[]) {
    return this.request<MediaUrlsResponse>('POST', '/v1/media/urls', { items });
  }
  getStorage() {
    return this.request<StorageConfigView>('GET', '/v1/storage');
  }
  testStorage(body: StorageConfigInput) {
    return this.request<StorageTestResult>('POST', '/v1/storage/test', body);
  }
  saveStorage(body: StorageConfigInput) {
    return this.request<StorageConfigView>('PUT', '/v1/storage', body);
  }
  storageUsage() {
    return this.request<StorageUsage>('GET', '/v1/storage/usage');
  }
  publicConfig() {
    return this.request<PublicConfig>('GET', '/v1/config');
  }
  /**
   * 连不上时抛错，不猜：猜“允许”会给普通用户看 S3 表单，猜“不允许”会让自建的管理员改不了配置。
   * 只有明确的 404 才当作允许，那是还没有这个接口的旧版服务端，当时都能自定义。
   */
  async allowCustomStorage(): Promise<boolean> {
    try {
      return (await this.publicConfig()).allowCustomStorage !== false;
    } catch (error) {
      if (error instanceof ApiFailure && error.status === 404) return true;
      throw error;
    }
  }
}
