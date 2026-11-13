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
// 启动时原生层还没被改过，读到的是手机自己的深浅。
let appliedSystem = systemScheme();
let state = build(pref, appliedSystem);
applyPalette(state.palette);
const listeners = new Set<() => void>();

/**
 * App 里固定了浅色或深色时，原生层也固定成同一种（issue #105）。系统的日期和时间选择框、
 * 对话框、导航栏按钮是原生画的，只看原生层的深浅：不固定的话，手机是浅色、App 固定深色时，
 * 半夜点“更早”会弹出一整块白色的选择框。Android 上它改的是 AppCompat 的夜间模式，
 * MainActivity 自己处理 uiMode 变化，不会重建界面。
 */
let forced: Scheme | null = null;
/**
 * 原生层固定着深浅时读不到手机自己的设置（getColorScheme 读到的是固定的值），
 * 撤掉固定后原生层要过一会儿才报出手机的深浅。这段时间里的变化是刚选“跟随手机”带来的，
 * 在前台也马上跟上，不等退到后台。
 */
let followUntil = 0;
const FOLLOW_MS = 3000;

function applyNative(appearance: ThemePref['appearance']) {
  const target = appearance === 'system' ? null : appearance;
  if (target === forced) return;
  forced = target;
  if (target === null) followUntil = Date.now() + FOLLOW_MS;
  Appearance.setColorScheme(target ?? 'unspecified');
}
applyNative(pref.appearance);

/**
 * 冷启动时上面那次固定在 Android 上没有生效：界面是深色，系统的时刻选择框还是浅色
 * （CI 流程 18b 杀掉 App 再打开后的截图）。界面出来以后再固定一次。
 * 原生层记着同一个值时再设一次什么都不做，所以先交还给系统再固定。
 */
export function reapplyNativeScheme(): void {
  if (forced === null) return;
  Appearance.setColorScheme('unspecified');
  Appearance.setColorScheme(forced);
}

function update(nextPref: ThemePref, nextSystem: Scheme) {
  pref = nextPref;
  appliedSystem = nextSystem;
  const next = build(pref, appliedSystem);
  if (next.key === state.key && next.pref === state.pref) return;
  state = next;
  for (const listener of listeners) listener();
}

/** 手机自己的深浅。原生层固定着时读不到，用最后一次知道的。 */
function phoneScheme(): Scheme {
  return forced === null ? systemScheme() : appliedSystem;
}

// 手机切换深色（比如定时在 22:00 切换）时，换主题要重新挂载界面，正在填的弹层会关掉。
// 所以 App 在前台时先不换，等它退到后台或者下次回到前台再跟上。
Appearance.addChangeListener(() => {
  // 原生层固定着时，这里的变化是固定本身带来的，不是手机换了深浅。
  if (forced !== null) return;
  if (AppState.currentState !== 'active' || Date.now() < followUntil) {
    update(pref, systemScheme());
  }
});
AppState.addEventListener('change', () => update(pref, phoneScheme()));

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 当前的主题，组件外用（测试）。 */
export function currentTheme(): ThemeState {
  return state;
}

/** 当前的主题。顺便把调色板写进 `colors`：子组件渲染时直接读它。 */
export function useTheme(): ThemeState {
  const current = useSyncExternalStore(subscribe, () => state);
  applyPalette(current.palette);
  return current;
}

export function setThemePref(next: ThemePref): void {
  applyNative(next.appearance);
  update(next, appliedSystem);
  try {
    prefFile().writeSync(JSON.stringify(next));
  } catch {
    // 写不进去只是下次启动回到原来的配色，这次已经生效。
    console.warn('saving theme failed');
  }
}
