import { formatMediaDuration, type MediaRef, type MediaVariant } from '@xiaodouya/shared';
import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioPlayer,
  useAudioPlayerStatus,
  useAudioRecorder,
} from 'expo-audio';
import { File } from 'expo-file-system';
import { Image } from 'expo-image';
import { useCallback, useEffect, useRef, useState } from 'react';
import { type ImageStyle, Pressable, type StyleProp, StyleSheet, Text, View } from 'react-native';
import { colors } from '../theme';
import { Mono, Muted, Stripes } from '../ui/primitives';
import type { Api } from './api';
import { useApp } from './app';
import type { PickedFile } from './media';
import { localUriFor } from './media';
import { type CachedUrl, downsamplePeaks, fallbackPeaks, isUrlFresh } from './mediaUtils';

/** 把同一帧里请求的链接合并成一次接口调用：回忆页一屏可能有几十张图。 */
class UrlBatcher {
  private cache = new Map<string, CachedUrl>();
  private waiting = new Map<string, ((url: string | null) => void)[]>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private api: Api) {}

  get(id: string, variant: MediaVariant): Promise<string | null> {
    const key = `${id}/${variant}`;
    const cached = this.cache.get(key);
    if (isUrlFresh(cached, Date.now())) return Promise.resolve(cached.url);
    return new Promise((resolve) => {
      const list = this.waiting.get(key) ?? [];
      list.push(resolve);
      this.waiting.set(key, list);
      this.timer ??= setTimeout(() => void this.flush(), 30);
    });
  }

  private async flush() {
    this.timer = null;
    const batch = [...this.waiting.entries()].slice(0, 200);
    for (const [key] of batch) this.waiting.delete(key);
    if (this.waiting.size > 0) this.timer = setTimeout(() => void this.flush(), 30);
    const items = batch.map(([key]) => {
      const [id, variant] = key.split('/') as [string, MediaVariant];
      return { id, variant };
    });
    let results = new Map<string, string | null>();
    try {
      const { urls } = await this.api.mediaUrls(items);
      results = new Map(urls.map((u) => [`${u.id}/${u.variant}`, u.url]));
      for (const u of urls) {
        if (u.url) {
          this.cache.set(`${u.id}/${u.variant}`, {
            url: u.url,
            expiresAt: Date.now() + u.expiresIn * 1000,
          });
        }
      }
    } catch {
      // 离线时拿不到链接：expo-image 的磁盘缓存仍可能显示已看过的图。
    }
    for (const [key, resolvers] of batch) {
      for (const resolve of resolvers) resolve(results.get(key) ?? null);
    }
  }
}

let batcher: { api: Api; instance: UrlBatcher } | null = null;

export function mediaUrlBatcher(api: Api): UrlBatcher {
  if (batcher?.api !== api) batcher = { api, instance: new UrlBatcher(api) };
  return batcher.instance;
}

/** 解析一个文件的显示地址：先用本地副本，否则取签名链接。 */
export function useMediaSource(media: MediaRef, variant: MediaVariant) {
  const { api, uploads } = useApp();
  const [source, setSource] = useState<{ uri: string; cacheKey: string } | null>(null);
  const effective = variant === 'thumb' && !media.hasThumb ? 'original' : variant;
  const pendingUpload = uploads.pendingIds().has(media.id);
  // pendingUpload 变化时要重新解析：本地副本在上传完成后会被删掉。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 见上
  useEffect(() => {
    let alive = true;
    const local = localUriFor(media.id, effective);
    if (local) {
      setSource({ uri: local, cacheKey: `${media.id}/${effective}` });
      return;
    }
    void mediaUrlBatcher(api)
      .get(media.id, effective)
      .then(async (url) => {
        if (!alive) return;
        if (url) {
          // 签名链接每次都变，用文件 id 做缓存键，否则同一张图会反复下载。
          setSource({ uri: url, cacheKey: `${media.id}/${effective}` });
          return;
        }
        // 缩略图可能还没传到，或这是家人刚传的：退回原图。
        if (effective === 'thumb') {
          const original = await mediaUrlBatcher(api).get(media.id, 'original');
          if (alive && original) setSource({ uri: original, cacheKey: `${media.id}/original` });
        }
      });
    return () => {
      alive = false;
    };
  }, [api, media.id, effective, pendingUpload]);
  return source;
}

