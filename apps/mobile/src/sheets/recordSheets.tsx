import {
  ageParts,
  assessTemperature,
  breastFeedState,
  checkRecordTime,
  chipsFor,
  createTapGuard,
  describeEvent,
  doseTimeText,
  type EventData,
  type FeedMethod,
  type FeedMilk,
  feedDefaultsAt,
  feedMilkFields,
  feedMilkOf,
  finishBreastFeed,
  formatClock,
  formatFullDate,
  formatMonthDay,
  formatTemperatureRange,
  formulaSnapshot,
  guardTap,
  isCustomVaccineId,
  isOpenBreastFeed,
  lastFeedDefaults,
  medicineSuggestions,
  mergeEdit,
  metricToSave,
  newCustomVaccineId,
  nextVaccine,
  optionalStartText,
  planSchedule,
  scaleFor,
  stepDisplay,
  TAP_HOLD_MS,
  t,
  toDisplay,
  toMetric,
  vaccineRecordName,
  vaccineStatuses,
  vaccinesToOffer,
} from '@xiaodouya/shared';
import * as Crypto from 'expo-crypto';
import * as Haptics from 'expo-haptics';
import { type ReactNode, useCallback, useRef, useState } from 'react';
import { Pressable, Text, useWindowDimensions, View } from 'react-native';
import { useApp, useRecords, useRegion, useUnits } from '../lib/app';
import { doseTimestamp, editedDoseTimestamp } from '../lib/dates';
import { gridItemWidth } from '../lib/layout';
import { colors, spacing, themedStyles } from '../theme';
import { PastDatePicker } from '../ui/BirthPicker';
import { useDeleteConfirm } from '../ui/DeleteConfirm';
import { useFeedback, useSheet } from '../ui/overlays';
import { Button, Chip, Dot, Mono, Muted, PressScale, SoftInput, Toggle } from '../ui/primitives';
import { SmallStepper } from '../ui/SmallStepper';
import {
  DateTimeRow,
  DayChips,
  type RecordTime,
  RecordTimeField,
  TimeCheckText,
  useRecordTime,
} from '../ui/TimeField';
import { BreastForm, BreastStart, BreastTimer, FeedMethodSwitch } from './breastSheets';
import { AddFormulaFlow, MilkChooser } from './formulaSheets';
import { DosePlanBar, VaccinePlanForm } from './vaccineSheets';

type EventOf<T extends EventData['type']> = Extract<EventData, { type: T }>;

/** 每个记录弹层的三种用法：新记录（都不传）、修改（initial + id）、补记（backfill）。 */
interface SheetMode<T extends EventData['type']> {
  initial?: EventOf<T>;
  id?: string;
  backfill?: boolean;
}

const HOUR = 3_600_000;

/**
 * 所有记录弹层的保存逻辑：写入、震动、Toast、撤销。
 * 一个弹层只保存一次：写本地的这几十毫秒里、弹层收起之前，保存按钮还能点到，连点会多记一条（issue #69）。
 * 弹层每次打开都是新的一份（见 `SheetProvider`），所以挡住的只是这一次的重复点击；写失败了会放开。
 */
export function useSaveEvent() {
  const app = useApp();
  const sheet = useSheet();
  const { toast } = useFeedback();
  const units = useUnits();
  const guard = useRef(createTapGuard({ holdMs: TAP_HOLD_MS })).current;
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
      const saved = await guardTap(guard, 'save', Date.now, () => app.write('event', data, id));
      if (!saved.ran) return;
      const recordId = saved.value;
      sheet.close();
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      const others = (me?.members ?? []).filter((m) => m.userId !== me?.user.id);
      const suffix = others.length === 1 ? t().records.syncedTo(others[0]?.label ?? '') : '';
      const now = Date.now();
      // 不是今天的记录在时间线上看不到，Toast 要说清楚记到了哪一天。
      const day =
        new Date(data.at).toDateString() === new Date(now).toDateString()
          ? ''
          : `${formatMonthDay(data.at)} `;
      toast(
        `${id ? t().records.saved : t().records.logged} · ${day}${describeEvent(data, now, units)}${suffix}`,
        {
          undo: id
            ? latest
              ? () => void app.write('event', latest, id)
              : undefined
            : () => void app.remove(recordId),
        },
      );
    },
    [app, sheet, toast, me, label, units, guard],
  );
}

