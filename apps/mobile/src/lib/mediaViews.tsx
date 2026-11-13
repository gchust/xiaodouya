import { formatMediaDuration, type MediaRef, type MediaVariant, t } from '@xiaodouya/shared';
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
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  type ImageStyle,
  Pressable,
  type StyleProp,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { colors, themedStyles } from '../theme';
import { useFeedback } from '../ui/overlays';
import { Mono, Muted, Stripes } from '../ui/primitives';
import type { Api } from './api';
import { useApp, useSyncStatus } from './app';
import { DownloadButton } from './DownloadButton';
import type { PickedFile } from './media';
import { localOriginalCopy, localUriFor } from './media';
import {
  type CachedUrl,
  createExclusivePlayback,
  downsamplePeaks,
  fallbackPeaks,
  isUrlFresh,
  mediaRetryDelayMs,
} from './mediaUtils';

/** 把同一帧里请求的链接合并成一次接口调用：回忆页一屏可能有几十张图。 */
class UrlBatcher {
  private cache = new Map<string, CachedUrl>();
  private waiting = new Map<string, ((url: string | null | undefined) => void)[]>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private api: Api) {}

  async get(id: string, variant: MediaVariant): Promise<string | null> {
    return (await this.lookup(id, variant)) ?? null;
  }

  /** undefined 表示没问到（断网），null 表示服务端说没有。离线时不能告诉用户“还没传完”。 */
  lookup(id: string, variant: MediaVariant): Promise<string | null | undefined> {
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
    let results: Map<string, string | null> | null = null;
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
      for (const resolve of resolvers) resolve(results ? (results.get(key) ?? null) : undefined);
    }
  }
}

export interface MediaSource {
  uri: string;
  cacheKey: string;
}

let batcher: { api: Api; instance: UrlBatcher } | null = null;

export function mediaUrlBatcher(api: Api): UrlBatcher {
  if (batcher?.api !== api) batcher = { api, instance: new UrlBatcher(api) };
  return batcher.instance;
}

/**
 * 链接取不到时什么时候再取。离线时不空转，靠这里在同步结束后补一次。只看回到 idle：
 * 恢复联网或刚同步到新数据时才可能拿到链接，每次状态变化都取的话，家人频繁同步时退避的定时器会一直被清掉。
 * 恢复联网后重新从最短的间隔开始。
 */
function useUrlRetry(settled: boolean) {
  const syncStatus = useSyncStatus();
  const [retry, setRetry] = useState(0);
  const failures = useRef(0);
  const offline = useRef(syncStatus === 'offline');
  const lastStatus = useRef(syncStatus);
  useEffect(() => {
    const wasOffline = lastStatus.current === 'offline';
    const changed = lastStatus.current !== syncStatus;
    lastStatus.current = syncStatus;
    offline.current = syncStatus === 'offline';
    if (!changed || settled || syncStatus !== 'idle') return;
    if (wasOffline) failures.current = 0;
    setRetry((n) => n + 1);
  }, [syncStatus, settled]);
  const schedule = useCallback((): ReturnType<typeof setTimeout> | null => {
    if (offline.current) return null;
    const delay = mediaRetryDelayMs(failures.current);
    failures.current += 1;
    return setTimeout(() => setRetry((n) => n + 1), delay);
  }, []);
  const succeeded = useCallback(() => {
    failures.current = 0;
  }, []);
  return { retry, schedule, succeeded };
}

/**
 * 解析一个文件的显示地址：先用本地副本，否则取签名链接。
 * thumbOnly：只用缩略图（证件卡片）。拿不到时不退回服务端的原图，返回 null 由调用方显示占位；
 * 离线时用看过之后留在 expo-image 磁盘缓存里的那份（退出登录时清掉）。
 */
