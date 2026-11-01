import {
  ageParts,
  type BabyData,
  documentSuggestions,
  type EventData,
  formatMonthDay,
  knowledgeForAge,
  vaccineStatuses,
} from '@xiaodouya/shared';
import * as Crypto from 'expo-crypto';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp, useRecords } from '../lib/app';
import { formatBirthTime } from '../lib/dates';
import { GrowthSheet, VaccineSheet } from '../sheets/recordSheets';
import { colors, spacing } from '../theme';
import { useFeedback, useSheet } from '../ui/overlays';
import {
  Button,
  Chip,
  Dot,
  ListCard,
  Mono,
  Muted,
  PageTitle,
  PressScale,
  Row,
  SectionTitle,
  SoftInput,
  Stripes,
} from '../ui/primitives';
import { SyncingPlaceholder } from '../ui/SyncingPlaceholder';

export function InfoScreen() {
  const insets = useSafeAreaInsets();
  const { baby, documents, events } = useRecords();
  const sheet = useSheet();
  const router = useRouter();
  if (!baby) return <SyncingPlaceholder />;
  const now = Date.now();
  const birthAt = baby.data.birthAt;
  const data = events.map((e) => e.data);
  const vaccines = vaccineStatuses(birthAt, data, now);
  const knowledge = knowledgeForAge(ageParts(birthAt, now).months);

  return (
    <ScrollView
      testID="info-screen"
      style={s.scroll}
      contentContainerStyle={[s.content, { paddingTop: insets.top + 12 }]}
      showsVerticalScrollIndicator={false}
    >
      <PageTitle>资料</PageTitle>

      <View style={s.section}>
        <SectionTitle>出生档案</SectionTitle>
        <ListCard>
          <Row
            label="名字"
            value={baby.data.name}
            onPress={() => openEdit(sheet, baby.id, baby.data, 'name')}
            testID="birth-name"
          />
          <Row label="出生时间" value={formatBirthTime(birthAt)} />
          <Row
            label="体重 / 身长"
            value={
              baby.data.birthWeightKg || baby.data.birthLengthCm
                ? `${baby.data.birthWeightKg ?? '—'} kg · ${baby.data.birthLengthCm ?? '—'} cm`
                : '待补充'
            }
            onPress={() => openEdit(sheet, baby.id, baby.data, 'measures')}
            testID="birth-measures"
          />
          <Row
            label="医院"
            value={baby.data.hospital || '待补充'}
            onPress={() => openEdit(sheet, baby.id, baby.data, 'hospital')}
            testID="birth-hospital"
          />
          <Row
            label="血型"
            value={baby.data.bloodType || '待补充'}
            onPress={() => openEdit(sheet, baby.id, baby.data, 'bloodType')}
            testID="birth-blood"
            last
          />
        </ListCard>
      </View>

      <View style={s.section}>
        <View style={s.sectionHead}>
          <SectionTitle>证件夹</SectionTitle>
          <Pressable
            testID="doc-add"
            accessibilityRole="button"
            accessibilityLabel="添加证件"
            hitSlop={8}
            onPress={() => sheet.open('添加证件 / 资料', () => <DocAddSheet />)}
          >
            <Text style={s.link}>＋ 添加</Text>
          </Pressable>
        </View>
        {documents.length === 0 ? (
          <Muted style={{ fontSize: 13, lineHeight: 20 }}>
            出生证明、健康手册、护照……都可以放在这里，需要的时候随时拿得出来。
          </Muted>
        ) : (
          <View style={s.docGrid}>
            {documents.map((d) => {
              const first = d.data.files[0];
              return (
                <PressScale
                  key={d.id}
                  testID={`doc-card-${d.data.name}`}
                  accessibilityLabel={d.data.name}
                  scaleTo={0.97}
                  style={s.docCard}
                  onPress={() => router.push({ pathname: '/doc/[id]', params: { id: d.id } })}
                >
                  <Stripes style={s.docThumb}>
                    <Mono weight="medium" style={{ fontSize: 10, color: colors.muted }}>
                      {first ? (first.kind === 'pdf' ? 'PDF' : 'IMG') : '空'}
                    </Mono>
                  </Stripes>
                  <Text style={s.docName} numberOfLines={1}>
                    {d.data.name}
                  </Text>
                  <Text
                    style={{
                      fontSize: 11,
                      color: d.data.files.length ? colors.muted : colors.accent,
                    }}
                  >
                    {d.data.files.length ? `${d.data.files.length} 个文件` : '待上传'}
                  </Text>
                </PressScale>
              );
            })}
          </View>
        )}
        <Muted style={{ fontSize: 11 }}>
          私有存储，只有家人能看 · 打开时生成 10 分钟有效的链接
        </Muted>
      </View>

      <View style={s.section}>
        <View style={s.sectionHead}>
          <SectionTitle>体重</SectionTitle>
          <Pressable
            testID="growth-add"
            accessibilityRole="button"
            accessibilityLabel="记录身高体重"
            hitSlop={8}
            onPress={() => sheet.open('身高体重', () => <GrowthSheet />)}
          >
            <Text style={s.link}>＋ 记录身高体重</Text>
          </Pressable>
        </View>
        <GrowthChart baby={baby.data} events={data} />
      </View>

      <View style={s.section}>
        <SectionTitle>疫苗本</SectionTitle>
        <ListCard>
          {vaccines.map((v, i) => (
            <Pressable
              key={v.id}
              testID={`vaccine-row-${v.id}`}
              accessibilityRole="button"
              accessibilityLabel={v.name}
              disabled={v.state === 'done'}
              onPress={() =>
                sheet.open('疫苗接种', () => <VaccineSheet birthAt={birthAt} preselect={v.id} />)
              }
              style={[s.vaccineRow, i < vaccines.length - 1 ? s.divider : null]}
            >
              <Dot
                color={
                  v.state === 'done' ? colors.green : v.state === 'due' ? colors.accent : colors.off
                }
              />
              <View style={{ flex: 1, gap: 1 }}>
                <Text style={{ fontSize: 13, color: colors.ink }}>{v.name}</Text>
                <Muted style={{ fontSize: 11 }}>
                  {v.ageLabel}
                  {v.note ? ` · ${v.note}` : ''}
                </Muted>
              </View>
              <Text
                style={{
                  fontSize: 11,
                  color:
                    v.state === 'done'
                      ? colors.green
                      : v.state === 'due'
                        ? colors.accent
                        : colors.muted,
                }}
              >
                {v.state === 'done' && v.doneAt
                  ? `已接种 ${formatMonthDay(v.doneAt)}`
                  : v.state === 'due'
                    ? '可以预约了'
                    : '未到时间'}
              </Text>
            </Pressable>
          ))}
        </ListCard>
        <Muted style={{ fontSize: 11, lineHeight: 18 }}>
          按新加坡国家儿童免疫计划排列，以诊所安排和健康手册为准。
        </Muted>
      </View>

      <View style={s.section}>
        <SectionTitle>这个月该知道的</SectionTitle>
        {knowledge.map((k) => (
          <View key={k.title} testID="knowledge-card" style={s.knowledge}>
            <Text style={{ fontSize: 14, fontWeight: '500', color: colors.ink }}>{k.title}</Text>
            <Text style={{ fontSize: 12, lineHeight: 20, color: colors.inkSoft }}>{k.body}</Text>
          </View>
        ))}
        <Muted style={{ fontSize: 11, lineHeight: 18 }}>
          仅供参考，宝宝不舒服时请以医生意见为准。
        </Muted>
      </View>
    </ScrollView>
  );
}

