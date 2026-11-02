import { formatBytes, t } from '@xiaodouya/shared';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { memo, useMemo } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  cancelUploads,
  momentsLeftEmpty,
  type UploadOwner,
  uploadOwners,
} from '../data/uploadCancel';
import type { UploadItem } from '../data/uploadQueue';
import { useApp, useRecords, useUploadProgress } from '../lib/app';
import { localUriFor } from '../lib/media';
import { uploadCardStatus, uploadCountsText, uploadSpeedText } from '../lib/uploadStatus';
import { colors, spacing } from '../theme';
import { useFeedback, useSheet } from '../ui/overlays';
import { Button, Empty, Mono, Muted, PageTitle, Stripes } from '../ui/primitives';

function statusLabel(item: UploadItem): string {
  const ui = t().ui;
  return {
    uploading: ui.uploadStatusUploading,
    queued: ui.uploadStatusQueued,
    waitingWifi: ui.uploadStatusWifi,
    waitingNetwork: ui.uploadStatusOffline,
    retrying: ui.uploadStatusRetrying,
    failed: ui.uploadStatusFailed,
  }[item.status];
}

function ownerLabel(owner: UploadOwner | undefined): string {
  const ui = t().ui;
  if (!owner) return ui.uploadOwnerUnknown;
  if (owner.kind === 'avatar') return ui.uploadOwnerAvatar;
  if (owner.kind === 'document') return ui.uploadOwnerDocument(owner.title);
  return ui.uploadOwnerMoment(owner.title || ui.thisMoment);
}

function kindLabel(kind: UploadItem['kind']): string {
  const ui = t().ui;
  return {
    image: ui.uploadKindImage,
    video: ui.uploadKindVideo,
    audio: ui.uploadKindAudio,
    pdf: ui.uploadKindPdf,
  }[kind];
}

function ItemThumb({ item }: { item: UploadItem }) {
  // 缩略图传完就从手机上删了，照片还能看原图；视频解码不了，就只写类型。
  const uri = useMemo(
    () =>
      localUriFor(item.id, 'thumb') ??
      (item.kind === 'image' ? localUriFor(item.id, 'original') : null),
    [item.id, item.kind],
  );
  return (
    <View style={s.thumb}>
      <Stripes style={StyleSheet.absoluteFill} />
      {uri ? (
        <Image source={{ uri }} style={StyleSheet.absoluteFill} contentFit="cover" />
      ) : (
        <View style={s.thumbLabel}>
          <Text style={s.thumbLabelText}>{kindLabel(item.kind)}</Text>
        </View>
      )}
    </View>
  );
}

const ItemRow = memo(
  function ItemRow({
    item,
    owner,
    onCancel,
  }: {
    item: UploadItem;
    owner: UploadOwner | undefined;
    onCancel: (item: UploadItem) => void;
  }) {
    const percent = item.size > 0 ? Math.min(100, Math.round((item.sent / item.size) * 100)) : 0;
    const name = item.name ?? kindLabel(item.kind);
    const failed = item.status === 'failed';
    return (
      <View style={s.row} testID={`upload-item-${item.id}`}>
        <ItemThumb item={item} />
        <View style={s.rowMain}>
          <Text style={s.name} numberOfLines={1}>
            {name}
          </Text>
          <Muted style={s.owner} numberOfLines={1}>
            {ownerLabel(owner)}
          </Muted>
          <View style={s.rowProgress}>
            <Text
              testID={`upload-status-${item.id}`}
              style={[s.status, failed ? { color: colors.danger } : null]}
              numberOfLines={failed ? 2 : 1}
            >
              {failed && item.reason ? item.reason : statusLabel(item)}
            </Text>
            <Mono style={s.bytes}>
              {t().ui.uploadOf(formatBytes(item.sent), formatBytes(item.size))}
            </Mono>
          </View>
          <View style={s.track}>
            <View
              style={[
                s.fill,
                { width: `${percent}%` },
                failed ? { backgroundColor: colors.danger } : null,
              ]}
            />
          </View>
        </View>
        <Pressable
          testID={`upload-cancel-${item.id}`}
          accessibilityRole="button"
          accessibilityLabel={t().ui.uploadCancelOne(name)}
          hitSlop={12}
          onPress={() => onCancel(item)}
        >
          <Text style={s.cancel}>{t().ui.uploadCancel}</Text>
        </Pressable>
      </View>
    );
  },
  (a, b) =>
    a.onCancel === b.onCancel &&
    a.owner === b.owner &&
    a.item.id === b.item.id &&
    a.item.sent === b.item.sent &&
    a.item.status === b.item.status &&
    a.item.reason === b.item.reason &&
    a.item.size === b.item.size,
);

function CancelSheet({ ids }: { ids: string[] }) {
  const app = useApp();
  const records = useRecords();
  const sheet = useSheet();
  const { toast } = useFeedback();
  const emptied = momentsLeftEmpty(records, new Set(ids));
  return (
    <>
      <Muted style={{ fontSize: 13, lineHeight: 21 }}>{t().ui.uploadCancelWarn}</Muted>
      {emptied > 0 ? (
        <Muted testID="upload-cancel-empty-note" style={{ fontSize: 13, lineHeight: 21 }}>
          {t().ui.uploadCancelEmptyMoments(emptied)}
        </Muted>
      ) : null}
      <Button
        testID="upload-cancel-confirm"
        tone="dark"
        label={t().ui.uploadCancelConfirm}
        onPress={() => {
          sheet.close();
          cancelUploads(ids, { records, write: app.write, queue: app.uploads }).then(
            () => toast(t().ui.uploadsCancelled),
            () => toast(t().ui.uploadCancelFailed),
          );
        }}
      />
      <Button
        testID="upload-cancel-keep"
        tone="ghost"
        height={44}
        label={t().ui.uploadCancelKeep}
        onPress={() => sheet.close()}
      />
    </>
  );
}

