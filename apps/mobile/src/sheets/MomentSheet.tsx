import { formatMediaDuration, type MediaRef } from '@xiaodouya/shared';
import * as Crypto from 'expo-crypto';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useApp } from '../lib/app';
import { type PickedFile, pickFromLibrary, queueForUpload } from '../lib/media';
import { LocalThumb, useRecorder } from '../lib/mediaViews';
import { colors, fonts } from '../theme';
import { useFeedback, useSheet } from '../ui/overlays';
import { Button, Chip, Mono, Muted, SoftInput, Toggle } from '../ui/primitives';

type Kind = 'moment' | 'letter';

export function MomentSheet({
  initialKind = 'moment',
  initialMilestone = false,
  initialTitle = '',
}: {
  initialKind?: Kind;
  initialMilestone?: boolean;
  initialTitle?: string;
}) {
  const app = useApp();
  const sheet = useSheet();
  const router = useRouter();
  const { toast } = useFeedback();
  const [kind, setKind] = useState<Kind>(initialKind);
  const [title, setTitle] = useState(initialTitle);
  const [text, setText] = useState('');
  const [milestone, setMilestone] = useState(initialMilestone);
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [saving, setSaving] = useState(false);
  const [picking, setPicking] = useState(false);
  const recorder = useRecorder();

  const isLetter = kind === 'letter';
  const canSave = isLetter
    ? Boolean(title.trim() || text.trim())
    : Boolean(title.trim() || text.trim() || files.length);

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
      const now = Date.now();
      if (isLetter) {
        await app.write('letter', {
          title: title.trim() || '无题',
          text: text.trim(),
          at: now,
          byName: app.label,
        });
        sheet.close();
        toast('信已保存');
      } else {
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
        await app.write('moment', {
          title: title.trim(),
          text: text.trim(),
          at: now,
          milestone,
          media: refs,
          byName: app.label,
        });
        sheet.close();
        if (refs.length === 0) toast('已保存到回忆');
      }
      router.navigate('/recall');
    } catch (error) {
      toast(error instanceof Error ? error.message : '保存失败，请再试一次');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
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
                  ? { backgroundColor: colors.accent, borderColor: colors.accent }
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
          {files.length > 0 ? (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ gap: 8 }}
            >
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
      {!canSave ? (
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
