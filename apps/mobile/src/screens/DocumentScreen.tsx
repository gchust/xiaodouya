import {
  type DocumentData,
  documentKind,
  formatBytes,
  MAX_MEDIA_PER_RECORD,
  type MediaRef,
  mergeEdit,
  t,
} from '@xiaodouya/shared';
import * as LocalAuthentication from 'expo-local-authentication';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp, useRecords } from '../lib/app';
import { DownloadButton } from '../lib/DownloadButton';
import { downloadFileNames } from '../lib/downloadCore';
import { gridItemWidth } from '../lib/layout';
import {
  openDocumentFile,
  type PickedFile,
  pickDocument,
  queueAllForUpload,
  takePhoto,
} from '../lib/media';
import { MediaImage } from '../lib/mediaViews';
import { DocumentReadersSheet, readersText } from '../sheets/documentSheets';
import { colors, fonts, spacing, themedStyles } from '../theme';
import { useDeleteConfirm } from '../ui/DeleteConfirm';
import { useFeedback, useSheet } from '../ui/overlays';
import {
  Button,
  Empty,
  ListCard,
  Mono,
  Muted,
  PageTitle,
  Row,
  SectionTitle,
  SoftInput,
  Stripes,
} from '../ui/primitives';

const FILE_GAP = 8;

