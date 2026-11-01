import {
  ageParts,
  type BabyData,
  birthMeasuresFromInput,
  birthMeasureText,
  type EventData,
  formatBirthMeasures,
  formatFullDate,
  formatMonthDay,
  knowledgeForAge,
  normalizeVaccineId,
  otherVaccineRecords,
  regionFor,
  scaleFor,
  toDisplay,
  type Units,
  type VaccineStatus,
  vaccineStatuses,
} from '@xiaodouya/shared';
import * as Crypto from 'expo-crypto';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp, useRecords, useRegion, useUnits } from '../lib/app';
import { formatBirthTime, isBirthInFuture } from '../lib/dates';
import { gridItemWidth } from '../lib/layout';
import { fileBadge } from '../lib/mediaUtils';
import { useTabScrollRef } from '../lib/tabScroll';
import { EventActionsSheet, GrowthSheet, VaccineSheet } from '../sheets/recordSheets';
import { colors, spacing } from '../theme';
import { BirthPicker } from '../ui/BirthPicker';
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
import { RegionPicker } from '../ui/RegionPicker';
import { SyncingPlaceholder } from '../ui/SyncingPlaceholder';

const DOC_GAP = 8;
/** 链接文字只有 16 高，上下各扩 14 才到 44。 */
const LINK_HIT_SLOP = { top: 14, bottom: 14, left: 12, right: 12 };

