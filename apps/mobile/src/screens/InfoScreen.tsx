import {
  ageParts,
  type BabyData,
  birthMeasuresFromInput,
  birthMeasureText,
  doseStatus,
  dosesToBackfill,
  type EventData,
  formatBirthMeasures,
  formatFullDate,
  formatMonthDay,
  inertPlanCount,
  knowledgeForAge,
  normalizeVaccineId,
  type OptionalVaccines,
  optionalRecordedText,
  optionalStartText,
  optionalVaccineBook,
  otherVaccineRecords,
  planSchedule,
  regionFor,
  scaleFor,
  t,
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
import { HiddenDosesSheet, VaccineBackfillSheet } from '../sheets/vaccineSheets';
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
  const { baby, documents, events, vaccinePlans } = useRecords();
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
  const planned = planSchedule(region, birthAt, vaccinePlans, data);
  const vaccines = vaccineStatuses(planned, birthAt, data, now);
  const others = otherVaccineRecords(planned, events);
  const canBackfill = dosesToBackfill(vaccines).length > 0;
  const inert = inertPlanCount(region, vaccinePlans);
  const knowledge = knowledgeForAge(ageParts(birthAt, now).months, units.temperature);
  // 记错了日期只能删掉重记，所以打过的剂次也要能点开。时间线只显示最近的几条，别处点不到。
  const openShot = (id: string) => {
    const entry = events.find((e) => e.id === id);
    if (!entry) return;
    sheet.open(t().info.thisDose, () => <EventActionsSheet id={entry.id} event={entry.data} />);
  };
  const openDose = (dose: VaccineStatus) => {
    if (dose.state !== 'done') {
      sheet.open(t().today.vaccination, () => (
        <VaccineSheet birthAt={birthAt} preselect={dose.id} />
      ));
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
      <PageTitle>{t().info.title}</PageTitle>

      <View style={s.section}>
        <SectionTitle>{t().info.birthProfile}</SectionTitle>
        <ListCard>
          <Row
            label={t().info.name}
            value={baby.data.name}
            onPress={() => openEdit(sheet, baby.id, baby.data, 'name')}
            testID="birth-name"
          />
          <Row
            label={t().info.birthTime}
            value={formatBirthTime(birthAt)}
            testID="birth-at"
            onPress={() =>
              sheet.open(t().info.birthTime, () => <BirthTimeSheet id={baby.id} baby={baby.data} />)
            }
          />
          <Row
            label={t().info.measures}
            value={
              baby.data.birthWeightKg || baby.data.birthLengthCm
                ? formatBirthMeasures(baby.data, units)
                : t().info.toAdd
            }
            onPress={() => openEdit(sheet, baby.id, baby.data, 'measures')}
            testID="birth-measures"
          />
          <Row
            label={t().info.hospital}
            value={baby.data.hospital || t().info.toAdd}
            onPress={() => openEdit(sheet, baby.id, baby.data, 'hospital')}
            testID="birth-hospital"
          />
          <Row
            label={t().info.bloodType}
            value={baby.data.bloodType || t().info.toAdd}
            onPress={() => openEdit(sheet, baby.id, baby.data, 'bloodType')}
            testID="birth-blood"
          />
          <Row
            label={t().info.region}
            value={region.name}
            testID="region-row"
            // 全家共用同一份疫苗表，只有管理员能改。服务端也按这个规则校验。
            onPress={
              role === 'admin'
                ? () =>
                    sheet.open(t().auth.region, () => <RegionSheet id={baby.id} baby={baby.data} />)
                : undefined
            }
            last
          />
        </ListCard>
      </View>

      <View style={s.section}>
        <View style={s.sectionHead}>
          <SectionTitle>{t().info.documents}</SectionTitle>
          <Pressable
            testID="doc-add"
            accessibilityRole="button"
            accessibilityLabel={t().info.addDocA11y}
            hitSlop={LINK_HIT_SLOP}
            onPress={() => sheet.open(t().info.addDoc, () => <DocAddSheet />)}
          >
            <Text style={s.link}>{t().nutritionUi.addLink}</Text>
          </Pressable>
        </View>
        {documents.length === 0 ? (
          <Muted style={{ fontSize: 13, lineHeight: 20 }}>{t().info.docsEmpty}</Muted>
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
                      {first ? fileBadge(first) : t().info.emptyDoc}
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
                    {d.data.files.length
                      ? t().info.fileCount(d.data.files.length)
                      : t().info.toUpload}
                  </Text>
                </PressScale>
              );
            })}
          </View>
        )}
        <Muted style={{ fontSize: 11 }}>{t().info.docsPrivate}</Muted>
      </View>

      <View style={s.section}>
        <View style={s.sectionHead}>
          <SectionTitle>
            {t().info.weightTitle(scaleFor('weight', units.weight).label)}
          </SectionTitle>
          <Pressable
            testID="growth-add"
            accessibilityRole="button"
            accessibilityLabel={t().info.recordGrowth}
            hitSlop={LINK_HIT_SLOP}
            onPress={() => sheet.open(t().records.growth, () => <GrowthSheet />)}
          >
            <Text style={s.link}>{t().info.addGrowth}</Text>
          </Pressable>
        </View>
        <GrowthChart baby={baby.data} events={data} units={units} />
      </View>

      <View style={s.section}>
        <View style={s.sectionHead}>
          <SectionTitle>{t().info.vaccineBook}</SectionTitle>
          <View style={s.headLinks}>
            {/* 放在标题这里：建档时一眼能看到，不用先滑过十几行的表。 */}
            {canBackfill ? (
              <Pressable
                testID="vaccine-backfill"
                accessibilityRole="button"
                accessibilityLabel={t().info.backfillDosesA11y}
                hitSlop={LINK_HIT_SLOP}
                onPress={() =>
                  sheet.open(t().info.backfillDoses, () => (
                    <VaccineBackfillSheet birthAt={birthAt} />
                  ))
                }
              >
                <Text style={s.link}>{t().info.backfillLink}</Text>
              </Pressable>
            ) : null}
            <Pressable
              testID="vaccine-add-custom"
              accessibilityRole="button"
              accessibilityLabel={t().info.otherDoseA11y}
              hitSlop={LINK_HIT_SLOP}
              onPress={() =>
                sheet.open(t().today.vaccination, () => <VaccineSheet birthAt={birthAt} custom />)
              }
            >
              <Text style={s.link}>{t().info.otherVaccineLink}</Text>
            </Pressable>
          </View>
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
        {planned.hidden.length > 0 ? (
          <Pressable
            testID="vaccine-hidden"
            accessibilityRole="button"
            accessibilityLabel={t().info.hiddenA11y(planned.hidden.length)}
            hitSlop={LINK_HIT_SLOP}
            onPress={() =>
              sheet.open(t().info.hiddenTitle, () => <HiddenDosesSheet birthAt={birthAt} />)
            }
            style={s.hiddenLink}
          >
            <Text style={s.linkMuted}>{t().info.hiddenLink(planned.hidden.length)}</Text>
          </Pressable>
        ) : null}
        {inert > 0 ? (
          <Muted testID="vaccine-inert-note" style={{ fontSize: 11, lineHeight: 18 }}>
            {t().info.inertPlans(inert)}
          </Muted>
        ) : null}
        {region.optionalVaccines ? (
          <OptionalVaccinesSection
            optional={region.optionalVaccines}
            events={events}
            onRecord={(vaccineId) =>
              sheet.open(t().today.vaccination, () => (
                <VaccineSheet birthAt={birthAt} preselect={vaccineId} />
              ))
            }
          />
        ) : null}
        {others.length > 0 ? (
          <View testID="vaccine-other-section" style={s.section}>
            <Text style={s.subTitle}>{t().info.otherRecords}</Text>
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
                    {t().info.givenOn(formatFullDate(record.at))}
                  </Text>
                </Pressable>
              ))}
            </ListCard>
            <Muted style={{ fontSize: 11, lineHeight: 18 }}>{t().info.otherRecordsNote}</Muted>
          </View>
        ) : null}
        <Muted testID="vaccine-disclaimer" style={{ fontSize: 11, lineHeight: 18 }}>
          {region.disclaimer}
        </Muted>
      </View>

      <View style={s.section}>
        <SectionTitle>{t().info.thisMonth}</SectionTitle>
        {knowledge.map((k) => (
          <View key={k.title} testID="knowledge-card" style={s.knowledge}>
            <Text style={{ fontSize: 14, fontWeight: '500', color: colors.ink }}>{k.title}</Text>
            <Text style={{ fontSize: 12, lineHeight: 20, color: colors.inkSoft }}>{k.body}</Text>
          </View>
        ))}
        <Muted style={{ fontSize: 11, lineHeight: 18 }}>{t().info.knowledgeNote}</Muted>
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
  const status = doseStatus(dose);
  const statusColor =
    status.tone === 'done' ? colors.green : status.tone === 'due' ? colors.accent : colors.muted;
  return (
    <Pressable
      testID={`vaccine-row-${dose.localId}`}
      accessibilityRole="button"
      accessibilityLabel={dose.name}
      onPress={onPress}
      style={[s.vaccineRow, last ? null : s.divider]}
    >
      <View style={{ width: 16 }}>
        <Dot
          color={
            status.tone === 'done'
              ? colors.green
              : status.tone === 'due'
                ? colors.accent
                : colors.off
          }
        />
      </View>
      <View style={{ flex: 1, gap: 1 }}>
        <Text style={{ fontSize: 13, color: colors.ink }}>{dose.name}</Text>
        <Muted style={{ fontSize: 11 }}>
          {dose.ageLabel}
          {dose.note ? ` · ${dose.note}` : ''}
        </Muted>
      </View>
      <Text testID={`vaccine-status-${dose.localId}`} style={{ fontSize: 11, color: statusColor }}>
        {status.text}
      </Text>
    </Pressable>
  );
}

