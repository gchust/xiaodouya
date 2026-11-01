import {
  ageParts,
  assessTemperature,
  chipsFor,
  describeEvent,
  type EventData,
  estimateNextFeed,
  formatTemperatureRange,
  medicineSuggestions,
  metricToSave,
  newCustomVaccineId,
  nextVaccine,
  scaleFor,
  stepDisplay,
  toDisplay,
  toMetric,
  vaccineStatuses,
  vaccinesToOffer,
} from '@xiaodouya/shared';
import * as Crypto from 'expo-crypto';
import * as Haptics from 'expo-haptics';
import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useApp, useRecords, useRegion, useUnits } from '../lib/app';
import { doseTimestamp } from '../lib/dates';
import { gridItemWidth } from '../lib/layout';
import { colors, fonts, spacing } from '../theme';
import { PastDatePicker } from '../ui/BirthPicker';
import { useFeedback, useSheet } from '../ui/overlays';
import { Button, Chip, Dot, Mono, Muted, PressScale, SoftInput } from '../ui/primitives';

const OFFSETS = [
  { minutes: 0, label: '刚刚' },
  { minutes: 15, label: '15 分钟前' },
  { minutes: 30, label: '30 分钟前' },
  { minutes: 60, label: '1 小时前' },
] as const;

function TimeOffsets({ value, onChange }: { value: number; onChange: (m: number) => void }) {
  return (
    <View style={s.chips}>
      {OFFSETS.map((o) => (
        <Chip
          key={o.minutes}
          testID={`offset-${o.minutes}`}
          label={o.label}
          selected={value === o.minutes}
          onPress={() => onChange(o.minutes)}
        />
      ))}
    </View>
  );
}

/** 所有记录弹层的保存逻辑：写入、震动、Toast、撤销。 */
export function useSaveEvent() {
  const app = useApp();
  const sheet = useSheet();
  const { toast } = useFeedback();
  const units = useUnits();
  const { me, label } = app;
  return useCallback(
    async (event: EventData, id?: string) => {
      const data: EventData = { ...event, byName: event.byName ?? label };
      const recordId = await app.write('event', data, id);
      sheet.close();
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      const others = (me?.members ?? []).filter((m) => m.userId !== me?.user.id);
      const suffix = others.length === 1 ? ` · 已同步给${others[0]?.label}` : '';
      toast(`已记录 · ${describeEvent(data, Date.now(), units)}${suffix}`, {
        undo: id ? undefined : () => void app.remove(recordId),
      });
    },
    [app, sheet, toast, me, label, units],
  );
}

function Stepper({
  value,
  unit,
  onDec,
  onInc,
  color = colors.ink,
  testPrefix,
}: {
  value: string;
  unit: string;
  onDec: () => void;
  onInc: () => void;
  color?: string;
  testPrefix: string;
}) {
  return (
    <View style={s.stepper}>
      <Pressable
        testID={`${testPrefix}-dec`}
        accessibilityRole="button"
        accessibilityLabel="减少"
        onPress={onDec}
        style={s.stepBtn}
      >
        <Text style={s.stepSign}>−</Text>
      </Pressable>
      <View style={s.stepValue}>
        <Mono weight="medium" style={[s.bigNumber, { color }]} testID={`${testPrefix}-value`}>
          {value}
        </Mono>
        <Muted style={s.unit}>{unit}</Muted>
      </View>
      <Pressable
        testID={`${testPrefix}-inc`}
        accessibilityRole="button"
        accessibilityLabel="增加"
        onPress={onInc}
        style={s.stepBtn}
      >
        <Text style={s.stepSign}>＋</Text>
      </Pressable>
    </View>
  );
}

