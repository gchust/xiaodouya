/** 这里不依赖任何东西：schemas 和 App 的启动代码都要用。 */
export const locales = ['zh', 'en'] as const;
export type Locale = (typeof locales)[number];

/** 语言标签换成目录语言：`zh*` 用中文，其他一律英文。没有标签时返回 null，由调用方决定。 */
export function localeFromTag(tag: string | null | undefined): Locale | null {
  const trimmed = tag?.trim().toLowerCase();
  if (!trimmed) return null;
  return trimmed === 'zh' || trimmed.startsWith('zh-') || trimmed.startsWith('zh_') ? 'zh' : 'en';
}

/**
 * 界面用哪种语言。用户选过的优先，否则跟随手机。
 * E2E 构建没选过时固定中文：CI 模拟器是 en-US，跟随系统的话所有 Maestro 流程都找不到文字。
 */
export function resolveLocale(
  preference: Locale | undefined,
  deviceTag: string | null | undefined,
  isE2E = false,
): Locale {
  if (preference) return preference;
  if (isE2E) return 'zh';
  return localeFromTag(deviceTag) ?? 'en';
}

/**
 * `Accept-Language` 的第一个语言。App 只发一个；浏览器式的列表取排在最前的，不按 q 值比较。
 * 没有或读不出来时返回 null，邮件再退回中文（v0.1.0 不发这个头，只懂中文）。
 */
export function localeFromAcceptLanguage(header: string | null | undefined): Locale | null {
  const first = header?.split(',')[0]?.split(';')[0]?.trim();
  if (!first || first === '*') return null;
  return localeFromTag(first);
}
