import {
  formatBytes,
  formatMonthDay,
  type MediaRef,
  momentCover,
  t,
  visualMedia,
} from '@xiaodouya/shared';
import { Image } from 'expo-image';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useVideoPlayer, VideoView } from 'expo-video';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
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
import { useApp, useRecords } from '../lib/app';
import { DownloadButton } from '../lib/DownloadButton';
import { downloadFileNames } from '../lib/downloadCore';
import { clampPan, containedSize } from '../lib/layout';
import { MediaImage, type MediaSource, useMediaSource, usePhotoSources } from '../lib/mediaViews';
import { canDecodeFull, type OriginalControl, photoPlan } from '../lib/photoPreview';
import { colors } from '../theme';
import { AvatarEditor } from '../ui/AvatarEditor';
import { useFeedback } from '../ui/overlays';
import { Stripes } from '../ui/primitives';

/** 全屏查看回忆里的照片和视频（左右滑动切换）、单个证件图片（可缩放）或宝宝的头像（可编辑）。 */
export function ViewerScreen() {
  const params = useLocalSearchParams<{
    moment?: string;
    document?: string;
    media?: string;
    index?: string;
    avatar?: string;
  }>();
  const { moments, documents, baby } = useRecords();
  const app = useApp();
  const { role } = app;
  const { toast } = useFeedback();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();

  // 只有回忆里的照片有预览。头像和证件要原图：编辑头像要原图，证件要看清小字。
  const hasPreviews = !params.avatar && !params.document;
  const moment =
    params.avatar || params.document ? undefined : moments.find((m) => m.id === params.moment);
  const { items, title, fileNames } = useMemo(() => {
    if (params.avatar) {
      return {
        items: baby?.data.avatar ? [baby.data.avatar] : [],
        title: baby ? t().ui.avatarOf(baby.data.name) : '',
        // 头像不提供下载：它本来就是从相册选的，值得留的照片在回忆里能下载。
        // 而且编辑时预览的是还没保存的图，这里下载到的却是旧图。
        fileNames: null,
      };
    }
    if (params.document) {
      const doc = documents.find((d) => d.id === params.document);
      return {
        items: (doc?.data.files ?? []).filter((f) => f.id === params.media),
        title: doc?.data.name ?? '',
        // 证件不在这里下载：这个页面能通过链接直接打开，没有经过证件夹解锁。
        fileNames: null,
      };
    }
    return {
      // 和时间线封面的序号用同一个筛选，点封面才会打开到同一张。
      items: visualMedia(moment?.data.media ?? []),
      title: moment
        ? `${moment.data.title || t().ui.thisMoment} · ${formatMonthDay(moment.data.at)}`
        : '',
      fileNames: moment
        ? downloadFileNames(moment.data.media, {
            title: moment.data.title || t().ui.thisMoment,
            at: moment.data.at,
          })
        : null,
    };
  }, [params.avatar, params.document, params.media, baby, documents, moment]);

  const initial = Math.min(Number(params.index ?? 0), Math.max(0, items.length - 1));
  const [index, setIndex] = useState(initial);
  const [zoomed, setZoomed] = useState(false);
  const list = useRef<FlatList<MediaRef>>(null);

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    setIndex(Math.round(e.nativeEvent.contentOffset.x / width));
  };
  const current = items[index];
  const currentName = current && fileNames?.get(current.id);
  // 只有一个文件时它就是封面，不用选。真正的权限在服务端：viewer 写回忆会被拒绝。
  const coverId =
    moment && items.length > 1 && role !== 'viewer'
      ? momentCover(moment.data.media, moment.data.coverMediaId)?.media.id
      : undefined;

  const setCover = (media: MediaRef) => {
    if (!moment) return;
    const { id } = moment;
    // 查看器可能开了一会儿，在最新版本上只改封面，不盖掉家人刚改的内容。
    const latest = app.store.getSnapshot().moments.find((m) => m.id === id)?.data ?? moment.data;
    void app.write('moment', { ...latest, coverMediaId: media.id }, id);
    toast(t().recall.coverSet, { undo: () => void app.write('moment', latest, id) });
  };

  const pages = (
    <FlatList
      ref={list}
      data={items}
      horizontal
      pagingEnabled
      // 放大时手指是用来拖动图片的，不能翻页。
      scrollEnabled={!zoomed}
      initialScrollIndex={initial}
      getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
      // 预览不缩小解码，一张约 12 MB。默认前后各留 10 屏，翻过的 20 张都在内存里。
      initialNumToRender={1}
      maxToRenderPerBatch={1}
      windowSize={3}
      keyExtractor={(item) => item.id}
      showsHorizontalScrollIndicator={false}
      // 跟着实际位置走，不等惯性结束：页码和“查看原图”要和眼前这张对得上。
      onScroll={onScroll}
      scrollEventThrottle={32}
      renderItem={({ item, index: i }) => (
        <View style={{ width, flex: 1 }}>
          {item.kind === 'video' ? (
            // 只挂载当前页的播放器：同时解码多个视频会很吃内存。
            i === index ? (
              <VideoPage media={item} />
            ) : (
              <MediaImage
                media={item}
                variant="thumb"
                contentFit="contain"
                style={StyleSheet.absoluteFill}
              />
            )
          ) : hasPreviews ? (
            <PreviewPhoto
              media={item}
              // 前后各一页提前准备好，再远的只留位置：一条回忆可能有 100 张。
              active={Math.abs(i - index) <= 1}
              current={i === index}
              onZoomChange={setZoomed}
            />
          ) : (
            <ZoomableImage media={item} onZoomChange={setZoomed}>
              <MediaImage
                media={item}
                variant="original"
                contentFit="contain"
                style={[StyleSheet.absoluteFill, { backgroundColor: '#000' }]}
              />
            </ZoomableImage>
          )}
        </View>
      )}
    />
  );

  return (
    <View style={s.root} testID="viewer-screen">
      {/* 真正的权限在服务端，这里只是不给 viewer 看入口。 */}
      {params.avatar && role !== 'viewer' ? (
        <AvatarEditor media={items[0]}>{pages}</AvatarEditor>
      ) : (
        pages
      )}
      <View style={[s.top, { paddingTop: insets.top + 8 }]} pointerEvents="box-none">
        <Pressable
          testID="viewer-close"
          accessibilityRole="button"
          accessibilityLabel={t().ui.close}
          hitSlop={12}
          onPress={() => router.back()}
        >
          <Text style={s.close}>×</Text>
        </Pressable>
        <Text style={s.title} numberOfLines={1}>
          {title}
        </Text>
        <Text style={s.count} testID="viewer-count">
          {items.length > 1 ? `${index + 1} / ${items.length}` : ''}
        </Text>
        {current && coverId ? (
          current.id === coverId ? (
            // 只说状态，不是按钮：已经是封面了。
            <View
              testID="viewer-cover-current"
              accessible
              accessibilityLabel={t().recall.isCover}
              style={s.coverState}
            >
              <View style={s.coverDot} />
              <Text style={s.coverText}>{t().recall.isCover}</Text>
            </View>
          ) : (
            <Pressable
              testID="viewer-set-cover"
              accessibilityRole="button"
              accessibilityLabel={t().recall.setCover}
              hitSlop={12}
              onPress={() => setCover(current)}
              style={s.coverButton}
            >
              <Text style={s.coverText}>{t().recall.setCover}</Text>
            </Pressable>
          )
        ) : null}
        {current && currentName ? (
          <DownloadButton
            key={current.id}
            media={current}
            fileName={currentName}
            tone="dark"
            testID="viewer-download"
          />
        ) : null}
      </View>
    </View>
  );
}

