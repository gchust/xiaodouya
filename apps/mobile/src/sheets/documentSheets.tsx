import { type DocumentData, documentReaderChoices, effectiveReaders, t } from '@xiaodouya/shared';
import * as Crypto from 'expo-crypto';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useApp, useRegion } from '../lib/app';
import { colors } from '../theme';
import { useFeedback, useSheet } from '../ui/overlays';
import { Button, Chip, Dot, ListCard, Muted, SoftInput } from '../ui/primitives';

/**
 * 新建一份证件。`owner` 有值时是这位家人自己的证件（F-137）：一开始谁都不给看，进详情页再选。
 * 建议名称来自地区：宝宝的和大人的不一样。
 */
export function DocAddSheet({ owner }: { owner?: string }) {
  const app = useApp();
  const sheet = useSheet();
  const router = useRouter();
  const region = useRegion();
  const [name, setName] = useState('');
  const suggestions = owner ? region.personalDocumentSuggestions : region.documentSuggestions;
  return (
    <>
      <View style={s.chips}>
        {suggestions.map((v) => (
          <Chip
            key={v}
            label={v}
            selected={name === v}
            onPress={() => setName(v)}
            testID={`doc-chip-${v}`}
          />
        ))}
      </View>
      <SoftInput
        testID="doc-name"
        value={name}
        onChangeText={setName}
        placeholder={t().info.docName}
        maxLength={100}
      />
      <Button
        testID="doc-create"
        label={t().info.createAndAdd}
        disabled={!name.trim()}
        onPress={() => {
          const id = Crypto.randomUUID();
          const data: DocumentData = owner
            ? { name: name.trim(), files: [], owner, sharedWith: [] }
            : { name: name.trim(), files: [] };
          void app.write('document', data, id);
          sheet.close();
          router.push({
            pathname: '/doc/[id]',
            params: owner ? { id, from: 'family' } : { id },
          });
        }}
      />
    </>
  );
}

/** 一行“谁能看”的摘要：只算现在真的能看的家人。 */
export function readersText(
  data: DocumentData,
  userId: string | null,
  members: Parameters<typeof effectiveReaders>[1],
) {
  const readers = effectiveReaders(data, members, userId);
  if (readers.length === 0) return t().info.onlyMe;
  return t().info.readersSummary(readers.map((m) => m.label).join(t().info.readerSeparator));
}

/**
 * 本人选谁能看自己的证件。保存时只留现在能选的人：已经离开家庭、改成只看回忆的不再留在列表里，
 * 以后他们回来也不会自动又能看。
 */
export function DocumentReadersSheet({ id, data }: { id: string; data: DocumentData }) {
  const app = useApp();
  const sheet = useSheet();
  const { toast } = useFeedback();
  const userId = app.me?.user.id ?? null;
  const choices = documentReaderChoices(app.me?.members ?? [], userId);
  const [selected, setSelected] = useState(
    () => new Set(effectiveReaders(data, app.me?.members ?? [], userId).map((m) => m.userId)),
  );
  const toggle = (memberId: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(memberId)) next.delete(memberId);
      else next.add(memberId);
      return next;
    });

  const save = async () => {
    // 弹层可能开了一会儿，用最新的版本，不要盖掉刚加的文件。
    const latest = app.store.getSnapshot().documents.find((d) => d.id === id)?.data ?? data;
    const sharedWith = choices.filter((m) => selected.has(m.userId)).map((m) => m.userId);
    await app.write('document', { ...latest, sharedWith }, id);
    sheet.close();
    toast(t().info.readersSaved);
  };

  return (
    <>
      {choices.length === 0 ? (
        <Muted style={{ fontSize: 13, lineHeight: 20 }}>{t().info.readersNone}</Muted>
      ) : (
        <ListCard>
          {choices.map((m, i) => {
            const on = selected.has(m.userId);
            return (
              <Pressable
                key={m.userId}
                testID={`doc-reader-${m.label}`}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: on }}
                accessibilityLabel={t().info.readerA11y(m.label, on)}
                onPress={() => toggle(m.userId)}
                style={[s.row, i < choices.length - 1 ? s.divider : null]}
              >
                <View style={{ width: 16 }}>
                  <Dot color={on ? colors.green : colors.off} />
                </View>
                <Text style={{ flex: 1, fontSize: 14, color: colors.ink }}>{m.label}</Text>
                <Text style={{ fontSize: 12, color: on ? colors.green : colors.muted }}>
                  {on ? t().info.readerOn : t().info.readerOff}
                </Text>
              </Pressable>
            );
          })}
        </ListCard>
      )}
      <Muted style={{ fontSize: 12, lineHeight: 19 }}>{t().info.readersHint}</Muted>
      <Button testID="doc-readers-save" label={t().common.save} onPress={() => void save()} />
    </>
  );
}

const s = StyleSheet.create({
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 13 },
  divider: { borderBottomWidth: 1, borderBottomColor: colors.rule },
});
