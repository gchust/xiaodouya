import { formatMonthDay, type MediaRef } from '@xiaodouya/shared';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useEffect, useMemo, useRef, useState } from 'react';
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
import { MediaImage, useMediaSource } from '../lib/mediaViews';
import { colors } from '../theme';
import { AvatarEditor } from '../ui/AvatarEditor';

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
  const { role } = useApp();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();

  const { items, title, fileNames } = useMemo(() => {
    if (params.avatar) {
      return {
        items: baby?.data.avatar ? [baby.data.avatar] : [],
        title: baby ? `${baby.data.name}的头像` : '',
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
    const moment = moments.find((m) => m.id === params.moment);
    return {
      items: (moment?.data.media ?? []).filter((x) => x.kind === 'image' || x.kind === 'video'),
      title: moment ? `${moment.data.title || '这一刻'} · ${formatMonthDay(moment.data.at)}` : '',
      fileNames: moment
        ? downloadFileNames(moment.data.media, {
            title: moment.data.title || '这一刻',
            at: moment.data.at,
          })
        : null,
    };
  }, [params.avatar, params.document, params.moment, params.media, baby, documents, moments]);

  const initial = Math.min(Number(params.index ?? 0), Math.max(0, items.length - 1));
  const [index, setIndex] = useState(initial);
  const [zoomed, setZoomed] = useState(false);
  const list = useRef<FlatList<MediaRef>>(null);

  const onScrollEnd = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    setIndex(Math.round(e.nativeEvent.contentOffset.x / width));
  };
  const current = items[index];
  const currentName = current && fileNames?.get(current.id);

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
      keyExtractor={(item) => item.id}
      showsHorizontalScrollIndicator={false}
      onMomentumScrollEnd={onScrollEnd}
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
          ) : (
            <ZoomableImage media={item} onZoomChange={setZoomed} />
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
          accessibilityLabel="关闭"
          hitSlop={12}
          onPress={() => router.back()}
        >
          <Text style={s.close}>×</Text>
        </Pressable>
        <Text style={s.title} numberOfLines={1}>
          {title}
        </Text>
        <Text style={s.count}>{items.length > 1 ? `${index + 1} / ${items.length}` : ''}</Text>
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

function ZoomableImage({
  media,
  onZoomChange,
}: {
  media: MediaRef;
  onZoomChange: (zoomed: boolean) => void;
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
        <MediaImage
          media={media}
          variant="original"
          contentFit="contain"
          style={[StyleSheet.absoluteFill, { backgroundColor: '#000' }]}
        />
      </Animated.View>
    </GestureDetector>
  );
}

function VideoPage({ media }: { media: MediaRef }) {
  const source = useMediaSource(media, 'original');
  if (!source) {
    return (
      <View style={s.center}>
        <ActivityIndicator color={colors.paper} />
        <Text style={s.loading}>正在准备视频…</Text>
      </View>
    );
  }
  return <VideoPlayer uri={source.uri} />;
}

function VideoPlayer({ uri }: { uri: string }) {
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
});
