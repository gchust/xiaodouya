import {
  formatMediaDuration,
  type LetterData,
  type MediaRef,
  type MomentData,
  mergeEdit,
  mergeMediaEdit,
} from '@xiaodouya/shared';
import * as Crypto from 'expo-crypto';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useApp } from '../lib/app';
import { type PickedFile, pickFromLibrary, queueForUpload } from '../lib/media';
import { ExistingThumb, LocalThumb, useRecorder } from '../lib/mediaViews';
import { colors, fonts } from '../theme';
import { useFeedback, useSheet } from '../ui/overlays';
import { Button, Chip, Mono, Muted, SoftInput, Toggle } from '../ui/primitives';
import { RecordTimeField, useRecordTime } from '../ui/TimeField';

export type MomentKind = 'moment' | 'letter';

/** 和 MomentData 的上限一致。超过了记录过不了校验，会整条显示不出来。 */
const MAX_MEDIA = 100;
const NOW_ONLY = [{ minutes: 0, label: '现在' }] as const;

export function MomentSheet({
  initialKind = 'moment',
  initialMilestone = false,
  initialTitle = '',
  onSaved,
  editMoment,
  editLetter,
}: {
  initialKind?: MomentKind;
  initialMilestone?: boolean;
  initialTitle?: string;
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
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [saving, setSaving] = useState(false);
  const [picking, setPicking] = useState(false);
  const recorder = useRecorder();
  const time = useRecordTime({ at: editing?.data.at, subject: 'memory' });

  const isLetter = kind === 'letter';
  const { setTitle: setSheetTitle } = sheet;
  useEffect(() => {
    if (editing) setSheetTitle(isLetter ? '修改这封信' : '修改这一刻');
    else setSheetTitle(isLetter ? '写给宝宝的信' : '记下这一刻');
  }, [editing, isLetter, setSheetTitle]);
  const hasContent = isLetter
    ? Boolean(title.trim() || text.trim())
    : // 只录音也能保存：保存时会自动停止录音。
      Boolean(title.trim() || text.trim() || kept.length || files.length || recorder.recording);
  const canSave = hasContent && !time.check.error;

  const pick = async () => {
    setPicking(true);
    try {
      const picked = await pickFromLibrary();
      if (picked.length > 0) setFiles((prev) => [...prev, ...picked]);
    } catch (error) {
      toast(error instanceof Error ? error.message : '打不开相册');
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
      Alert.alert('没有麦克风权限', '可以在系统设置里给小豆芽打开麦克风权限。');
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
      if (!isLetter && kept.length + files.length > MAX_MEDIA) {
        toast(`一条回忆最多放 ${MAX_MEDIA} 个文件，可以再记一条。`);
        return;
      }
      if (isLetter) {
        const fields = { title: title.trim() || '无题', text: text.trim(), at };
        if (editLetter) {
          const { id, data } = editLetter;
          // 弹层可能开了一会儿，只改用户动过的字段，不要盖掉家人刚改的内容。
          const latest = app.store.getSnapshot().letters.find((l) => l.id === id)?.data ?? data;
          await app.write('letter', mergeEdit(data, latest, fields), id);
          sheet.close();
          toast('已保存', { undo: () => void app.write('letter', latest, id) });
          return;
        }
        await app.write('letter', { ...fields, byName: app.label });
        sheet.close();
        toast('信已保存');
      } else {
        // 先进上传队列再写记录，文件传不上去也不会丢：队列会一直重试，记录里已经有引用。
        const refs: MediaRef[] = [];
        for (const file of files) {
          refs.push(
            await queueForUpload(app.uploads, file, {
              id: Crypto.randomUUID(),
              scope: 'memory',
              videoWifiOnly: app.prefs.videoWifiOnly,
            }),
          );
        }
        const fields = { title: title.trim(), text: text.trim(), at, milestone };
        if (editMoment) {
          const { id, data } = editMoment;
          const latest = app.store.getSnapshot().moments.find((m) => m.id === id)?.data ?? data;
          // 移除只是从记录里摘掉，文件还在存储里，撤销后还能看到。
          const media = mergeMediaEdit(data.media, latest.media, [...kept, ...refs]);
          await app.write('moment', mergeEdit(data, latest, { ...fields, media }), id);
          sheet.close();
          toast('已保存', { undo: () => void app.write('moment', latest, id) });
          return;
        }
        await app.write('moment', { ...fields, media: refs, byName: app.label });
        sheet.close();
        if (refs.length === 0) toast('已保存到回忆');
      }
      onSaved?.(kind);
      router.navigate('/recall');
    } catch (error) {
      toast(error instanceof Error ? error.message : '保存失败，请再试一次');
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
            label="这一刻"
            selected={kind === 'moment'}
            onPress={() => setKind('moment')}
            style={s.kindChip}
          />
          <Chip
            testID="kind-letter"
            label="写给宝宝的信"
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
              accessibilityLabel="选择照片或视频"
              disabled={picking}
              onPress={() => void pick()}
              style={s.picker}
            >
              <Text style={s.pickerLabel}>{picking ? '正在打开…' : '照片 / 视频'}</Text>
              <Text style={s.pickerSub}>从相册选，可多选</Text>
            </Pressable>
            <Pressable
              testID="record-audio"
              accessibilityRole="button"
              accessibilityLabel={recorder.recording ? '停止录音' : '开始录音'}
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
                {recorder.recording ? '● 录音中' : '录音'}
              </Text>
              {recorder.recording ? (
                <Mono style={{ fontSize: 10, color: colors.white, opacity: 0.8 }}>
                  {formatMediaDuration(recorder.elapsedMs)} · 点击停止
                </Mono>
              ) : (
                <Text style={s.pickerSub}>哭声、咿呀、你说的话</Text>
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
        placeholder={isLetter ? '信的标题，比如：百天快乐' : '这一刻叫什么？比如：第一次笑出声'}
        maxLength={100}
        style={{ fontFamily: fonts.serifMedium, fontSize: 15 }}
      />
      <SoftInput
        testID="moment-text"
        maxLength={20000}
        value={text}
        onChangeText={setText}
        placeholder={isLetter ? '想对长大后的宝宝说的话…' : '写下当时的样子，以后宝宝会想看的。'}
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
            label="标为里程碑"
            value={milestone}
            onChange={setMilestone}
            last
          />
        </View>
      )}
      {!hasContent ? (
        <Muted style={{ fontSize: 11, marginBottom: -8 }}>写点什么，或者选一张照片。</Muted>
      ) : null}
      <Button
        testID="moment-save"
        tone="dark"
        label="保存"
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