export function FeedSheet({
  initial,
  id,
}: {
  initial?: Extract<EventData, { type: 'feed' }>;
  id?: string;
}) {
  const { events } = useRecords();
  const save = useSaveEvent();
  const last = estimateNextFeed(
    events.map((e) => e.data),
    Date.now(),
  ).last;
  const { volume } = useUnits();
  const scale = scaleFor('volume', volume);
  const original = initial?.ml ?? last?.ml;
  const [amount, setAmount] = useState(() => toDisplay('volume', original ?? 90, volume));
  const [note, setNote] = useState(initial?.note ?? '');
  const [offset, setOffset] = useState(0);
  return (
    <>
      {id ? null : <TimeOffsets value={offset} onChange={setOffset} />}
      <Stepper
        testPrefix="ml"
        value={amount.toFixed(scale.decimals)}
        unit={scale.label}
        onDec={() => setAmount((v) => stepDisplay('volume', v, -1, volume))}
        onInc={() => setAmount((v) => stepDisplay('volume', v, 1, volume))}
      />
      <View style={s.mlChips}>
        {chipsFor(volume).map((v) => {
          const on = amount === v;
          return (
            <Pressable
              key={v}
              testID={`${volume}-chip-${v}`}
              accessibilityRole="button"
              accessibilityLabel={`${v} ${scale.name}`}
              accessibilityState={{ selected: on }}
              hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
              onPress={() => setAmount(v)}
              style={[s.mlChip, { backgroundColor: on ? colors.ink : colors.paper }]}
            >
              <Mono weight="medium" style={{ fontSize: 13, color: on ? colors.paper : colors.ink }}>
                {v}
              </Mono>
            </Pressable>
          );
        })}
      </View>
      <SoftInput
        testID="feed-note"
        value={note}
        onChangeText={setNote}
        placeholder="备注（可选）：吐奶、打嗝、喝得慢…"
        maxLength={200}
      />
      <Button
        testID="feed-save"
        label={id ? '保存' : '记录'}
        onPress={() =>
          void save(
            {
              type: 'feed',
              at: initial?.at ?? Date.now() - offset * 60_000,
              ml: metricToSave('volume', original, amount, volume),
              note: note.trim() || undefined,
              byName: initial?.byName,
            },
            id,
          )
        }
      />
    </>
  );
}

export function DiaperSheet() {
  const save = useSaveEvent();
  const [offset, setOffset] = useState(0);
  const record = (kind: 'wee' | 'poo' | 'both') =>
    void save({ type: 'diaper', at: Date.now() - offset * 60_000, kind });
  return (
    <>
      <TimeOffsets value={offset} onChange={setOffset} />
      <View style={s.diaperRow}>
        <PressScale
          testID="diaper-wee"
          accessibilityLabel="尿尿"
          style={s.diaperBtn}
          onPress={() => record('wee')}
        >
          <Dot color={colors.wee} size={14} />
          <Text style={s.diaperLabel}>尿尿</Text>
        </PressScale>
        <PressScale
          testID="diaper-poo"
          accessibilityLabel="便便"
          style={s.diaperBtn}
          onPress={() => record('poo')}
        >
          <Dot color={colors.poo} size={14} />
          <Text style={s.diaperLabel}>便便</Text>
        </PressScale>
        <PressScale
          testID="diaper-both"
          accessibilityLabel="都有"
          style={s.diaperBtn}
          onPress={() => record('both')}
        >
          <View style={{ flexDirection: 'row', gap: 3 }}>
            <Dot color={colors.wee} size={10} />
            <Dot color={colors.poo} size={10} />
          </View>
          <Text style={s.diaperLabel}>都有</Text>
        </PressScale>
      </View>
      <Muted>点一下就记好了。</Muted>
    </>
  );
}

const MORE_GAP = 10;

export function MoreSheet({ birthAt }: { birthAt: number }) {
  const sheet = useSheet();
  const { width: windowWidth } = useWindowDimensions();
  const itemWidth = gridItemWidth(windowWidth - spacing.page * 2, 3, MORE_GAP);
  const canEatSolids = ageParts(birthAt, Date.now()).months >= 6;
  const items: { key: string; label: string; color: string; onPress?: () => void; sub?: string }[] =
    [
      {
        key: 'temp',
        label: '体温',
        color: '#b8645e',
        onPress: () => sheet.replace('体温', () => <TempSheet birthAt={birthAt} />),
      },
      {
        key: 'med',
        label: '吃药',
        color: '#8a7a9e',
        onPress: () => sheet.replace('吃药', () => <MedSheet />),
      },
      {
        key: 'bath',
        label: '洗澡',
        color: '#6f9aa0',
        onPress: () => sheet.replace('洗澡', () => <BathSheet />),
      },
      {
        key: 'growth',
        label: '身高体重',
        color: '#6f9a6a',
        onPress: () => sheet.replace('身高体重', () => <GrowthSheet />),
      },
      {
        key: 'vaccine',
        label: '疫苗',
        color: '#6f9a6a',
        onPress: () => sheet.replace('疫苗接种', () => <VaccineSheet birthAt={birthAt} />),
      },
      canEatSolids
        ? {
            key: 'solids',
            label: '辅食',
            color: '#c9a24a',
            onPress: () => sheet.replace('辅食', () => <SolidsSheet />),
          }
        : { key: 'solids', label: '辅食', color: colors.hint, sub: '6 个月后开放' },
    ];
  return (
    <View style={s.moreGrid}>
      {items.map((item) => (
        <PressScale
          key={item.key}
          testID={`more-${item.key}`}
          accessibilityLabel={item.label}
          accessibilityState={{ disabled: !item.onPress }}
          disabled={!item.onPress}
          onPress={item.onPress}
          style={[s.moreItem, { width: itemWidth, opacity: item.onPress ? 1 : 0.5 }]}
        >
          <Dot color={item.color} />
          <Text style={s.moreLabel}>{item.label}</Text>
          {item.sub ? <Text style={s.moreSub}>{item.sub}</Text> : null}
        </PressScale>
      ))}
    </View>
  );
}

