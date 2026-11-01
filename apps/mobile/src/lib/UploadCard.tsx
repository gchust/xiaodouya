import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, motion } from '../theme';
import { useFeedback } from '../ui/overlays';
import { Mono } from '../ui/primitives';
import { useApp, useUploadProgress } from './app';

/** 顶部上传进度。排队等 Wi-Fi 或失败时也如实显示，不让用户以为传完了。 */
export function UploadCard() {
  const { uploads, sessionState } = useApp();
  const progress = useUploadProgress();
  const insets = useSafeAreaInsets();
  const { toast } = useFeedback();
  const visible = useSharedValue(0);
  const wasActive = useRef(false);
  const [shown, setShown] = useState(false);

  const hasWork = progress.total > 0 || progress.failedCount > 0;
  const show = sessionState === 'ready' && hasWork;

  useEffect(() => {
    if (show) setShown(true);
    visible.value = withTiming(show ? 1 : 0, { duration: 340, easing: motion.easing });
  }, [show, visible]);

  useEffect(() => {
    if (progress.total > 0) wasActive.current = true;
    if (wasActive.current && progress.total === 0 && progress.failedCount === 0) {
      wasActive.current = false;
      toast('文件都上传好了');
    }
  }, [progress.total, progress.failedCount, toast]);

  const style = useAnimatedStyle(() => ({
    opacity: visible.value,
    transform: [{ translateY: (1 - visible.value) * -90 }],
  }));

  if (!shown) return null;
  const percent = Math.round(progress.fraction * 100);
  let text = `正在上传 ${progress.total} 个文件`;
  if (progress.failedCount > 0 && progress.total === 0)
    text = `${progress.failedCount} 个文件上传失败`;
  else if (progress.waitingForWifi) text = `${progress.total} 个视频等 Wi-Fi 再上传`;
  else if (!progress.active && progress.total > 0) text = `${progress.total} 个文件等待上传`;

  return (
    <Animated.View
      testID={show ? 'upload-card' : undefined}
      pointerEvents={progress.failedCount > 0 ? 'auto' : 'none'}
      style={[s.card, { top: insets.top + 6 }, style]}
    >
      <View style={s.row}>
        <Text testID="upload-text" style={{ fontSize: 12, color: colors.ink, flexShrink: 1 }}>
          {text}
        </Text>
        {progress.failedCount > 0 ? (
          <Pressable
            testID="upload-retry"
            accessibilityRole="button"
            accessibilityLabel="重试上传"
            hitSlop={10}
            onPress={() => void uploads.retryFailed()}
          >
            <Text style={{ fontSize: 12, color: colors.accent }}>重试</Text>
          </Pressable>
        ) : (
          <Mono style={{ fontSize: 12, color: colors.muted }}>{percent}%</Mono>
        )}
      </View>
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
        <View style={[s.fill, { width: `${percent}%` }]} />
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
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: 10 },
  track: { height: 4, borderRadius: 2, backgroundColor: '#efe7dc', overflow: 'hidden' },
  fill: { height: '100%', backgroundColor: colors.accent },
});