export function InfoScreen() {
  const insets = useSafeAreaInsets();
  const scrollRef = useTabScrollRef('info');
  const { baby, documents, events } = useRecords();
  const { role } = useApp();
  const region = useRegion();
  const units = useUnits();
  const sheet = useSheet();
  const router = useRouter();
  const { width: windowWidth } = useWindowDimensions();
  if (!baby) return <SyncingPlaceholder />;
  const docWidth = gridItemWidth(windowWidth - spacing.page * 2, 2, DOC_GAP);
  const now = Date.now();
  const birthAt = baby.data.birthAt;
  const data = events.map((e) => e.data);
  const vaccines = vaccineStatuses(region, birthAt, data, now);
  const others = otherVaccineRecords(region, events);
  const knowledge = knowledgeForAge(ageParts(birthAt, now).months, units.temperature);
  // 记错了日期只能删掉重记，所以打过的剂次也要能点开。时间线只显示最近的几条，别处点不到。
  const openShot = (id: string) => {
    const entry = events.find((e) => e.id === id);
    if (!entry) return;
    sheet.open('这条接种记录', () => <EventActionsSheet id={entry.id} event={entry.data} />);
  };
  const openDose = (dose: VaccineStatus) => {
    if (dose.state !== 'done') {
      sheet.open('疫苗接种', () => <VaccineSheet birthAt={birthAt} preselect={dose.id} />);
      return;
    }
    const shot = events.find(
      (e) => e.data.type === 'vaccine' && normalizeVaccineId(e.data.vaccineId) === dose.id,
    );
    if (shot) openShot(shot.id);
  };

  return (
    <ScrollView
      ref={scrollRef}
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
          <Row
            label="出生时间"
            value={formatBirthTime(birthAt)}
            testID="birth-at"
            onPress={() =>
              sheet.open('出生时间', () => <BirthTimeSheet id={baby.id} baby={baby.data} />)
            }
          />
          <Row
            label="体重 / 身长"
            value={
              baby.data.birthWeightKg || baby.data.birthLengthCm
                ? formatBirthMeasures(baby.data, units)
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
          />
          <Row
            label="地区"
            value={region.name}
            testID="region-row"
            // 全家共用同一份疫苗表，只有管理员能改。服务端也按这个规则校验。
            onPress={
              role === 'admin'
                ? () => sheet.open('所在地区', () => <RegionSheet id={baby.id} baby={baby.data} />)
                : undefined
            }
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
            hitSlop={LINK_HIT_SLOP}
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
                  style={[s.docCard, { width: docWidth }]}
                  onPress={() => router.push({ pathname: '/doc/[id]', params: { id: d.id } })}
                >
                  <Stripes style={s.docThumb}>
                    <Mono weight="medium" style={{ fontSize: 10, color: colors.muted }}>
                      {first ? fileBadge(first) : '空'}
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
          <SectionTitle>体重（{scaleFor('weight', units.weight).label}）</SectionTitle>
          <Pressable
            testID="growth-add"
            accessibilityRole="button"
            accessibilityLabel="记录身高体重"
            hitSlop={LINK_HIT_SLOP}
            onPress={() => sheet.open('身高体重', () => <GrowthSheet />)}
          >
            <Text style={s.link}>＋ 记录身高体重</Text>
          </Pressable>
        </View>
        <GrowthChart baby={baby.data} events={data} units={units} />
      </View>

      <View style={s.section}>
        <View style={s.sectionHead}>
          <SectionTitle>疫苗本</SectionTitle>
          <Pressable
            testID="vaccine-add-custom"
            accessibilityRole="button"
            accessibilityLabel="记一剂其他疫苗"
            hitSlop={LINK_HIT_SLOP}
            onPress={() => sheet.open('疫苗接种', () => <VaccineSheet birthAt={birthAt} custom />)}
          >
            <Text style={s.link}>＋ 其他疫苗</Text>
          </Pressable>
        </View>
        {region.emptyScheduleNote ? (
          <Muted testID="vaccine-empty-note" style={{ fontSize: 13, lineHeight: 20 }}>
            {region.emptyScheduleNote}
          </Muted>
        ) : null}
        {vaccines.length > 0 ? (
          <ListCard>
            {vaccines.map((v, i) => (
              <VaccineRow
                key={v.id}
                dose={v}
                last={i === vaccines.length - 1}
                onPress={() => openDose(v)}
              />
            ))}
          </ListCard>
        ) : null}
        {others.length > 0 ? (
          <View testID="vaccine-other-section" style={s.section}>
            <Text style={s.subTitle}>其他接种记录</Text>
            <ListCard>
              {others.map((record, i) => (
                <Pressable
                  key={record.id}
                  testID={`vaccine-other-${record.id}`}
                  accessibilityRole="button"
                  accessibilityLabel={record.name}
                  onPress={() => openShot(record.id)}
                  style={[s.vaccineRow, i < others.length - 1 ? s.divider : null]}
                >
                  <View style={{ width: 16 }}>
                    <Dot color={colors.green} />
                  </View>
                  <Text style={{ flex: 1, fontSize: 13, color: colors.ink }}>{record.name}</Text>
                  <Text style={{ fontSize: 11, color: colors.green }}>
                    已接种 {formatFullDate(record.at)}
                  </Text>
                </Pressable>
              ))}
            </ListCard>
            <Muted style={{ fontSize: 11, lineHeight: 18 }}>
              这些记录不在当前地区的疫苗表里，也不会自动算进上面的剂次。不同地区的疫苗能不能互相替代，请问医生。
            </Muted>
          </View>
        ) : null}
        <Muted testID="vaccine-disclaimer" style={{ fontSize: 11, lineHeight: 18 }}>
          {region.disclaimer}
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

function VaccineRow({
  dose,
  last,
  onPress,
}: {
  dose: VaccineStatus;
  last: boolean;
  onPress: () => void;
}) {
  // 看情况或和医生商量的剂次不能写成“可以预约了”，那等于建议每个孩子都打。
  const optional = dose.kind !== 'routine' && dose.state !== 'done';
  const due = dose.state === 'due' && !optional;
  const statusColor = dose.state === 'done' ? colors.green : due ? colors.accent : colors.muted;
  const status =
    dose.state === 'done' && dose.doneAt !== null
      ? `已接种 ${formatMonthDay(dose.doneAt)}`
      : dose.kind === 'shared-decision'
        ? '和医生商量'
        : dose.kind === 'conditional'
          ? '看情况'
          : due
            ? '可以预约了'
            : '未到时间';
  return (
    <Pressable
      testID={`vaccine-row-${dose.localId}`}
      accessibilityRole="button"
      accessibilityLabel={dose.name}
      onPress={onPress}
      style={[s.vaccineRow, last ? null : s.divider]}
    >
      <View style={{ width: 16 }}>
        <Dot color={dose.state === 'done' ? colors.green : due ? colors.accent : colors.off} />
      </View>
      <View style={{ flex: 1, gap: 1 }}>
        <Text style={{ fontSize: 13, color: colors.ink }}>{dose.name}</Text>
        <Muted style={{ fontSize: 11 }}>
          {dose.ageLabel}
          {dose.note ? ` · ${dose.note}` : ''}
        </Muted>
      </View>
      <Text testID={`vaccine-status-${dose.localId}`} style={{ fontSize: 11, color: statusColor }}>
        {status}
      </Text>
    </Pressable>
  );
}

function RegionSheet({ id, baby }: { id: string; baby: BabyData }) {
  const app = useApp();
  const sheet = useSheet();
  const { toast } = useFeedback();
  const current = regionFor(baby.region).id;
  const [selected, setSelected] = useState(current);
  const target = regionFor(selected);
  // 和显示的地区比，不和字段比：v0.1.0 的档案没有这个字段，显示的是新加坡，选新加坡不算改动。
  const changed = selected !== current;

  const save = async () => {
    // 弹层可能开了一会儿，用最新的档案，不要盖掉家人刚改的内容。
    const latest = app.store.getSnapshot().baby ?? { id, data: baby };
    await app.write('baby', { ...latest.data, region: selected }, latest.id);
    sheet.close();
    toast(`已换成${target.name}`);
  };

  return (
    <>
      <RegionPicker value={selected} onChange={setSelected} />
      <Muted testID="region-note" style={{ fontSize: 13, lineHeight: 21 }}>
        {changed
          ? `换成${target.name}后，全家的疫苗本都按当地方案显示。已记下的接种不会丢，不在新方案里的放到“其他接种记录”。没改过单位的家人，默认单位也会跟着变。`
          : '地区决定疫苗本和默认单位。'}
      </Muted>
      <Button
        testID="region-confirm"
        label={changed ? `确定换成${target.name}` : '确定'}
        disabled={!changed}
        onPress={() => void save()}
      />
    </>
  );
}

function GrowthChart({
  baby,
  events,
  units,
}: {
  baby: BabyData;
  events: EventData[];
  units: Units;
}) {
  const shown = (kg: number) => toDisplay('weight', kg, units.weight);
  const points = [
    ...(baby.birthWeightKg ? [{ w: shown(baby.birthWeightKg), label: '出生' }] : []),
    ...events
      .filter((e): e is Extract<EventData, { type: 'growth' }> => e.type === 'growth')
      .sort((a, b) => a.at - b.at)
      .map((e) => ({ w: shown(e.weightKg), label: formatMonthDay(e.at) })),
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
          <GrowthBar
            height={Math.round((p.w / max) * 78)}
            opacity={i === points.length - 1 ? 1 : 0.45}
          />
          <Muted style={{ fontSize: 10 }} numberOfLines={1}>
            {p.label}
          </Muted>
        </View>
      ))}
    </View>
  );
}