export function TempSheet({ birthAt }: { birthAt: number }) {
  const save = useSaveEvent();
  const { temperature: unit } = useUnits();
  const scale = scaleFor('temperature', unit);
  const [value, setValue] = useState(() => toDisplay('temperature', 36.8, unit));
  const [offset, setOffset] = useState(0);
  const celsius = toMetric('temperature', value, unit);
  const assessment = assessTemperature(celsius, ageParts(birthAt, Date.now()).months, unit);
  const tone =
    assessment.level === 'fever' || assessment.level === 'urgent'
      ? colors.danger
      : assessment.level === 'elevated'
        ? colors.accent
        : colors.ink;
  return (
    <>
      <TimeOffsets value={offset} onChange={setOffset} />
      <Stepper
        testPrefix="temp"
        value={value.toFixed(scale.decimals)}
        unit={scale.label}
        color={tone}
        onDec={() => setValue((v) => stepDisplay('temperature', v, -1, unit))}
        onInc={() => setValue((v) => stepDisplay('temperature', v, 1, unit))}
      />
      <Text testID="temp-hint" style={[s.hint, { color: tone }]}>
        {assessment.hint}
      </Text>
      <Button
        testID="temp-save"
        label="记录"
        onPress={() =>
          void save({
            type: 'temp',
            at: Date.now() - offset * 60_000,
            celsius,
            note: assessment.note,
          })
        }
      />
    </>
  );
}

export function MedSheet() {
  const save = useSaveEvent();
  const [name, setName] = useState('维生素D');
  const [dose, setDose] = useState('1 滴');
  const [offset, setOffset] = useState(0);
  return (
    <>
      <TimeOffsets value={offset} onChange={setOffset} />
      <View style={s.chips}>
        {medicineSuggestions.map((v) => (
          <Chip
            key={v}
            label={v}
            selected={name === v}
            onPress={() => {
              setName(v);
              setDose(v === '维生素D' ? '1 滴' : '');
            }}
          />
        ))}
      </View>
      <SoftInput
        testID="med-name"
        value={name}
        onChangeText={setName}
        placeholder="药名"
        maxLength={100}
      />
      <SoftInput
        testID="med-dose"
        value={dose}
        onChangeText={setDose}
        placeholder="剂量"
        maxLength={100}
      />
      <Button
        testID="med-save"
        label="记录"
        disabled={!name.trim()}
        onPress={() =>
          void save({
            type: 'med',
            at: Date.now() - offset * 60_000,
            name: name.trim(),
            dose: dose.trim() || undefined,
          })
        }
      />
    </>
  );
}

export function BathSheet() {
  const save = useSaveEvent();
  const { temperature } = useUnits();
  const [offset, setOffset] = useState(0);
  return (
    <>
      <TimeOffsets value={offset} onChange={setOffset} />
      <Muted style={{ fontSize: 13, lineHeight: 21 }}>
        水温 {formatTemperatureRange(37, 40, temperature)}
        ，用手肘试一下不烫就好。洗完先擦干脐部和皮肤褶皱。
      </Muted>
      <Button
        testID="bath-save"
        label="记录洗澡"
        onPress={() => void save({ type: 'bath', at: Date.now() - offset * 60_000 })}
      />
    </>
  );
}

export function SolidsSheet() {
  const save = useSaveEvent();
  const [note, setNote] = useState('');
  const [offset, setOffset] = useState(0);
  return (
    <>
      <TimeOffsets value={offset} onChange={setOffset} />
      <SoftInput
        testID="solids-note"
        value={note}
        onChangeText={setNote}
        placeholder="吃了什么？比如：南瓜泥两勺"
        maxLength={200}
      />
      <Button
        testID="solids-save"
        label="记录"
        disabled={!note.trim()}
        onPress={() =>
          void save({ type: 'solids', at: Date.now() - offset * 60_000, food: note.trim() })
        }
      />
    </>
  );
}