export function MediaImage({
  media,
  variant,
  style,
  contentFit = 'cover',
}: {
  media: MediaRef;
  variant: MediaVariant;
  style?: StyleProp<ImageStyle>;
  width?: number;
  contentFit?: 'cover' | 'contain';
}) {
  const source = useMediaSource(media, variant);
  return (
    <View style={style as object}>
      <Stripes style={StyleSheet.absoluteFill} />
      {source ? (
        <Image
          testID={`media-${media.id}`}
          source={source}
          style={StyleSheet.absoluteFill}
          contentFit={contentFit}
          transition={200}
          cachePolicy="disk"
          accessibilityLabel={media.name ?? '照片'}
        />
      ) : null}
    </View>
  );
}

export function PlayBadge() {
  return (
    <View style={s.playBadge} pointerEvents="none">
      <View style={s.playTriangle} />
    </View>
  );
}

function Waveform({
  peaks,
  progress,
  height = 18,
}: {
  peaks: readonly number[];
  progress: number;
  height?: number;
}) {
  return (
    <View style={[s.wave, { height }]}>
      {peaks.map((p, i) => (
        <View
          // biome-ignore lint/suspicious/noArrayIndexKey: 波形点没有独立身份，顺序固定
          key={i}
          style={{
            width: 3,
            borderRadius: 2,
            height: Math.max(3, Math.round(p * height)),
            backgroundColor: i / peaks.length < progress ? colors.accent : colors.off,
          }}
        />
      ))}
    </View>
  );
}

/** 录音卡片。播放器只在点击后才加载文件，时间线上有很多录音时也不占资源。 */
export function AudioCard({ media }: { media: MediaRef }) {
  const [active, setActive] = useState(false);
  const peaks = media.peaks?.length ? media.peaks.slice(0, 28) : fallbackPeaks(media.id);
  const duration = media.durationMs ? formatMediaDuration(media.durationMs) : '';
  if (active) return <ActiveAudio media={media} peaks={peaks} duration={duration} />;
  return (
    <Pressable
      testID={`audio-${media.id}`}
      accessibilityRole="button"
      accessibilityLabel={`播放录音 ${media.name ?? ''}`}
      style={s.audio}
      onPress={() => setActive(true)}
    >
      <View style={[s.audioBtn, { backgroundColor: colors.ink }]}>
        <View style={s.audioTriangle} />
      </View>
      <View style={s.audioMain}>
        <Muted numberOfLines={1}>{media.name || '录音'}</Muted>
        <Waveform peaks={peaks} progress={0} />
      </View>
      <Mono style={s.audioDuration}>{duration}</Mono>
    </Pressable>
  );
}

function ActiveAudio({
  media,
  peaks,
  duration,
}: {
  media: MediaRef;
  peaks: readonly number[];
  duration: string;
}) {
  const source = useMediaSource(media, 'original');
  const player = useAudioPlayer(source ? { uri: source.uri } : null);
  const status = useAudioPlayerStatus(player);
  const started = useRef(false);
  useEffect(() => {
    if (source && status.isLoaded && !started.current) {
      started.current = true;
      player.play();
    }
  }, [source, status.isLoaded, player]);
  useEffect(() => {
    if (status.didJustFinish) void player.seekTo(0);
  }, [status.didJustFinish, player]);
  const progress = status.duration ? status.currentTime / status.duration : 0;
  const playing = status.playing;
  return (
    <Pressable
      testID={`audio-${media.id}`}
      accessibilityRole="button"
      accessibilityLabel={playing ? '暂停录音' : '播放录音'}
      accessibilityState={{ busy: !source }}
      style={s.audio}
      onPress={() => {
        if (playing) player.pause();
        else player.play();
      }}
    >
      <View style={[s.audioBtn, { backgroundColor: playing ? colors.accent : colors.ink }]}>
        {playing ? (
          <View style={{ flexDirection: 'row', gap: 3 }}>
            <View style={s.pauseBar} />
            <View style={s.pauseBar} />
          </View>
        ) : (
          <View style={s.audioTriangle} />
        )}
      </View>
      <View style={s.audioMain}>
        <Muted numberOfLines={1}>{media.name || '录音'}</Muted>
        <Waveform peaks={peaks} progress={progress} />
      </View>
      <Mono style={s.audioDuration}>{duration}</Mono>
    </Pressable>
  );
}

