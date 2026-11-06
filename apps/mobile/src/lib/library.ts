import { type FavoriteData, type FavoriteTarget, favoriteIdFor, t } from '@xiaodouya/shared';
import * as Clipboard from 'expo-clipboard';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { useCallback } from 'react';
import { colors } from '../theme';
import { useFeedback } from '../ui/overlays';
import { useApp, useRecords } from './app';

/**
 * 在 App 里打开资料的原页面（issue #98）。用系统的 Custom Tabs（expo-web-browser），不用 WebView：
 * 不用自己处理抖音、小红书页面里跳 App 的 `intent://`、`snssdk1128://`，全屏播放、登录状态都是浏览器的，
 * 页面里的脚本也碰不到 App。`createTask: false` 让它留在小豆芽的任务里，返回就回到资料列表。
 *
 * 没有支持 Custom Tabs 的浏览器时交给系统打开；连浏览器都没有（CI 的 AOSP 模拟器就是这样）就复制链接并说明。
 */
export async function openResourceUrl(url: string, toast: (message: string) => void) {
  try {
    await WebBrowser.openBrowserAsync(url, {
      toolbarColor: colors.card,
      secondaryToolbarColor: colors.paper,
      controlsColor: colors.accent,
      showTitle: true,
      enableBarCollapsing: true,
      createTask: false,
    });
    return;
  } catch {
    // 往下试系统打开
  }
  try {
    await Linking.openURL(url);
  } catch {
    await Clipboard.setStringAsync(url).catch(() => {});
    toast(t().library.openFailed);
  }
}

/** 收藏和取消收藏，全家共用。取消是软删除，Toast 可撤销，不用确认（和隐藏疫苗剂次一样只是个开关）。 */
export function useFavorites() {
  const app = useApp();
  const { favorites } = useRecords();
  const { toast } = useFeedback();

  const find = useCallback(
    (targetId: string) => favorites.find((f) => f.data.targetId === targetId),
    [favorites],
  );

  const toggle = useCallback(
    async (target: FavoriteTarget, targetId: string) => {
      const existing = find(targetId);
      if (existing) {
        const previous = existing.data;
        await app.remove(existing.id);
        toast(t().library.unfavorited, {
          undo: () => void app.write('event', previous, existing.id),
        });
        return;
      }
      const id = favoriteIdFor(targetId);
      const data: FavoriteData = {
        type: 'favorite',
        target,
        targetId,
        addedAt: Date.now(),
        folders: [],
        byName: app.label || undefined,
      };
      await app.write('event', data, id);
      toast(t().library.favorited, { undo: () => void app.remove(id) });
    },
    [app, find, toast],
  );

  return { find, toggle };
}