/**
 * 当地免疫规划以外、自愿选的疫苗（issue #68：入口只在接种弹层里时找不到）。
 * 默认收起，不把免费的表挤到下面。没有状态和提醒，只写记过的日期；每一剂的记录还在“其他接种记录”里改。
 */
function OptionalVaccinesSection({
  optional,
  events,
  onRecord,
}: {
  optional: OptionalVaccines;
  events: readonly { id: string; data: EventData }[];
  onRecord: (vaccineId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const book = optionalVaccineBook(optional, events);
  const summary = t().info.optionalSummary(
    book.length,
    book.filter((entry) => entry.records.length > 0).length,
  );
  return (
    <View testID="vaccine-optional-section" style={s.section}>
      <ListCard>
        <Pressable
          testID="vaccine-optional-toggle"
          accessibilityRole="button"
          accessibilityLabel={`${optional.title} · ${summary}`}
          accessibilityState={{ expanded: open }}
          onPress={() => setOpen((v) => !v)}
          style={[s.vaccineRow, open ? s.divider : null]}
        >
          <View style={{ flex: 1, gap: 1 }}>
            <Text style={{ fontSize: 13, fontWeight: '500', color: colors.ink }}>
              {optional.title}
            </Text>
            <Muted style={{ fontSize: 11 }}>{summary}</Muted>
          </View>
          <Text style={s.link}>{open ? t().info.optionalCollapse : t().info.optionalExpand}</Text>
        </Pressable>
        {open
          ? book.map((entry, i) => {
              const v = entry.vaccine;
              const recorded = optionalRecordedText(entry);
              return (
                <Pressable
                  key={v.id}
                  testID={`vaccine-optional-row-${v.localId}`}
                  accessibilityRole="button"
                  accessibilityLabel={[
                    t().info.optionalRecordA11y(v.name),
                    optionalStartText(v),
                    recorded,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                  onPress={() => onRecord(v.id)}
                  style={[s.vaccineRow, i < book.length - 1 ? s.divider : null]}
                >
                  <View style={{ width: 16 }}>
                    <Dot color={recorded ? colors.green : colors.off} />
                  </View>
                  <View style={{ flex: 1, gap: 1 }}>
                    <Text style={{ fontSize: 13, color: colors.ink }}>{v.name}</Text>
                    <Muted style={{ fontSize: 11 }}>{optionalStartText(v)}</Muted>
                  </View>
                  {recorded ? (
                    <Text
                      testID={`vaccine-optional-status-${v.localId}`}
                      style={{
                        fontSize: 11,
                        color: colors.green,
                        maxWidth: '40%',
                        textAlign: 'right',
                      }}
                    >
                      {recorded}
                    </Text>
                  ) : (
                    <Text style={s.linkMuted}>›</Text>
                  )}
                </Pressable>
              );
            })
          : null}
      </ListCard>
      {open ? (
        <Muted testID="vaccine-optional-book-note" style={{ fontSize: 11, lineHeight: 18 }}>
          {optional.note}
        </Muted>
      ) : null}
    </View>
  );
}

function RegionSheet({ id, baby }: { id: string; baby: BabyData }) {
  const app = useApp();
  const sheet = useSheet();
  const { toast } = useFeedback();
  const hasPlans = app.store.getSnapshot().vaccinePlans.length > 0;
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
    toast(t().info.regionChanged(target.name));
  };

  return (
    <>
      <RegionPicker value={selected} onChange={setSelected} />
      <Muted testID="region-note" style={{ fontSize: 13, lineHeight: 21 }}>
        {changed
          ? t().info.regionChangeNote(target.name, hasPlans ? t().info.regionPlansNote : '')
          : t().info.regionHint}
      </Muted>
      <Button
        testID="region-confirm"
        label={changed ? t().info.confirmRegion(target.name) : t().common.confirm}
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
    ...(baby.birthWeightKg ? [{ w: shown(baby.birthWeightKg), label: t().info.birthPoint }] : []),
    ...events
      .filter((e): e is Extract<EventData, { type: 'growth' }> => e.type === 'growth')
      .sort((a, b) => a.at - b.at)
      .map((e) => ({ w: shown(e.weightKg), label: formatMonthDay(e.at) })),
  ].slice(-5);
  if (points.length === 0) {
    return (
      <View style={[s.chart, { alignItems: 'center', justifyContent: 'center' }]}>
        <Muted style={{ fontSize: 13 }}>{t().info.chartEmpty}</Muted>
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
    toast(t().records.saved);
  };

  return (
    <>
      <BirthPicker value={birth} onChange={setBirth} />
      {future ? (
        <Text testID="birth-error" style={{ fontSize: 13, lineHeight: 20, color: colors.danger }}>
          {t().auth.birthInFuture}
        </Text>
      ) : (
        <Muted style={{ fontSize: 12, lineHeight: 19 }}>{t().info.birthChangeNote}</Muted>
      )}
      <Button
        testID="birth-save"
        label={t().common.save}
        disabled={future}
        onPress={() => void save()}
      />
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
    name: t().info.name,
    measures: t().info.birthMeasures,
    hospital: t().auth.birthHospital,
    bloodType: t().info.bloodType,
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
    toast(t().records.saved);
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
            placeholder={t().info.weightExample(
              units.weight,
              units.weight === 'kg' ? '3.4' : '7.5',
            )}
          />
          <SoftInput
            testID="edit-length"
            value={length}
            onChangeText={setLength}
            keyboardType="decimal-pad"
            placeholder={t().info.lengthExample(
              units.length,
              units.length === 'cm' ? '50' : '19.5',
            )}
          />
        </>
      ) : (
        <SoftInput
          testID="edit-text"
          value={text}
          onChangeText={setText}
          placeholder={field === 'bloodType' ? t().info.bloodExample : t().info.pleaseFill}
          maxLength={100}
        />
      )}
      <Button
        testID="edit-save"
        label={t().common.save}
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
        placeholder={t().info.docName}
        maxLength={100}
      />
      <Button
        testID="doc-create"
        label={t().info.createAndAdd}
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
  linkMuted: { fontSize: 12, color: colors.muted },
  headLinks: { flexDirection: 'row', gap: 18 },
  hiddenLink: { alignSelf: 'flex-end', paddingVertical: 2 },
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