/** 备注只在修改时才有输入框，新记录要尽量少点几下。喂奶自己有备注，体温的备注是自动生成的。 */
function EventNote({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  return (
    <SoftInput
      testID="event-note"
      value={value}
      onChangeText={onChange}
      placeholder={t().records.noteOptional}
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
        accessibilityLabel={t().records.decrease}
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
        accessibilityLabel={t().records.increase}
        onPress={onInc}
        style={s.stepBtn}
      >
        <Text style={s.stepSign}>{t().records.plus}</Text>
      </Pressable>
    </View>
  );
}

/**
 * 喂奶弹层：顶上 `瓶喂 / 亲喂`，默认跟上一次。有正在计时的亲喂时直接显示计时，
 * 修改一条还没结束的亲喂也是计时；喂完的亲喂、补记和“更早”开始的亲喂填两侧的分钟数。
 */
export function FeedSheet({ initial, id, backfill }: SheetMode<'feed'>) {
  const { events, formulas } = useRecords();
  const save = useSaveEvent();
  const time = useRecordTime({ at: initial?.at, backfill });
  const [picked, setPicked] = useState<FeedMethod | null>(() =>
    initial ? (initial.method === 'breast' ? 'breast' : 'bottle') : null,
  );
  if (id && initial && isOpenBreastFeed(initial)) return <BreastTimer id={id} />;
  const data = events.map((e) => e.data);
  const now = Date.now();
  const running = id || backfill ? null : breastFeedState(data, now);
  const openId =
    running && running.status !== 'none'
      ? events.find((e) => e.data === running.feed)?.id
      : undefined;
  const method = picked ?? (openId ? 'breast' : lastFeedDefaults(data, formulas, now).method);
  const methodSwitch = <FeedMethodSwitch value={method} onChange={setPicked} />;
  // 添加奶粉时整个弹层换成表单，切换条不能留在上面：点了亲喂会把填了一半的奶粉丢掉。
  if (method === 'bottle') {
    return <BottleFeed initial={initial} id={id} time={time} header={methodSwitch} />;
  }
  const body = openId ? (
    <BreastTimer id={openId} />
  ) : id || time.choice.kind === 'exact' ? (
    <BreastForm
      initial={initial}
      id={id}
      time={time}
      onSave={(next) => void save(next, id, initial)}
    />
  ) : (
    <BreastStart time={time} />
  );
  return (
    <>
      {methodSwitch}
      {body}
    </>
  );
}

function BottleFeed({
  initial,
  id,
  time,
  header,
}: {
  initial?: EventOf<'feed'>;
  id?: string;
  time: RecordTime;
  header: ReactNode;
}) {
  const { events, formulas } = useRecords();
  const app = useApp();
  const save = useSaveEvent();
  const data = events.map((e) => e.data);
  const { volume } = useUnits();
  const scale = scaleFor('volume', volume);
  // 新记录沿用上一次瓶喂的奶量（亲喂的 0ml 不算）；把亲喂改成瓶喂时也一样。
  const original =
    initial && initial.method !== 'breast'
      ? initial.ml
      : lastFeedDefaults(data, formulas, Date.now()).ml;
  const [amount, setAmount] = useState(() => toDisplay('volume', original ?? 90, volume));
  const [note, setNote] = useState(initial?.note ?? '');
  // 修改时固定用记录上的快照：只改时间或奶量不能改写当时的数值，只有换了奶粉才用现在的。
  const [pickedMilk, setPickedMilk] = useState<FeedMilk | null>(() =>
    initial && initial.method !== 'breast' ? feedMilkOf(initial) : null,
  );
  // 没动过就跟着时间走：补记以前的喂奶，默认是那个时候喂的奶粉，不是现在的。
  const milk =
    pickedMilk ??
    (time.choice.kind === 'exact'
      ? feedDefaultsAt(data, formulas, time.resolve(), Date.now())
      : lastFeedDefaults(data, formulas, Date.now()));
  const [addingFormula, setAddingFormula] = useState(false);
  if (addingFormula) {
    return (
      <AddFormulaFlow
        heading={t().records.addFormula}
        onCancel={() => setAddingFormula(false)}
        onDone={(formulaId) => {
          setAddingFormula(false);
          const added = app.store.getSnapshot().formulas.find((f) => f.id === formulaId);
          if (added) {
            setPickedMilk({ milkType: 'formula', formulaId, formula: formulaSnapshot(added.data) });
          }
        }}
      />
    );
  }
  return (
    <>
      {header}
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
        placeholder={t().records.feedNotePlaceholder}
        maxLength={200}
      />
      <MilkChooser
        value={milk}
        onChange={setPickedMilk}
        onAddFormula={() => setAddingFormula(true)}
      />
      <Button
        testID="feed-save"
        label={id ? t().common.save : t().records.record}
        disabled={Boolean(time.check.error)}
        onPress={() =>
          void save(
            {
              ...initial,
              type: 'feed',
              at: time.resolve(),
              ml: metricToSave('volume', original, amount, volume),
              note: note.trim() || undefined,
              milkType: undefined,
              formulaId: undefined,
              formula: undefined,
              ...feedMilkFields(milk),
              // 把亲喂改成瓶喂：计时的字段都去掉。本来就是瓶喂的，这些键和原来一样是空的，不算改动。
              method: undefined,
              side: undefined,
              sideSince: undefined,
              leftSec: undefined,
              rightSec: undefined,
              endAt: undefined,
            },
            id,
            initial,
          )
        }
      />
    </>
  );
}

const diaperOptions = () =>
  [
    { kind: 'wee', label: t().records.diaperWet },
    { kind: 'poo', label: t().records.diaperDirty },
    { kind: 'both', label: t().records.diaperBoth },
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
        {diaperOptions().map(({ kind, label }) => {
          const on = selected === kind;
          return (
            <PressScale
              key={kind}
              testID={`diaper-${kind}`}
              accessibilityLabel={label}
              accessibilityState={{ selected: on, disabled: invalid && !id }}
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
            label={t().common.save}
            disabled={invalid}
            onPress={() => {
              if (selected) record(selected);
            }}
          />
        </>
      ) : (
        <Muted>{t().records.oneTapHint}</Muted>
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
      <DateTimeRow
        label={t().records.fellAsleep}
        testID="sleep-start"
        value={start}
        onChange={changeStart}
      />
      {wasOpen ? (
        <View>
          <Toggle
            testID="sleep-still"
            label={t().records.stillAsleep}
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
        <DateTimeRow label={t().records.wokeUp} testID="sleep-end" value={end} onChange={setEnd} />
      )}
      <TimeCheckText check={check} />
      <EventNote value={note} onChange={setNote} />
      <Button
        testID="sleep-save"
        label={id ? t().common.save : t().records.record}
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
    sheet.replace(backfill ? t().records.backfillTitle(label) : label, render);
  // 平时这三样在今天页有自己的按钮，只有补记才要从这里进。
  const daily = backfill
    ? [
        {
          key: 'feed',
          label: t().today.feed,
          color: colors.feed,
          onPress: () => open(t().today.feed, () => <FeedSheet backfill />),
        },
        {
          key: 'diaper',
          label: t().today.diaper,
          color: colors.diaper,
          onPress: () => open(t().today.diaper, () => <DiaperSheet backfill />),
        },
        {
          key: 'sleep',
          label: t().today.sleep,
          color: colors.sleepText,
          onPress: () => open(t().today.sleep, () => <SleepSheet />),
        },
      ]
    : [];
  const items: { key: string; label: string; color: string; onPress?: () => void; sub?: string }[] =
    [
      ...daily,
      {
        key: 'temp',
        label: t().records.temp,
        color: colors.temp,
        onPress: () =>
          open(t().records.temp, () => <TempSheet birthAt={birthAt} backfill={backfill} />),
      },
      {
        key: 'med',
        label: t().records.med,
        color: colors.med,
        onPress: () => open(t().records.med, () => <MedSheet backfill={backfill} />),
      },
      {
        key: 'bath',
        label: t().records.bath,
        color: colors.bath,
        onPress: () => open(t().records.bath, () => <BathSheet backfill={backfill} />),
      },
      {
        key: 'growth',
        label: t().records.growth,
        color: colors.growth,
        onPress: () => open(t().records.growth, () => <GrowthSheet backfill={backfill} />),
      },
      {
        key: 'vaccine',
        label: t().records.vaccine,
        color: colors.vaccine,
        onPress: () =>
          sheet.replace(t().today.vaccination, () => <VaccineSheet birthAt={birthAt} />),
      },
      canEatSolids
        ? {
            key: 'solids',
            label: t().records.solids,
            color: colors.solids,
            onPress: () => open(t().records.solids, () => <SolidsSheet backfill={backfill} />),
          }
        : {
            key: 'solids',
            label: t().records.solids,
            color: colors.hint,
            sub: t().records.solidsFrom6m,
          },
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
      ? colors.dangerText
      : assessment.level === 'elevated'
        ? colors.warnText
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
        label={id ? t().common.save : t().records.record}
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
  const [name, setName] = useState(initial?.name ?? medicineSuggestions()[0] ?? '');
  const [dose, setDose] = useState(initial ? (initial.dose ?? '') : t().records.oneDrop);
  const [note, setNote] = useState(initial?.note ?? '');
  const time = useRecordTime({ at: initial?.at, backfill });
  return (
    <>
      <RecordTimeField time={time} />
      <View style={s.chips}>
        {medicineSuggestions().map((v) => (
          <Chip
            key={v}
            label={v}
            selected={name === v}
            onPress={() => {
              setName(v);
              setDose(v === medicineSuggestions()[0] ? t().records.oneDrop : '');
            }}
          />
        ))}
      </View>
      <SoftInput
        testID="med-name"
        value={name}
        onChangeText={setName}
        placeholder={t().records.medName}
        maxLength={100}
      />
      <SoftInput
        testID="med-dose"
        value={dose}
        onChangeText={setDose}
        placeholder={t().records.dose}
        maxLength={100}
      />
      {id ? <EventNote value={note} onChange={setNote} /> : null}
      <Button
        testID="med-save"
        label={id ? t().common.save : t().records.record}
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
          {t().records.bathTip(formatTemperatureRange(37, 40, temperature))}
        </Muted>
      )}
      <Button
        testID="bath-save"
        label={id ? t().common.save : t().records.recordBath}
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
        placeholder={t().records.solidsPlaceholder}
        maxLength={200}
      />
      {id ? <EventNote value={note} onChange={setNote} /> : null}
      <Button
        testID="solids-save"
        label={id ? t().common.save : t().records.record}
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
        label={t().records.weight}
        value={w.toFixed(1)}
        unit={scaleFor('weight', units.weight).label}
        onDec={() => setW((v) => stepDisplay('weight', v, -1, units.weight))}
        onInc={() => setW((v) => stepDisplay('weight', v, 1, units.weight))}
      />
      <SmallStepper
        testPrefix="length"
        label={t().records.length}
        value={h.toFixed(1)}
        unit={scaleFor('length', units.length).label}
        onDec={() => setH((v) => stepDisplay('length', v, -1, units.length))}
        onInc={() => setH((v) => stepDisplay('length', v, 1, units.length))}
      />
      {id ? <EventNote value={note} onChange={setNote} /> : null}
      <Button
        testID="growth-save"
        label={id ? t().common.save : t().records.record}
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
  const { events, vaccinePlans } = useRecords();
  const region = useRegion();
  const save = useSaveEvent();
  const sheet = useSheet();
  const shots = events.map((e) => e.data);
  const statuses = vaccineStatuses(
    planSchedule(region, birthAt, vaccinePlans, shots),
    birthAt,
    shots,
    Date.now(),
  );
  const [planning, setPlanning] = useState(false);
  const [pickingOptional, setPickingOptional] = useState(false);
  const optional = region.optionalVaccines;
  const pending = vaccinesToOffer(statuses, preselect);
  const [selected, setSelected] = useState(
    custom ? CUSTOM_OPTION : (preselect ?? nextVaccine(statuses)?.id ?? CUSTOM_OPTION),
  );
  const [customName, setCustomName] = useState('');
  const [date, setDate] = useState(() => new Date());
  const isCustom = selected === CUSTOM_OPTION;
  const dose = pending.find((v) => v.id === selected);
  const chosenOptional = optional?.vaccines.find((v) => v.id === selected);
  const name = isCustom ? customName.trim() : (dose?.recordName ?? chosenOptional?.recordName);
  const now = Date.now();
  const check = checkRecordTime({ at: doseTimestamp(date, now), birthAt, now, dateOnly: true });
  const submit = () => {
    if (!name) return;
    void save({
      type: 'vaccine',
      at: doseTimestamp(date, Date.now()),
      vaccineId: isCustom
        ? newCustomVaccineId(Crypto.randomUUID())
        : ((dose ?? chosenOptional)?.id as string),
      name,
    });
  };
  // 从“＋ 其他疫苗”进来才有这个切换。默认还是记一剂打过的，从表上的剂次进来时不多一步。
  const modeChips = custom ? (
    <View style={s.chips}>
      <Chip
        testID="vaccine-mode-done"
        label={t().records.alreadyGiven}
        selected={!planning}
        onPress={() => {
          setPlanning(false);
          sheet.setTitle(t().today.vaccination);
        }}
      />
      <Chip
        testID="vaccine-mode-plan"
        label={t().records.notYetPlan}
        selected={planning}
        onPress={() => {
          setPlanning(true);
          sheet.setTitle(t().records.addToPlan);
        }}
      />
    </View>
  ) : null;
  // 自费疫苗有十几种，平铺会把“已接种”挤出屏幕，所以在弹层里换成列表，选好再回来。
  if (optional && pickingOptional) {
    const back = () => {
      setPickingOptional(false);
      sheet.setTitle(t().today.vaccination);
    };
    return (
      <>
        <Muted testID="vaccine-optional-note" style={{ fontSize: 12, lineHeight: 19 }}>
          {optional.note}
        </Muted>
        <View style={{ gap: 8 }}>
          {optional.vaccines.map((v) => {
            const on = selected === v.id;
            return (
              <Pressable
                key={v.id}
                testID={`vaccine-optional-${v.localId}`}
                accessibilityRole="button"
                accessibilityLabel={`${v.name} · ${optionalStartText(v)}`}
                accessibilityState={{ selected: on }}
                onPress={() => {
                  setSelected(v.id);
                  back();
                }}
                style={[s.vaccineOption, { backgroundColor: on ? colors.ink : colors.paper }]}
              >
                <Text style={{ fontSize: 14, color: on ? colors.paper : colors.ink }}>
                  {v.name}
                </Text>
                <Text style={{ fontSize: 11, color: on ? colors.off : colors.muted }}>
                  {optionalStartText(v)}
                </Text>
              </Pressable>
            );
          })}
        </View>
        <Button
          testID="vaccine-optional-back"
          tone="ghost"
          label={t().common.back}
          onPress={back}
        />
      </>
    );
  }
  if (planning) {
    return (
      <>
        {modeChips}
        <VaccinePlanForm initialName={customName} />
      </>
    );
  }
  return (
    <>
      {modeChips}
      {preselect && dose ? <DosePlanBar dose={dose} /> : null}
      <PastDatePicker
        label={t().records.doseDate}
        testID="vaccine-date"
        value={date}
        onChange={setDate}
      />
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
                {v.name} · {doseTimeText(v)}
              </Text>
            </Pressable>
          );
        })}
        {optional ? (
          <Pressable
            testID="vaccine-optional"
            accessibilityRole="button"
            accessibilityLabel={
              chosenOptional ? chosenOptional.name : t().records.optionalVaccineA11y(optional.title)
            }
            accessibilityState={{ selected: Boolean(chosenOptional) }}
            onPress={() => {
              setPickingOptional(true);
              sheet.setTitle(optional.title);
            }}
            style={[
              s.vaccineOption,
              { backgroundColor: chosenOptional ? colors.ink : colors.paper },
            ]}
          >
            <Text style={{ fontSize: 14, color: chosenOptional ? colors.paper : colors.ink }}>
              {chosenOptional
                ? `${chosenOptional.name} · ${optionalStartText(chosenOptional)}`
                : `${optional.title} · ${t().records.pickFromList} ›`}
            </Text>
          </Pressable>
        ) : null}
        {pending.length > 0 || optional ? (
          <Pressable
            testID="vaccine-custom"
            accessibilityRole="button"
            accessibilityLabel={t().records.otherVaccine}
            accessibilityState={{ selected: isCustom }}
            onPress={() => setSelected(CUSTOM_OPTION)}
            style={[s.vaccineOption, { backgroundColor: isCustom ? colors.ink : colors.paper }]}
          >
            <Text style={{ fontSize: 14, color: isCustom ? colors.paper : colors.ink }}>
              {t().records.otherVaccineCustom}
            </Text>
          </Pressable>
        ) : null}
      </View>
      {isCustom ? (
        <SoftInput
          testID="vaccine-custom-name"
          value={customName}
          onChangeText={setCustomName}
          placeholder={t().records.vaccineName}
          maxLength={100}
        />
      ) : null}
      {dose?.note ? <Muted style={{ fontSize: 12, lineHeight: 19 }}>{dose.note}</Muted> : null}
      {chosenOptional?.note ? (
        <Muted testID="vaccine-optional-dose-note" style={{ fontSize: 12, lineHeight: 19 }}>
          {chosenOptional.note}
        </Muted>
      ) : null}
      {chosenOptional?.mayReplace ? (
        <Muted testID="vaccine-optional-replace" style={{ fontSize: 12, lineHeight: 19 }}>
          {chosenOptional.mayReplace}
        </Muted>
      ) : null}
      {/* 地区的说明讲的是免疫规划表，选了自费疫苗时换成自费疫苗的说明。 */}
      {optional && chosenOptional ? (
        <Muted testID="vaccine-optional-disclaimer" style={{ fontSize: 11, lineHeight: 18 }}>
          {optional.note}
        </Muted>
      ) : (
        <Muted testID="vaccine-sheet-disclaimer" style={{ fontSize: 11, lineHeight: 18 }}>
          {region.disclaimer}
        </Muted>
      )}
      <Button
        testID="vaccine-save"
        tone="green"
        label={t().records.given}
        disabled={!name}
        onPress={submit}
      />
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
      <PastDatePicker
        label={t().records.doseDate}
        testID="vaccine-date"
        value={date}
        onChange={setDate}
      />
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
          placeholder={t().records.vaccineName}
          maxLength={100}
        />
      ) : null}
      <EventNote value={note} onChange={setNote} />
      <Muted style={{ fontSize: 11, lineHeight: 18 }}>{region.disclaimer}</Muted>
      <Button
        testID="vaccine-edit-save"
        tone="green"
        label={t().common.save}
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
      return { title: t().records.editFeed, render: () => <FeedSheet initial={event} id={id} /> };
    case 'diaper':
      return {
        title: t().records.editDiaper,
        render: () => <DiaperSheet initial={event} id={id} />,
      };
    case 'sleep':
      return { title: t().records.editSleep, render: () => <SleepSheet initial={event} id={id} /> };
    case 'temp':
      return {
        title: t().records.editTemp,
        render: () => <TempSheet birthAt={birthAt} initial={event} id={id} />,
      };
    case 'med':
      return { title: t().records.editMed, render: () => <MedSheet initial={event} id={id} /> };
    case 'bath':
      return { title: t().records.editBath, render: () => <BathSheet initial={event} id={id} /> };
    case 'solids':
      return {
        title: t().records.editSolids,
        render: () => <SolidsSheet initial={event} id={id} />,
      };
    case 'growth':
      return {
        title: t().records.editGrowth,
        render: () => <GrowthSheet initial={event} id={id} />,
      };
    case 'vaccine':
      return {
        title: vaccineRecordName(event.vaccineId, event.name),
        render: () => <VaccineEditSheet initial={event} id={id} />,
      };
  }
}

