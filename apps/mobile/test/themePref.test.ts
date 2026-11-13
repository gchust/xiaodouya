import { beforeEach, describe, expect, it, vi } from 'vitest';

// 模拟原生层：Android 上 Appearance.setColorScheme 改的是 AppCompat 的夜间模式，配置变化之后
// 才发 appearanceChanged；在这之前 getColorScheme 读到的还是旧值（RN 的 AppearanceModule）。
const native = vi.hoisted(() => ({
  phone: 'light' as 'light' | 'dark',
  forced: null as 'light' | 'dark' | null,
  reported: 'light' as 'light' | 'dark',
  appState: 'active' as string,
  file: null as string | null,
  calls: [] as string[],
  appearanceListeners: [] as ((p: { colorScheme: string }) => void)[],
  appStateListeners: [] as (() => void)[],
}));

/** 原生层把配置变化发给 JS（真机上是 setColorScheme 之后几十毫秒，或者手机自己切换深浅）。 */
function nativeConfigChanged() {
  const next = native.forced ?? native.phone;
  if (next === native.reported) return;
  native.reported = next;
  for (const listener of native.appearanceListeners) listener({ colorScheme: next });
}

vi.mock('react-native', () => ({
  Appearance: {
    getColorScheme: () => native.reported,
    setColorScheme: (scheme: string) => {
      native.calls.push(scheme);
      native.forced = scheme === 'light' || scheme === 'dark' ? scheme : null;
    },
    addChangeListener: (listener: (p: { colorScheme: string }) => void) => {
      native.appearanceListeners.push(listener);
      return { remove: () => {} };
    },
  },
  AppState: {
    get currentState() {
      return native.appState;
    },
    addEventListener: (_type: string, listener: () => void) => {
      native.appStateListeners.push(listener);
      return { remove: () => {} };
    },
  },
}));

vi.mock('expo-file-system', () => ({
  Paths: { document: '/doc' },
  File: class {
    get exists() {
      return native.file !== null;
    }
    textSync() {
      return native.file ?? '';
    }
    writeSync(text: string) {
      native.file = text;
    }
  },
}));

// theme.ts 引了 Reanimated，这里只要调色板。
vi.mock('../src/theme', async () => import('../src/themes/runtime'));

type ThemePrefModule = typeof import('../src/lib/themePref');

async function launch(opts: { phone: 'light' | 'dark'; saved?: object }): Promise<ThemePrefModule> {
  vi.resetModules();
  native.phone = opts.phone;
  native.forced = null;
  native.reported = opts.phone;
  native.appState = 'active';
  native.file = opts.saved ? JSON.stringify(opts.saved) : null;
  native.calls = [];
  native.appearanceListeners = [];
  native.appStateListeners = [];
  const mod = await import('../src/lib/themePref');
  nativeConfigChanged();
  return mod;
}

/** 当前生效的深浅（不渲染组件，直接读 useTheme 用的那份状态）。 */
function scheme(mod: ThemePrefModule): string {
  return mod.currentTheme().scheme;
}

describe('系统的日期时间选择框、对话框跟着 App 里固定的深浅（issue #105）', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('启动时固定了深色：原生层也切到深色，手机还是浅色', async () => {
    const mod = await launch({ phone: 'light', saved: { theme: 'paper', appearance: 'dark' } });
    expect(native.calls).toEqual(['dark']);
    expect(scheme(mod)).toBe('dark');
  });

  it('跟随手机时不改原生层', async () => {
    const mod = await launch({ phone: 'dark' });
    expect(native.calls).toEqual([]);
    expect(scheme(mod)).toBe('dark');
  });

  it('在 App 里选浅色、深色：原生层跟着换', async () => {
    const mod = await launch({ phone: 'light' });
    mod.setThemePref({ theme: 'paper', appearance: 'dark' });
    expect(native.calls).toEqual(['dark']);
    expect(scheme(mod)).toBe('dark');
    nativeConfigChanged();
    mod.setThemePref({ theme: 'paper', appearance: 'light' });
    expect(native.calls).toEqual(['dark', 'light']);
    expect(scheme(mod)).toBe('light');
  });

  it('只换配色不重复设置原生层', async () => {
    const mod = await launch({ phone: 'light', saved: { theme: 'paper', appearance: 'dark' } });
    mod.setThemePref({ theme: 'lavender', appearance: 'dark' });
    expect(native.calls).toEqual(['dark']);
  });

  it('从固定深色换回跟随手机：用手机自己的浅色，不被原生层还没撤掉的深色骗到', async () => {
    const mod = await launch({ phone: 'light', saved: { theme: 'paper', appearance: 'dark' } });
    // 原生层已经是深色，getColorScheme 读到的是 dark。
    expect(native.reported).toBe('dark');
    mod.setThemePref({ theme: 'paper', appearance: 'system' });
    expect(native.calls).toEqual(['dark', 'unspecified']);
    expect(scheme(mod)).toBe('light');
    nativeConfigChanged();
    expect(scheme(mod)).toBe('light');
  });

  it('固定深色期间手机换成了深色，换回跟随手机后在前台也马上跟上', async () => {
    const mod = await launch({ phone: 'light', saved: { theme: 'paper', appearance: 'dark' } });
    // 原生层强制深色时，手机自己切换深浅不会发事件，JS 也读不到手机的设置。
    native.phone = 'dark';
    native.appState = 'background';
    for (const listener of native.appStateListeners) listener();
    native.appState = 'active';
    for (const listener of native.appStateListeners) listener();
    mod.setThemePref({ theme: 'paper', appearance: 'light' });
    nativeConfigChanged();
    mod.setThemePref({ theme: 'paper', appearance: 'system' });
    // 原生层撤掉强制之后才报出手机的深色：这次是刚选的“跟随手机”带来的，在前台也要跟上。
    nativeConfigChanged();
    expect(scheme(mod)).toBe('dark');
  });

  it('跟随手机时，手机在 App 前台切换深浅，照旧等退到后台再换', async () => {
    const mod = await launch({ phone: 'light' });
    native.phone = 'dark';
    nativeConfigChanged();
    expect(scheme(mod)).toBe('light');
    native.appState = 'background';
    for (const listener of native.appStateListeners) listener();
    expect(scheme(mod)).toBe('dark');
  });
});