function SmallStepper({
  label,
  value,
  unit,
  onDec,
  onInc,
  testPrefix,
}: {
  label: string;
  value: string;
  unit: string;
  onDec: () => void;
  onInc: () => void;
  testPrefix: string;
}) {
  return (
    <View style={s.smallStepper}>
      <Text style={s.smallLabel}>{label}</Text>
      <Pressable
        testID={`${testPrefix}-dec`}
        accessibilityRole="button"
        accessibilityLabel={`${label}减少`}
        onPress={onDec}
        style={s.smallBtn}
      >
        <Text style={{ fontSize: 18, color: colors.ink }}>−</Text>
      </Pressable>
      <Text style={s.smallValue} testID={`${testPrefix}-value`}>
        {value}
        <Text style={s.smallUnit}> {unit}</Text>
      </Text>
      <Pressable
        testID={`${testPrefix}-inc`}
        accessibilityRole="button"
        accessibilityLabel={`${label}增加`}
        onPress={onInc}
        style={s.smallBtn}
      >
        <Text style={{ fontSize: 18, color: colors.ink }}>＋</Text>
      </Pressable>
    </View>
  );
}

export function GrowthSheet() {
  const { events, baby } = useRecords();
  const save = useSaveEvent();
  const latest = events.find((e) => e.data.type === 'growth')?.data as
    | Extract<EventData, { type: 'growth' }>
    | undefined;
  const units = useUnits();
  const originalWeight = latest?.weightKg ?? baby?.data.birthWeightKg;
  const originalLength = latest?.lengthCm ?? baby?.data.birthLengthCm;
  const [w, setW] = useState(() => toDisplay('weight', originalWeight ?? 3.4, units.weight));
  const [h, setH] = useState(() => toDisplay('length', originalLength ?? 50, units.length));
  return (
    <>
      <SmallStepper
        testPrefix="weight"
        label="体重"
        value={w.toFixed(1)}
        unit={scaleFor('weight', units.weight).label}
        onDec={() => setW((v) => stepDisplay('weight', v, -1, units.weight))}
        onInc={() => setW((v) => stepDisplay('weight', v, 1, units.weight))}
      />
      <SmallStepper
        testPrefix="length"
        label="身长"
        value={h.toFixed(1)}
        unit={scaleFor('length', units.length).label}
        onDec={() => setH((v) => stepDisplay('length', v, -1, units.length))}
        onInc={() => setH((v) => stepDisplay('length', v, 1, units.length))}
      />
      <Button
        testID="growth-save"
        label="记录"
        onPress={() =>
          void save({
            type: 'growth',
            at: Date.now(),
            weightKg: metricToSave('weight', originalWeight, w, units.weight),
            lengthCm: metricToSave('length', originalLength, h, units.length),
          })
        }
      />
    </>
  );
}

/** 选中“其他疫苗”时的占位值，不会和带地区前缀的 id 冲突。 */
const CUSTOM_OPTION = 'custom';

export function VaccineSheet({
  birthAt,
  preselect,
  custom,
}: {
  birthAt: number;
  preselect?: string;
  /** 直接打开“其他疫苗”，用于疫苗本上的添加入口。 */
  custom?: boolean;
}) {
  const { events } = useRecords();
  const region = useRegion();
  const save = useSaveEvent();
  const statuses = vaccineStatuses(
    region,
    birthAt,
    events.map((e) => e.data),
    Date.now(),
  );
  const pending = vaccinesToOffer(statuses, preselect);
  const [selected, setSelected] = useState(
    custom ? CUSTOM_OPTION : (preselect ?? nextVaccine(statuses)?.id ?? CUSTOM_OPTION),
  );
  const [customName, setCustomName] = useState('');
  const [date, setDate] = useState(() => new Date());
  const isCustom = selected === CUSTOM_OPTION;
  const dose = pending.find((v) => v.id === selected);
  const name = isCustom ? customName.trim() : dose?.name;
  const submit = () => {
    if (!name) return;
    void save({
      type: 'vaccine',
      at: doseTimestamp(date, Date.now()),
      vaccineId: isCustom ? newCustomVaccineId(Crypto.randomUUID()) : (dose?.id as string),
      name,
    });
  };
  return (
    <>
      <PastDatePicker label="接种日期" testID="vaccine-date" value={date} onChange={setDate} />
      <View style={{ gap: 8 }}>
        {pending.map((v) => {
          const on = selected === v.id;
          return (
            <Pressable
              key={v.id}
              testID={`vaccine-${v.localId}`}
              accessibilityRole="button"
              accessibilityLabel={v.name}
              accessibilityState={{ selected: on }}
              onPress={() => setSelected(v.id)}
              style={[s.vaccineOption, { backgroundColor: on ? colors.ink : colors.paper }]}
            >
              <Text style={{ fontSize: 14, color: on ? colors.paper : colors.ink }}>
                {v.name} · {v.ageLabel}
              </Text>
            </Pressable>
          );
        })}
        {pending.length > 0 ? (
          <Pressable
            testID="vaccine-custom"
            accessibilityRole="button"
            accessibilityLabel="其他疫苗"
            accessibilityState={{ selected: isCustom }}
            onPress={() => setSelected(CUSTOM_OPTION)}
            style={[s.vaccineOption, { backgroundColor: isCustom ? colors.ink : colors.paper }]}
          >
            <Text style={{ fontSize: 14, color: isCustom ? colors.paper : colors.ink }}>
              其他疫苗（自己填名字）
            </Text>
          </Pressable>
        ) : null}
      </View>
      {isCustom ? (
        <SoftInput
          testID="vaccine-custom-name"
          value={customName}
          onChangeText={setCustomName}
          placeholder="疫苗名称"
          maxLength={100}
        />
      ) : null}
      {dose?.note ? <Muted style={{ fontSize: 12, lineHeight: 19 }}>{dose.note}</Muted> : null}
      <Muted testID="vaccine-sheet-disclaimer" style={{ fontSize: 11, lineHeight: 18 }}>
        {region.disclaimer}
      </Muted>
      <Button testID="vaccine-save" tone="green" label="已接种" disabled={!name} onPress={submit} />
    </>
  );
}

