import {
  formatMediaDuration,
  type LetterData,
  MAX_MEDIA_PER_RECORD,
  type MediaRef,
  type MomentData,
  mergeEdit,
  mergeMediaEdit,
  t,
} from '@xiaodouya/shared';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useApp } from '../lib/app';
import { IS_E2E } from '../lib/config';
import { type PickedFile, pickFromLibrary, queueAllForUpload } from '../lib/media';
import { mergePicked } from '../lib/mediaUtils';
import { ExistingThumb, LocalThumb, useRecorder } from '../lib/mediaViews';
import { colors, fonts } from '../theme';
import { useFeedback, useSheet } from '../ui/overlays';
import { Button, Chip, Mono, Muted, SoftInput, Toggle } from '../ui/primitives';
import { RecordTimeField, useRecordTime } from '../ui/TimeField';

export type MomentKind = 'moment' | 'letter';

const NOW_ONLY = [
  {
    minutes: 0,
    get label() {
      return t().recall.now;
    },
  },
] as const;

export function MomentSheet({
  initialKind = 'moment',
  initialMilestone = false,
  initialTitle = '',
  initialFiles = [],
  onSaved,
  editMoment,
  editLetter,
}: {
  initialKind?: MomentKind;
  initialMilestone?: boolean;
  initialTitle?: string;
  /** App 被系统回收后找回的选择结果。 */
  initialFiles?: PickedFile[];
  /** 保存后由回忆页切到能看到这条内容的子标签。 */
  onSaved?: (kind: MomentKind) => void;
  /** 修改已有的回忆。类型不能换：回忆和信是两个集合。 */
  editMoment?: { id: string; data: MomentData };
  editLetter?: { id: string; data: LetterData };
}) {
  const app = useApp();
  const sheet = useSheet();
  const router = useRouter();
  const { toast } = useFeedback();
  const editing = editMoment ?? editLetter;
  const [kind, setKind] = useState<MomentKind>(
    editLetter ? 'letter' : editMoment ? 'moment' : initialKind,
  );
  const [title, setTitle] = useState(editing?.data.title ?? initialTitle);
  const [text, setText] = useState(editing?.data.text ?? '');
  const [milestone, setMilestone] = useState(editMoment?.data.milestone ?? initialMilestone);
  const [kept, setKept] = useState<MediaRef[]>(editMoment?.data.media ?? []);
  const [files, setFiles] = useState<PickedFile[]>(initialFiles);
  const [saving, setSaving] = useState(false);
  const [picking, setPicking] = useState(false);
  const recorder = useRecorder();
  const time = useRecordTime({ at: editing?.data.at, subject: 'memory' });

  const isLetter = kind === 'letter';
  const { setTitle: setSheetTitle } = sheet;
  useEffect(() => {
    if (editing) setSheetTitle(isLetter ? t().recall.editLetter : t().recall.editMoment);
    else setSheetTitle(isLetter ? t().recall.letterToBaby : t().ui.recordMoment);
  }, [editing, isLetter, setSheetTitle]);
  const hasContent = isLetter
    ? Boolean(title.trim() || text.trim())
    : // 只录音也能保存：保存时会自动停止录音。
      Boolean(title.trim() || text.trim() || kept.length || files.length || recorder.recording);
  const canSave = hasContent && !time.check.error;

  const pick = async (options?: { e2eBulk?: boolean }) => {
    setPicking(true);
    try {
      const picked = await pickFromLibrary(options);
      const merged = mergePicked(files, picked, kept.length, MAX_MEDIA_PER_RECORD);
      setFiles(merged.files);
      if (merged.dropped > 0) {
        toast(t().recall.tooManyDropped(MAX_MEDIA_PER_RECORD, merged.dropped));
      }
    } catch (error) {
      toast(error instanceof Error ? error.message : t().recall.cantOpenGallery);
    } finally {
      setPicking(false);
    }
  };

  const toggleRecord = async () => {
    if (recorder.recording) {
      const file = await recorder.stop();
      if (file) setFiles((prev) => [...prev, file]);
      return;
    }
    const started = await recorder.start();
    if (!started) {
      Alert.alert(t().recall.noMic, t().recall.micSettings);
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      if (recorder.recording) {
        const last = await recorder.stop();
        if (last) files.push(last);
      }
      const at = time.resolve();
      if (!isLetter && kept.length + files.length > MAX_MEDIA_PER_RECORD) {
        toast(t().recall.tooMany(MAX_MEDIA_PER_RECORD));
        return;
      }
      if (isLetter) {
        const fields = { title: title.trim() || t().ui.untitled, text: text.trim(), at };
        if (editLetter) {
          const { id, data } = editLetter;
          // 弹层可能开了一会儿，只改用户动过的字段，不要盖掉家人刚改的内容。
          const latest = app.store.getSnapshot().letters.find((l) => l.id === id)?.data ?? data;
          await app.write('letter', mergeEdit(data, latest, fields), id);
          sheet.close();
          toast(t().records.saved, { undo: () => void app.write('letter', latest, id) });
          return;
        }
        await app.write('letter', { ...fields, byName: app.label });
        sheet.close();
        toast(t().recall.letterSaved);
      } else {
        // 先进上传队列再写记录，文件传不上去也不会丢：队列会一直重试，记录里已经有引用。
        const { refs, failed } = await queueAllForUpload(app.uploads, files, {
          scope: 'memory',
          videoWifiOnly: app.prefs.videoWifiOnly,
        });
        // 全部失败又没写别的内容时不存空记录，让用户留在弹层里看到原因。
        if (failed[0] && refs.length === 0 && !kept.length && !title.trim() && !text.trim()) {
          toast(failed[0]);
          return;
        }
        const failedNote = failed[0] ? t().recall.filesFailed(failed.length, failed[0]) : null;
        const fields = { title: title.trim(), text: text.trim(), at, milestone };
        if (editMoment) {
          const { id, data } = editMoment;
          const latest = app.store.getSnapshot().moments.find((m) => m.id === id)?.data ?? data;
          // 这里只从记录里摘掉。服务端发现没有记录再用它，才在宽限期后清理，撤销就不会清理。
          const media = mergeMediaEdit(data.media, latest.media, [...kept, ...refs]);
          await app.write('moment', mergeEdit(data, latest, { ...fields, media }), id);
          sheet.close();
          toast(failedNote ?? t().records.saved, {
            undo: () => void app.write('moment', latest, id),
          });
          return;
        }
        await app.write('moment', { ...fields, media: refs, byName: app.label });
        sheet.close();
        if (failedNote) toast(failedNote);
        else if (refs.length === 0) toast(t().recall.savedToMemories);
      }
      onSaved?.(kind);
      router.navigate('/recall');
    } catch (error) {
      toast(error instanceof Error ? error.message : t().recall.saveFailed);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      {editing ? null : (
        <View style={s.kinds}>
          <Chip
            testID="kind-moment"
            label={t().recall.thisMoment}
            selected={kind === 'moment'}
            onPress={() => setKind('moment')}
            style={s.kindChip}
          />
          <Chip
            testID="kind-letter"
            label={t().recall.letterToBaby}
            selected={kind === 'letter'}
            onPress={() => setKind('letter')}
            style={s.kindChip}
          />
        </View>
      )}
      {isLetter ? null : (
        <>
          <View style={s.pickers}>
            <Pressable
              testID="pick-media"
              accessibilityRole="button"
              accessibilityLabel={t().recall.pickMedia}
              disabled={picking}
              onPress={() => void pick()}
              onLongPress={IS_E2E ? () => void pick({ e2eBulk: true }) : undefined}
              style={s.picker}
            >
              <Text style={s.pickerLabel}>
                {picking ? t().recall.opening : t().recall.photoVideo}
              </Text>
              <Text style={s.pickerSub}>{t().recall.fromGallery}</Text>
            </Pressable>
            <Pressable
              testID="record-audio"
              accessibilityRole="button"
              accessibilityLabel={
                recorder.recording ? t().recall.stopRecording : t().recall.startRecording
              }
              onPress={() => void toggleRecord()}
              style={[
                s.picker,
                recorder.recording
                  ? {
                      backgroundColor: colors.accent,
                      borderColor: colors.accent,
                      borderStyle: 'solid',
                    }
                  : null,
              ]}
            >
              <Text style={[s.pickerLabel, recorder.recording ? { color: colors.white } : null]}>
                {recorder.recording ? t().recall.recordingNow : t().ui.recording}
              </Text>
              {recorder.recording ? (
                <Mono style={{ fontSize: 10, color: colors.white, opacity: 0.8 }}>
                  {t().recall.tapToStop(formatMediaDuration(recorder.elapsedMs))}
                </Mono>
              ) : (
                <Text style={s.pickerSub}>{t().recall.recordHint}</Text>
              )}
            </Pressable>
          </View>
          {kept.length + files.length > 0 ? (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ gap: 8 }}
            >
              {kept.map((media) => (
                <ExistingThumb
                  key={media.id}
                  media={media}
                  onRemove={() => setKept((prev) => prev.filter((m) => m.id !== media.id))}
                />
              ))}
              {files.map((file) => (
                <LocalThumb
                  key={file.uri}
                  file={file}
                  onRemove={() => setFiles((prev) => prev.filter((f) => f.uri !== file.uri))}
                />
              ))}
            </ScrollView>
          ) : null}
        </>
      )}
      <SoftInput
        testID="moment-title"
        value={title}
        onChangeText={setTitle}
        placeholder={
          isLetter ? t().recall.letterTitlePlaceholder : t().recall.momentTitlePlaceholder
        }
        maxLength={100}
        style={{ fontFamily: fonts.serifMedium, fontSize: 15 }}
      />
      <SoftInput
        testID="moment-text"
        maxLength={20000}
        value={text}
        onChangeText={setText}
        placeholder={isLetter ? t().recall.letterPlaceholder : t().recall.momentPlaceholder}
        multiline
        numberOfLines={4}
        textAlignVertical="top"
        style={s.textArea}
      />
      <RecordTimeField time={time} offsets={NOW_ONLY} />
      {isLetter ? null : (
        <View>
          <Toggle
            testID="moment-milestone"
            label={t().recall.markMilestone}
            value={milestone}
            onChange={setMilestone}
            last
          />
        </View>
      )}
      {!hasContent ? (
        <Muted style={{ fontSize: 11, marginBottom: -8 }}>{t().recall.needContent}</Muted>
      ) : null}
      <Button
        testID="moment-save"
        tone="dark"
        label={t().common.save}
        disabled={!canSave}
        busy={saving}
        onPress={() => void save()}
      />
    </>
  );
}

const s = StyleSheet.create({
  kinds: { flexDirection: 'row', gap: 8 },
  kindChip: { paddingHorizontal: 14, paddingVertical: 8 },
  pickers: { flexDirection: 'row', gap: 8 },
  picker: {
    flex: 1,
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
  textArea: { fontFamily: fonts.serifMedium, lineHeight: 24, minHeight: 112 },
});