/** 上传详情：每个文件传到哪了、在等什么、为什么失败，以及不想传了怎么办。 */
export function UploadsScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const sheet = useSheet();
  const app = useApp();
  const progress = useUploadProgress();
  const records = useRecords();
  const owners = useMemo(() => uploadOwners(records), [records]);
  const { items } = progress;
  const hasFailed = progress.failedCount > 0;
  const percent = Math.round(progress.fraction * 100);
  const speed = uploadSpeedText(progress);

  const confirmOne = useMemo(
    () => (item: UploadItem) =>
      sheet.open(t().ui.uploadCancelOneTitle, () => <CancelSheet ids={[item.id]} />),
    [sheet],
  );
  const confirmAll = () => {
    const counts = {
      image: progress.counts.image + progress.failedCounts.image,
      video: progress.counts.video + progress.failedCounts.video,
      audio: progress.counts.audio + progress.failedCounts.audio,
      pdf: progress.counts.pdf + progress.failedCounts.pdf,
    };
    const summary = uploadCountsText(counts);
    sheet.open(t().ui.uploadCancelAllTitle(summary), () => (
      <CancelSheet ids={items.map((i) => i.id)} />
    ));
  };

  return (
    <View style={s.root} testID="uploads-screen">
      <View style={[s.header, { paddingTop: insets.top + 8 }]}>
        <View style={s.topRow}>
          <Pressable
            testID="uploads-back"
            accessibilityRole="button"
            accessibilityLabel={t().common.back}
            hitSlop={12}
            onPress={() => router.back()}
          >
            <Text style={s.back}>{t().auth.backLink}</Text>
          </Pressable>
          {items.length > 0 ? (
            <Pressable
              testID="uploads-cancel-all"
              accessibilityRole="button"
              accessibilityLabel={t().ui.uploadCancelAll}
              hitSlop={12}
              onPress={confirmAll}
            >
              <Text style={s.link}>{t().ui.uploadCancelAll}</Text>
            </Pressable>
          ) : null}
        </View>
        <PageTitle>{t().ui.uploadsTitle}</PageTitle>
      </View>
      {items.length === 0 ? (
        <View testID="uploads-empty" style={s.emptyWrap}>
          {progress.finishedInBatch > 0 ? (
            <Empty title={t().ui.uploadsAllDone} sub={t().ui.uploadsAllDoneSub} />
          ) : (
            <Empty title={t().ui.uploadsNothing} sub={t().ui.uploadsNothingSub} />
          )}
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(item) => item.id}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}
          ListHeaderComponent={
            <View style={s.summary} testID="uploads-summary">
              <Text testID="uploads-summary-text" style={s.summaryText}>
                {uploadCardStatus(progress).text}
              </Text>
              <View style={s.summaryLine}>
                <Mono testID="uploads-speed" style={s.speed}>
                  {speed ?? ' '}
                </Mono>
                <Mono style={s.speed}>{percent}%</Mono>
              </View>
              <View style={s.track}>
                <View style={[s.fill, { width: `${percent}%` }]} />
              </View>
              {hasFailed ? (
                <Button
                  testID="uploads-retry"
                  tone="outline"
                  height={40}
                  label={t().common.retry}
                  onPress={() => void app.uploads.retryFailed()}
                />
              ) : null}
            </View>
          }
          renderItem={({ item }) => (
            <ItemRow item={item} owner={owners.get(item.id)} onCancel={confirmOne} />
          )}
        />
      )}
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.paper },
  header: { paddingHorizontal: spacing.page, gap: 8 },
  topRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  back: { fontSize: 14, color: colors.muted, padding: 4, marginLeft: -4 },
  link: { fontSize: 13, color: colors.accent, padding: 4 },
  emptyWrap: { flex: 1, justifyContent: 'center', paddingBottom: 80 },
  summary: {
    marginHorizontal: spacing.page,
    marginTop: 14,
    marginBottom: 6,
    padding: 14,
    gap: 8,
    borderRadius: 14,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
  },
  summaryText: { fontSize: 14, color: colors.ink },
  summaryLine: { flexDirection: 'row', justifyContent: 'space-between', gap: 10 },
  speed: { fontSize: 12, color: colors.muted },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginHorizontal: spacing.page,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#efe7dc',
  },
  thumb: {
    width: 48,
    height: 48,
    borderRadius: 10,
    overflow: 'hidden',
    backgroundColor: colors.sand,
  },
  thumbLabel: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  thumbLabelText: { fontSize: 11, color: colors.inkSoft },
  rowMain: { flex: 1, gap: 3 },
  name: { fontSize: 14, color: colors.ink },
  owner: { fontSize: 11 },
  rowProgress: { flexDirection: 'row', justifyContent: 'space-between', gap: 8, marginTop: 3 },
  status: { fontSize: 11, color: colors.muted, flexShrink: 1 },
  bytes: { fontSize: 11, color: colors.muted },
  track: { height: 4, borderRadius: 2, backgroundColor: '#efe7dc', overflow: 'hidden' },
  fill: { height: '100%', backgroundColor: colors.accent },
  cancel: { fontSize: 13, color: colors.muted, padding: 4 },
});
