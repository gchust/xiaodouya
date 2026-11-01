import { useEffect, useRef } from 'react';
import type { ScrollViewInstance } from 'react-native';

const targets = new Map<string, () => void>();

/**
 * 切换底部标签时回到顶部。不用 useFocusEffect：
 * 它在从证件详情页返回时也会触发，返回后列表就跳走了。
 */
export function useTabScrollRef(route: string) {
  const ref = useRef<ScrollViewInstance>(null);
  useEffect(() => {
    targets.set(route, () => ref.current?.scrollTo({ y: 0, animated: false }));
    return () => {
      targets.delete(route);
    };
  }, [route]);
  return ref;
}

export function scrollTabToTop(route: string): void {
  targets.get(route)?.();
}