function GrowthChart({ baby, events }: { baby: BabyData; events: EventData[] }) {
  const points = [
    ...(baby.birthWeightKg ? [{ w: baby.birthWeightKg, label: '出生' }] : []),
    ...events
      .filter((e): e is Extract<EventData, { type: 'growth' }> => e.type === 'growth')
      .sort((a, b) => a.at - b.at)
      .map((e) => ({ w: e.weightKg, label: formatMonthDay(e.at) })),
  ].slice(-5);
  if (points.length === 0) {
    return (
      <View style={[s.chart, { alignItems: 'center', justifyContent: 'center' }]}>
        <Muted style={{ fontSize: 13 }}>记录一次体重，这里就会画出来。</Muted>
      </View>
    );
  }
  const max = Math.max(...points.map((p) => p.w));
  return (
    <View style={s.chart} testID="growth-chart">
      {points.map((p, i) => (
        <View key={`${p.label}-${p.w}`} style={s.barColumn}>
          <Mono weight="medium" style={{ fontSize: 11 }}>
            {p.w.toFixed(1)}
          </Mono>
          <View
            style={[
              s.bar,
              { height: Math.round((p.w / max) * 78), opacity: i === points.length - 1 ? 1 : 0.45 },
            ]}
          />
          <Muted style={{ fontSize: 10 }} numberOfLines={1}>
            {p.label}
          </Muted>
        </View>
      ))}
    </View>
  );
}

type EditField = 'name' | 'measures' | 'hospital' | 'bloodType';

