import {
  MAX_SHARE_TARGETS,
  pickShareTargets,
  type ShareTargetChoice,
  type ShareTargetId,
} from '@xiaodouya/shared';
import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { ShareTargetsNative } from '../../modules/share-targets';
import { IS_E2E } from './config';

/** 弹层里的一个按钮。E2E 构建多一个 `e2e`，指向 App 自己的测试 Activity（plugins/with-e2e-share-target.js）。 */
export interface ShareTargetButton extends Omit<ShareTargetChoice, 'id'> {
  id: ShareTargetId | 'e2e';
  /** 系统的应用图标（PNG data URI），取不到时是 null，界面写名字的首字。 */
  icon: string | null;
}

/** 图标按 3 倍屏取，界面上画 44。 */
const ICON_PX = 132;

/**
 * 只有 Android 能直接发到某个 App：iOS 查不了装了什么，也不能指定发给谁（canOpenURL 要逐个声明 scheme，
 * 而且只能打开 App，不能带上文字），所以 iOS 一直是 null，界面用系统分享面板。
 * 查询失败也是空列表，不是错误：总还有“更多”和复制链接。
 */
export function useShareTargets(order: readonly ShareTargetId[]): ShareTargetButton[] | null {
  const [targets, setTargets] = useState<ShareTargetButton[] | null>(null);
  const native = Platform.OS === 'android' ? ShareTargetsNative : null;
  const key = order.join(',');

  // biome-ignore lint/correctness/useExhaustiveDependencies: key 就是 order 的内容，数组每次渲染都是新的。
  useEffect(() => {
    if (!native) return;
    let live = true;
    const load = async () => {
      const receivers = await native.receivers();
      const picked: Omit<ShareTargetButton, 'icon'>[] = pickShareTargets(order, receivers, {
        defaultSmsPackage: native.defaultSmsPackage(),
      });
      if (IS_E2E) {
        const self = receivers.find((r) => r.packageName === native.packageName);
        if (self) picked.splice(MAX_SHARE_TARGETS - 1, Infinity, { ...self, id: 'e2e' });
      }
      return Promise.all(
        picked.map(async (target) => ({
          ...target,
          icon: await native.icon(target.packageName, ICON_PX).catch(() => null),
        })),
      );
    };
    void load()
      .catch(() => [])
      .then((result) => {
        if (live) setTargets(result);
      });
    return () => {
      live = false;
    };
  }, [native, key]);

  return native ? (targets ?? null) : null;
}

/** Android 才有。 */
export const sendTextTo = (packageName: string, text: string): Promise<boolean> =>
  ShareTargetsNative?.sendText(packageName, text) ?? Promise.resolve(false);

export const copyText = (text: string): Promise<boolean> =>
  ShareTargetsNative
    ? ShareTargetsNative.copyText(text).then(
        () => true,
        () => false,
      )
    : Promise.resolve(false);

export const canSendDirectly = (): boolean =>
  Platform.OS === 'android' && ShareTargetsNative !== null;
