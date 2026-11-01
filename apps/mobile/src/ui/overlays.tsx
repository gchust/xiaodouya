import { usePathname } from 'expo-router';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  BackHandler,
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { IS_E2E } from '../lib/config';
import { keyboardLift, sheetMaxHeight } from '../lib/layout';
import { colors, fonts, motion, spacing } from '../theme';

/** CI 的模拟器取一次界面就要好几秒，E2E 构建放长一些，避免点撤销时已经消失、点到下面的内容。 */
const TOAST_MS = IS_E2E ? 8_000 : 3600;

// ─── 底部弹层 ────────────────────────────────────────────

interface SheetApi {
  open(title: string, render: () => ReactNode): void;
  /** 替换当前弹层内容（比如从“更多”进入“体温”），不需要关再开。 */
  replace(title: string, render: () => ReactNode): void;
  /** 只改标题，弹层内容不动。 */
  setTitle(title: string): void;
  close(): void;
}

const SheetContext = createContext<SheetApi | null>(null);

export function useSheet(): SheetApi {
  const api = useContext(SheetContext);
  if (!api) throw new Error('useSheet 必须在 SheetProvider 内使用');
  return api;
}

function SheetLayer({
  sheet,
  visible,
  onClose,
  onHidden,
}: {
  sheet: { title: string; render: () => ReactNode } | null;
  visible: boolean;
  onClose: () => void;
  onHidden: () => void;
}) {
  const insets = useSafeAreaInsets();
  const progress = useSharedValue(0);
  const drag = useSharedValue(0);
  const height = useSharedValue(800);
  const keyboard = useSharedValue(0);
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [layerHeight, setLayerHeight] = useState(windowHeight);
  // 量到过的最大高度就是键盘收起时的高度。不能在键盘收起时才记：缩小后的布局事件可能比键盘事件先到。
  // 只在宽度变化（折叠屏）时重新量，窗口高度可能因为键盘而变，那时重量就会把键盘算两次。
  const fullHeight = useRef({ windowWidth, value: 0 });
  if (fullHeight.current.windowWidth !== windowWidth) {
    fullHeight.current = { windowWidth, value: 0 };
  }
  const lift = keyboardLift(keyboardHeight, fullHeight.current.value, layerHeight);

  useEffect(() => {
    keyboard.value = withTiming(lift, { duration: 220 });
  }, [lift, keyboard]);

  useEffect(() => {
    drag.value = 0;
    progress.value = withTiming(visible ? 1 : 0, motion, (finished) => {
      if (finished && !visible) runOnJS(onHidden)();
    });
  }, [visible, progress, drag, onHidden]);

  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const show = Keyboard.addListener(showEvent, (e) => {
      setKeyboardHeight(e.endCoordinates.height);
    });
    const hide = Keyboard.addListener(hideEvent, () => {
      setKeyboardHeight(0);
    });
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  useEffect(() => {
    if (!visible) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [visible, onClose]);

  const pan = Gesture.Pan()
    .activeOffsetY(10)
    .onUpdate((e) => {
      drag.value = Math.max(0, e.translationY);
    })
    .onEnd((e) => {
      if (e.translationY > 90 || e.velocityY > 900) {
        runOnJS(onClose)();
      } else {
        drag.value = withTiming(0, { duration: 180 });
      }
    });

  const scrimStyle = useAnimatedStyle(() => ({ opacity: progress.value }));
  const panelStyle = useAnimatedStyle(() => ({
    transform: [
      { translateY: (1 - progress.value) * (height.value + 40) + drag.value - keyboard.value },
    ],
  }));

  // 没有弹层时也挂着这一层：要在键盘打开之前就量到完整高度。
  return (
    <View
      style={StyleSheet.absoluteFill}
      pointerEvents={sheet && visible ? 'box-none' : 'none'}
      onLayout={(e) => {
        const measured = e.nativeEvent.layout.height;
        fullHeight.current.value = Math.max(fullHeight.current.value, measured);
        setLayerHeight(measured);
      }}
    >
      {sheet ? (
        <>
          <Animated.View
            style={[StyleSheet.absoluteFill, { backgroundColor: colors.scrim }, scrimStyle]}
          >
            <Pressable
              style={StyleSheet.absoluteFill}
              onPress={onClose}
              testID="sheet-scrim"
              accessibilityLabel="关闭"
            />
          </Animated.View>
          <Animated.View
            style={[
              s.panel,
              {
                maxHeight: sheetMaxHeight(layerHeight, lift, insets.top),
                paddingBottom: Math.max(insets.bottom, 12) + 14,
              },
              panelStyle,
            ]}
            onLayout={(e) => {
              height.value = e.nativeEvent.layout.height;
            }}
          >
            <GestureDetector gesture={pan}>
              <View style={s.handleArea}>
                <View style={s.handle} />
                <View style={s.header}>
                  <Text accessibilityRole="header" style={s.title} numberOfLines={2}>
                    {sheet.title}
                  </Text>
                  <Pressable
                    onPress={onClose}
                    hitSlop={12}
                    testID="sheet-cancel"
                    accessibilityRole="button"
                    accessibilityLabel="取消"
                  >
                    <Text style={s.cancel}>取消</Text>
                  </Pressable>
                </View>
              </View>
            </GestureDetector>
            <ScrollView
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
              contentContainerStyle={s.sheetBody}
              bounces={false}
            >
              {sheet.render()}
            </ScrollView>
          </Animated.View>
        </>
      ) : null}
    </View>
  );
}

// ─── Toast ──────────────────────────────────────────────

interface ToastOptions {
  undo?: () => void;
  durationMs?: number;
}

interface FeedbackApi {
  toast(message: string, options?: ToastOptions): void;
  /** 顶部深色横幅：其他家人刚同步过来的记录。 */
  banner(initial: string, message: string): void;
  dismissToast(): void;
}

const FeedbackContext = createContext<FeedbackApi | null>(null);

export function useFeedback(): FeedbackApi {
  const api = useContext(FeedbackContext);
  if (!api) throw new Error('useFeedback 必须在 FeedbackProvider 内使用');
  return api;
}

function ToastLayer({
  toast,
  onUndo,
}: {
  toast: { message: string; undo?: () => void } | null;
  onUndo: () => void;
}) {
  const insets = useSafeAreaInsets();
  // 回忆页右下角有深色悬浮按钮，Toast 要让开，否则两块深色叠在一起看不清。
  const onRecall = usePathname() === '/recall';
  const visible = useSharedValue(0);
  const last = useRef(toast);
  if (toast) last.current = toast;
  useEffect(() => {
    visible.value = withTiming(toast ? 1 : 0, { duration: 260, easing: motion.easing });
  }, [toast, visible]);
  const style = useAnimatedStyle(() => ({
    opacity: visible.value,
    transform: [{ translateY: (1 - visible.value) * 20 }],
  }));
  const shown = last.current;
  return (
    <Animated.View
      pointerEvents={toast ? 'auto' : 'none'}
      style={[s.toast, { bottom: Math.max(insets.bottom, 8) + (onRecall ? 134 : 70) }, style]}
      testID="toast"
    >
      <Text style={s.toastText} numberOfLines={2}>
        {shown?.message}
      </Text>
      {shown?.undo ? (
        <Pressable
          onPress={onUndo}
          hitSlop={10}
          testID="toast-undo"
          accessibilityRole="button"
          accessibilityLabel="撤销"
        >
          <Text style={s.toastUndo}>撤销</Text>
        </Pressable>
      ) : null}
    </Animated.View>
  );
}

function BannerLayer({ banner }: { banner: { initial: string; message: string } | null }) {
  const insets = useSafeAreaInsets();
  const visible = useSharedValue(0);
  const last = useRef(banner);
  if (banner) last.current = banner;
  useEffect(() => {
    visible.value = withTiming(banner ? 1 : 0, { duration: 400, easing: motion.easing });
  }, [banner, visible]);
  const style = useAnimatedStyle(() => ({
    opacity: visible.value,
    transform: [{ translateY: (1 - visible.value) * -120 }],
  }));
  return (
    <Animated.View
      pointerEvents="none"
      style={[s.banner, { top: insets.top + 8 }, style]}
      testID={banner ? 'family-banner' : undefined}
    >
      <View style={s.bannerAvatar}>
        <Text style={s.bannerInitial}>{last.current?.initial}</Text>
      </View>
      <View style={{ flex: 1, gap: 1 }}>
        <Text style={s.bannerApp}>小豆芽 · 刚刚</Text>
        <Text style={s.bannerText} numberOfLines={1}>
          {last.current?.message}
        </Text>
      </View>
    </Animated.View>
  );
}

/** Toast 和横幅：包在最外层，任何地方都能用，也始终显示在弹层之上。 */
export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<{ message: string; undo?: () => void } | null>(null);
  const [banner, setBanner] = useState<{ initial: string; message: string } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bannerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const feedback = useMemo<FeedbackApi>(
    () => ({
      toast(message, options) {
        if (toastTimer.current) clearTimeout(toastTimer.current);
        setToast({ message, undo: options?.undo });
        toastTimer.current = setTimeout(() => setToast(null), options?.durationMs ?? TOAST_MS);
      },
      dismissToast() {
        if (toastTimer.current) clearTimeout(toastTimer.current);
        setToast(null);
      },
      banner(initial, message) {
        if (bannerTimer.current) clearTimeout(bannerTimer.current);
        setBanner({ initial, message });
        bannerTimer.current = setTimeout(() => setBanner(null), 4200);
      },
    }),
    [],
  );

  const undo = useCallback(() => {
    toast?.undo?.();
    setToast(null);
  }, [toast]);

  return (
    <FeedbackContext.Provider value={feedback}>
      {children}
      <ToastLayer toast={toast} onUndo={undo} />
      <BannerLayer banner={banner} />
    </FeedbackContext.Provider>
  );
}