/** 点时间线的一条记录：能改的进编辑，都能删。 */
export function EventActionsSheet({ id, event }: { id: string; event: EventData }) {
  const app = useApp();
  const sheet = useSheet();
  const { toast } = useFeedback();
  const isOpenSleep = event.type === 'sleep' && !event.endAt;
  const remove = async () => {
    await app.remove(id);
    sheet.close();
    toast('已删除这条记录', {
      undo: () => void app.write('event', event, id),
    });
  };
  return (
    <>
      <Muted style={{ fontSize: 13, lineHeight: 20 }}>
        {[event.note, event.byName ? `${event.byName}记录` : null].filter(Boolean).join(' · ') ||
          '想怎么处理这条记录？'}
      </Muted>
      {event.type === 'feed' ? (
        <Button
          testID="event-edit"
          tone="outline"
          label="修改奶量和备注"
          onPress={() => sheet.replace('修改喂奶', () => <FeedSheet initial={event} id={id} />)}
        />
      ) : null}
      {isOpenSleep ? (
        <Button
          testID="event-wake"
          tone="outline"
          label="现在醒了"
          onPress={() => {
            void app.write('event', { ...event, endAt: Date.now() }, id);
            sheet.close();
          }}
        />
      ) : null}
      <Button
        testID="event-delete"
        tone="ghost"
        label="删除这条记录"
        onPress={() => void remove()}
      />
    </>
  );
}

const s = StyleSheet.create({
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  stepper: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 6,
  },
  stepBtn: {
    width: 56,
    height: 56,
    borderRadius: 28,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.paper,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepSign: { fontSize: 24, color: colors.ink },
  stepValue: { flexDirection: 'row', alignItems: 'baseline', gap: 4 },
  bigNumber: { fontSize: 52, lineHeight: 52 },
  unit: { fontSize: 16 },
  mlChips: { flexDirection: 'row', gap: 8 },
  mlChip: { flex: 1, alignItems: 'center', paddingVertical: 9, borderRadius: 10 },
  diaperRow: { flexDirection: 'row', gap: 10 },
  diaperBtn: {
    flex: 1,
    height: 96,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.paper,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  diaperLabel: { fontSize: 16, color: colors.ink },
  moreGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: MORE_GAP },
  moreItem: {
    height: 88,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.paper,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  moreLabel: { fontSize: 14, color: colors.ink },
  moreSub: { fontSize: 10, color: colors.muted },
  hint: { fontSize: 12, lineHeight: 19 },
  smallStepper: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 12,
    backgroundColor: colors.paper,
    borderRadius: 14,
  },
  smallLabel: { fontSize: 14, color: colors.muted, width: 44 },
  smallBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  smallValue: { fontFamily: fonts.monoMedium, fontSize: 26, color: colors.ink },
  smallUnit: { fontSize: 13, color: colors.muted },
  vaccineOption: { paddingHorizontal: 14, paddingVertical: 13, borderRadius: 12 },
});
