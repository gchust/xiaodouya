/** 账号相关的纯逻辑。不依赖 React Native，便于测试。 */
import type { MeResponse } from '@xiaodouya/shared';
import { accountText } from './accountText';

/**
 * 只在还没有家庭时引导验证，而且可以跳过：邮件服务出问题、邮箱填错时不能把人关在外面。
 * 已经有家庭的老账号到「家人 → 设置」里验证。
 * 严格比较 false：从 v0.1.0 升级时缓存的身份没有这个字段，不能因此多出一步。
 */
export function shouldOfferVerifyStep(me: MeResponse, skippedUserId: string | null): boolean {
  return me.emailVerified === false && !me.family && skippedUserId !== me.user.id;
}

export interface ConsentSegment {
  text: string;
  url?: string;
  testID?: string;
}

/** 没有地址的文件不提：不能让人同意一份打不开的文件。 */
export function consentSegments(
  termsUrl: string | null,
  privacyUrl: string | null,
): ConsentSegment[] | null {
  const links: ConsentSegment[] = [];
  if (termsUrl) {
    links.push({ text: accountText.consentTerms, url: termsUrl, testID: 'consent-terms' });
  }
  if (privacyUrl) {
    links.push({ text: accountText.consentPrivacy, url: privacyUrl, testID: 'consent-privacy' });
  }
  const [first, second] = links;
  if (!first) return null;
  return second
    ? [{ text: accountText.consentPrefix }, first, { text: accountText.consentAnd }, second]
    : [{ text: accountText.consentPrefix }, first];
}

export function exportFileName(now: Date): string {
  return `xiaodouya-export-${now.toISOString().slice(0, 10).replaceAll('-', '')}.json`;
}

/** 缓存根目录下放用户文件副本的目录。图片库自己的缓存目录由 Image.clearDiskCache 处理，不能直接删。 */
const PERSONAL_CACHE_DIRECTORIES = new Set(['ImagePicker', 'DocumentPicker', 'Print']);

export function isPersonalCacheDirectory(name: string): boolean {
  return PERSONAL_CACHE_DIRECTORIES.has(name);
}