/** 录音：波形来自真实电平，保存在记录里，家人不用下载音频也能看到。 */
export function useRecorder() {
  const recorder = useAudioRecorder({ ...RecordingPresets.HIGH_QUALITY, isMeteringEnabled: true });
  const [recording, setRecording] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const samples = useRef<number[]>([]);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearTimer = useCallback(() => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
  }, []);

  useEffect(() => clearTimer, [clearTimer]);

  const start = useCallback(async () => {
    const permission = await requestRecordingPermissionsAsync();
    if (!permission.granted) return false;
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
    await recorder.prepareToRecordAsync();
    recorder.record();
    samples.current = [];
    setElapsedMs(0);
    setRecording(true);
    const startedAt = Date.now();
    timer.current = setInterval(() => {
      setElapsedMs(Date.now() - startedAt);
      const metering = recorder.getStatus().metering;
      if (typeof metering === 'number') samples.current.push(metering);
    }, 150);
    return true;
  }, [recorder]);

  const stop = useCallback(async (): Promise<PickedFile | null> => {
    clearTimer();
    const duration = elapsedMs;
    await recorder.stop();
    setRecording(false);
    await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
    const uri = recorder.uri;
    if (!uri) return null;
    const d = new Date();
    const stamp = `${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
    return {
      uri,
      kind: 'audio',
      mime: 'audio/mp4',
      size: new File(uri).size ?? 0,
      name: `录音 · ${stamp}`,
      durationMs: Math.max(1000, duration),
      peaks: downsamplePeaks(samples.current),
    };
  }, [recorder, elapsedMs, clearTimer]);

  return { recording, elapsedMs, start, stop };
}

/** 弹层里已选文件的小缩略图。 */
export function LocalThumb({ file, onRemove }: { file: PickedFile; onRemove: () => void }) {
  return (
    <View style={s.localThumb} testID="selected-media">
      <Stripes style={StyleSheet.absoluteFill} />
      {file.kind === 'image' || file.kind === 'video' ? (
        <Image source={{ uri: file.uri }} style={StyleSheet.absoluteFill} contentFit="cover" />
      ) : (
        <View style={s.localAudio}>
          <Mono weight="medium" style={{ fontSize: 11, color: colors.sleep, textAlign: 'center' }}>
            录音{'\n'}
            {file.durationMs ? formatMediaDuration(file.durationMs) : ''}
          </Mono>
        </View>
      )}
      {file.kind === 'video' && file.durationMs ? (
        <View style={s.localDuration}>
          <Mono weight="medium" style={{ fontSize: 9, color: colors.white }}>
            ▶ {formatMediaDuration(file.durationMs)}
          </Mono>
        </View>
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="移除"
        hitSlop={6}
        onPress={onRemove}
        style={s.remove}
      >
        <Text style={{ fontSize: 11, color: colors.white, lineHeight: 14 }}>×</Text>
      </Pressable>
    </View>
  );
}

const s = StyleSheet.create({
  playBadge: {
    position: 'absolute',
    left: '50%',
    top: '50%',
    width: 48,
    height: 48,
    marginLeft: -24,
    marginTop: -24,
    borderRadius: 24,
    backgroundColor: 'rgba(43,38,34,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  playTriangle: {
    width: 0,
    height: 0,
    marginLeft: 4,
    borderLeftWidth: 13,
    borderTopWidth: 8,
    borderBottomWidth: 8,
    borderLeftColor: colors.white,
    borderTopColor: 'transparent',
    borderBottomColor: 'transparent',
  },
  wave: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  audio: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 14,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
  },
  audioBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  audioTriangle: {
    width: 0,
    height: 0,
    marginLeft: 2,
    borderLeftWidth: 9,
    borderTopWidth: 6,
    borderBottomWidth: 6,
    borderLeftColor: colors.white,
    borderTopColor: 'transparent',
    borderBottomColor: 'transparent',
  },
  pauseBar: { width: 3, height: 11, backgroundColor: colors.white, borderRadius: 1 },
  audioMain: { flex: 1, minWidth: 0, gap: 4, overflow: 'hidden' },
  audioDuration: { fontSize: 12, color: colors.muted },
  localThumb: { width: 72, height: 72, borderRadius: 10, overflow: 'hidden' },
  localAudio: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  localDuration: {
    position: 'absolute',
    left: 4,
    bottom: 4,
    paddingHorizontal: 5,
    borderRadius: 999,
    backgroundColor: 'rgba(43,38,34,0.6)',
  },
  remove: {
    position: 'absolute',
    right: 3,
    top: 3,
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: 'rgba(43,38,34,0.7)',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
