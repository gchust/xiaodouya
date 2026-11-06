import { type EventSubscription, requireOptionalNativeModule } from 'expo-modules-core';

export interface SharedText {
  text: string;
  subject?: string | null;
}

interface NativeShareIntent {
  /** 取出还没处理的分享，取过就清掉。没有时是 null。 */
  take(): SharedText | null;
  addListener(name: 'onShare', listener: () => void): EventSubscription;
}

/** iOS 上没有这个模块（`platforms` 只写了 android），拿到 null 就只能粘贴链接。 */
export const ShareIntentNative = requireOptionalNativeModule<NativeShareIntent>('ShareIntent');