export function useMediaSource(
  media: MediaRef,
  variant: MediaVariant,
  options?: { thumbOnly?: boolean },
) {
  const { api, uploads } = useApp();
  const [source, setSource] = useState<MediaSource | null>(null);
  const thumbOnly = options?.thumbOnly === true;
  const effective = thumbOnly
    ? 'thumb'
    : variant === 'thumb' && !media.hasThumb
      ? 'original'
      : variant;
  const pendingUpload = uploads.pendingIds().has(media.id);
  const { retry, schedule, succeeded } = useUrlRetry(source !== null);

  // pendingUpload 变化时要重新解析：本地副本在上传完成后会被删掉。
  // retry 变化时再取一次：链接是空的（离线，或家人还没传完），之后才可能拿到。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 见上
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const local = localUriFor(media.id, effective);
    if (local) {
      setSource({ uri: local, cacheKey: `${media.id}/${effective}` });
      return;
    }
    // 缩略图在队列里排队时先显示本地原图，不然刚保存的照片要等上传才看得到。视频不行：原图不是图片。
    const localOriginal =
      effective === 'thumb' && media.kind === 'image' ? localUriFor(media.id, 'original') : null;
    if (localOriginal) {
      setSource({ uri: localOriginal, cacheKey: `${media.id}/original` });
      return;
    }
    const resolve = async () => {
      const batcher = mediaUrlBatcher(api);
      const url = await batcher.lookup(media.id, effective);
      if (!alive) return;
      if (url) {
        // 签名链接每次都变，用文件 id 做缓存键，否则同一张图会反复下载。
        succeeded();
        setSource({ uri: url, cacheKey: `${media.id}/${effective}` });
        return;
      }
      if (thumbOnly) {
        const cached = url === undefined ? await cachedImageUri(`${media.id}/thumb`) : null;
        if (!alive) return;
        if (cached) setSource({ uri: cached, cacheKey: `${media.id}/thumb` });
        else timer = schedule();
        return;
      }
      // 缩略图可能还没传到，或这是家人刚传的：退回原图。
      if (effective === 'thumb') {
        const original = await batcher.get(media.id, 'original');
        if (!alive) return;
        if (original) {
          succeeded();
          setSource({ uri: original, cacheKey: `${media.id}/original` });
          return;
        }
      }
      timer = schedule();
    };
    void resolve();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [api, media.id, effective, thumbOnly, pendingUpload, retry]);
  return source;
}

/** expo-image 磁盘缓存里这个缓存键对应的文件。没有或读不到时是 null。 */
async function cachedImageUri(cacheKey: string): Promise<string | null> {
  try {
    const path = await Image.getCachePathAsync(cacheKey);
    if (!path) return null;
    const uri = path.startsWith('file:') ? path : `file://${path}`;
    return new File(uri).exists ? uri : null;
  } catch {
    return null;
  }
}

export interface PhotoSources {
  answered: boolean;
  localOriginal: boolean;
  thumb: MediaSource | null;
  preview: MediaSource | null;
  original: MediaSource | null;
}

const NO_SOURCES: PhotoSources = {
  answered: false,
  localOriginal: false,
  thumb: null,
  preview: null,
  original: null,
};

/**
 * 查看器一张照片的所有来源。三个变体在同一批里问，打开一张照片只多签两个名字，不多一次请求。
 * 不退回原图：useMediaSource 取不到缩略图时会下载原图，这里不能让占位图花掉原图的流量。
 * active 为 false 时不取：列表会提前挂载前后很多页，不能一打开就下载十几张预览。
 */
export function usePhotoSources(media: MediaRef, active: boolean): PhotoSources {
  const { api, uploads } = useApp();
  const [sources, setSources] = useState<PhotoSources>(NO_SOURCES);
  const pendingUpload = uploads.pendingIds().has(media.id);
  const settled = sources.localOriginal || sources.original !== null;
  const { retry, schedule, succeeded } = useUrlRetry(settled);

  // pendingUpload 变化时要重新解析：原图传完后本地副本就删了。
  // retry 变化时再取一次：家人可能还没传完，要等原图好了才能打开“查看原图”。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 见上
  useEffect(() => {
    if (!active) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const sourceOf = (variant: MediaVariant, uri: string | null | undefined) =>
      uri ? { uri, cacheKey: `${media.id}/${variant}` } : null;
    const resolve = async () => {
      const local = await localOriginalCopy(media);
      if (!alive) return;
      if (local) {
        setSources({
          ...NO_SOURCES,
          localOriginal: true,
          original: sourceOf('original', local),
        });
        return;
      }
      const batcher = mediaUrlBatcher(api);
      const remote = (variant: MediaVariant) => {
        const copy = localUriFor(media.id, variant);
        return copy ? Promise.resolve(copy) : batcher.lookup(media.id, variant);
      };
      const [thumb, preview, original] = await Promise.all([
        media.hasThumb ? remote('thumb') : null,
        remote('preview'),
        batcher.lookup(media.id, 'original'),
      ]);
      if (!alive) return;
      const answered = original !== undefined;
      // 断网时别的都没问到：已经拿到的链接还能用，不能因为这一轮没问到就清掉。
      setSources((before) => ({
        answered: answered || before.answered,
        localOriginal: false,
        thumb: sourceOf('thumb', thumb) ?? before.thumb,
        preview: sourceOf('preview', preview) ?? before.preview,
        original: sourceOf('original', original) ?? before.original,
      }));
      if (original) succeeded();
      else timer = schedule();
    };
    void resolve();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [api, media.id, media.hasThumb, media.size, media.kind, active, pendingUpload, retry]);
  return sources;
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
      {/* contain 模式会留白，留白处要显示背景（查看器是黑底），不能露出占位条纹。 */}
      {contentFit === 'contain' && source ? null : <Stripes style={StyleSheet.absoluteFill} />}
      {source ? (
        <Image
          testID={`media-${media.id}`}
          source={source}
          style={StyleSheet.absoluteFill}
          contentFit={contentFit}
          transition={200}
          cachePolicy="disk"
          accessibilityLabel={media.name ?? t().ui.photo}
        />
      ) : null}
    </View>
  );
}

