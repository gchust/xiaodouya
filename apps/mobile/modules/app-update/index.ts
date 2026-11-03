import { requireOptionalNativeModule } from 'expo-modules-core';

interface NativeAppUpdate {
  currentVersion(): { code: number; name: string };
  canRequestPackageInstalls(): boolean;
  openInstallSettings(): void;
  sha256(fileUri: string): Promise<string>;
}

/** iOS 上没有这个模块（`platforms` 只写了 android），调用方拿到 null 就不提供应用内更新。 */
export const AppUpdateNative = requireOptionalNativeModule<NativeAppUpdate>('AppUpdate');
