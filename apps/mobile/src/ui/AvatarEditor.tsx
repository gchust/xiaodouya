import type { MediaRef } from '@xiaodouya/shared';
import { t } from '@xiaodouya/shared';
import { Image } from 'expo-image';
import type { ImageRef } from 'expo-image-manipulator';
import { type ReactNode, type RefObject, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../lib/app';
import { saveAvatar } from '../lib/avatar';
import { clampPan, cropRect } from '../lib/layout';
import {
  cropImage,
  loadForEditing,
  type PickedFile,
  pickFromLibrary,
  rotateImage,
  savedImageFile,
} from '../lib/media';
import { colors } from '../theme';
import { useFeedback } from './overlays';

type Rect = ReturnType<typeof cropRect>;

/**
 * 查看器底部的头像编辑：换一张、旋转、裁剪。按钮都在屏幕下方，单手够得到。
 * 旋转和裁剪只在内存里改，点「保存」才生成文件并上传：
 * 文件不做硬删除，连点三下旋转如果每次都上传，就会在存储里留下三张废图。
 */
export function AvatarEditor({ media, children }: { media?: MediaRef; children: ReactNode }) {
  const app = useApp();
  const { toast } = useFeedback();
  const insets = useSafeAreaInsets();
  const [draft, setDraft] = useState<ImageRef | null>(null);
  // 还没改过（只是点了裁剪又取消）就不用保存。
  const [dirty, setDirty] = useState(false);
  const [cropping, setCropping] = useState(false);
  const [busy, setBusy] = useState(false);
  const readCrop = useRef<(() => Rect) | null>(null);

  // 一张图解码后几十 MB，而 JS 的垃圾回收看不到这部分内存，要主动放掉。
  useEffect(() => () => draft?.release(), [draft]);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    try {
      await work();
    } catch (error) {
      toast(error instanceof Error ? error.message : t().ui.avatarFailed);
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    setDraft(null);
    setDirty(false);
    setCropping(false);
  };

  const persist = async (file: PickedFile) => {
    await saveAvatar(app, file);
    reset();
    toast(t().ui.avatarDone);
  };

  const replace = () =>
    run(async () => {
      const [file] = await pickFromLibrary({ singleImage: true });
      if (file) await persist(file);
    });

  const rotate = () =>
    run(async () => {
      const image = draft ?? (media ? await loadForEditing(app.api, media) : null);
      if (!image) return;
      const rotated = await rotateImage(image);
      if (image !== draft) image.release();
      setDraft(rotated);
      setDirty(true);
    });

  const startCrop = () =>
    run(async () => {
      const image = draft ?? (media ? await loadForEditing(app.api, media) : null);
      if (!image) return;
      setDraft(image);
      setCropping(true);
    });

  const cancel = () => {
    if (cropping && dirty) setCropping(false);
    else reset();
  };

  const confirmCrop = () =>
    run(async () => {
      if (!draft || !readCrop.current) return;
      setDraft(await cropImage(draft, readCrop.current()));
      setDirty(true);
      setCropping(false);
    });

  const save = () =>
    run(async () => {
      if (draft) await persist(await savedImageFile(draft));
    });

  return (
    <>
      <View style={s.stage}>
        {!draft ? (
          children
        ) : cropping ? (
          <CropStage image={draft} readCrop={readCrop} />
        ) : (
          <Image
            testID="avatar-draft"
            accessibilityLabel={t().ui.avatarPreview}
            source={draft}
            contentFit="contain"
            style={StyleSheet.absoluteFill}
          />
        )}
        {busy ? (
          <View style={s.busy} pointerEvents="none">
            <ActivityIndicator color={colors.paper} />
          </View>
        ) : null}
      </View>
      <View style={[s.bar, { paddingBottom: Math.max(insets.bottom, 8) + 4 }]}>
        {cropping ? (
          <>
            <BarButton
              id="avatar-cancel"
              label={t().common.cancel}
              disabled={busy}
              onPress={cancel}
            />
            <BarButton
              id="avatar-crop-confirm"
              label={t().ui.cropDone}
              primary
              disabled={busy}
              onPress={() => void confirmCrop()}
            />
          </>
        ) : dirty ? (
          <>
            <BarButton
              id="avatar-cancel"
              label={t().common.cancel}
              disabled={busy}
              onPress={cancel}
            />
            <BarButton
              id="avatar-rotate"
              label={t().ui.rotate}
              disabled={busy}
              onPress={() => void rotate()}
            />
            <BarButton
              id="avatar-crop"
              label={t().ui.crop}
              disabled={busy}
              onPress={() => void startCrop()}
            />
            <BarButton
              id="avatar-save"
              label={t().common.save}
              primary
              disabled={busy}
              onPress={() => void save()}
            />
          </>
        ) : (
          <>
            <BarButton
              id="avatar-replace"
              label={t().ui.replacePhoto}
              disabled={busy}
              onPress={() => void replace()}
            />
            <BarButton
              id="avatar-rotate"
              label={t().ui.rotate}
              disabled={busy || !media}
              onPress={() => void rotate()}
            />
            <BarButton
              id="avatar-crop"
              label={t().ui.crop}
              disabled={busy || !media}
              onPress={() => void startCrop()}
            />
          </>
        )}
      </View>
    </>
  );
}

function BarButton({
  id,
  label,
  primary,
  disabled,
  onPress,
}: {
  id: string;
  label: string;
  primary?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      testID={id}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={onPress}
      style={[s.button, primary ? s.buttonPrimary : null, disabled ? s.buttonDisabled : null]}
    >
      <Text style={s.buttonLabel}>{label}</Text>
    </Pressable>
  );
}

const FRAME_MARGIN = 24;
const MAX_ZOOM = 5;
const DOUBLE_TAP_ZOOM = 2.5;

/** 正方形取景框：一根手指拖动，双击放大，也能双指缩放。半夜单手也用得了。 */
function CropStage({
  image,
  readCrop,
}: {
  image: ImageRef;
  readCrop: RefObject<(() => Rect) | null>;
}) {
  const [box, setBox] = useState({ width: 0, height: 0 });
  const frame = Math.max(0, Math.min(box.width, box.height) - FRAME_MARGIN * 2);
  // 图片先按短边铺满取景框。
  const cover = frame / Math.min(image.width, image.height);
  const baseWidth = image.width * cover;
  const baseHeight = image.height * cover;
  const zoom = useSharedValue(1);
  const savedZoom = useSharedValue(1);
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const savedX = useSharedValue(0);
  const savedY = useSharedValue(0);

  readCrop.current = () =>
    cropRect({
      frame,
      imageWidth: image.width,
      imageHeight: image.height,
      zoom: zoom.value,
      x: x.value,
      y: y.value,
    });

  const pinch = Gesture.Pinch()
    .onUpdate((e) => {
      const next = Math.min(MAX_ZOOM, Math.max(1, savedZoom.value * e.scale));
      zoom.value = next;
      // 缩小时图片边缘会往里收，平移量要跟着收，否则取景框里会露出空白。
      x.value = clampPan(x.value, next, frame, baseWidth);
      y.value = clampPan(y.value, next, frame, baseHeight);
    })
    .onEnd(() => {
      savedZoom.value = zoom.value;
    });
  const pan = Gesture.Pan()
    .maxPointers(1)
    .minDistance(4)
    .onStart(() => {
      savedX.value = x.value;
      savedY.value = y.value;
    })
    .onUpdate((e) => {
      x.value = clampPan(savedX.value + e.translationX, zoom.value, frame, baseWidth);
      y.value = clampPan(savedY.value + e.translationY, zoom.value, frame, baseHeight);
    });
  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(() => {
      const next = zoom.value > 1 ? 1 : DOUBLE_TAP_ZOOM;
      savedZoom.value = next;
      zoom.value = withTiming(next);
      x.value = withTiming(clampPan(x.value, next, frame, baseWidth));
      y.value = withTiming(clampPan(y.value, next, frame, baseHeight));
    });
  const moved = useAnimatedStyle(() => ({
    transform: [{ translateX: x.value }, { translateY: y.value }, { scale: zoom.value }],
  }));

  const frameTop = (box.height - frame) / 2;
  const frameLeft = (box.width - frame) / 2;
  return (
    <GestureDetector gesture={Gesture.Simultaneous(pinch, pan, doubleTap)}>
      <View
        testID="avatar-crop-stage"
        style={StyleSheet.absoluteFill}
        collapsable={false}
        onLayout={(e) => {
          const { width, height } = e.nativeEvent.layout;
          setBox({ width, height });
        }}
      >
        {frame > 0 ? (
          <>
            <Animated.View
              style={[
                {
                  position: 'absolute',
                  left: (box.width - baseWidth) / 2,
                  top: (box.height - baseHeight) / 2,
                  width: baseWidth,
                  height: baseHeight,
                },
                moved,
              ]}
            >
              <Image source={image} contentFit="fill" style={StyleSheet.absoluteFill} />
            </Animated.View>
            <View style={StyleSheet.absoluteFill} pointerEvents="none">
              <View style={[s.mask, { left: 0, right: 0, top: 0, height: frameTop }]} />
              <View style={[s.mask, { left: 0, right: 0, bottom: 0, height: frameTop }]} />
              <View style={[s.mask, { left: 0, width: frameLeft, top: frameTop, height: frame }]} />
              <View
                style={[s.mask, { right: 0, width: frameLeft, top: frameTop, height: frame }]}
              />
              <View
                style={[s.frame, { left: frameLeft, top: frameTop, width: frame, height: frame }]}
              >
                {/* 今天页的头像是圆的，这条线告诉家长最后露出来的是哪一块。 */}
                <View style={[s.circle, { borderRadius: frame / 2 }]} />
              </View>
              <Text style={[s.hint, { top: frameTop + frame + 14 }]}>{t().ui.cropHint}</Text>
            </View>
          </>
        ) : null}
      </View>
    </GestureDetector>
  );
}

const s = StyleSheet.create({
  stage: { flex: 1, overflow: 'hidden', backgroundColor: '#000' },
  busy: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  bar: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 10,
    backgroundColor: '#000',
  },
  button: {
    flex: 1,
    height: 48,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.14)',
  },
  buttonPrimary: { backgroundColor: colors.accent },
  buttonDisabled: { opacity: 0.45 },
  buttonLabel: { color: colors.white, fontSize: 14, fontWeight: '500' },
  mask: { position: 'absolute', backgroundColor: 'rgba(0,0,0,0.62)' },
  frame: { position: 'absolute', borderWidth: 1, borderColor: colors.white },
  circle: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.55)',
  },
  hint: {
    position: 'absolute',
    left: 0,
    right: 0,
    textAlign: 'center',
    color: colors.paper,
    fontSize: 13,
  },
});