function eventTimeText(event: EventData): string {
  const start = `${formatFullDate(event.at)} ${formatClock(event.at)}`;
  // 睡眠和亲喂有结束时间，写成一段。
  const endAt =
    event.type === 'sleep' || (event.type === 'feed' && event.method === 'breast')
      ? event.endAt
      : undefined;
  if (!endAt) return start;
  const sameDay = formatFullDate(event.at) === formatFullDate(endAt);
  const end = sameDay ? formatClock(endAt) : `${formatFullDate(endAt)} ${formatClock(endAt)}`;
  return `${start} – ${end}`;
}

/** 点时间线的一条记录：都能改，都能删。 */
export function EventActionsSheet({ id, event }: { id: string; event: EventData }) {
  const app = useApp();
  const sheet = useSheet();
  const { toast } = useFeedback();
  const birthAt = useRecords().baby?.data.birthAt ?? 0;
  const isOpenSleep = event.type === 'sleep' && !event.endAt;
  const units = useUnits();
  const confirmDelete = useDeleteConfirm();
  const editor = eventEditor(id, event, birthAt);
  const remove = async () => {
    await app.remove(id);
    sheet.close();
    toast(t().records.recordDeleted, {
      undo: () => void app.write('event', event, id),
    });
  };
  const summary = `${describeEvent(event, Date.now(), units)} · ${eventTimeText(event)}`;
  return (
    <>
      <Muted testID="event-detail" style={{ fontSize: 13, lineHeight: 20 }}>
        {[
          eventTimeText(event),
          event.note,
          event.byName ? t().records.recordedBy(event.byName) : null,
        ]
          .filter(Boolean)
          .join(' · ')}
      </Muted>
      <Button
        testID="event-edit"
        tone="outline"
        label={t().records.edit}
        onPress={() => sheet.replace(editor.title, editor.render)}
      />
      {isOpenSleep ? (
        <Button
          testID="event-wake"
          tone="outline"
          label={t().records.awakeNow}
          onPress={() => {
            void app.write('event', { ...event, endAt: Date.now() }, id);
            sheet.close();
          }}
        />
      ) : null}
      {isOpenBreastFeed(event) ? (
        <Button
          testID="event-end-breast"
          tone="outline"
          label={t().records.breastEndNow}
          onPress={() => {
            // 按最新的那一版结束：弹层开着时可能又换过边。
            const latest = app.store.getSnapshot().events.find((e) => e.id === id)?.data;
            if (latest && isOpenBreastFeed(latest)) {
              void app.write('event', finishBreastFeed(latest, Date.now()), id);
            }
            sheet.close();
          }}
        />
      ) : null}
      <Button
        testID="event-delete"
        tone="ghost"
        label={t().records.deleteRecord}
        onPress={() => confirmDelete({ kind: 'event', event, summary }, remove)}
      />
    </>
  );
}

const s = themedStyles(() => ({
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
  vaccineOption: { paddingHorizontal: 14, paddingVertical: 13, borderRadius: 12 },
}));