/** 弹层放在 AppProvider 里面，弹层内容才能读取账号和记录。 */
export function SheetProvider({ children }: { children: ReactNode }) {
  const [sheet, setSheet] = useState<{ title: string; render: () => ReactNode } | null>(null);
  const [visible, setVisible] = useState(false);
  const { dismissToast } = useFeedback();

  const close = useCallback(() => {
    Keyboard.dismiss();
    setVisible(false);
  }, []);
  const onHidden = useCallback(() => setSheet(null), []);

  const api = useMemo<SheetApi>(
    () => ({
      open(title, render) {
        // Toast 显示在弹层之上，正好盖住底部的按钮：喂完奶马上点尿布，点击全落在 Toast 上。
        dismissToast();
        setSheet({ title, render });
        setVisible(true);
      },
      replace(title, render) {
        setSheet({ title, render });
        setVisible(true);
      },
      setTitle(title) {
        setSheet((current) =>
          current && current.title !== title ? { ...current, title } : current,
        );
      },
      close,
    }),
    [close, dismissToast],
  );

  return (
    <SheetContext.Provider value={api}>
      {children}
      <SheetLayer sheet={sheet} visible={visible} onClose={close} onHidden={onHidden} />
    </SheetContext.Provider>
  );
}

const s = StyleSheet.create({
  panel: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.card,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: spacing.page,
  },
  handleArea: { paddingTop: 10, gap: 16, paddingBottom: 16 },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.handle,
    alignSelf: 'center',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    gap: 12,
  },
  title: { flexShrink: 1, fontFamily: fonts.serifBold, fontSize: 20, color: colors.ink },
  cancel: { fontSize: 13, color: colors.muted, padding: 4 },
  sheetBody: { gap: 16 },
  toast: {
    position: 'absolute',
    left: 16,
    right: 16,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 14,
    backgroundColor: colors.ink,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 10,
  },
  toastText: { color: colors.paper, fontSize: 13, flex: 1 },
  toastUndo: { color: colors.accentLight, fontWeight: '500', fontSize: 13, padding: 2 },
  banner: {
    position: 'absolute',
    left: 12,
    right: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 16,
    backgroundColor: colors.ink,
    flexDirection: 'row',
    gap: 10,
    alignItems: 'center',
    elevation: 8,
  },
  bannerAvatar: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bannerInitial: { fontFamily: fonts.serifBold, fontSize: 13, color: colors.white },
  bannerApp: { fontSize: 11, color: '#bdb3a8' },
  bannerText: { fontSize: 13, color: colors.paper },
});