export function DocumentScreen({ id, from }: { id: string; from?: 'family' }) {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const app = useApp();
  const { documents } = useRecords();
  const sheet = useSheet();
  const { toast } = useFeedback();
  const { width: windowWidth } = useWindowDimensions();
  const fileWidth = gridItemWidth(windowWidth - spacing.page * 2, 2, FILE_GAP);
  const [showNumber, setShowNumber] = useState(false);
  const [unlocked, setUnlocked] = useState(!app.prefs.documentLock);
  const [authFailed, setAuthFailed] = useState(false);
  const [preparing, setPreparing] = useState<'scan' | 'upload' | null>(null);
  const confirmDelete = useDeleteConfirm();
  const entry = documents.find((d) => d.id === id);
  const userId = app.me?.user.id ?? null;
  const members = app.me?.members ?? [];
  // 家人自己的证件（F-137）：自己的多一行“谁能看”，别人给我看的只读。只读只是界面，服务端也拒绝别人的修改。
  const kind = entry ? documentKind(entry.data, userId) : from === 'family' ? 'mine' : 'family';
  const readOnly = kind === 'shared';
  // 成员列表可能还没刷新：找不到称呼时不写名字，不能把账号 id 露出来。
  const ownerLabel = members.find((m) => m.userId === entry?.data.owner)?.label ?? null;
  const fromFamily = from === 'family' || kind !== 'family';

  const authenticate = async () => {
    setAuthFailed(false);
    const enrolled = await LocalAuthentication.isEnrolledAsync().catch(() => false);
    if (!enrolled) {
      // 手机没设锁屏就无从验证，放行但不静默：提示用户这个开关现在不起作用。
      toast(t().info.noDeviceLock);
      setUnlocked(true);
      return;
    }
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: t().info.verifyToView,
      cancelLabel: t().common.cancel,
    });
    if (result.success) setUnlocked(true);
    else setAuthFailed(true);
  };

  // 只在进入页面时验证一次。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 依赖变化不应该重新弹出验证
  useEffect(() => {
    if (!unlocked) void authenticate();
  }, []);

  const back = (
    <Pressable
      testID="doc-back"
      accessibilityRole="button"
      accessibilityLabel={fromFamily ? t().info.backToFamily : t().info.backToInfo}
      hitSlop={12}
      onPress={() => router.back()}
    >
      <Text style={s.back}>{fromFamily ? t().info.backFamilyLink : t().info.backInfoLink}</Text>
    </Pressable>
  );

  if (!entry) {
    return (
      <View style={[s.root, { paddingTop: insets.top + 8, paddingHorizontal: spacing.page }]}>
        {back}
        <Empty
          title={t().info.docGone}
          sub={fromFamily ? t().info.docGoneSharedSub : t().info.docGoneSub}
        />
      </View>
    );
  }

  if (!unlocked) {
    return (
      <View
        style={[s.root, { paddingTop: insets.top + 8, paddingHorizontal: spacing.page, gap: 20 }]}
      >
        {back}
        <Empty
          title={t().info.docsLocked}
          sub={authFailed ? t().info.verifyFailed : t().info.verifyPrompt}
        />
        <Button testID="doc-unlock" label={t().info.verify} onPress={() => void authenticate()} />
      </View>
    );
  }

  const data = entry.data;
  // 选文件可能花了一会儿，用最新的版本，不要盖掉家人刚改的内容。
  const latest = () => app.store.getSnapshot().documents.find((d) => d.id === id)?.data ?? data;

  const addFiles = async (files: PickedFile[]) => {
    if (files.length === 0) return;
    if (latest().files.length + files.length > MAX_MEDIA_PER_RECORD) {
      throw new Error(t().info.docTooMany(MAX_MEDIA_PER_RECORD));
    }
    const { refs, failed } = await queueAllForUpload(app.uploads, files, {
      scope: kind === 'mine' ? 'personal' : 'document',
      videoWifiOnly: false,
    });
    if (refs.length > 0) {
      const current = latest();
      await app.write('document', { ...current, files: [...current.files, ...refs] }, id);
    }
    if (failed[0]) throw new Error(failed[0]);
  };

  // 这里只从记录里摘掉。服务端发现没有记录再用它，才在宽限期后清理，撤销就不会清理。
  const removeFile = (file: MediaRef) =>
    confirmDelete({ kind: 'documentFile', name: file.name ?? t().info.aFile }, async () => {
      sheet.close();
      const current = latest();
      const files = current.files.filter((f) => f.id !== file.id);
      await app.write('document', { ...current, files }, id);
      toast(t().info.removedFile(file.name ?? t().info.aFile), {
        undo: () => {
          const now = latest();
          void app.write('document', { ...now, files: [...now.files, file] }, id);
        },
      });
    });

  const guard = (kind: 'scan' | 'upload', run: () => Promise<PickedFile[]>) => async () => {
    setPreparing(kind);
    try {
      await addFiles(await run());
    } catch (error) {
      toast(error instanceof Error ? error.message : t().info.addFailed);
    } finally {
      setPreparing(null);
    }
  };

  // 文件名只用文件自己的名字或证件名称，证件号码不能出现在手机的文件列表里。
  const fileNames = downloadFileNames(data.files, { title: data.name });
  const number = data.number
    ? showNumber
      ? data.number
      : `${data.number.slice(0, 3)}•••••${data.number.slice(-1)}`
    : t().info.notFilled;

  const openEdit = () =>
    sheet.open(t().info.editDoc, () => <DocumentEditSheet id={id} data={data} />);

  const openFile = (file: MediaRef) => {
    if (file.kind === 'pdf') {
      void openDocumentFile(app.api, app.uploads, file).catch((error: Error) =>
        toast(error.message),
      );
      return;
    }
    router.push({ pathname: '/viewer', params: { document: id, media: file.id } });
  };

  return (
    <View style={s.root} testID="document-screen">
      <ScrollView
        contentContainerStyle={[
          s.content,
          { paddingTop: insets.top + 8, paddingBottom: insets.bottom + 32 },
        ]}
        showsVerticalScrollIndicator={false}
      >
        <View style={{ gap: 8 }}>
          {back}
          <View style={{ gap: 4 }}>
            <PageTitle testID="doc-title">{data.name}</PageTitle>
            {data.subtitle ? <Muted>{data.subtitle}</Muted> : null}
          </View>
        </View>

        <ListCard>
          <Row
            label={t().info.docNumber}
            testID="doc-number-toggle"
            accessibilityLabel={showNumber ? t().info.hideDocNumber : t().info.showDocNumber}
            onPress={() => setShowNumber((v) => !v)}
            value={
              <Mono style={{ fontSize: 13 }} testID="doc-number-value">
                {number}
              </Mono>
            }
          />
          <Row
            label={t().info.issueDate}
            value={data.issuedOn || t().info.notFilled}
            testID="doc-issued"
            onPress={readOnly ? undefined : openEdit}
          />
          <Row
            label={t().info.expiry}
            value={data.expiresOn || t().info.notFilled}
            last={kind !== 'mine'}
            onPress={readOnly ? undefined : openEdit}
          />
          {kind === 'mine' ? (
            <Row
              label={t().info.whoCanView}
              testID="doc-readers"
              accessibilityLabel={t().info.whoCanViewA11y}
              value={readersText(data, userId, members)}
              last
              onPress={() =>
                sheet.open(t().info.whoCanView, () => <DocumentReadersSheet id={id} data={data} />)
              }
            />
          ) : null}
        </ListCard>
        {readOnly ? (
          <Muted testID="doc-read-only" style={{ fontSize: 12, lineHeight: 19, marginTop: -8 }}>
            {ownerLabel ? t().info.sharedReadOnly(ownerLabel) : t().info.sharedReadOnlyUnknown}
          </Muted>
        ) : null}
        {readOnly ? null : (
          <Pressable
            testID="doc-edit"
            accessibilityRole="button"
            accessibilityLabel={t().info.editDoc}
            hitSlop={{ top: 8, bottom: 20 }}
            onPress={openEdit}
            style={{ marginTop: -12 }}
          >
            <Text style={{ fontSize: 12, color: colors.accentText }}>{t().info.editDocLink}</Text>
          </Pressable>
        )}

        <View style={{ gap: 8 }}>
          <View style={s.fileHead}>
            <SectionTitle>{t().info.files}</SectionTitle>
            <Muted testID="doc-file-count">{t().info.filesCount(data.files.length)}</Muted>
          </View>
          {data.files.length === 0 ? (
            <Text style={{ fontSize: 13, color: colors.muted, paddingVertical: 14 }}>
              {readOnly ? t().info.noFilesReadOnly : t().info.noFiles}
            </Text>
          ) : (
            <View style={s.files}>
              {data.files.map((file) => (
                <View key={file.id} style={[s.file, { width: fileWidth }]}>
                  <Pressable
                    testID={`doc-file-${file.name ?? file.id}`}
                    accessibilityRole="button"
                    accessibilityLabel={file.name ?? t().info.aFile}
                    style={s.fileOpen}
                    onPress={() => openFile(file)}
                  >
                    <View style={s.preview}>
                      {file.kind === 'image' ? (
                        <MediaImage media={file} variant="thumb" style={StyleSheet.absoluteFill} />
                      ) : (
                        <Stripes style={[StyleSheet.absoluteFill, s.pdfBadge]}>
                          <Mono weight="medium" style={{ fontSize: 14, color: colors.muted }}>
                            PDF
                          </Mono>
                        </Stripes>
                      )}
                    </View>
                    <Text numberOfLines={1} style={{ fontSize: 11, color: colors.ink }}>
                      {file.name ?? t().info.aFile}
                    </Text>
                  </Pressable>
                  <View style={s.fileMeta}>
                    <Muted style={{ fontSize: 10 }}>{formatBytes(file.size)}</Muted>
                    <View style={s.fileActions}>
                      <DownloadButton
                        media={file}
                        fileName={fileNames.get(file.id) ?? data.name}
                        sensitive
                        testID={`doc-file-download-${file.name ?? file.id}`}
                      />
                      {readOnly ? null : (
                        <Pressable
                          testID={`doc-file-remove-${file.name ?? file.id}`}
                          accessibilityRole="button"
                          accessibilityLabel={t().info.removeFileNamed(file.name ?? t().info.aFile)}
                          // 左边紧挨着下载按钮（它的热区是 12），这边不能再往左扩，否则会点错。
                          hitSlop={{ top: 14, bottom: 14, left: 4, right: 14 }}
                          onPress={() => void removeFile(file)}
                        >
                          <Text style={{ fontSize: 11, color: colors.muted }}>
                            {t().common.remove}
                          </Text>
                        </Pressable>
                      )}
                    </View>
                  </View>
                </View>
              ))}
            </View>
          )}
        </View>

        {readOnly ? null : (
          <>
            <View style={s.actions}>
              <Button
                testID="doc-scan"
                tone="outline"
                height={52}
                label={t().info.takePhoto}
                labelStyle={s.actionLabel}
                busy={preparing === 'scan'}
                disabled={preparing === 'upload'}
                style={{ flex: 1, borderRadius: 14 }}
                onPress={() => void guard('scan', takePhoto)()}
              />
              <Button
                testID="doc-upload"
                height={52}
                label={t().info.uploadFile}
                labelStyle={s.actionLabel}
                busy={preparing === 'upload'}
                disabled={preparing === 'scan'}
                style={{ flex: 1, borderRadius: 14 }}
                onPress={() => void guard('upload', pickDocument)()}
              />
            </View>
            <Muted style={{ fontSize: 11, lineHeight: 18 }}>
              {kind === 'mine' ? t().info.mineNote : t().info.fileTypesNote}
            </Muted>
            <Button
              testID="doc-delete"
              tone="ghost"
              height={44}
              label={t().info.deleteDoc}
              onPress={() =>
                confirmDelete(
                  { kind: 'document', name: data.name },
                  () => {
                    void app.remove(id);
                    sheet.close();
                    router.back();
                    toast(t().info.deletedNamed(data.name), {
                      undo: () => void app.write('document', data, id),
                    });
                  },
                  { confirmTestID: 'doc-delete-confirm' },
                )
              }
            />
          </>
        )}
      </ScrollView>
    </View>
  );
}

