import {
  expiredAttachmentCount,
  type FeedbackInboxItem,
  feedbackAttachmentFileName,
  formatBytes,
  formatClock,
  formatMonthDay,
  t,
} from '@xiaodouya/shared';
import { Image } from 'expo-image';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ApiFailure } from '../lib/api';
import { useApp } from '../lib/app';
import { DownloadButton } from '../lib/DownloadButton';
import { DownloadGone } from '../lib/downloadCore';
import {
  appendInboxPage,
  inboxAttachmentRows,
  inboxStatusText,
  shortFeedbackId,
} from '../lib/feedbackInbox';
import { colors, fonts, spacing, themedStyles } from '../theme';
import {
  Button,
  Empty,
  ListCard,
  Mono,
  Muted,
  PageTitle,
  Row,
  SectionTitle,
} from '../ui/primitives';
import { Text } from '../ui/Text';
import { VideoPlayer, ZoomableImage } from './ViewerScreen';

/**
 * 收到的反馈：维护者在 App 里看用户发来的文字和附件（F-125）。附件不在公开的 issue 里，只能在这里或
 * `cli feedback` 看。入口只给服务端说 canViewFeedback 的账号，接口本身也只认服务端的名单。
 * 照片和视频可能拍到别人家的孩子：图片只放内存缓存，下载按证件处理（不进相册，先说明）。
 */

const errorText = (error: unknown) =>
  error instanceof ApiFailure ? error.message : t().ui.networkError;

const when = (ms: number) => `${formatMonthDay(ms)} ${formatClock(ms)}`;

function BackLink({ label, a11y, testID }: { label: string; a11y: string; testID: string }) {
  const router = useRouter();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={a11y}
      hitSlop={12}
      onPress={() => router.back()}
    >
      <Text style={s.back}>{label}</Text>
    </Pressable>
  );
}

export function FeedbackInboxScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { api } = useApp();
  const [items, setItems] = useState<FeedbackInboxItem[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const loadFirst = useCallback(async () => {
    setError(null);
    try {
      const page = await api.feedbackInbox();
      setItems(page.items);
      setNext(page.next);
    } catch (e) {
      setError(errorText(e));
    }
  }, [api]);

  useEffect(() => {
    void loadFirst();
  }, [loadFirst]);

  const refresh = async () => {
    setRefreshing(true);
    await loadFirst();
    setRefreshing(false);
  };

  const loadMore = async () => {
    if (!next || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await api.feedbackInbox(next);
      setItems((before) => appendInboxPage(before ?? [], page.items));
      setNext(page.next);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <ScrollView
      testID="feedback-inbox-screen"
      style={s.root}
      contentContainerStyle={[
        s.content,
        { paddingTop: insets.top + 8, paddingBottom: insets.bottom + 32 },
      ]}
      showsVerticalScrollIndicator={false}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => void refresh()}
          colors={[colors.accent]}
          progressBackgroundColor={colors.card}
        />
      }
    >
      <View style={{ gap: 8 }}>
        <BackLink
          label={t().feedback.back}
          a11y={t().feedback.backA11y}
          testID="feedback-inbox-back"
        />
        <PageTitle>{t().feedback.inboxTitle}</PageTitle>
      </View>
      <View style={s.hint} testID="feedback-inbox-note">
        <Text style={s.hintText}>{t().feedback.inboxNote}</Text>
      </View>

      {error && !items ? (
        <View style={{ gap: 12 }} testID="feedback-inbox-error">
          <Text style={s.error}>{t().feedback.inboxLoadFailed(error)}</Text>
          <Button
            testID="feedback-inbox-retry"
            tone="outline"
            label={t().feedback.inboxRetry}
            onPress={() => void loadFirst()}
          />
        </View>
      ) : !items ? (
        <ActivityIndicator color={colors.accent} style={{ paddingVertical: 24 }} />
      ) : items.length === 0 ? (
        <View testID="feedback-inbox-empty">
          <Empty title={t().feedback.inboxEmpty} sub={t().feedback.inboxEmptySub} />
        </View>
      ) : (
        <ListCard>
          {items.map((item, i) => {
            const attachments = item.attachmentCount;
            return (
              <Pressable
                key={item.id}
                testID={`feedback-inbox-item-${item.id}`}
                accessibilityRole="button"
                accessibilityLabel={t().feedback.inboxOpenA11y(item.text.slice(0, 40))}
                onPress={() =>
                  router.push({ pathname: '/feedback-inbox/[id]', params: { id: item.id } })
                }
                style={[s.itemRow, i === items.length - 1 ? null : s.divider]}
              >
                <Text style={s.itemText} numberOfLines={2}>
                  {item.text}
                </Text>
                <View style={s.itemMeta}>
                  <Muted style={{ fontSize: 11 }}>
                    {when(item.createdAt)}
                    {t().feedback.attachmentCount(attachments)}
                  </Muted>
                  <Text
                    style={{
                      fontSize: 11,
                      color: item.status === 'sent' ? colors.greenText : colors.muted,
                    }}
                  >
                    {inboxStatusText(item.status)}
                  </Text>
                </View>
              </Pressable>
            );
          })}
        </ListCard>
      )}

      {items && error ? <Text style={s.error}>{t().feedback.inboxLoadFailed(error)}</Text> : null}
      {items && next ? (
        <Button
          testID="feedback-inbox-more"
          tone="outline"
          label={loadingMore ? t().feedback.inboxLoadingMore : t().feedback.inboxMore}
          busy={loadingMore}
          onPress={() => void loadMore()}
        />
      ) : null}
    </ScrollView>
  );
}