/** 比 1 大一点点就算放大，否则手指一动就锁住翻页。 */
const ZOOMED_ABOVE = 1.01;

/** 收到的反馈的全屏查看（FeedbackMediaScreen）也用它。只用到宽高：不知道时按铺满算。 */
export function ZoomableImage({
  media,
  onZoomChange,
  children,
}: {
  media: { width?: number; height?: number };
  onZoomChange: (zoomed: boolean) => void;
  children: ReactNode;
}) {
  const window = useWindowDimensions();
  const [box, setBox] = useState({ width: window.width, height: window.height });
  const [zoomed, setZoomed] = useState(false);
  const content = containedSize(box.width, box.height, media.width, media.height);
  const scale = useSharedValue(1);
  const saved = useSharedValue(1);
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const savedX = useSharedValue(0);
  const savedY = useSharedValue(0);
  const isZoomed = useSharedValue(false);

  useEffect(() => () => onZoomChange(false), [onZoomChange]);

  const reportZoom = (next: boolean) => {
    setZoomed(next);
    onZoomChange(next);
  };

  const pinch = Gesture.Pinch()
    .onUpdate((e) => {
      const next = Math.min(5, Math.max(1, saved.value * e.scale));
      scale.value = next;
      // 缩小时图片边缘会往里收，平移量要跟着收，否则露出一片黑。
      x.value = clampPan(x.value, next, box.width, content.width);
      y.value = clampPan(y.value, next, box.height, content.height);
      const nowZoomed = next > ZOOMED_ABOVE;
      if (nowZoomed !== isZoomed.value) {
        isZoomed.value = nowZoomed;
        runOnJS(reportZoom)(nowZoomed);
      }
    })
    .onEnd(() => {
      saved.value = scale.value;
    });
  // 没放大时直接禁用，手势完全不参与，左右翻页由 FlatList 处理。
  const pan = Gesture.Pan()
    .enabled(zoomed)
    .maxPointers(1)
    .minDistance(4)
    .onStart(() => {
      savedX.value = x.value;
      savedY.value = y.value;
    })
    .onUpdate((e) => {
      x.value = clampPan(savedX.value + e.translationX, scale.value, box.width, content.width);
      y.value = clampPan(savedY.value + e.translationY, scale.value, box.height, content.height);
    });
  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(() => {
      const next = scale.value > 1 ? 1 : 2.5;
      scale.value = withTiming(next);
      saved.value = next;
      if (next === 1) {
        x.value = withTiming(0);
        y.value = withTiming(0);
      }
      isZoomed.value = next > ZOOMED_ABOVE;
      runOnJS(reportZoom)(isZoomed.value);
    });
  const style = useAnimatedStyle(() => ({
    transform: [{ translateX: x.value }, { translateY: y.value }, { scale: scale.value }],
  }));
  return (
    <GestureDetector gesture={Gesture.Simultaneous(pinch, pan, doubleTap)}>
      <Animated.View
        style={[StyleSheet.absoluteFill, style]}
        onLayout={(e) => {
          const { width, height } = e.nativeEvent.layout;
          setBox({ width, height });
        }}
      >
        {children}
      </Animated.View>
    </GestureDetector>
  );
}

