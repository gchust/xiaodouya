import { getCalendars, getLocales } from 'expo-localization';

/** 系统设置里的地区代码，比如 SG。只用来猜建档时的默认地区，用户可以改。 */
export function deviceRegionCode(): string | null {
  return getLocales()[0]?.regionCode ?? null;
}

export function deviceTimezone(): string | null {
  return getCalendars()[0]?.timeZone ?? null;
}
