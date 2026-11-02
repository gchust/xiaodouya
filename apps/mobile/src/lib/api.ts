import type {
  AuthResponse,
  FamilyExport,
  MediaUrlsResponse,
  MediaVariant,
  MeResponse,
  Prefs,
  PublicConfig,
  Role,
  SendEmailCodeResponse,
  StorageConfigInput,
  StorageConfigView,
  StorageTestResult,
  StorageUsage,
  SyncRequest,
  SyncResponse,
  UploadUrlRequest,
  UploadUrlResponse,
} from '@xiaodouya/shared';
import {
  type ApiError,
  type ApiErrorParams,
  apiErrorMessage,
  getLocale,
  t,
} from '@xiaodouya/shared';

export class ApiFailure extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    params?: ApiErrorParams,
  ) {
    // 所有界面都直接显示 error.message，所以在这里换成当前语言。
    super(apiErrorMessage(code, params, message));
  }
}

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
          // 让服务端知道发验证码邮件用什么语言：注册和找回密码时还没有偏好。
          'accept-language': getLocale(),
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
      throw new ApiFailure(0, 'network', t().ui.networkError);
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
        error?.message ?? t().ui.serverError(response.status),
        error?.params,
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
  /** 旧服务器没有这个接口或字段、或者连不上时，都当作没开邮件。登录页不能因此出错。 */
  async passwordResetEnabled(): Promise<boolean> {
    try {
      return (await this.publicConfig()).passwordReset === true;
    } catch {
      return false;
    }
  }
  forgotPassword(email: string) {
    return this.request('POST', '/v1/auth/password/forgot', { email });
  }
  resetPassword(body: { email: string; code: string; newPassword: string }) {
    return this.request('POST', '/v1/auth/password/reset', body);
  }
  sendEmailCode() {
    return this.request<SendEmailCodeResponse>('POST', '/v1/me/email/send-code');
  }
  verifyEmail(code: string) {
    return this.request<MeResponse>('POST', '/v1/me/email/verify', { code });
  }
  deleteAccount(password: string) {
    return this.request('POST', '/v1/me/delete', { password });
  }
  exportFamily() {
    return this.request<FamilyExport>('GET', '/v1/family/export');
  }
  me() {
    return this.request<MeResponse>('GET', '/v1/me');
  }
  updatePrefs(prefs: Prefs) {
    return this.request<Prefs>('PUT', '/v1/me/prefs', prefs);
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