export function FeedbackDetailScreen({ id }: { id: string }) {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { api } = useApp();
  const [item, setItem] = useState<FeedbackInboxItem | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setItem(await api.feedbackInboxItem(id));
    } catch (e) {
      setError(errorText(e));
    }
  }, [api, id]);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = item ? inboxAttachmentRows(item) : [];
  const showError = Boolean(item?.lastError && item.status === 'queued');
  const expired = item ? expiredAttachmentCount(item) : 0;
  // 每次点下载都现取一个链接：签名 10 分钟就过期，不能用打开页面时取的。
  const freshUrl = (attachmentId: string) => async () => {
    try {
      return (await api.feedbackAttachmentUrl(id, attachmentId)).url;
    } catch (e) {
      if (e instanceof ApiFailure && e.status === 410) throw new DownloadGone();
      throw e;
    }
  };

  return (
    <ScrollView
      testID="feedback-detail-screen"
      style={s.root}
      contentContainerStyle={[
        s.content,
        { paddingTop: insets.top + 8, paddingBottom: insets.bottom + 32 },
      ]}
      showsVerticalScrollIndicator={false}
    >
      <View style={{ gap: 8 }}>
        <BackLink
          label={t().feedback.detailBack}
          a11y={t().feedback.detailBackA11y}
          testID="feedback-detail-back"
        />
        <PageTitle>{t().feedback.detailTitle(shortFeedbackId(id))}</PageTitle>
      </View>

      {error && !item ? (
        <View style={{ gap: 12 }} testID="feedback-detail-error">
          <Text style={s.error}>{t().feedback.inboxLoadFailed(error)}</Text>
          <Button
            testID="feedback-detail-retry"
            tone="outline"
            label={t().feedback.inboxRetry}
            onPress={() => void load()}
          />
        </View>
      ) : !item ? (
        <ActivityIndicator color={colors.accent} style={{ paddingVertical: 24 }} />
      ) : (
        <>
          <View style={s.card} testID="feedback-detail-text">
            <Text selectable style={s.bodyText}>
              {item.text}
            </Text>
          </View>

          <View style={{ gap: 8 }}>
            <SectionTitle>{t().feedback.detailAttachments}</SectionTitle>
            {rows.length > 0 ? (
              <ListCard>
                {rows.map((row, i) => (
                  <View
                    key={row.attachment.id}
                    style={[s.attachmentRow, i === rows.length - 1 ? null : s.divider]}
                  >
                    <Pressable
                      testID={`feedback-attachment-${i}`}
                      accessibilityRole="button"
                      accessibilityLabel={t().feedback.attachmentOpenA11y(row.label)}
                      style={s.attachmentOpen}
                      onPress={() =>
                        router.push({
                          pathname: '/feedback-media',
                          params: {
                            feedback: id,
                            attachment: row.attachment.id,
                            kind: row.attachment.kind,
                            mime: row.attachment.mime,
                            size: String(row.attachment.size),
                            label: row.label,
                          },
                        })
                      }
                    >
                      <View style={s.kindDot} />
                      <View style={{ flex: 1, gap: 2 }}>
                        <Text style={{ fontSize: 14, color: colors.ink }}>{row.label}</Text>
                        <Mono style={{ fontSize: 11, color: colors.muted }}>
                          {`${row.attachment.mime} · ${formatBytes(row.attachment.size)}`}
                        </Mono>
                      </View>
                    </Pressable>
                    <DownloadButton
                      media={row.attachment}
                      fileName={row.fileName}
                      sensitive
                      signedUrl={freshUrl(row.attachment.id)}
                      testID={`feedback-attachment-download-${i}`}
                    />
                  </View>
                ))}
              </ListCard>
            ) : item.attachmentCount === 0 ? (
              <Muted style={s.note} testID="feedback-detail-no-attachments">
                {t().feedback.detailNoAttachments}
              </Muted>
            ) : null}
            {expired > 0 ? (
              <Muted style={s.note} testID="feedback-detail-expired">
                {t().feedback.detailExpired(expired)}
              </Muted>
            ) : null}
            {item.attachmentsDeleteAt ? (
              <Muted style={s.note}>
                {t().feedback.detailDeleteAt(formatMonthDay(item.attachmentsDeleteAt))}
              </Muted>
            ) : null}
            {item.attachmentCount > 0 ? (
              <Muted
                style={s.note}
                testID={
                  item.publicAttachments ? 'feedback-detail-public' : 'feedback-detail-private'
                }
              >
                {item.publicAttachments ? t().feedback.detailPublic : t().feedback.detailPrivate}
              </Muted>
            ) : null}
          </View>

          <View style={{ gap: 8 }}>
            <SectionTitle>{t().feedback.detailStatus}</SectionTitle>
            <ListCard>
              <Row
                label={t().feedback.detailStatus}
                value={
                  <Text
                    style={{
                      fontSize: 13,
                      color: item.status === 'sent' ? colors.greenText : colors.muted,
                    }}
                  >
                    {inboxStatusText(item.status)}
                  </Text>
                }
              />
              <Row
                label={t().feedback.detailTime}
                value={<Mono style={s.value}>{when(item.submittedAt ?? item.createdAt)}</Mono>}
              />
              {item.issueUrl ? (
                <Row
                  label={t().feedback.detailIssue}
                  testID="feedback-detail-issue"
                  accessibilityLabel={t().feedback.detailOpenIssueA11y(item.issueNumber ?? '')}
                  onPress={() => void Linking.openURL(item.issueUrl!).catch(() => {})}
                  value={
                    <Mono style={[s.value, { color: colors.accentText }]}>
                      {item.issueNumber ? `#${item.issueNumber}` : '↗'}
                    </Mono>
                  }
                  last={!showError}
                />
              ) : (
                <Row
                  label={t().feedback.detailIssue}
                  value={t().feedback.detailNoIssue}
                  last={!showError}
                />
              )}
              {showError ? (
                <Row label={t().feedback.detailLastError} value={item.lastError ?? ''} last />
              ) : null}
            </ListCard>
            {/* 完整的 id 单独一行：`cli feedback <id>` 要用，放在行里英文界面会被截断。 */}
            <View style={{ gap: 2 }}>
              <Muted style={s.note}>{t().feedback.detailId}</Muted>
              <Mono selectable testID="feedback-detail-id" style={s.idText}>
                {item.id}
              </Mono>
            </View>
          </View>

          <View style={{ gap: 8 }}>
            <SectionTitle>{t().feedback.detailDiagnostics}</SectionTitle>
            <ListCard>
              <Row
                label={t().feedback.appVersion}
                value={<Mono style={s.value}>{item.diagnostics.appVersion}</Mono>}
              />
              <Row
                label={t().feedback.system}
                value={
                  <Mono
                    style={s.value}
                  >{`${item.diagnostics.os} ${item.diagnostics.osVersion}`}</Mono>
                }
              />
              <Row
                label={t().feedback.language}
                value={<Mono style={s.value}>{item.diagnostics.locale}</Mono>}
              />
              <Row
                label={t().feedback.region}
                value={
                  <Mono style={s.value}>{item.diagnostics.region ?? t().feedback.noRegion}</Mono>
                }
                last
              />
            </ListCard>
          </View>
        </>
      )}
    </ScrollView>
  );
}