function PhotoLayer({
  source,
  testID,
  label,
  fullDecode,
  onLoad,
  onError,
  onProgress,
}: {
  source: MediaSource;
  testID?: string;
  label: string;
  /** 放大时才看得出区别。默认按屏幕大小解码，点了“查看原图”也不会更清楚。 */
  fullDecode?: boolean;
  onLoad?: () => void;
  onError?: () => void;
  onProgress?: (percent: number) => void;
}) {
  return (
    <Image
      testID={testID}
      source={source}
      style={StyleSheet.absoluteFill}
      contentFit="contain"
      transition={200}
      cachePolicy="disk"
      allowDownscaling={!fullDecode}
      accessibilityLabel={label}
      onLoad={onLoad}
      onError={onError}
      onProgress={
        onProgress &&
        (({ loaded, total }) => {
          if (total > 0) onProgress((loaded / total) * 100);
        })
      }
    />
  );
}

/** 默认显示预览，加载时先有缩略图。“查看原图”点了才下载，原图盖在预览上，好了才看得出变化。 */
function PreviewPhoto({
  media,
  active,
  current,
  onZoomChange,
}: {
  media: MediaRef;
  active: boolean;
  current: boolean;
  onZoomChange: (zoomed: boolean) => void;
}) {
  const sources = usePhotoSources(media, active);
  const [wantOriginal, setWantOriginal] = useState(false);
  const [originalLoaded, setOriginalLoaded] = useState(false);
  const [originalFailed, setOriginalFailed] = useState(false);
  const [percent, setPercent] = useState<number | null>(null);
  const plan = photoPlan({
    answered: sources.answered,
    localOriginal: sources.localOriginal,
    preview: sources.preview !== null,
    original: sources.original !== null,
    wantOriginal,
    originalLoaded,
    originalFailed,
  });
  const label = media.name ?? t().ui.photo;
  const base =
    plan.base === 'preview' ? sources.preview : plan.base === 'original' ? sources.original : null;
  const load = () => {
    setOriginalFailed(false);
    setPercent(null);
    setWantOriginal(true);
  };
  return (
    <>
      <ZoomableImage media={media} onZoomChange={onZoomChange}>
        <View style={[StyleSheet.absoluteFill, { backgroundColor: '#000' }]}>
          {!sources.thumb && !base ? <Stripes style={StyleSheet.absoluteFill} /> : null}
          {sources.thumb ? <PhotoLayer source={sources.thumb} label={label} /> : null}
          {base ? (
            <PhotoLayer
              key={plan.base}
              testID={`viewer-image-${plan.base}`}
              source={base}
              label={label}
              fullDecode={plan.base === 'preview' || canDecodeFull(media)}
            />
          ) : null}
          {plan.overlayOriginal && sources.original ? (
            <PhotoLayer
              testID="viewer-image-original"
              source={sources.original}
              label={label}
              fullDecode={canDecodeFull(media)}
              onLoad={() => setOriginalLoaded(true)}
              onError={() => setOriginalFailed(true)}
              onProgress={setPercent}
            />
          ) : null}
        </View>
      </ZoomableImage>
      {current ? (
        <OriginalButton control={plan.control} size={media.size} percent={percent} onLoad={load} />
      ) : null}
    </>
  );
}

