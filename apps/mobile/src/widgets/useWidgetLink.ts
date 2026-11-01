import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { AppState, Linking } from 'react-native';
import { linkFromParams, linkKey, parseWidgetLink, type WidgetLink } from './links';

/** 同一个链接可能从两条路进来（见下面的注释），这么短的时间内只处理一次。 */
const DUPLICATE_WINDOW_MS = 3_000;
let lastHandled = { key: '', at: 0 };
let consumedInitialUrl: string | null = null;

/**
 * 处理小工具点进来的链接：`?event=<id>` 打开这条记录的修改和撤销，`?sheet=feed` 打开喂奶弹层。
 * 打开后清掉参数，否则切回这个页面时又会弹一次。
 *
 * 小工具的后台任务可能已经把 JS 跑起来了。这时界面渲染得比 Activity 恢复还早，
 * expo-router 取初始链接时拿不到 Activity，链接就丢了。所以恢复之后再自己取一次。
 */
export function useWidgetLink(handlers: {
  ready: boolean;
  openEvent(id: string): void;
  openFeed(): void;
}): void {
  const { ready } = handlers;
  const latest = useRef(handlers);
  latest.current = handlers;
  const { event, sheet } = useLocalSearchParams<{ event?: string; sheet?: string }>();
  const router = useRouter();
  const [missed, setMissed] = useState<WidgetLink | null>(null);

  useEffect(() => {
    const check = () => {
      void Linking.getInitialURL().then((url) => {
        if (!url || url === consumedInitialUrl) return;
        consumedInitialUrl = url;
        setMissed(parseWidgetLink(url));
      });
    };
    check();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') check();
    });
    return () => sub.remove();
  }, []);

  const fromParams = linkFromParams({ event, sheet });
  const link = fromParams ?? missed;
  // link 每次渲染都是新对象，key 才代表它变了。
  const key = link ? linkKey(link) : null;
  const current = useRef({ link, hasParams: fromParams !== null });
  current.current = { link, hasParams: fromParams !== null };

  useEffect(() => {
    const { link: target, hasParams } = current.current;
    if (!ready || !target || !key) return;
    const now = Date.now();
    if (lastHandled.key !== key || now - lastHandled.at > DUPLICATE_WINDOW_MS) {
      lastHandled = { key, at: now };
      if (target.kind === 'event') latest.current.openEvent(target.id);
      else latest.current.openFeed();
    }
    setMissed(null);
    if (hasParams) router.setParams({ event: undefined, sheet: undefined });
  }, [ready, key, router]);
}