/** 只有一张，不用像回忆的查看器那样在放大时锁住翻页。 */
const ignoreZoom = () => {};

/** 全屏看一个附件。链接每次打开时现取，不放进 MediaImage 的缓存，图片也不写磁盘缓存。 */
export function FeedbackMediaScreen() {
  const params = useLocalSearchParams<{
    feedback: string;
    attachment: string;
    kind?: string;
    mime?: string;
    size?: string;
    label?: string;
  }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { api } = useApp();
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dims, setDims] = useState<{ width?: number; height?: number }>({});
  const isVideo = params.kind === 'video';
  const size = Number(params.size ?? 0);

  const load = useCallback(async () => {
    setError(null);
    setUrl(null);
    try {
      setUrl((await api.feedbackAttachmentUrl(params.feedback, params.attachment)).url);
    } catch (e) {
      setError(errorText(e));
    }
  }, [api, params.feedback, params.attachment]);

  useEffect(() => {
    void load();
  }, [load]);

  const media = {
    id: params.attachment,
    kind: isVideo ? ('video' as const) : ('image' as const),
    mime: params.mime ?? (isVideo ? 'video/mp4' : 'image/jpeg'),
    size,
  };
  const freshUrl = async () => {
    try {
      return (await api.feedbackAttachmentUrl(params.feedback, params.attachment)).url;
    } catch (e) {
      if (e instanceof ApiFailure && e.status === 410) throw new DownloadGone();
      throw e;
    }
  };

  return (
    <View style={s.viewer} testID="feedback-media-screen">
      {error ? (
        <View style={s.center} testID="feedback-media-error">
          <Text style={s.viewerText}>{t().feedback.mediaFailed(error)}</Text>
          <Pressable
            testID="feedback-media-retry"
            accessibilityRole="button"
            accessibilityLabel={t().feedback.mediaRetry}
            hitSlop={12}
            onPress={() => void load()}
            style={s.pill}
          >
            <Text style={s.viewerText}>{t().feedback.mediaRetry}</Text>
          </Pressable>
        </View>
      ) : !url ? (
        <View style={s.center}>
          <ActivityIndicator color={colors.white} />
          <Text style={s.viewerText}>{t().feedback.mediaLoading}</Text>
        </View>
      ) : isVideo ? (
        <VideoPlayer uri={url} />
      ) : (
        <ZoomableImage media={dims} onZoomChange={ignoreZoom}>
          <Image
            testID="feedback-media-image"
            source={{ uri: url }}
            style={[StyleSheet.absoluteFill, { backgroundColor: colors.black }]}
            contentFit="contain"
            transition={200}
            // 别人家的照片不留在磁盘缓存里。
            cachePolicy="memory"
            accessibilityLabel={params.label ?? t().ui.photo}
            onLoad={(e) => setDims({ width: e.source.width, height: e.source.height })}
            onError={() => setError(t().ui.networkError)}
          />
        </ZoomableImage>
      )}
      <View style={[s.top, { paddingTop: insets.top + 8 }]} pointerEvents="box-none">
        <Pressable
          testID="feedback-media-close"
          accessibilityRole="button"
          accessibilityLabel={t().ui.close}
          hitSlop={12}
          onPress={() => router.back()}
        >
          <Text style={s.close}>×</Text>
        </Pressable>
        <Text style={s.title} numberOfLines={1}>
          {params.label ? `${params.label} · ${formatBytes(size)}` : ''}
        </Text>
        <DownloadButton
          media={media}
          fileName={feedbackAttachmentFileName(params.attachment, media.mime)}
          sensitive
          signedUrl={freshUrl}
          tone="dark"
          testID="feedback-media-download"
        />
      </View>
    </View>
  );
}

