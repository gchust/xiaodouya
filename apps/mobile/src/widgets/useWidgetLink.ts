import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef } from 'react';
import { AppState, Linking } from 'react-native';
import { clearLinkInbox, subscribeLinkInbox } from './linkInbox';
import { linkFromParams, linkKey, parseWidgetLink, type WidgetLink } from './links';

/** 同一次点击可能从几条路同时进来（见下面的注释），这么短的时间内只处理一次。 */
const DUPLICATE_WINDOW_MS = 3_000;
let lastHandled = { key: '', at: 0 };
let consumedInitialUrl: string | null = null;

/**
 * 处理小工具点进来的链接：`?event=<id>` 打开这条记录的修改和撤销，`?sheet=feed` 打开喂奶弹层。
 *
 * 只靠 expo-router 的参数不够。系统回收进程后 Activity 记录还在，重建时链接不在初始 Intent 里，
 * 只通过 onNewIntent 送来：JS 已经被小工具的后台任务跑起来时会发一次 `url` 事件（入口文件接住），
 * 否则要等 Activity 恢复后从 `getInitialURL` 取（`with-latest-intent` 插件存下了它）。
 */
export function useWidgetLink(handlers: {
  ready: boolean;
  openEvent(id: string): void;
  openFeed(): void;
}): void {
  const { ready } = handlers;
  const latest = useRef(handlers);
  latest.current = handlers;
  const pending = useRef<WidgetLink | null>(null);
  const { event, sheet } = useLocalSearchParams<{ event?: string; sheet?: string }>();
  const router = useRouter();

  const flush = useCallback(() => {
    const link = pending.current;
    if (!link || !latest.current.ready) return;
    pending.current = null;
    const key = linkKey(link);
    const now = Date.now();
    if (lastHandled.key === key && now - lastHandled.at < DUPLICATE_WINDOW_MS) return;
    lastHandled = { key, at: now };
    if (link.kind === 'event') latest.current.openEvent(link.id);
    else latest.current.openFeed();
  }, []);

  const deliver = useCallback(
    (link: WidgetLink | null) => {
      if (!link) return;
      pending.current = link;
      flush();
    },
    [flush],
  );

  useEffect(() => {
    const checkInitial = () => {
      void Linking.getInitialURL().then((url) => {
        if (!url || url === consumedInitialUrl) return;
        consumedInitialUrl = url;
        deliver(parseWidgetLink(url));
      });
    };
    checkInitial();
    const appState = AppState.addEventListener('change', (state) => {
      if (state === 'active') checkInitial();
    });
    const unsubscribe = subscribeLinkInbox((url) => {
      clearLinkInbox();
      deliver(parseWidgetLink(url));
    });
    return () => {
      appState.remove();
      unsubscribe();
    };
  }, [deliver]);

  // 宝宝资料还没加载好时先存着。
  useEffect(() => {
    if (ready) flush();
  }, [ready, flush]);

  useEffect(() => {
    const link = linkFromParams({ event, sheet });
    if (!link) return;
    deliver(link);
    // 清掉参数，否则切回这个页面时又会弹一次。
    router.setParams({ event: undefined, sheet: undefined });
  }, [event, sheet, deliver, router]);
}
