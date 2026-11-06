import {
  FEEDBACK_MAX_ATTACHMENTS,
  FEEDBACK_MAX_IMAGE_BYTES,
  FEEDBACK_MAX_TEXT,
  type FeedbackConfig,
  type FeedbackStatus,
  type FeedbackView,
  feedbackDiagnostics,
  formatBytes,
  formatMonthDay,
  getLocale,
  regionFor,
  t,
} from '@xiaodouya/shared';
import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  type ScrollViewInstance,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ApiFailure } from '../lib/api';
import { useApp, useRecords } from '../lib/app';
import {
  adoptFeedbackFile,
  clearFeedbackDraft,
  loadFeedbackDraft,
  newFeedbackDraft,
  prepareFeedbackFile,
  putFeedbackFile,
  removeFeedbackFile,
  saveFeedbackDraft,
} from '../lib/feedbackDraft';
import {
  admitAttachments,
  attachmentVisibility,
  type FeedbackDraft,
  type FeedbackDraftFile,
  FeedbackPrepareFailed,
  FeedbackUploadFailed,
  sendFeedbackDraft,
} from '../lib/feedbackSend';
import { pickFromLibrary } from '../lib/media';
import { LocalThumb } from '../lib/mediaViews';
import { colors, fonts, spacing, themedStyles } from '../theme';
import { useFeedback as useToast } from '../ui/overlays';
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

/** null：还在问服务器；undefined：问不到（离线），先让人写，发的时候再说。 */
type ServerFeedback = FeedbackConfig | null | undefined;

const DISABLED: FeedbackConfig = {
  enabled: false,
  public: true,
  attachments: false,
  attachmentDays: null,
};

const statusText = (status: FeedbackStatus) =>
  status === 'sent'
    ? t().feedback.statusSent
    : status === 'queued'
      ? t().feedback.statusQueued
      : t().feedback.statusDraft;

function failureReason(error: unknown): string {
  if (error instanceof FeedbackPrepareFailed) return t().feedback.photoFailedReason;
  if (error instanceof FeedbackUploadFailed) {
    return error.status === 410 ? t().ui.localFileGone : t().ui.serverError(error.status);
  }
  if (error instanceof ApiFailure) return error.message;
  return t().ui.networkError;
}

/**
 * 反馈问题。文字会发到公开的 GitHub issue（服务器说仓库公开时就这么提醒）。照片和视频在服务器配了公开链接时
 * 和文字一起放进 issue（F-126，提示里写明，提交时告诉服务端用户看到的是这个提示），否则只有开发者能看。
 * 照片加进来时就压缩、去掉 EXIF 和 GPS，压缩不了的不加，不退回原图。
 * 草稿一直存在手机上：断网、发送失败、App 被杀之后再打开都还在，同一份草稿重发不会多一条。
 */
