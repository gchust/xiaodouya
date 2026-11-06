import { File, Paths } from 'expo-file-system';
import { useSyncExternalStore } from 'react';
import { Appearance, AppState } from 'react-native';
import { applyPalette } from '../theme';
import {
  defaultThemePref,
  type Palette,
  paletteFor,
  parseThemePref,
  resolveScheme,
  type Scheme,
  type ThemePref,
} from '../themes/palettes';

/**
 * 主题配色只存在这台手机上（F-142）：
 * - 是看的人自己的喜好，爸爸喜欢深色、妈妈喜欢薰衣草，不该同步给全家；
 * - 登录页也要用，那时还没有账号；
 * - 不是宝宝的数据，退出登录不清（SQLite 的 meta 表会随 store.clear() 清掉，所以单独放一个文件）；
 * - 启动时要在第一次渲染前同步读出来，否则会先闪一下默认配色。
 */
function prefFile(): File {
  return new File(Paths.document, 'theme.json');
}

function readPref(): ThemePref {
  try {
    const file = prefFile();
    return file.exists ? parseThemePref(file.textSync()) : defaultThemePref;
  } catch {
    return defaultThemePref;
  }
}

function systemScheme(): Scheme {
  return Appearance.getColorScheme() === 'dark' ? 'dark' : 'light';
}

export interface ThemeState {
  pref: ThemePref;
  scheme: Scheme;
  /** 主题和深浅都算上，变了界面要重新挂载。 */
  key: string;
  palette: Palette;
}

function build(pref: ThemePref, system: Scheme): ThemeState {
  const scheme = resolveScheme(pref.appearance, system);
  return { pref, scheme, key: `${pref.theme}-${scheme}`, palette: paletteFor(pref.theme, scheme) };
}

let pref = readPref();
let appliedSystem = systemScheme();
let state = build(pref, appliedSystem);
applyPalette(state.palette);
const listeners = new Set<() => void>();

function update(nextPref: ThemePref, nextSystem: Scheme) {
  pref = nextPref;
  appliedSystem = nextSystem;
  const next = build(pref, appliedSystem);
  if (next.key === state.key && next.pref === state.pref) return;
  state = next;
  for (const listener of listeners) listener();
}

// 手机切换深色（比如定时在 22:00 切换）时，换主题要重新挂载界面，正在填的弹层会关掉。
// 所以 App 在前台时先不换，等它退到后台或者下次回到前台再跟上。
Appearance.addChangeListener(() => {
  if (AppState.currentState !== 'active') update(pref, systemScheme());
});
AppState.addEventListener('change', () => update(pref, systemScheme()));

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 当前的主题。顺便把调色板写进 `colors`：子组件渲染时直接读它。 */
export function useTheme(): ThemeState {
  const current = useSyncExternalStore(subscribe, () => state);
  applyPalette(current.palette);
  return current;
}

export function setThemePref(next: ThemePref): void {
  update(next, appliedSystem);
  try {
    prefFile().writeSync(JSON.stringify(next));
  } catch {
    // 写不进去只是下次启动回到原来的配色，这次已经生效。
    console.warn('saving theme failed');
  }
}
