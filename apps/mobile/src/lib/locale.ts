import { type Locale, resolveLocale, setLocale } from '@xiaodouya/shared';
import { getLocales } from 'expo-localization';
import { IS_E2E } from './config';

/** 系统语言，比如 zh-Hans-SG。每次都重新读，用户可能在 App 开着时改系统语言。 */
export function deviceLanguageTag(): string | null {
  return getLocales()[0]?.languageTag ?? null;
}

/**
 * 按偏好定下当前语言。界面在 AppProvider 里调用；小工具的后台任务可能在 App 没开时被拉起，
 * 那里没有 AppProvider，要自己调用一次。
 */
export function applyLocale(
  preference: Locale | undefined,
  deviceTag = deviceLanguageTag(),
): Locale {
  const locale = resolveLocale(preference, deviceTag, IS_E2E);
  setLocale(locale);
  return locale;
}