/**
 * 证件卡片上的缩略图。只用缩略图，拿不到时什么都不画，下面的类型标记露出来。
 * 磁盘缓存在 App 的缓存目录，退出登录和删除账号时随 clearLocalMedia 清掉。
 */
export function DocumentThumb({
  media,
  testID,
  style,
}: {
  media: MediaRef;
  testID: string;
  style?: StyleProp<ImageStyle>;
}) {
  const source = useMediaSource(media, 'thumb', { thumbOnly: true });
  if (!source) return null;
  return (
    <Image
      testID={testID}
      source={source}
      style={style}
      contentFit="cover"
      transition={200}
      cachePolicy="disk"
    />
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
export function AudioCard({ media, fileName }: { media: MediaRef; fileName: string }) {
  const [active, setActive] = useState(false);
  const peaks = media.peaks?.length ? media.peaks.slice(0, 28) : fallbackPeaks(media.id);
  const duration = media.durationMs ? formatMediaDuration(media.durationMs) : '';
  const download = (
    <DownloadButton media={media} fileName={fileName} testID={`audio-download-${media.id}`} />
  );
  if (active) {
    return (
      <ActiveAudio
        media={media}
        peaks={peaks}
        duration={duration}
        download={download}
        onFail={() => setActive(false)}
      />
    );
  }
  return (
    <Pressable
      testID={`audio-${media.id}`}
      accessibilityRole="button"
      accessibilityLabel={t().ui.playRecordingNamed(media.name ?? '')}
      style={s.audio}
      onPress={() => setActive(true)}
    >
      <View style={[s.audioBtn, { backgroundColor: colors.ink }]}>
        <View style={s.audioTriangle} />
      </View>
      <View style={s.audioMain}>
        <Muted numberOfLines={1}>{media.name || t().ui.recording}</Muted>
        <Waveform peaks={peaks} progress={0} />
      </View>
      <Mono style={s.audioDuration}>{duration}</Mono>
      {download}
    </Pressable>
  );
}

const audioPlayback = createExclusivePlayback<{ pause(): void }>();
/** 这么久还没加载好就告诉用户。链接取不到时不会有任何错误事件，只能靠超时。 */
const AUDIO_LOAD_TIMEOUT_MS = 20_000;

function ActiveAudio({
  media,
  peaks,
  duration,
  download,
  onFail,
}: {
  media: MediaRef;
  peaks: readonly number[];
  duration: string;
  download: ReactNode;
  onFail: () => void;
}) {
  const source = useMediaSource(media, 'original');
  const player = useAudioPlayer(source ? { uri: source.uri } : null);
  const status = useAudioPlayerStatus(player);
  const { toast } = useFeedback();
  const started = useRef(false);
  const failRef = useRef(() => {});
  failRef.current = () => {
    toast(t().ui.recordingUnavailable);
    onFail();
  };
  const play = useCallback(() => {
    audioPlayback.claim(player);
    player.play();
  }, [player]);
  useEffect(() => () => audioPlayback.release(player), [player]);
  useEffect(() => {
    if (source && status.isLoaded && !started.current) {
      started.current = true;
      play();
    }
  }, [source, status.isLoaded, play]);
  useEffect(() => {
    if (status.didJustFinish) void player.seekTo(0);
  }, [status.didJustFinish, player]);
  useEffect(() => {
    if (status.error) failRef.current();
  }, [status.error]);
  const loading = !status.isLoaded;
  useEffect(() => {
    if (!loading) return;
    const timer = setTimeout(() => failRef.current(), AUDIO_LOAD_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [loading]);
  const progress = status.duration ? status.currentTime / status.duration : 0;
  const playing = status.playing;
  return (
    <Pressable
      testID={`audio-${media.id}`}
      accessibilityRole="button"
      accessibilityLabel={
        loading ? t().ui.recordingLoading : playing ? t().ui.pauseRecording : t().ui.playRecording
      }
      accessibilityState={{ busy: loading }}
      disabled={loading}
      style={s.audio}
      onPress={() => {
        if (playing) player.pause();
        else play();
      }}
    >
      <View style={[s.audioBtn, { backgroundColor: playing ? colors.accentFill : colors.ink }]}>
        {loading ? (
          <ActivityIndicator size="small" color={playing ? colors.onAccent : colors.paper} />
        ) : playing ? (
          <View style={{ flexDirection: 'row', gap: 3 }}>
            <View style={s.pauseBar} />
            <View style={s.pauseBar} />
          </View>
        ) : (
          <View style={s.audioTriangle} />
        )}
      </View>
      <View style={s.audioMain}>
        <Muted numberOfLines={1}>{media.name || t().ui.recording}</Muted>
        <Waveform peaks={peaks} progress={progress} />
      </View>
      <Mono style={s.audioDuration}>{duration}</Mono>
      {download}
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
      name: t().ui.recordingAt(stamp),
      durationMs: Math.max(1000, duration),
      peaks: downsamplePeaks(samples.current),
    };
  }, [recorder, elapsedMs, clearTimer]);

  return { recording, elapsedMs, start, stop };
}

/** 修改回忆时，已经在记录里的文件。样子和刚选的一样，用户不需要区分。 */
export function ExistingThumb({
  media,
  cover = false,
  onRemove,
}: {
  media: MediaRef;
  /** 时间线上用它当封面。移除后封面回到第一个，所以要让人看得到。 */
  cover?: boolean;
  onRemove: () => void;
}) {
  const visual = media.kind === 'image' || media.kind === 'video';
  return (
    <View style={s.localThumb} testID="existing-media">
      {visual ? (
        <MediaImage media={media} variant="thumb" style={StyleSheet.absoluteFill} />
      ) : (
        <>
          <Stripes style={StyleSheet.absoluteFill} />
          <View style={s.localAudio}>
            <Mono
              weight="medium"
              style={{ fontSize: 11, color: colors.sleepText, textAlign: 'center' }}
            >
              {t().ui.recordingLabel(media.durationMs ? formatMediaDuration(media.durationMs) : '')}
            </Mono>
          </View>
        </>
      )}
      {media.kind === 'video' && media.durationMs ? (
        <View style={s.localDuration}>
          <Mono weight="medium" style={{ fontSize: 9, color: colors.white }}>
            ▶ {formatMediaDuration(media.durationMs)}
          </Mono>
        </View>
      ) : null}
      {cover ? (
        <View style={s.coverTag} testID="existing-media-cover">
          <Text style={s.coverTagText}>{t().recall.isCover}</Text>
        </View>
      ) : null}
      <Pressable
        testID="existing-media-remove"
        accessibilityRole="button"
        accessibilityLabel={t().ui.removeFromMemory}
        // 同 LocalThumb：缩略图裁剪了溢出，热区只能往图内扩。
        hitSlop={{ top: 3, right: 3, bottom: 23, left: 23 }}
        onPress={onRemove}
        style={s.remove}
      >
        <Text style={{ fontSize: 11, color: colors.white, lineHeight: 14 }}>×</Text>
      </Pressable>
    </View>
  );
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
          <Mono
            weight="medium"
            style={{ fontSize: 11, color: colors.sleepText, textAlign: 'center' }}
          >
            {t().ui.recordingLabel(file.durationMs ? formatMediaDuration(file.durationMs) : '')}
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
        testID="selected-media-remove"
        accessibilityRole="button"
        accessibilityLabel={t().common.remove}
        // 缩略图裁剪了溢出，热区只能往图内扩：上右到图边，下左补足 44。
        hitSlop={{ top: 3, right: 3, bottom: 23, left: 23 }}
        onPress={onRemove}
        style={s.remove}
      >
        <Text style={{ fontSize: 11, color: colors.white, lineHeight: 14 }}>×</Text>
      </Pressable>
    </View>
  );
}

const s = themedStyles(() => ({
  playBadge: {
    position: 'absolute',
    left: '50%',
    top: '50%',
    width: 48,
    height: 48,
    marginLeft: -24,
    marginTop: -24,
    borderRadius: 24,
    backgroundColor: colors.veilSoft,
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
    // 在 ink 底的按钮上，深色模式下 ink 是浅色。
    borderLeftColor: colors.paper,
    borderTopColor: 'transparent',
    borderBottomColor: 'transparent',
  },
  pauseBar: { width: 3, height: 11, backgroundColor: colors.onAccent, borderRadius: 1 },
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
    backgroundColor: colors.veil,
  },
  coverTag: {
    position: 'absolute',
    left: 4,
    top: 4,
    paddingHorizontal: 5,
    borderRadius: 999,
    backgroundColor: colors.accentFill,
  },
  coverTagText: { fontSize: 9, lineHeight: 14, color: colors.onAccent },
  remove: {
    position: 'absolute',
    right: 3,
    top: 3,
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: colors.veilStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
}));
