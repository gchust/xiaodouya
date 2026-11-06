import { quotaStatus, t } from '@xiaodouya/shared';
import { usePathname, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, motion, themedStyles } from '../theme';
import { useFeedback } from '../ui/overlays';
import { Mono } from '../ui/primitives';
import { useApp, useUploadProgress } from './app';
import { uploadCardStatus, uploadSpeedText } from './uploadStatus';

/**
 * 顶部上传进度。排队等 Wi-Fi 或失败时也如实显示，不让用户以为传完了。
 * 点卡片打开上传详情。它盖在页面标题和返回链接上面，所以可以关掉，卡片之外的点击照常给下面的页面。
 */
export function UploadCard() {
  const { uploads, sessionState, api } = useApp();
  const progress = useUploadProgress();
  const insets = useSafeAreaInsets();
  const { toast } = useFeedback();
  const router = useRouter();
  const pathname = usePathname();
  const visible = useSharedValue(0);
  const fill = useSharedValue(0);
  const wasActive = useRef(false);
  const [shown, setShown] = useState(false);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);

  const status = uploadCardStatus(progress);
  const hasWork = progress.total > 0 || progress.failedCount > 0;
  // 详情页自己就显示进度，卡片再盖在标题上没有意义。
  const show =
    sessionState === 'ready' && hasWork && dismissedKey !== status.key && pathname !== '/uploads';
  const percent = Math.round(progress.fraction * 100);
  const speed = uploadSpeedText(progress);

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
      // 全部取消时什么也没传，不能说“都传好了”。
      if (progress.finishedInBatch === 0) return;
      toast(t().ui.allUploaded);
      // 这时候提醒快满了最有用：用户刚传完，知道是什么占了空间。读不到就算了，下次再说。
      void api
        .storageUsage()
        .then((usage) => {
          const { warning } = quotaStatus(usage);
          if (warning) toast(warning);
        })
        .catch(() => {});
    }
  }, [progress.total, progress.failedCount, progress.finishedInBatch, toast, api]);

  const style = useAnimatedStyle(() => ({
    opacity: visible.value,
    transform: [{ translateY: (1 - visible.value) * -90 }],
  }));
  const fillStyle = useAnimatedStyle(() => ({ width: `${fill.value}%` }));

  if (!shown) return null;

  return (
    <Animated.View
      pointerEvents={show ? 'box-none' : 'none'}
      style={[s.card, { top: insets.top + 6 }, style]}
    >
      {/* 整张卡片的点击放在最底下一层，而不是把内容包起来：包起来的话 × 和重试成了它的子元素，无障碍会把它们合并掉。 */}
      <Pressable
        testID={show ? 'upload-card' : undefined}
        accessibilityRole="button"
        accessibilityLabel={t().ui.openUploads(status.text)}
        style={s.tapLayer}
        onPress={() => router.push('/uploads')}
      />
      <View style={s.row} pointerEvents="box-none">
        <View style={s.main} pointerEvents="none">
          <Text testID="upload-text" style={{ fontSize: 12, color: colors.ink, flexShrink: 1 }}>
            {status.text}
          </Text>
        </View>
        {progress.failedCount > 0 ? (
          <Pressable
            testID="upload-retry"
            accessibilityRole="button"
            accessibilityLabel={t().ui.retryUpload}
            hitSlop={14}
            onPress={() => void uploads.retryFailed()}
          >
            <Text style={{ fontSize: 12, color: colors.accentText }}>{t().common.retry}</Text>
          </Pressable>
        ) : null}
        <Pressable
          testID="upload-dismiss"
          accessibilityRole="button"
          accessibilityLabel={t().ui.hideUploadNotice}
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
            style={{ fontSize: 11, color: colors.dangerText }}
            numberOfLines={2}
          >
            {progress.failedReason}
          </Text>
        ) : (
          // 没有速度时也占着这一行，卡片的高度不会跟着跳。
          <View style={s.speedLine}>
            <Mono testID="upload-speed" style={{ fontSize: 11, color: colors.muted }}>
              {speed ?? ' '}
            </Mono>
            <Mono style={{ fontSize: 11, color: colors.muted }}>{percent}%</Mono>
          </View>
        )}
        <View style={s.track}>
          <Animated.View style={[s.fill, fillStyle]} />
        </View>
      </View>
    </Animated.View>
  );
}

const s = themedStyles(() => ({
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
  tapLayer: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  main: { flex: 1, flexDirection: 'row', justifyContent: 'space-between', gap: 10 },
  speedLine: { flexDirection: 'row', justifyContent: 'space-between', gap: 10 },
  dismiss: { fontSize: 15, lineHeight: 16, color: colors.muted },
  track: { height: 4, borderRadius: 2, backgroundColor: colors.track, overflow: 'hidden' },
  fill: { height: '100%', backgroundColor: colors.accent },
}));
