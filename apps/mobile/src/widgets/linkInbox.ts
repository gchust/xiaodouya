import { Linking } from 'react-native';

type Listener = (url: string) => void;

let latest: string | null = null;
const listeners = new Set<Listener>();

/**
 * 后台任务已经把 JS 跑起来时，Activity 重建送来的链接只会发一次 `url` 事件，
 * 这时界面和 expo-router 都还没开始监听。所以在入口文件就接住，等今天页挂载后再取。
 */
export function startLinkInbox(): void {
  Linking.addEventListener('url', ({ url }) => {
    latest = url;
    for (const listener of listeners) listener(url);
  });
}

/** 取走还没处理的链接，同时订阅之后到达的。 */
export function subscribeLinkInbox(listener: Listener): () => void {
  if (latest) listener(latest);
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function clearLinkInbox(): void {
  latest = null;
}