function DocumentEditSheet({ id, data }: { id: string; data: DocumentData }) {
  const app = useApp();
  const sheet = useSheet();
  const [name, setName] = useState(data.name);
  const [number, setNumber] = useState(data.number ?? '');
  const [issued, setIssued] = useState(data.issuedOn ?? '');
  const [expires, setExpires] = useState(data.expiresOn ?? '');
  const [subtitle, setSubtitle] = useState(data.subtitle ?? '');
  return (
    <>
      <SoftInput
        testID="doc-edit-name"
        value={name}
        onChangeText={setName}
        placeholder={t().info.docName}
        maxLength={100}
      />
      <SoftInput
        testID="doc-edit-subtitle"
        value={subtitle}
        onChangeText={setSubtitle}
        placeholder={t().info.descPlaceholder}
        maxLength={100}
      />
      <SoftInput
        testID="doc-edit-number"
        value={number}
        onChangeText={setNumber}
        placeholder={t().info.docNumber}
        autoCapitalize="characters"
        autoCorrect={false}
        maxLength={100}
        style={{ fontFamily: fonts.monoRegular }}
      />
      <SoftInput
        testID="doc-edit-issued"
        value={issued}
        onChangeText={setIssued}
        placeholder={t().info.issueDatePlaceholder}
        maxLength={40}
      />
      <SoftInput
        testID="doc-edit-expires"
        value={expires}
        onChangeText={setExpires}
        placeholder={t().info.expiryPlaceholder}
        maxLength={40}
      />
      <Button
        testID="doc-edit-save"
        label={t().common.save}
        disabled={!name.trim()}
        onPress={() => {
          const latest = app.store.getSnapshot().documents.find((d) => d.id === id)?.data ?? data;
          void app.write(
            'document',
            mergeEdit(data, latest, {
              name: name.trim(),
              subtitle: subtitle.trim() || undefined,
              number: number.trim() || undefined,
              issuedOn: issued.trim() || undefined,
              expiresOn: expires.trim() || undefined,
            }),
            id,
          );
          sheet.close();
        }}
      />
    </>
  );
}

const s = themedStyles(() => ({
  root: { flex: 1, backgroundColor: colors.paper },
  content: { paddingHorizontal: spacing.page, gap: 20 },
  back: { fontSize: 14, color: colors.muted, padding: 4, marginLeft: -4 },
  fileHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  files: { flexDirection: 'row', flexWrap: 'wrap', gap: FILE_GAP },
  file: { gap: 2 },
  fileOpen: { gap: 6 },
  fileMeta: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  fileActions: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  preview: {
    aspectRatio: 3 / 4,
    borderRadius: 10,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.line,
  },
  pdfBadge: { alignItems: 'center', justifyContent: 'center' },
  actions: { flexDirection: 'row', gap: 8 },
  actionLabel: { fontSize: 14, fontWeight: '400' },
}));
