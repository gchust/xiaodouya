import type {
  AuthResponse,
  CreateFeedbackRequest,
  CreateFeedbackResponse,
  CreateMomentsShareRequest,
  CreateShareRequest,
  CreateShareResponse,
  CreateTimelineShareRequest,
  FamilyExport,
  FeedbackAttachmentUrlResponse,
  FeedbackInboxItem,
  FeedbackInboxResponse,
  FeedbackListResponse,
  FeedbackStatus,
  MediaUrlsResponse,
  MediaVariant,
  MeResponse,
  MultipartPartsResponse,
  MultipartPartUrlsRequest,
  MultipartPartUrlsResponse,
  MultipartRef,
  MultipartStartRequest,
  MultipartStartResponse,
  Prefs,
  PublicConfig,
  Role,
  SendEmailCodeResponse,
  ShareListResponse,
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
  type AppUpdateInfo,
  AppUpdateResponse,
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
          // Android 的 OkHttp 会把 GET 响应存进 cache/http-cache。请求上也写明不存：
          // 自己部署的旧服务端没有 `no-store` 时，`/v1/me` 也不会落到手机上（F-135）。
          'cache-control': 'no-store',
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
  /** 响应里的链接和哈希要交给下载和校验，先过 zod。格式不对和查不到一样当失败。 */
  async appUpdate(versionCode: number): Promise<AppUpdateInfo | null> {
    const json = await this.request<unknown>(
      'GET',
      `/v1/app/update?platform=android&versionCode=${versionCode}`,
    );
    const parsed = AppUpdateResponse.safeParse(json);
    if (!parsed.success) throw new ApiFailure(502, 'invalid_response', t().update.failedCheck);
    return parsed.data.update;
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
  multipartStart(body: MultipartStartRequest) {
    return this.request<MultipartStartResponse>('POST', '/v1/media/multipart', body);
  }
  multipartParts(id: string, body: MultipartRef) {
    return this.request<MultipartPartsResponse>('POST', `/v1/media/${id}/multipart/parts`, body);
  }
  multipartPartUrls(id: string, body: MultipartPartUrlsRequest) {
    return this.request<MultipartPartUrlsResponse>(
      'POST',
      `/v1/media/${id}/multipart/part-urls`,
      body,
    );
  }
  async multipartComplete(id: string, body: MultipartRef) {
    await this.request('POST', `/v1/media/${id}/multipart/complete`, body);
  }
  async cancelUpload(id: string) {
    await this.request('POST', `/v1/media/${id}/cancel`, {});
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
  createShare(body: CreateShareRequest) {
    return this.request<CreateShareResponse>('POST', '/v1/shares', body);
  }
  createTimelineShare(body: CreateTimelineShareRequest) {
    return this.request<CreateShareResponse>('POST', '/v1/shares/timeline', body);
  }
  createMomentsShare(body: CreateMomentsShareRequest) {
    return this.request<CreateShareResponse>('POST', '/v1/shares/moments', body);
  }
  listShares() {
    return this.request<ShareListResponse>('GET', '/v1/shares');
  }
  revokeShare(id: string) {
    return this.request('DELETE', `/v1/shares/${id}`);
  }
  publicConfig() {
    return this.request<PublicConfig>('GET', '/v1/config');
  }
  createFeedback(body: CreateFeedbackRequest) {
    return this.request<CreateFeedbackResponse>('POST', '/v1/feedback', body);
  }
  submitFeedback(id: string) {
    return this.request<{ id: string; status: FeedbackStatus }>(
      'POST',
      `/v1/feedback/${id}/submit`,
      {},
    );
  }
  listFeedback() {
    return this.request<FeedbackListResponse>('GET', '/v1/feedback');
  }
  /** 收到的反馈：只有服务端名单里的账号能用，其他人 403。 */
  feedbackInbox(before?: string | null) {
    const query = before ? `?before=${encodeURIComponent(before)}` : '';
    return this.request<FeedbackInboxResponse>('GET', `/v1/feedback-inbox${query}`);
  }
  feedbackInboxItem(id: string) {
    return this.request<FeedbackInboxItem>('GET', `/v1/feedback-inbox/${id}`);
  }
  /** 每次打开、每次下载都现取，10 分钟有效，不缓存。 */
  feedbackAttachmentUrl(id: string, attachmentId: string) {
    return this.request<FeedbackAttachmentUrlResponse>(
      'GET',
      `/v1/feedback-inbox/${id}/attachments/${attachmentId}`,
    );
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
