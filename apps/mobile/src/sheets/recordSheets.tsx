import {
  ageParts,
  assessTemperature,
  checkRecordTime,
  chipsFor,
  describeEvent,
  type EventData,
  estimateNextFeed,
  formatClock,
  formatFullDate,
  formatMonthDay,
  formatTemperatureRange,
  isCustomVaccineId,
  medicineSuggestions,
  mergeEdit,
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
import { type ReactNode, useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useApp, useRecords, useRegion, useUnits } from '../lib/app';
import { doseTimestamp, editedDoseTimestamp } from '../lib/dates';
import { gridItemWidth } from '../lib/layout';
import { colors, fonts, spacing } from '../theme';
import { PastDatePicker } from '../ui/BirthPicker';
import { useFeedback, useSheet } from '../ui/overlays';
import { Button, Chip, Dot, Mono, Muted, PressScale, SoftInput, Toggle } from '../ui/primitives';
import {
  DateTimeRow,
  DayChips,
  RecordTimeField,
  TimeCheckText,
  useRecordTime,
} from '../ui/TimeField';

type EventOf<T extends EventData['type']> = Extract<EventData, { type: T }>;

/** 每个记录弹层的三种用法：新记录（都不传）、修改（initial + id）、补记（backfill）。 */
interface SheetMode<T extends EventData['type']> {
  initial?: EventOf<T>;
  id?: string;
  backfill?: boolean;
}

const HOUR = 3_600_000;

/** 所有记录弹层的保存逻辑：写入、震动、Toast、撤销。 */
export function useSaveEvent() {
  const app = useApp();
  const sheet = useSheet();
  const { toast } = useFeedback();
  const units = useUnits();
  const { me, label } = app;
  return useCallback(
    async (event: EventData, id?: string, base?: EventData) => {
      const latest = id ? app.store.getSnapshot().events.find((e) => e.id === id)?.data : undefined;
      // 修改沿用原来的记录人：是谁记的不因为谁改过而变。没有记录人的旧记录也不能算到修改者头上。
      const data: EventData = id
        ? latest
          ? mergeEdit(base ?? latest, latest, event)
          : event
        : { ...event, byName: event.byName ?? label };
      const recordId = await app.write('event', data, id);
      sheet.close();
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      const others = (me?.members ?? []).filter((m) => m.userId !== me?.user.id);
      const suffix = others.length === 1 ? ` · 已同步给${others[0]?.label}` : '';
      const now = Date.now();
      // 不是今天的记录在时间线上看不到，Toast 要说清楚记到了哪一天。
      const day =
        new Date(data.at).toDateString() === new Date(now).toDateString()
          ? ''
          : `${formatMonthDay(data.at)} `;
      toast(`${id ? '已保存' : '已记录'} · ${day}${describeEvent(data, now, units)}${suffix}`, {
        undo: id
          ? latest
            ? () => void app.write('event', latest, id)
            : undefined
          : () => void app.remove(recordId),
      });
    },
    [app, sheet, toast, me, label, units],
  );
}

/** 备注只在修改时才有输入框，新记录要尽量少点几下。喂奶自己有备注，体温的备注是自动生成的。 */
function EventNote({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  return (
    <SoftInput
      testID="event-note"
      value={value}
      onChangeText={onChange}
      placeholder="备注（可选）"
      maxLength={200}
    />
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

export function FeedSheet({ initial, id, backfill }: SheetMode<'feed'>) {
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
  const time = useRecordTime({ at: initial?.at, backfill });
  return (
    <>
      <RecordTimeField time={time} />
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
        disabled={Boolean(time.check.error)}
        onPress={() =>
          void save(
            {
              ...initial,
              type: 'feed',
              at: time.resolve(),
              ml: metricToSave('volume', original, amount, volume),
              note: note.trim() || undefined,
            },
            id,
            initial,
          )
        }
      />
    </>
  );
}

const DIAPER_OPTIONS = [
  { kind: 'wee', label: '尿尿' },
  { kind: 'poo', label: '便便' },
  { kind: 'both', label: '都有' },
] as const;

export function DiaperSheet({ initial, id, backfill }: SheetMode<'diaper'> = {}) {
  const save = useSaveEvent();
  const time = useRecordTime({ at: initial?.at, backfill });
  const [selected, setSelected] = useState(initial?.kind);
  const [note, setNote] = useState(initial?.note ?? '');
  const invalid = Boolean(time.check.error);
  const record = (kind: 'wee' | 'poo' | 'both') =>
    void save(
      {
        ...initial,
        type: 'diaper',
        at: time.resolve(),
        kind,
        note: note.trim() || undefined,
      },
      id,
      initial,
    );
  return (
    <>
      <RecordTimeField time={time} />
      <View style={s.diaperRow}>
        {DIAPER_OPTIONS.map(({ kind, label }) => {
          const on = selected === kind;
          return (
            <PressScale
              key={kind}
              testID={`diaper-${kind}`}
              accessibilityLabel={label}
              accessibilityState={{ selected: on, disabled: invalid }}
              disabled={invalid && !id}
              style={[s.diaperBtn, on ? s.diaperOn : null]}
              // 新记录点一下就记好。修改时先选，和别的字段一起保存。
              onPress={() => (id ? setSelected(kind) : record(kind))}
            >
              {kind === 'both' ? (
                <View style={{ flexDirection: 'row', gap: 3 }}>
                  <Dot color={colors.wee} size={10} />
                  <Dot color={colors.poo} size={10} />
                </View>
              ) : (
                <Dot color={kind === 'wee' ? colors.wee : colors.poo} size={14} />
              )}
              <Text style={s.diaperLabel}>{label}</Text>
            </PressScale>
          );
        })}
      </View>
      {id ? (
        <>
          <EventNote value={note} onChange={setNote} />
          <Button
            testID="diaper-save"
            label="保存"
            disabled={invalid}
            onPress={() => {
              if (selected) record(selected);
            }}
          />
        </>
      ) : (
        <Muted>点一下就记好了。</Muted>
      )}
    </>
  );
}

/** 补记和修改睡眠。平时的睡眠还是在今天页点一下开始、再点一下结束。 */
export function SleepSheet({ initial, id }: SheetMode<'sleep'> = {}) {
  const save = useSaveEvent();
  const birthAt = useRecords().baby?.data.birthAt;
  const [start, setStart] = useState(() => initial?.at ?? Date.now() - HOUR);
  const [end, setEnd] = useState(() => initial?.endAt ?? Date.now());
  // 只有还没结束的睡眠才有这个开关：已经结束的不用倒回去，点错了删掉重记也只是一下。
  const wasOpen = Boolean(initial) && !initial?.endAt;
  const [stillAsleep, setStillAsleep] = useState(wasOpen);
  const [note, setNote] = useState(initial?.note ?? '');
  const now = Date.now();
  const check = checkRecordTime({
    at: start,
    endAt: stillAsleep ? undefined : end,
    birthAt,
    now: Math.max(now, initial?.at ?? 0, initial?.endAt ?? 0),
  });
  const changeStart = (next: number) => {
    // 补记时挪开始时间，睡了多久不变，否则选“昨天”之后就成了睡了一整天。
    if (!initial) setEnd((e) => Math.min(e + next - start, Date.now()));
    setStart(next);
  };
  return (
    <>
      <DateTimeRow label="睡着" testID="sleep-start" value={start} onChange={changeStart} />
      {wasOpen ? (
        <View>
          <Toggle
            testID="sleep-still"
            label="还在睡"
            value={stillAsleep}
            onChange={(next) => {
              setStillAsleep(next);
              if (!next) setEnd(Date.now());
            }}
            last
          />
        </View>
      ) : null}
      {stillAsleep ? null : (
        <DateTimeRow label="醒来" testID="sleep-end" value={end} onChange={setEnd} />
      )}
      <TimeCheckText check={check} />
      <EventNote value={note} onChange={setNote} />
      <Button
        testID="sleep-save"
        label={id ? '保存' : '记录'}
        disabled={Boolean(check.error)}
        onPress={() =>
          void save(
            {
              ...initial,
              type: 'sleep',
              at: start,
              endAt: stillAsleep ? undefined : end,
              note: note.trim() || undefined,
            },
            id,
            initial,
          )
        }
      />
    </>
  );
}

const MORE_GAP = 10;

export function MoreSheet({ birthAt, backfill }: { birthAt: number; backfill?: boolean }) {
  const sheet = useSheet();
  const { width: windowWidth } = useWindowDimensions();
  const itemWidth = gridItemWidth(windowWidth - spacing.page * 2, 3, MORE_GAP);
  const canEatSolids = ageParts(birthAt, Date.now()).months >= 6;
  const open = (label: string, render: () => ReactNode) =>
    sheet.replace(backfill ? `补记${label}` : label, render);
  // 平时这三样在今天页有自己的按钮，只有补记才要从这里进。
  const daily = backfill
    ? [
        {
          key: 'feed',
          label: '喂奶',
          color: colors.accent,
          onPress: () => open('喂奶', () => <FeedSheet backfill />),
        },
        {
          key: 'diaper',
          label: '尿布',
          color: colors.diaper,
          onPress: () => open('尿布', () => <DiaperSheet backfill />),
        },
        {
          key: 'sleep',
          label: '睡眠',
          color: colors.sleep,
          onPress: () => open('睡眠', () => <SleepSheet />),
        },
      ]
    : [];
  const items: { key: string; label: string; color: string; onPress?: () => void; sub?: string }[] =
    [
      ...daily,
      {
        key: 'temp',
        label: '体温',
        color: '#b8645e',
        onPress: () => open('体温', () => <TempSheet birthAt={birthAt} backfill={backfill} />),
      },
      {
        key: 'med',
        label: '吃药',
        color: '#8a7a9e',
        onPress: () => open('吃药', () => <MedSheet backfill={backfill} />),
      },
      {
        key: 'bath',
        label: '洗澡',
        color: '#6f9aa0',
        onPress: () => open('洗澡', () => <BathSheet backfill={backfill} />),
      },
      {
        key: 'growth',
        label: '身高体重',
        color: '#6f9a6a',
        onPress: () => open('身高体重', () => <GrowthSheet backfill={backfill} />),
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
            onPress: () => open('辅食', () => <SolidsSheet backfill={backfill} />),
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

export function TempSheet({
  birthAt,
  initial,
  id,
  backfill,
}: { birthAt: number } & SheetMode<'temp'>) {
  const save = useSaveEvent();
  const { temperature: unit } = useUnits();
  const scale = scaleFor('temperature', unit);
  const original = initial?.celsius;
  const [value, setValue] = useState(() => toDisplay('temperature', original ?? 36.8, unit));
  const time = useRecordTime({ at: initial?.at, backfill });
  const celsius = toMetric('temperature', value, unit);
  // 按量体温那时的月龄判断：同样的 38℃，3 个月以下和以上的建议不一样。
  const assessment = assessTemperature(celsius, ageParts(birthAt, time.resolve()).months, unit);
  const tone =
    assessment.level === 'fever' || assessment.level === 'urgent'
      ? colors.danger
      : assessment.level === 'elevated'
        ? colors.accent
        : colors.ink;
  return (
    <>
      <RecordTimeField time={time} />
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
        label={id ? '保存' : '记录'}
        disabled={Boolean(time.check.error)}
        onPress={() => {
          const at = time.resolve();
          const saved = metricToSave('temperature', original, value, unit);
          // 备注是根据体温和月龄生成的。这两样变了，旧备注（比如“发烧”）就不对了。
          const unchanged = initial && saved === initial.celsius && at === initial.at;
          void save(
            {
              ...initial,
              type: 'temp',
              at,
              celsius: saved,
              note: unchanged ? initial.note : assessment.note,
            },
            id,
            initial,
          );
        }}
      />
    </>
  );
}

export function MedSheet({ initial, id, backfill }: SheetMode<'med'> = {}) {
  const save = useSaveEvent();
  const [name, setName] = useState(initial?.name ?? '维生素D');
  const [dose, setDose] = useState(initial ? (initial.dose ?? '') : '1 滴');
  const [note, setNote] = useState(initial?.note ?? '');
  const time = useRecordTime({ at: initial?.at, backfill });
  return (
    <>
      <RecordTimeField time={time} />
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
      {id ? <EventNote value={note} onChange={setNote} /> : null}
      <Button
        testID="med-save"
        label={id ? '保存' : '记录'}
        disabled={!name.trim() || Boolean(time.check.error)}
        onPress={() =>
          void save(
            {
              ...initial,
              type: 'med',
              at: time.resolve(),
              name: name.trim(),
              dose: dose.trim() || undefined,
              note: note.trim() || undefined,
            },
            id,
            initial,
          )
        }
      />
    </>
  );
}

export function BathSheet({ initial, id, backfill }: SheetMode<'bath'> = {}) {
  const save = useSaveEvent();
  const { temperature } = useUnits();
  const time = useRecordTime({ at: initial?.at, backfill });
  const [note, setNote] = useState(initial?.note ?? '');
  return (
    <>
      <RecordTimeField time={time} />
      {id ? (
        <EventNote value={note} onChange={setNote} />
      ) : (
        <Muted style={{ fontSize: 13, lineHeight: 21 }}>
          水温 {formatTemperatureRange(37, 40, temperature)}
          ，用手肘试一下不烫就好。洗完先擦干脐部和皮肤褶皱。
        </Muted>
      )}
      <Button
        testID="bath-save"
        label={id ? '保存' : '记录洗澡'}
        disabled={Boolean(time.check.error)}
        onPress={() =>
          void save(
            { ...initial, type: 'bath', at: time.resolve(), note: note.trim() || undefined },
            id,
            initial,
          )
        }
      />
    </>
  );
}

export function SolidsSheet({ initial, id, backfill }: SheetMode<'solids'> = {}) {
  const save = useSaveEvent();
  const [food, setFood] = useState(initial?.food ?? '');
  const [note, setNote] = useState(initial?.note ?? '');
  const time = useRecordTime({ at: initial?.at, backfill });
  return (
    <>
      <RecordTimeField time={time} />
      <SoftInput
        testID="solids-note"
        value={food}
        onChangeText={setFood}
        placeholder="吃了什么？比如：南瓜泥两勺"
        maxLength={200}
      />
      {id ? <EventNote value={note} onChange={setNote} /> : null}
      <Button
        testID="solids-save"
        label={id ? '保存' : '记录'}
        disabled={!food.trim() || Boolean(time.check.error)}
        onPress={() =>
          void save(
            {
              ...initial,
              type: 'solids',
              at: time.resolve(),
              food: food.trim(),
              note: note.trim() || undefined,
            },
            id,
            initial,
          )
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

export function GrowthSheet({ initial, id, backfill }: SheetMode<'growth'> = {}) {
  const { events, baby } = useRecords();
  const save = useSaveEvent();
  const latest = events.find((e) => e.data.type === 'growth')?.data as
    | EventOf<'growth'>
    | undefined;
  const units = useUnits();
  const originalWeight = initial?.weightKg ?? latest?.weightKg ?? baby?.data.birthWeightKg;
  const originalLength = initial?.lengthCm ?? latest?.lengthCm ?? baby?.data.birthLengthCm;
  const [w, setW] = useState(() => toDisplay('weight', originalWeight ?? 3.4, units.weight));
  const [h, setH] = useState(() => toDisplay('length', originalLength ?? 50, units.length));
  const [note, setNote] = useState(initial?.note ?? '');
  const time = useRecordTime({ at: initial?.at, backfill });
  return (
    <>
      <RecordTimeField time={time} />
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
      {id ? <EventNote value={note} onChange={setNote} /> : null}
      <Button
        testID="growth-save"
        label={id ? '保存' : '记录'}
        disabled={Boolean(time.check.error)}
        onPress={() =>
          void save(
            {
              ...initial,
              type: 'growth',
              at: time.resolve(),
              weightKg: metricToSave('weight', originalWeight, w, units.weight),
              lengthCm: metricToSave('length', originalLength, h, units.length),
              note: note.trim() || undefined,
            },
            id,
            initial,
          )
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
  const now = Date.now();
  const check = checkRecordTime({ at: doseTimestamp(date, now), birthAt, now, dateOnly: true });
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
      <DayChips
        testID="vaccine-date"
        value={date.getTime()}
        onChange={(at) => setDate(new Date(at))}
      />
      <TimeCheckText check={check} />
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

/** 改一剂已经记下的疫苗。哪一剂是不能改的：记错了剂次要删掉重记，否则疫苗本的状态会乱。 */
function VaccineEditSheet({ initial, id }: { initial: EventOf<'vaccine'>; id: string }) {
  const save = useSaveEvent();
  const region = useRegion();
  const birthAt = useRecords().baby?.data.birthAt;
  const [date, setDate] = useState(() => new Date(initial.at));
  const [name, setName] = useState(initial.name);
  const [note, setNote] = useState(initial.note ?? '');
  const custom = isCustomVaccineId(initial.vaccineId);
  const now = Date.now();
  const check = checkRecordTime({
    at: editedDoseTimestamp(initial.at, date, now),
    birthAt,
    now: Math.max(now, initial.at),
    dateOnly: true,
  });
  return (
    <>
      <PastDatePicker label="接种日期" testID="vaccine-date" value={date} onChange={setDate} />
      <DayChips
        testID="vaccine-date"
        value={date.getTime()}
        onChange={(at) => setDate(new Date(at))}
      />
      <TimeCheckText check={check} />
      {custom ? (
        <SoftInput
          testID="vaccine-custom-name"
          value={name}
          onChangeText={setName}
          placeholder="疫苗名称"
          maxLength={100}
        />
      ) : null}
      <EventNote value={note} onChange={setNote} />
      <Muted style={{ fontSize: 11, lineHeight: 18 }}>{region.disclaimer}</Muted>
      <Button
        testID="vaccine-edit-save"
        tone="green"
        label="保存"
        disabled={!name.trim() || Boolean(check.error)}
        onPress={() =>
          void save(
            {
              ...initial,
              at: editedDoseTimestamp(initial.at, date, Date.now()),
              name: name.trim(),
              note: note.trim() || undefined,
            },
            id,
            initial,
          )
        }
      />
    </>
  );
}

function eventEditor(
  id: string,
  event: EventData,
  birthAt: number,
): { title: string; render: () => ReactNode } {
  switch (event.type) {
    case 'feed':
      return { title: '修改喂奶', render: () => <FeedSheet initial={event} id={id} /> };
    case 'diaper':
      return { title: '修改尿布', render: () => <DiaperSheet initial={event} id={id} /> };
    case 'sleep':
      return { title: '修改睡眠', render: () => <SleepSheet initial={event} id={id} /> };
    case 'temp':
      return {
        title: '修改体温',
        render: () => <TempSheet birthAt={birthAt} initial={event} id={id} />,
      };
    case 'med':
      return { title: '修改吃药', render: () => <MedSheet initial={event} id={id} /> };
    case 'bath':
      return { title: '修改洗澡', render: () => <BathSheet initial={event} id={id} /> };
    case 'solids':
      return { title: '修改辅食', render: () => <SolidsSheet initial={event} id={id} /> };
    case 'growth':
      return { title: '修改身高体重', render: () => <GrowthSheet initial={event} id={id} /> };
    case 'vaccine':
      return { title: event.name, render: () => <VaccineEditSheet initial={event} id={id} /> };
  }
}

function eventTimeText(event: EventData): string {
  const start = `${formatFullDate(event.at)} ${formatClock(event.at)}`;
  if (event.type !== 'sleep' || !event.endAt) return start;
  const sameDay = formatFullDate(event.at) === formatFullDate(event.endAt);
  const end = sameDay
    ? formatClock(event.endAt)
    : `${formatFullDate(event.endAt)} ${formatClock(event.endAt)}`;
  return `${start} – ${end}`;
}

/** 点时间线的一条记录：都能改，都能删。 */
export function EventActionsSheet({ id, event }: { id: string; event: EventData }) {
  const app = useApp();
  const sheet = useSheet();
  const { toast } = useFeedback();
  const birthAt = useRecords().baby?.data.birthAt ?? 0;
  const isOpenSleep = event.type === 'sleep' && !event.endAt;
  const editor = eventEditor(id, event, birthAt);
  const remove = async () => {
    await app.remove(id);
    sheet.close();
    toast('已删除这条记录', {
      undo: () => void app.write('event', event, id),
    });
  };
  return (
    <>
      <Muted testID="event-detail" style={{ fontSize: 13, lineHeight: 20 }}>
        {[eventTimeText(event), event.note, event.byName ? `${event.byName}记录` : null]
          .filter(Boolean)
          .join(' · ')}
      </Muted>
      <Button
        testID="event-edit"
        tone="outline"
        label="修改"
        onPress={() => sheet.replace(editor.title, editor.render)}
      />
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
  diaperOn: { borderColor: colors.ink, borderWidth: 2, backgroundColor: colors.sand },
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