function openEdit(
  sheet: ReturnType<typeof useSheet>,
  id: string,
  baby: BabyData,
  field: EditField,
) {
  const titles: Record<EditField, string> = {
    name: '名字',
    measures: '出生体重和身长',
    hospital: '出生医院',
    bloodType: '血型',
  };
  sheet.open(titles[field], () => <BabyEditSheet id={id} baby={baby} field={field} />);
}

function BabyEditSheet({ id, baby, field }: { id: string; baby: BabyData; field: EditField }) {
  const app = useApp();
  const sheet = useSheet();
  const { toast } = useFeedback();
  const [text, setText] = useState(
    field === 'name'
      ? baby.name
      : field === 'hospital'
        ? (baby.hospital ?? '')
        : (baby.bloodType ?? ''),
  );
  const [weight, setWeight] = useState(baby.birthWeightKg?.toString() ?? '');
  const [length, setLength] = useState(baby.birthLengthCm?.toString() ?? '');

  const save = async () => {
    const next: BabyData = { ...baby };
    if (field === 'name') {
      if (!text.trim()) return;
      next.name = text.trim();
    }
    if (field === 'hospital') next.hospital = text.trim() || undefined;
    if (field === 'bloodType') next.bloodType = text.trim() || undefined;
    if (field === 'measures') {
      const w = Number.parseFloat(weight);
      const l = Number.parseFloat(length);
      if (weight && !(w >= 0.3 && w <= 10)) return toast('体重看起来不太对，单位是公斤');
      if (length && !(l >= 20 && l <= 80)) return toast('身长看起来不太对，单位是厘米');
      next.birthWeightKg = weight ? w : undefined;
      next.birthLengthCm = length ? l : undefined;
    }
    await app.write('baby', next, id);
    sheet.close();
    toast('已保存');
  };

  return (
    <>
      {field === 'measures' ? (
        <>
          <SoftInput
            testID="edit-weight"
            value={weight}
            onChangeText={setWeight}
            keyboardType="decimal-pad"
            placeholder="体重（kg），比如 3.4"
          />
          <SoftInput
            testID="edit-length"
            value={length}
            onChangeText={setLength}
            keyboardType="decimal-pad"
            placeholder="身长（cm），比如 50"
          />
        </>
      ) : (
        <SoftInput
          testID="edit-text"
          value={text}
          onChangeText={setText}
          placeholder={field === 'bloodType' ? '比如 O+' : '请填写'}
          maxLength={100}
        />
      )}
      <Button testID="edit-save" label="保存" onPress={() => void save()} />
    </>
  );
}

function DocAddSheet() {
  const app = useApp();
  const sheet = useSheet();
  const router = useRouter();
  const [name, setName] = useState('');
  return (
    <>
      <View style={s.docChips}>
        {['出生证明', '护照', '儿童健康手册', ...documentSuggestions].map((v) => (
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
        placeholder="证件或资料名称"
        maxLength={100}
      />
      <Button
        testID="doc-create"
        label="创建并添加文件"
        disabled={!name.trim()}
        onPress={() => {
          const id = Crypto.randomUUID();
          void app.write('document', { name: name.trim(), files: [] }, id);
          sheet.close();
          router.push({ pathname: '/doc/[id]', params: { id } });
        }}
      />
    </>
  );
}

const s = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: colors.paper },
  content: { paddingHorizontal: spacing.page, paddingBottom: 28, gap: 24 },
  section: { gap: 8 },
  sectionHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  link: { fontSize: 12, color: colors.accent },
  docGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  docCard: {
    width: '48.8%',
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 14,
    padding: 12,
    gap: 6,
  },
  docThumb: { height: 56, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  docName: { fontSize: 13, color: colors.ink },
  chart: {
    flexDirection: 'row',
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 14,
    padding: 16,
    alignItems: 'flex-end',
    gap: 10,
    height: 150,
  },
  barColumn: { flex: 1, alignItems: 'center', justifyContent: 'flex-end', gap: 6, height: '100%' },
  bar: {
    width: '100%',
    maxWidth: 34,
    backgroundColor: colors.accent,
    borderTopLeftRadius: 6,
    borderTopRightRadius: 6,
    borderBottomLeftRadius: 2,
    borderBottomRightRadius: 2,
  },
  vaccineRow: { flexDirection: 'row', gap: 10, alignItems: 'center', paddingVertical: 11 },
  divider: { borderBottomWidth: 1, borderBottomColor: colors.rule },
  knowledge: {
    paddingHorizontal: 16,
    paddingVertical: 14,
    backgroundColor: colors.sand,
    borderRadius: 12,
    gap: 4,
  },
  docChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
});
