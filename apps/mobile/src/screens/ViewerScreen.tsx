import { formatMonthDay, type MediaRef } from '@xiaodouya/shared';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useMemo, useRef, useState } from 'react';
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
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRecords } from '../lib/app';
import { MediaImage, useMediaSource } from '../lib/mediaViews';
import { colors } from '../theme';

/** 全屏查看回忆里的照片和视频（左右滑动切换）或单个证件图片（可缩放）。 */
export function ViewerScreen() {
  const params = useLocalSearchParams<{
    moment?: string;
    document?: string;
    media?: string;
    index?: string;
  }>();
  const { moments, documents } = useRecords();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();

  const { items, title } = useMemo(() => {
    if (params.document) {
      const doc = documents.find((d) => d.id === params.document);
      return {
        items: (doc?.data.files ?? []).filter((f) => f.id === params.media),
        title: doc?.data.name ?? '',
      };
    }
    const moment = moments.find((m) => m.id === params.moment);
    return {
      items: (moment?.data.media ?? []).filter((x) => x.kind === 'image' || x.kind === 'video'),
      title: moment ? `${moment.data.title || '这一刻'} · ${formatMonthDay(moment.data.at)}` : '',
    };
  }, [params.document, params.moment, params.media, documents, moments]);

  const initial = Math.min(Number(params.index ?? 0), Math.max(0, items.length - 1));
  const [index, setIndex] = useState(initial);
  const list = useRef<FlatList<MediaRef>>(null);

  const onScrollEnd = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    setIndex(Math.round(e.nativeEvent.contentOffset.x / width));
  };

  return (
    <View style={s.root} testID="viewer-screen">
      <FlatList
        ref={list}
        data={items}
        horizontal
        pagingEnabled
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
              <ZoomableImage media={item} />
            )}
          </View>
        )}
      />
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
      </View>
    </View>
  );
}

function ZoomableImage({ media }: { media: MediaRef }) {
  const scale = useSharedValue(1);
  const saved = useSharedValue(1);
  const pinch = Gesture.Pinch()
    .onUpdate((e) => {
      scale.value = Math.min(5, Math.max(1, saved.value * e.scale));
    })
    .onEnd(() => {
      saved.value = scale.value;
    });
  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(() => {
      const next = scale.value > 1 ? 1 : 2.5;
      scale.value = withTiming(next);
      saved.value = next;
    });
  const style = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  return (
    <GestureDetector gesture={Gesture.Simultaneous(pinch, doubleTap)}>
      <Animated.View style={[StyleSheet.absoluteFill, style]}>
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