const s = themedStyles(() => ({
  root: { flex: 1, backgroundColor: colors.paper },
  content: { paddingHorizontal: spacing.page, gap: 20 },
  back: { fontSize: 14, color: colors.muted, padding: 4, marginLeft: -4 },
  hint: {
    backgroundColor: colors.sand,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  hintText: { fontSize: 12, lineHeight: 19, color: colors.inkSoft },
  error: { fontSize: 13, lineHeight: 20, color: colors.dangerText },
  itemRow: { paddingVertical: 12, gap: 4 },
  itemText: { fontSize: 14, lineHeight: 21, color: colors.ink, fontFamily: fonts.serifMedium },
  itemMeta: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
  divider: { borderBottomWidth: 1, borderBottomColor: colors.rule },
  card: {
    backgroundColor: colors.card,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  bodyText: { fontSize: 14, lineHeight: 22, color: colors.ink },
  attachmentRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12 },
  attachmentOpen: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10 },
  kindDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.accent },
  value: { fontSize: 12, color: colors.ink },
  idText: { fontSize: 12, color: colors.inkSoft },
  note: { fontSize: 11, lineHeight: 17 },
  viewer: { flex: 1, backgroundColor: colors.black },
  center: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    paddingHorizontal: 32,
  },
  viewerText: { color: colors.white, fontSize: 13, textAlign: 'center', lineHeight: 20 },
  pill: {
    minHeight: 36,
    paddingHorizontal: 16,
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.white,
    justifyContent: 'center',
  },
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
    backgroundColor: colors.mediaChip,
  },
  close: { color: colors.white, fontSize: 28, lineHeight: 30, paddingHorizontal: 6 },
  title: { flex: 1, color: colors.white, fontSize: 14 },
}));