function OriginalButton({
  control,
  size,
  percent,
  onLoad,
}: {
  control: OriginalControl;
  size: number;
  percent: number | null;
  onLoad: () => void;
}) {
  const insets = useSafeAreaInsets();
  if (control === 'none') return null;
  const ui = t().ui;
  const sized = formatBytes(size);
  const text = {
    view: ui.viewOriginal(sized),
    loading: ui.loadingOriginal(percent === null ? null : Math.round(percent)),
    shown: ui.showingOriginal(sized),
    failed: ui.originalLoadFailed,
    uploading: ui.originalNotUploaded,
  }[control];
  const testID = `viewer-original-${control}`;
  const inner = (
    <>
      {control === 'loading' ? <ActivityIndicator size="small" color={colors.white} /> : null}
      <Text style={s.originalText}>{text}</Text>
    </>
  );
  return (
    <View style={[s.originalBar, { bottom: insets.bottom + 20 }]} pointerEvents="box-none">
      {control === 'view' || control === 'failed' ? (
        <Pressable
          testID={testID}
          accessibilityRole="button"
          accessibilityLabel={text}
          hitSlop={8}
          onPress={onLoad}
          style={[s.originalPill, s.originalPillActive]}
        >
          {inner}
        </Pressable>
      ) : (
        // 不是按钮：只说状态，读屏也念得到。
        <View
          testID={testID}
          accessible
          accessibilityLabel={text}
          accessibilityState={{ disabled: true, busy: control === 'loading' }}
          style={s.originalPill}
        >
          {inner}
        </View>
      )}
    </View>
  );
}

function VideoPage({ media }: { media: MediaRef }) {
  const source = useMediaSource(media, 'original');
  if (!source) {
    return (
      <View style={s.center}>
        <ActivityIndicator color={colors.paper} />
        <Text style={s.loading}>{t().ui.preparingVideo}</Text>
      </View>
    );
  }
  return <VideoPlayer uri={source.uri} />;
}

export function VideoPlayer({ uri }: { uri: string }) {
  const player = useVideoPlayer({ uri }, (p) => {
    p.play();
  });
  return (
    <VideoView
      player={player}
      style={StyleSheet.absoluteFill}
      contentFit="contain"
      nativeControls
    />
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  top: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    paddingHorizontal: 16,
    paddingBottom: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  close: { color: colors.white, fontSize: 28, lineHeight: 30, paddingHorizontal: 6 },
  title: { flex: 1, color: colors.white, fontSize: 14 },
  count: { color: colors.white, fontSize: 12 },
  // 能点的有白色细边，只说状态的没有，和底部“查看原图”的胶囊一样。
  coverButton: {
    minHeight: 26,
    paddingHorizontal: 10,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.white,
    justifyContent: 'center',
  },
  coverState: { minHeight: 26, flexDirection: 'row', alignItems: 'center', gap: 6 },
  coverDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.accentLight },
  coverText: { color: colors.white, fontSize: 12 },
  center: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  loading: { color: colors.paper, fontSize: 13 },
  originalBar: {
    position: 'absolute',
    left: 16,
    right: 16,
    alignItems: 'center',
  },
  originalPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: 40,
    paddingHorizontal: 16,
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  originalPillActive: { borderWidth: StyleSheet.hairlineWidth, borderColor: colors.white },
  originalText: { flexShrink: 1, color: colors.white, fontSize: 13, textAlign: 'center' },
});
