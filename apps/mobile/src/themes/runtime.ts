// 只用类型：这个文件要能在 vitest 里加载，不能引 React Native 的代码。
import type { StyleSheet } from 'react-native';
import { defaultThemeId, type Palette, paletteFor } from './palettes';

/** StyleSheet.create 接受的对象。 */
type Styles = Parameters<typeof StyleSheet.create>[0];

/**
 * 当前主题的颜色，来源见 docs/design/SPEC.md“主题配色”。不要在页面里写新的颜色
 * （`scripts/check-colors.mjs` 会拦下来）。
 *
 * 渲染时读。换主题或深浅时 `applyPalette` 原地改这个对象，AppProvider 随后让整棵界面重新挂载，
 * 和换语言一样（逐个组件订阅主题容易漏）。所以不能在模块顶层读它，样式表用 `themedStyles`。
 */
export const colors: Palette = { ...paletteFor(defaultThemeId, 'light') };

let version = 0;

export function applyPalette(next: Palette): void {
  const changed = (Object.keys(next) as (keyof Palette)[]).some((key) => colors[key] !== next[key]);
  if (!changed) return;
  Object.assign(colors, next);
  version += 1;
}

/**
 * 写在模块顶层的样式表：`const s = themedStyles(() => ({...}))`，代替 `StyleSheet.create({...})`。
 * 读 `s.card` 时按当前主题生成（每个主题只生成一次），用法和原来的 StyleSheet 对象一样。
 * 类型和 StyleSheet.create 一样：RN 0.88 的 StyleSheet.create 原样返回传入的对象，这里不用再调它。
 */
export function themedStyles<T extends Styles>(factory: () => T & Styles): Readonly<T> {
  let cached: T | null = null;
  let builtAt = -1;
  const current = (): T => {
    if (cached === null || builtAt !== version) {
      cached = factory();
      builtAt = version;
    }
    return cached;
  };
  return new Proxy({} as T, {
    get: (_target, key) => Reflect.get(current(), key),
    has: (_target, key) => Reflect.has(current(), key),
    ownKeys: () => Reflect.ownKeys(current()),
    getOwnPropertyDescriptor: (_target, key) => {
      const descriptor = Reflect.getOwnPropertyDescriptor(current(), key);
      return descriptor ? { ...descriptor, configurable: true } : undefined;
    },
  });
}
