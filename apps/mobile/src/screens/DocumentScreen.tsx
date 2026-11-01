import {
  type DocumentData,
  formatBytes,
  MAX_MEDIA_PER_RECORD,
  type MediaRef,
  mergeEdit,
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
import { colors, fonts, spacing } from '../theme';
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

export function DocumentScreen({ id }: { id: string }) {
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
  const entry = documents.find((d) => d.id === id);

  const authenticate = async () => {
    setAuthFailed(false);
    const enrolled = await LocalAuthentication.isEnrolledAsync().catch(() => false);
    if (!enrolled) {
      // 手机没设锁屏就无从验证，放行但不静默：提示用户这个开关现在不起作用。
      toast('这台手机没有设置指纹或锁屏密码，证件夹无法上锁');
      setUnlocked(true);
      return;
    }
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: '验证后查看证件',
      cancelLabel: '取消',
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
      accessibilityLabel="返回资料"
      hitSlop={12}
      onPress={() => router.back()}
    >
      <Text style={s.back}>‹ 资料</Text>
    </Pressable>
  );

  if (!entry) {
    return (
      <View style={[s.root, { paddingTop: insets.top + 8, paddingHorizontal: spacing.page }]}>
        {back}
        <Empty title="这份资料已经不在了" sub="可能被其他家人删除了。" />
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
          title="证件夹已上锁"
          sub={authFailed ? '验证没有通过，可以再试一次。' : '验证指纹或锁屏密码后查看。'}
        />
        <Button testID="doc-unlock" label="验证" onPress={() => void authenticate()} />
      </View>
    );
  }

  const data = entry.data;
  // 选文件可能花了一会儿，用最新的版本，不要盖掉家人刚改的内容。
  const latest = () => app.store.getSnapshot().documents.find((d) => d.id === id)?.data ?? data;

  const addFiles = async (files: PickedFile[]) => {
    if (files.length === 0) return;
    if (latest().files.length + files.length > MAX_MEDIA_PER_RECORD) {
      throw new Error(`一份证件最多放 ${MAX_MEDIA_PER_RECORD} 个文件`);
    }
    const { refs, failed } = await queueAllForUpload(app.uploads, files, {
      scope: 'document',
      videoWifiOnly: false,
    });
    if (refs.length > 0) {
      const current = latest();
      await app.write('document', { ...current, files: [...current.files, ...refs] }, id);
    }
    if (failed[0]) throw new Error(failed[0]);
  };

  // 这里只从记录里摘掉。服务端发现没有记录再用它，才在宽限期后清理，撤销就不会清理。
  const removeFile = async (file: MediaRef) => {
    const current = latest();
    const files = current.files.filter((f) => f.id !== file.id);
    await app.write('document', { ...current, files }, id);
    toast(`已移除${file.name ?? '文件'}`, {
      undo: () => {
        const now = latest();
        void app.write('document', { ...now, files: [...now.files, file] }, id);
      },
    });
  };

  const guard = (kind: 'scan' | 'upload', run: () => Promise<PickedFile[]>) => async () => {
    setPreparing(kind);
    try {
      await addFiles(await run());
    } catch (error) {
      toast(error instanceof Error ? error.message : '添加失败，请再试一次');
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
    : '未填写';

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
            label="证件号码"
            testID="doc-number-toggle"
            accessibilityLabel={showNumber ? '隐藏证件号码' : '显示证件号码'}
            onPress={() => setShowNumber((v) => !v)}
            value={
              <Mono style={{ fontSize: 13 }} testID="doc-number-value">
                {number}
              </Mono>
            }
          />
          <Row
            label="签发日期"
            value={data.issuedOn || '未填写'}
            testID="doc-issued"
            onPress={() =>
              sheet.open('编辑证件信息', () => <DocumentEditSheet id={id} data={data} />)
            }
          />
          <Row
            label="有效期至"
            value={data.expiresOn || '未填写'}
            last
            onPress={() =>
              sheet.open('编辑证件信息', () => <DocumentEditSheet id={id} data={data} />)
            }
          />
        </ListCard>
        <Pressable
          testID="doc-edit"
          accessibilityRole="button"
          accessibilityLabel="编辑证件信息"
          hitSlop={{ top: 8, bottom: 20 }}
          onPress={() =>
            sheet.open('编辑证件信息', () => <DocumentEditSheet id={id} data={data} />)
          }
          style={{ marginTop: -12 }}
        >
          <Text style={{ fontSize: 12, color: colors.accent }}>编辑名称、号码和日期</Text>
        </Pressable>

        <View style={{ gap: 8 }}>
          <View style={s.fileHead}>
            <SectionTitle>文件</SectionTitle>
            <Muted testID="doc-file-count">{data.files.length} 个</Muted>
          </View>
          {data.files.length === 0 ? (
            <Text style={{ fontSize: 13, color: colors.muted, paddingVertical: 14 }}>
              还没有文件。拍一张或上传 PDF。
            </Text>
          ) : (
            <View style={s.files}>
              {data.files.map((file) => (
                <View key={file.id} style={[s.file, { width: fileWidth }]}>
                  <Pressable
                    testID={`doc-file-${file.name ?? file.id}`}
                    accessibilityRole="button"
                    accessibilityLabel={file.name ?? '文件'}
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
                      {file.name ?? '文件'}
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
                      <Pressable
                        testID={`doc-file-remove-${file.name ?? file.id}`}
                        accessibilityRole="button"
                        accessibilityLabel={`移除${file.name ?? '文件'}`}
                        // 左边紧挨着下载按钮（它的热区是 12），这边不能再往左扩，否则会点错。
                        hitSlop={{ top: 14, bottom: 14, left: 4, right: 14 }}
                        onPress={() => void removeFile(file)}
                      >
                        <Text style={{ fontSize: 11, color: colors.muted }}>移除</Text>
                      </Pressable>
                    </View>
                  </View>
                </View>
              ))}
            </View>
          )}
        </View>

        <View style={s.actions}>
          <Button
            testID="doc-scan"
            tone="outline"
            height={52}
            label="拍照 / 扫描"
            labelStyle={s.actionLabel}
            busy={preparing === 'scan'}
            disabled={preparing === 'upload'}
            style={{ flex: 1, borderRadius: 14 }}
            onPress={() => void guard('scan', takePhoto)()}
          />
          <Button
            testID="doc-upload"
            height={52}
            label="上传文件"
            labelStyle={s.actionLabel}
            busy={preparing === 'upload'}
            disabled={preparing === 'scan'}
            style={{ flex: 1, borderRadius: 14 }}
            onPress={() => void guard('upload', pickDocument)()}
          />
        </View>
        <Muted style={{ fontSize: 11, lineHeight: 18 }}>
          支持 JPG、PNG、HEIC、PDF。存放在私有目录，不会出现在回忆里。
        </Muted>
        <Button
          testID="doc-delete"
          tone="ghost"
          height={44}
          label="删除这份资料"
          onPress={() =>
            sheet.open(`删除${data.name}？`, () => (
              <>
                <Muted style={{ fontSize: 13 }}>删除后，全家都看不到这份资料了。</Muted>
                <Button
                  testID="doc-delete-confirm"
                  label="确定删除"
                  onPress={() => {
                    void app.remove(id);
                    sheet.close();
                    router.back();
                    toast(`已删除${data.name}`, {
                      undo: () => void app.write('document', data, id),
                    });
                  }}
                />
              </>
            ))
          }
        />
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
        placeholder="证件或资料名称"
        maxLength={100}
      />
      <SoftInput
        testID="doc-edit-subtitle"
        value={subtitle}
        onChangeText={setSubtitle}
        placeholder="说明，比如：ICA 电子版"
        maxLength={100}
      />
      <SoftInput
        testID="doc-edit-number"
        value={number}
        onChangeText={setNumber}
        placeholder="证件号码"
        autoCapitalize="characters"
        autoCorrect={false}
        maxLength={100}
        style={{ fontFamily: fonts.monoRegular }}
      />
      <SoftInput
        testID="doc-edit-issued"
        value={issued}
        onChangeText={setIssued}
        placeholder="签发日期，比如 2026.10.06"
        maxLength={40}
      />
      <SoftInput
        testID="doc-edit-expires"
        value={expires}
        onChangeText={setExpires}
        placeholder="有效期至（可选）"
        maxLength={40}
      />
      <Button
        testID="doc-edit-save"
        label="保存"
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

const s = StyleSheet.create({
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
});
