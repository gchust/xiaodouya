import { formatBytes } from '../domain/age';
import { getLocale } from '.';

export type ApiErrorParams = Record<string, string | number>;

/**
 * 服务端错误的本地文案。接口的 `message` 一直是中文（v0.1.0 直接显示它），所以中文不用查，
 * 其他语言按 `code` 查，查不到才显示 `message`。一个 `code` 对应几种说法时，服务端用 `params` 区分。
 * `scripts/check-i18n.mjs` 会核对服务端用到的每个 `code` 这里都有。
 */
const en = new Map<string, (params: ApiErrorParams) => string>(
  Object.entries({
    invalid_json: () => 'The request was not valid.',
    invalid_input: (p: ApiErrorParams) =>
      ({
        accountIdMissing: 'Please enter the Account ID.',
        accountIdBad: "The Account ID format isn't right.",
        endpointMissing: 'Please enter the Endpoint.',
        customDomainHttps: 'A custom domain must use https.',
        secretMissing: 'Please enter the Secret Access Key.',
      })[String(p.reason)] ?? `Invalid input: ${p.field ?? 'request'} ${p.detail ?? ''}`.trim(),
    internal: () => 'Something went wrong on the server. Please try again later.',
    not_found: () => 'Not found.',
    signup_closed: () =>
      'This server is not open for sign-up. You need an invite code from family.',
    invalid_invite: () => 'The invite code is invalid or has expired.',
    email_taken: () => 'This email is already registered. You can sign in.',
    bad_credentials: () => 'Incorrect email or password.',
    mail_disabled: () => "This server doesn't have email set up. Please contact whoever set it up.",
    invalid_code: () => 'The code is incorrect or has expired.',
    too_many_attempts: (p: ApiErrorParams) => {
      if (p.reason === 'signup') return 'Too many sign-ups right now. Please try again in a while.';
      if (p.reason === 'send') return 'Too many codes sent. Please try again later.';
      if (p.reason === 'export') return 'Exporting too often. Please try again later.';
      return typeof p.minutes === 'number'
        ? `Too many attempts. Please try again in ${p.minutes} minutes.`
        : 'Too many attempts. Please try again later.';
    },
    unauthenticated: (p: ApiErrorParams) =>
      p.reason === 'expired'
        ? 'Your sign-in has expired. Please sign in again.'
        : 'Please sign in first.',
    no_family: () => "You haven't joined a family yet.",
    forbidden: (p: ApiErrorParams) => {
      if (p.reason === 'viewer') return 'You can only view memories and photos.';
      if (p.reason === 'admin') return 'Only an admin can do this.';
      return "You don't have permission.";
    },
    wrong_password: () => 'Incorrect password.',
    only_admin: () =>
      "You are this family's only admin. First make another family member an admin, or remove the other members, then delete your account.",
    already_in_family: () => "You're already in a family.",
    last_admin: () => 'A family needs at least one admin.',
    too_large: (p: ApiErrorParams) =>
      typeof p.maxBytes === 'number'
        ? `The file is too large. The maximum for this type is ${formatBytes(p.maxBytes)}.`
        : 'Too much content in this sync.',
    rate_limited: () => 'Too many requests. It will retry automatically in a moment.',
    quota_exceeded: (p: ApiErrorParams) =>
      `Storage is full (${typeof p.quota === 'number' ? formatBytes(p.quota) : 'limit reached'}). Delete some memories or documents, then retry.`,
    bad_type: () => "This file type isn't supported.",
    already_uploaded: () => 'This file has already been uploaded.',
    no_storage: (p: ApiErrorParams) =>
      p.reason === 'notConfigured'
        ? 'Storage is not set up yet. Ask an admin to set it up in Family > Storage.'
        : 'Storage is not available.',
    not_uploaded: () => "The file hasn't finished uploading.",
    size_mismatch: () => "The file size doesn't match. Please upload it again.",
    custom_storage_disabled: () => "This server doesn't allow custom storage.",
    bad_endpoint: () => "This storage address can't be used.",
    storage_test_failed: (p: ApiErrorParams) =>
      storageTestReasonText(typeof p.reason === 'string' ? p.reason : undefined),
  }),
);

/** 按语言取服务端错误要显示的话。 */
export function apiErrorMessage(
  code: string,
  params: ApiErrorParams | undefined,
  serverMessage: string,
): string {
  if (getLocale() === 'zh') return serverMessage;
  return en.get(code)?.(params ?? {}) ?? serverMessage;
}

function storageTestReasonText(reason: string | undefined): string {
  switch (reason) {
    case 'ok':
      return 'Read and write OK';
    case 'noBucket':
      return "Can't find this bucket. Check the name and region.";
    case 'badKey':
      return "The key is wrong, or it doesn't have read and write access to this bucket.";
    case 'unreachable':
      return "Can't reach the storage address. Check the Endpoint or Account ID.";
    default:
      return 'Connection failed. Check that the settings are complete.';
  }
}

/** “测试连接”的结果。中文用服务端的话，别的语言按原因显示。 */
export function storageTestMessage(reason: string | undefined, serverMessage: string): string {
  return getLocale() === 'zh' ? serverMessage : storageTestReasonText(reason);
}
