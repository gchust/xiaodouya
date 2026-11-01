import { quotaStatus } from '@xiaodouya/shared';
import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, motion } from '../theme';
import { useFeedback } from '../ui/overlays';
import { Mono } from '../ui/primitives';
import { useApp, useUploadProgress } from './app';
import { uploadCardStatus } from './uploadStatus';

/**
 * 顶部上传进度。排队等 Wi-Fi 或失败时也如实显示，不让用户以为传完了。
 * 它盖在页面标题和返回链接上面，所以可以关掉，而且除了自己的按钮，点击都要穿透给下面的页面。
 */
export function UploadCard() {
  const { uploads, sessionState, api } = useApp();
  const progress = useUploadProgress();
  const insets = useSafeAreaInsets();
  const { toast } = useFeedback();
  const visible = useSharedValue(0);
  const fill = useSharedValue(0);
  const wasActive = useRef(false);
  const [shown, setShown] = useState(false);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);

  const status = uploadCardStatus(progress);
  const hasWork = progress.total > 0 || progress.failedCount > 0;
  const show = sessionState === 'ready' && hasWork && dismissedKey !== status.key;
  const percent = Math.round(progress.fraction * 100);

  // 这一批传完了就忘掉：下一批文件的状态可能和关掉时一样，但那是新的事。
  useEffect(() => {
    if (!hasWork) setDismissedKey(null);
  }, [hasWork]);

  useEffect(() => {
    if (show) setShown(true);
    visible.value = withTiming(show ? 1 : 0, { duration: 340, easing: motion.easing });
  }, [show, visible]);

  useEffect(() => {
    fill.value = withTiming(percent, { duration: 150 });
  }, [percent, fill]);

  useEffect(() => {
    if (progress.total > 0) wasActive.current = true;
    if (wasActive.current && progress.total === 0 && progress.failedCount === 0) {
      wasActive.current = false;
      toast('文件都上传好了');
      // 这时候提醒快满了最有用：用户刚传完，知道是什么占了空间。读不到就算了，下次再说。
      void api
        .storageUsage()
        .then((usage) => {
          const { warning } = quotaStatus(usage);
          if (warning) toast(warning);
        })
        .catch(() => {});
    }
  }, [progress.total, progress.failedCount, toast, api]);

  const style = useAnimatedStyle(() => ({
    opacity: visible.value,
    transform: [{ translateY: (1 - visible.value) * -90 }],
  }));
  const fillStyle = useAnimatedStyle(() => ({ width: `${fill.value}%` }));

  if (!shown) return null;

  return (
    <Animated.View
      testID={show ? 'upload-card' : undefined}
      pointerEvents={show ? 'box-none' : 'none'}
      style={[s.card, { top: insets.top + 6 }, style]}
    >
      <View style={s.row} pointerEvents="box-none">
        <View style={s.main} pointerEvents="none">
          <Text testID="upload-text" style={{ fontSize: 12, color: colors.ink, flexShrink: 1 }}>
            {status.text}
          </Text>
          {progress.failedCount > 0 ? null : (
            <Mono style={{ fontSize: 12, color: colors.muted }}>{percent}%</Mono>
          )}
        </View>
        {progress.failedCount > 0 ? (
          <Pressable
            testID="upload-retry"
            accessibilityRole="button"
            accessibilityLabel="重试上传"
            hitSlop={14}
            onPress={() => void uploads.retryFailed()}
          >
            <Text style={{ fontSize: 12, color: colors.accent }}>重试</Text>
          </Pressable>
        ) : null}
        <Pressable
          testID="upload-dismiss"
          accessibilityRole="button"
          accessibilityLabel="先收起上传提示"
          hitSlop={14}
          onPress={() => setDismissedKey(status.key)}
        >
          <Text style={s.dismiss}>×</Text>
        </Pressable>
      </View>
      <View style={{ gap: 7 }} pointerEvents="none">
        {progress.failedReason ? (
          <Text
            testID="upload-reason"
            style={{ fontSize: 11, color: colors.danger }}
            numberOfLines={2}
          >
            {progress.failedReason}
          </Text>
        ) : null}
        <View style={s.track}>
          <Animated.View style={[s.fill, fillStyle]} />
        </View>
      </View>
    </Animated.View>
  );
}

const s = StyleSheet.create({
  card: {
    position: 'absolute',
    left: 16,
    right: 16,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 14,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
    gap: 7,
    elevation: 6,
    shadowColor: colors.ink,
    shadowOpacity: 0.12,
    shadowRadius: 9,
    shadowOffset: { width: 0, height: 6 },
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  main: { flex: 1, flexDirection: 'row', justifyContent: 'space-between', gap: 10 },
  dismiss: { fontSize: 15, lineHeight: 16, color: colors.muted },
  track: { height: 4, borderRadius: 2, backgroundColor: '#efe7dc', overflow: 'hidden' },
  fill: { height: '100%', backgroundColor: colors.accent },
});
