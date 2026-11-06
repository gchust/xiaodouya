import type { ShareReceiver } from '@xiaodouya/shared';
import { requireOptionalNativeModule } from 'expo-modules-core';

interface NativeShareTargets {
  readonly packageName: string;
  receivers(): Promise<ShareReceiver[]>;
  defaultSmsPackage(): string | null;
  icon(packageName: string, size: number): Promise<string | null>;
  sendText(packageName: string, text: string): Promise<boolean>;
  /** 系统分享面板，去掉小豆芽自己。打不开时是 false。 */
  shareSheet(text: string): Promise<boolean>;
  copyText(text: string): Promise<void>;
}

/** iOS 上没有这个模块（`platforms` 只写了 android），调用方拿到 null 就用系统分享面板。 */
export const ShareTargetsNative = requireOptionalNativeModule<NativeShareTargets>('ShareTargets');