export function FeedbackScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const app = useApp();
  const { baby } = useRecords();
  const { toast } = useToast();
  const [server, setServer] = useState<ServerFeedback>(null);
  const [draft, setDraft] = useState<FeedbackDraft | null>(null);
  const [restored, setRestored] = useState(false);
  const [picking, setPicking] = useState(false);
  const [sending, setSending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<FeedbackView[]>([]);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollRef = useRef<ScrollViewInstance>(null);

  const loadHistory = useCallback(async () => {
    try {
      setHistory((await app.api.listFeedback()).items.filter((i) => i.status !== 'draft'));
    } catch {
      // 旧服务器没有这个接口，或者离线：列表只是参考，不提示。
    }
  }, [app.api]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const config = await app.api.publicConfig();
        // 旧服务器没有这个字段：当作没开。
        if (alive) setServer(config.feedback ?? { ...DISABLED });
      } catch {
        if (alive) setServer(undefined);
      }
    })();
    void (async () => {
      const saved = await loadFeedbackDraft();
      if (!alive) return;
      setDraft(saved ?? newFeedbackDraft());
      setRestored(Boolean(saved && (saved.text.trim() || saved.files.length)));
    })();
    void loadHistory();
    return () => {
      alive = false;
    };
  }, [app.api, loadHistory]);

  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    },
    [],
  );

  const update = (next: FeedbackDraft, immediately = false) => {
    setDraft(next);
    setError(null);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    if (immediately) void saveFeedbackDraft(next);
    else saveTimer.current = setTimeout(() => void saveFeedbackDraft(next), 400);
  };

  const diagnostics = useMemo(
    () =>
      feedbackDiagnostics({
        appVersion: Constants.expoConfig?.version,
        os: Platform.OS,
        osVersion:
          Platform.OS === 'android'
            ? (Platform.constants as { Release?: string }).Release
            : Platform.Version,
        locale: getLocale(),
        region: app.role && baby ? regionFor(baby.data.region).id : undefined,
      }),
    [app.role, baby],
  );

  const enabled = server === undefined || Boolean(server?.enabled);
  const isPublic = server?.public ?? true;
  const allowFiles = server === undefined || Boolean(server?.attachments);
  const visibility = attachmentVisibility(server);
  const days = server?.attachmentDays ?? null;
  const busy = sending !== null;
  const canSend = Boolean(draft?.text.trim()) && !busy;

  const pick = async () => {
    if (!draft) return;
    setPicking(true);
    try {
      const picked = await pickFromLibrary({ e2eFeedback: true });
      const { accepted, rejection } = admitAttachments(draft.files.length, picked);
      const files = [...draft.files];
      let photoFailed = false;
      let photoTooBig = false;
      for (const file of accepted) {
        let adopted: FeedbackDraftFile;
        try {
          adopted = await adoptFeedbackFile(file);
        } catch (error) {
          // 视频只是复制，失败和以前一样报出去。
          if (file.kind === 'video') throw error;
          // 压缩不了的照片不加，绝不退回原图：原图可能带着拍摄地点，而附件会公开。
          photoFailed = true;
          continue;
        }
        if (adopted.kind === 'image' && adopted.size > FEEDBACK_MAX_IMAGE_BYTES) {
          removeFeedbackFile(adopted);
          photoTooBig = true;
          continue;
        }
        files.push(adopted);
      }
      update({ ...draft, files }, true);
      if (photoFailed) toast(t().feedback.photoFailed);
      else if (rejection?.reason === 'tooMany')
        toast(t().feedback.tooMany(FEEDBACK_MAX_ATTACHMENTS));
      else if (rejection?.reason === 'unsupported') toast(t().feedback.unsupported);
      else if (rejection?.reason === 'tooBig')
        toast(t().feedback.tooBig(formatBytes(rejection.maxBytes)));
      else if (photoTooBig) toast(t().feedback.tooBig(formatBytes(FEEDBACK_MAX_IMAGE_BYTES)));
    } catch (e) {
      toast(e instanceof Error ? e.message : t().recall.cantOpenGallery);
    } finally {
      setPicking(false);
    }
  };

  const remove = (id: string) => {
    if (!draft) return;
    const file = draft.files.find((f) => f.id === id);
    if (file) removeFeedbackFile(file);
    update({ ...draft, files: draft.files.filter((f) => f.id !== id) }, true);
  };

  const send = async () => {
    if (!draft || !canSend) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    // 草稿先落盘：发送途中 App 被杀，回来还能接着发。
    const working: FeedbackDraft = structuredClone(draft);
    await saveFeedbackDraft(working);
    setError(null);
    setSending(t().feedback.sending);
    try {
      const status = await sendFeedbackDraft(
        working,
        diagnostics,
        {
          create: (body) => app.api.createFeedback(body),
          submit: (id) => app.api.submitFeedback(id),
          put: putFeedbackFile,
          save: saveFeedbackDraft,
          prepare: prepareFeedbackFile,
          onProgress: (done, total) =>
            setSending(
              total > 0 && done < total
                ? t().feedback.uploading(done, total)
                : t().feedback.sending,
            ),
        },
        // 和页面上的提示一致：说了会公开才告诉服务端同意。
        { publicAttachments: visibility !== 'private' },
      );
      clearFeedbackDraft();
      setDraft(newFeedbackDraft());
      setRestored(false);
      toast(status === 'sent' ? t().feedback.sent : t().feedback.queued);
      void loadHistory();
    } catch (e) {
      // 上传过的标记也要记住，下次只传剩下的。
      setDraft(working);
      setError(t().feedback.failedKept(failureReason(e)));
    } finally {
      setSending(null);
    }
  };

  return (
    <KeyboardAvoidingView
      style={s.root}
      testID="feedback-screen"
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ScrollView
        ref={scrollRef}
        contentContainerStyle={[
          s.content,
          { paddingTop: insets.top + 8, paddingBottom: insets.bottom + 32 },
        ]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={{ gap: 8 }}>
          <Pressable
            testID="feedback-back"
            accessibilityRole="button"
            accessibilityLabel={t().feedback.backA11y}
            hitSlop={12}
            onPress={() => router.back()}
          >
            <Text style={s.back}>{t().feedback.back}</Text>
          </Pressable>
          <PageTitle>{t().feedback.title}</PageTitle>
        </View>

        {server === null || !draft ? (
          <View style={{ gap: 8, alignItems: 'center', paddingVertical: 24 }}>
            <ActivityIndicator color={colors.accent} />
            <Muted style={{ fontSize: 12 }}>{t().feedback.checking}</Muted>
          </View>
        ) : !enabled ? (
          <View testID="feedback-unavailable">
            <Empty title={t().feedback.unavailableTitle} sub={t().feedback.unavailableSub} />
          </View>
        ) : (
          <>
            <View style={s.hint} testID="feedback-privacy">
              <Text style={s.hintStrong}>
                {allowFiles && visibility === 'public'
                  ? t().feedback.publicWithFilesNote
                  : allowFiles && visibility === 'linked'
                    ? t().feedback.linkedWithFilesNote
                    : isPublic
                      ? t().feedback.publicNote
                      : t().feedback.privateNote}
              </Text>
              <Text style={s.hintText}>
                {!allowFiles
                  ? t().feedback.textOnlyNote
                  : visibility === 'private'
                    ? t().feedback.attachmentsNote(days)
                    : t().feedback.publicFilesNote(days)}
              </Text>
            </View>

            {restored ? (
              <Muted style={{ fontSize: 12 }} testID="feedback-restored">
                {t().feedback.draftRestored}
              </Muted>
            ) : null}

            <View style={s.card}>
              <TextInput
                testID="feedback-text"
                value={draft.text}
                onChangeText={(text) => update({ ...draft, text })}
                editable={!busy}
                placeholder={t().feedback.placeholder}
                accessibilityLabel={t().feedback.placeholder}
                placeholderTextColor={colors.muted}
                selectionColor={colors.accent}
                maxLength={FEEDBACK_MAX_TEXT}
                multiline
                textAlignVertical="top"
                style={s.textArea}
              />
              <Mono style={s.counter}>
                {t().feedback.counter(draft.text.length, FEEDBACK_MAX_TEXT)}
              </Mono>
            </View>

            {allowFiles ? (
              <View style={{ gap: 10 }}>
                <Pressable
                  testID="feedback-pick"
                  accessibilityRole="button"
                  accessibilityLabel={t().feedback.pick}
                  accessibilityState={{ disabled: picking || busy }}
                  disabled={picking || busy || draft.files.length >= FEEDBACK_MAX_ATTACHMENTS}
                  onPress={() => void pick()}
                  style={[
                    s.picker,
                    draft.files.length >= FEEDBACK_MAX_ATTACHMENTS ? { opacity: 0.45 } : null,
                  ]}
                >
                  <Text style={s.pickerLabel}>
                    {picking ? t().feedback.picking : t().feedback.pick}
                  </Text>
                  <Text style={s.pickerSub}>
                    {visibility === 'public'
                      ? t().feedback.pickSubPublic(FEEDBACK_MAX_ATTACHMENTS)
                      : visibility === 'linked'
                        ? t().feedback.pickSubLinked(FEEDBACK_MAX_ATTACHMENTS)
                        : t().feedback.pickSub(FEEDBACK_MAX_ATTACHMENTS)}
                  </Text>
                </Pressable>
                {draft.files.length > 0 ? (
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={{ gap: 8 }}
                  >
                    {draft.files.map((file) => (
                      <LocalThumb
                        key={file.id}
                        file={{ uri: file.uri, kind: file.kind, mime: file.mime, size: file.size }}
                        onRemove={() => (busy ? undefined : remove(file.id))}
                      />
                    ))}
                  </ScrollView>
                ) : null}
              </View>
            ) : null}

            <View style={{ gap: 8 }}>
              <SectionTitle>
                {isPublic ? t().feedback.diagnosticsPublicTitle : t().feedback.diagnosticsTitle}
              </SectionTitle>
              <ListCard>
                <Row
                  label={t().feedback.appVersion}
                  value={<Mono style={s.value}>{diagnostics.appVersion}</Mono>}
                />
                <Row
                  label={t().feedback.system}
                  value={
                    <Mono style={s.value}>{`${diagnostics.os} ${diagnostics.osVersion}`}</Mono>
                  }
                />
                <Row
                  label={t().feedback.language}
                  value={<Mono style={s.value}>{diagnostics.locale}</Mono>}
                />
                <Row
                  label={t().feedback.region}
                  value={<Mono style={s.value}>{diagnostics.region ?? t().feedback.noRegion}</Mono>}
                  last
                />
              </ListCard>
              <Muted style={s.note}>{t().feedback.diagnosticsNote}</Muted>
            </View>

            {error ? (
              <Text
                style={s.error}
                testID="feedback-error"
                // 失败时人在页面底部，提示刚好出现在屏幕下沿，只露半句。滚到它上方一点，连按钮一起看得到。
                onLayout={(e) =>
                  scrollRef.current?.scrollTo({ y: Math.max(0, e.nativeEvent.layout.y - 160) })
                }
              >
                {error}
              </Text>
            ) : null}
            {sending ? (
              <Muted style={{ fontSize: 12, textAlign: 'center' }} testID="feedback-progress">
                {sending}
              </Muted>
            ) : null}
            <Button
              testID="feedback-send"
              tone="dark"
              label={t().feedback.send}
              disabled={!canSend}
              busy={busy}
              onPress={() => void send()}
            />
          </>
        )}

        {history.length > 0 ? (
          <View style={{ gap: 8 }} testID="feedback-history">
            <SectionTitle>{t().feedback.history}</SectionTitle>
            <ListCard>
              {history.map((item, i) => (
                <View
                  key={item.id}
                  style={[s.historyRow, i === history.length - 1 ? null : s.divider]}
                  testID={`feedback-item-${item.status}`}
                >
                  <Text style={s.historyText} numberOfLines={1}>
                    {item.excerpt}
                  </Text>
                  <View style={s.historyMeta}>
                    <Muted style={{ fontSize: 11 }}>
                      {formatMonthDay(item.createdAt)}
                      {t().feedback.attachmentCount(item.attachments)}
                    </Muted>
                    <Text
                      style={{
                        fontSize: 11,
                        color: item.status === 'sent' ? colors.greenText : colors.muted,
                      }}
                    >
                      {statusText(item.status)}
                    </Text>
                  </View>
                </View>
              ))}
            </ListCard>
          </View>
        ) : null}
      </ScrollView>
    </KeyboardAvoidingView>
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
    gap: 6,
  },
  hintStrong: { fontSize: 13, lineHeight: 20, color: colors.ink },
  hintText: { fontSize: 12, lineHeight: 19, color: colors.inkSoft },
  card: {
    backgroundColor: colors.card,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 14,
    padding: 4,
  },
  textArea: {
    minHeight: 150,
    paddingHorizontal: 12,
    paddingTop: 12,
    paddingBottom: 4,
    fontSize: 14,
    lineHeight: 22,
    color: colors.ink,
  },
  counter: { fontSize: 10, color: colors.muted, textAlign: 'right', padding: 8, paddingTop: 0 },
  picker: {
    height: 64,
    borderRadius: 14,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: colors.dashed,
    backgroundColor: colors.paper,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
  },
  pickerLabel: { fontSize: 14, color: colors.ink },
  pickerSub: { fontSize: 10, color: colors.muted },
  value: { fontSize: 12, color: colors.ink },
  note: { fontSize: 11, lineHeight: 17 },
  error: { fontSize: 13, lineHeight: 20, color: colors.dangerText },
  historyRow: { paddingVertical: 11, gap: 3 },
  historyText: { fontSize: 14, color: colors.ink, fontFamily: fonts.serifMedium },
  historyMeta: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
  divider: { borderBottomWidth: 1, borderBottomColor: colors.rule },
}));