function GrowthBar({ height, opacity }: { height: number; opacity: number }) {
  const animated = useSharedValue(height);
  useEffect(() => {
    animated.value = withTiming(height, { duration: 400 });
  }, [height, animated]);
  const style = useAnimatedStyle(() => ({ height: animated.value }));
  return <Animated.View style={[s.bar, { opacity }, style]} />;
}

function BirthTimeSheet({ id, baby }: { id: string; baby: BabyData }) {
  const app = useApp();
  const sheet = useSheet();
  const { toast } = useFeedback();
  const [birth, setBirth] = useState(() => new Date(baby.birthAt));
  const future = isBirthInFuture(birth.getTime(), Date.now());

  const save = async () => {
    // 弹层可能开了很久，这里按保存时的时间再判断一次。
    if (isBirthInFuture(birth.getTime(), Date.now())) return;
    await app.write('baby', { ...baby, birthAt: birth.getTime() }, id);
    sheet.close();
    toast('已保存');
  };

  return (
    <>
      <BirthPicker value={birth} onChange={setBirth} />
      {future ? (
        <Text testID="birth-error" style={{ fontSize: 13, lineHeight: 20, color: colors.danger }}>
          出生时间不能晚于现在
        </Text>
      ) : (
        <Muted style={{ fontSize: 12, lineHeight: 19 }}>
          改了之后，天数、月龄和疫苗时间都会重新计算。
        </Muted>
      )}
      <Button testID="birth-save" label="保存" disabled={future} onPress={() => void save()} />
    </>
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
  const units = useUnits();
  const [text, setText] = useState(
    field === 'name'
      ? baby.name
      : field === 'hospital'
        ? (baby.hospital ?? '')
        : (baby.bloodType ?? ''),
  );
  const [weight, setWeight] = useState(() =>
    birthMeasureText('weight', baby.birthWeightKg, units.weight),
  );
  const [length, setLength] = useState(() =>
    birthMeasureText('length', baby.birthLengthCm, units.length),
  );

  const save = async () => {
    const next: BabyData = { ...baby };
    if (field === 'name') {
      if (!text.trim()) return;
      next.name = text.trim();
    }
    if (field === 'hospital') next.hospital = text.trim() || undefined;
    if (field === 'bloodType') next.bloodType = text.trim() || undefined;
    if (field === 'measures') {
      const measures = birthMeasuresFromInput(weight, length, units, baby);
      if (!measures.ok) return toast(measures.error);
      next.birthWeightKg = measures.weightKg;
      next.birthLengthCm = measures.lengthCm;
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
            placeholder={`体重（${units.weight}），比如 ${units.weight === 'kg' ? '3.4' : '7.5'}`}
          />
          <SoftInput
            testID="edit-length"
            value={length}
            onChangeText={setLength}
            keyboardType="decimal-pad"
            placeholder={`身长（${units.length}），比如 ${units.length === 'cm' ? '50' : '19.5'}`}
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
      <Button
        testID="edit-save"
        label="保存"
        disabled={field === 'name' && !text.trim()}
        onPress={() => void save()}
      />
    </>
  );
}

function DocAddSheet() {
  const app = useApp();
  const sheet = useSheet();
  const router = useRouter();
  const region = useRegion();
  const [name, setName] = useState('');
  return (
    <>
      <View style={s.docChips}>
        {region.documentSuggestions.map((v) => (
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
  // zIndex 让链接的热区压过下面紧挨着的卡片。
  sectionHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    zIndex: 1,
  },
  link: { fontSize: 12, color: colors.accent },
  subTitle: { fontSize: 13, fontWeight: '500', color: colors.ink, marginTop: 4 },
  docGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: DOC_GAP },
  docCard: {
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
