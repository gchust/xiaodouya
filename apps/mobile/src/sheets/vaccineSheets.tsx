import DateTimePicker from '@react-native-community/datetimepicker';
import {
  checkRecordTime,
  dosesToBackfill,
  doseTimeText,
  formatFullDate,
  isCustomVaccineId,
  planFor,
  planSchedule,
  type VaccineDose,
  type VaccinePlanData,
  vaccineStatuses,
} from '@xiaodouya/shared';
import * as Crypto from 'expo-crypto';
import * as Haptics from 'expo-haptics';
import { type ReactNode, useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useApp, useRecords, useRegion } from '../lib/app';
import {
  doseTimestamp,
  plannedDaysLater,
  plannedDayTimestamp,
  plannedNextMonth,
} from '../lib/dates';
import { colors, fonts } from '../theme';
import { PastDatePicker } from '../ui/BirthPicker';
import { useFeedback, useSheet } from '../ui/overlays';
import { Button, Chip, Mono, Muted, SoftInput } from '../ui/primitives';
import { DayChips, TimeCheckText } from '../ui/TimeField';

const LINK_HIT_SLOP = { top: 14, bottom: 14, left: 8, right: 8 };
const MAX_MONTHS = 240;

/**
 * 写配置都走这里。不用 useSaveEvent：配置不是一条记录，“已记录 undefined” 的 Toast 不适用。
 * 用保存时最新的配置，弹层开着的时候家人可能已经改过同一剂。
 */
function useVaccinePlans() {
  const app = useApp();
  const sheet = useSheet();
  const { toast } = useFeedback();
  const change = useCallback(
    async (vaccineId: string, patch: Partial<VaccinePlanData>, message: string) => {
      const current = planFor(app.store.getSnapshot().vaccinePlans, vaccineId);
      const id = await app.write(
        'event',
        { ...(current?.data ?? { type: 'vaccine-plan', vaccineId }), ...patch },
        current?.id,
      );
      sheet.close();
      toast(message, {
        undo: current ? () => void app.write('event', current.data, id) : () => void app.remove(id),
      });
    },
    [app, sheet, toast],
  );
  const removeCustom = useCallback(
    async (dose: VaccineDose) => {
      const current = planFor(app.store.getSnapshot().vaccinePlans, dose.id);
      if (!current) return;
      await app.remove(current.id);
      sheet.close();
      toast(`已从计划里移除 · ${dose.name}`, {
        undo: () => void app.write('event', current.data, current.id),
      });
    },
    [app, sheet, toast],
  );
  return { change, removeCustom };
}

/** 接种弹层顶部的一行：这一剂打算什么时候打，改时间和隐藏都从这里进，不用先学配置页。 */
export function DosePlanBar({ dose }: { dose: VaccineDose }) {
  const sheet = useSheet();
  const { change, removeCustom } = useVaccinePlans();
  const custom = isCustomVaccineId(dose.id);
  return (
    <View style={s.planBar}>
      <Muted testID="vaccine-plan-summary" style={s.planSummary} numberOfLines={1}>
        {doseTimeText(dose)}
      </Muted>
      <Pressable
        testID="vaccine-plan-time"
        accessibilityRole="button"
        accessibilityLabel={`改${dose.name}的计划时间`}
        hitSlop={LINK_HIT_SLOP}
        onPress={() =>
          sheet.replace(dose.name, () =>
            custom ? <VaccinePlanForm dose={dose} /> : <DoseTimeSheet dose={dose} />,
          )
        }
      >
        <Text style={s.link}>{custom ? '修改' : '改时间'}</Text>
      </Pressable>
      <Pressable
        testID="vaccine-plan-hide"
        accessibilityRole="button"
        accessibilityLabel={custom ? `从计划里移除${dose.name}` : `隐藏${dose.name}`}
        hitSlop={LINK_HIT_SLOP}
        onPress={() =>
          custom
            ? void removeCustom(dose)
            : void change(dose.id, { hidden: true }, `已隐藏 · ${dose.name}`)
        }
      >
        <Text style={s.link}>{custom ? '移除' : '隐藏这一剂'}</Text>
      </Pressable>
    </View>
  );
}

/**
 * 选计划日期。系统选择器翻到下个月要点好几下，而诊所约的大多是下周或下个月，所以先给两个胶囊。
 * 可以选过去的日期：计划可能是补填的，App 不判断。
 */
function PlanDateField({
  value,
  onChange,
  extra,
}: {
  value: Date | null;
  onChange: (next: Date) => void;
  extra?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const now = Date.now();
  const week = plannedDaysLater(7, now);
  const month = plannedNextMonth(now);
  const same = (d: Date) => value?.toDateString() === d.toDateString();
  return (
    <>
      <View style={s.chips}>
        <Chip
          testID="vaccine-plan-week"
          label="下周"
          selected={same(week)}
          onPress={() => onChange(week)}
        />
        <Chip
          testID="vaccine-plan-month"
          label="下个月"
          selected={same(month)}
          onPress={() => onChange(month)}
        />
        <Chip
          testID="vaccine-plan-pick"
          label="选日期"
          selected={value !== null && !same(week) && !same(month)}
          onPress={() => setOpen(true)}
        />
        {extra}
      </View>
      {value ? (
        <Mono testID="vaccine-plan-date" style={s.dateText}>
          {formatFullDate(value.getTime())}
        </Mono>
      ) : null}
      {open ? (
        <DateTimePicker
          value={value ?? new Date()}
          mode="date"
          onChange={(event, date) => {
            setOpen(false);
            // 取消时系统也会传一个日期回来，那不是用户选的。
            if (event.type === 'set' && date) onChange(date);
          }}
        />
      ) : null}
    </>
  );
}

function PlanNote() {
  return (
    <Muted testID="vaccine-plan-note" style={{ fontSize: 11, lineHeight: 18 }}>
      这是你们家的安排，App 不判断时间是否合适，以诊所安排和健康手册为准。
    </Muted>
  );
}

/** 诊所另约了时间：改这一剂的计划日期。内置表不变，恢复后回到表上的时间。 */
function DoseTimeSheet({ dose }: { dose: VaccineDose }) {
  const { vaccinePlans } = useRecords();
  const { change } = useVaccinePlans();
  const existing = planFor(vaccinePlans, dose.id)?.data.plannedAt;
  const [date, setDate] = useState(existing === undefined ? null : new Date(existing));
  return (
    <>
      <Muted style={{ fontSize: 13, lineHeight: 20 }}>表上的时间：{dose.ageLabel}</Muted>
      <PlanDateField value={date} onChange={setDate} />
      <PlanNote />
      <Button
        testID="vaccine-plan-save"
        label="保存"
        disabled={date === null}
        onPress={() => {
          if (date) {
            void change(
              dose.id,
              { plannedAt: plannedDayTimestamp(date) },
              `已改时间 · ${dose.name}`,
            );
          }
        }}
      />
      {existing !== undefined ? (
        <Button
          testID="vaccine-plan-reset"
          tone="ghost"
          label="恢复表上的时间"
          onPress={() =>
            void change(dose.id, { plannedAt: undefined }, `已恢复表上的时间 · ${dose.name}`)
          }
        />
      ) : null}
    </>
  );
}

type PlanTime = { kind: 'none' } | { kind: 'date'; date: Date } | { kind: 'months'; text: string };

function initialPlanTime(plan: VaccinePlanData | undefined): PlanTime {
  if (plan?.plannedAt !== undefined) return { kind: 'date', date: new Date(plan.plannedAt) };
  if (plan?.months !== undefined) return { kind: 'months', text: String(plan.months) };
  return { kind: 'none' };
}

function parsedMonths(text: string): number | null {
  if (!/^\d{1,3}$/.test(text.trim())) return null;
  const months = Number(text);
  return months <= MAX_MONTHS ? months : null;
}

/** 给计划加一个疫苗，或者改已经加的。一个名字就能保存，时间可以之后再定。 */
export function VaccinePlanForm({
  dose,
  initialName,
}: {
  dose?: VaccineDose;
  initialName?: string;
}) {
  const app = useApp();
  const sheet = useSheet();
  const { toast } = useFeedback();
  const { vaccinePlans } = useRecords();
  const { removeCustom } = useVaccinePlans();
  const existing = dose ? planFor(vaccinePlans, dose.id) : undefined;
  const [name, setName] = useState(existing?.data.name ?? initialName ?? '');
  const [time, setTime] = useState<PlanTime>(() => initialPlanTime(existing?.data));
  const months = time.kind === 'months' ? parsedMonths(time.text) : null;
  const invalid = !name.trim() || (time.kind === 'months' && months === null);

  const save = async () => {
    if (invalid) return;
    const id = existing?.id ?? Crypto.randomUUID();
    const before = app.store.getSnapshot().vaccinePlans.find((p) => p.id === id)?.data;
    await app.write(
      'event',
      {
        ...(before ?? { type: 'vaccine-plan', vaccineId: `custom:${id}` }),
        name: name.trim(),
        plannedAt: time.kind === 'date' ? plannedDayTimestamp(time.date) : undefined,
        months: months ?? undefined,
      },
      id,
    );
    sheet.close();
    toast(`${before ? '已保存' : '已加进计划'} · ${name.trim()}`, {
      undo: before ? () => void app.write('event', before, id) : () => void app.remove(id),
    });
  };

  return (
    <>
      <SoftInput
        testID="vaccine-plan-name"
        value={name}
        onChangeText={setName}
        placeholder="疫苗名称"
        maxLength={100}
      />
      <PlanDateField
        value={time.kind === 'date' ? time.date : null}
        onChange={(date) => setTime({ kind: 'date', date })}
        extra={
          <Chip
            testID="vaccine-plan-age"
            label="按月龄"
            selected={time.kind === 'months'}
            onPress={() =>
              setTime(time.kind === 'months' ? { kind: 'none' } : { kind: 'months', text: '' })
            }
          />
        }
      />
      {time.kind === 'months' ? (
        <SoftInput
          testID="vaccine-plan-months"
          value={time.text}
          onChangeText={(text) => setTime({ kind: 'months', text })}
          keyboardType="number-pad"
          placeholder="满几个月，比如 6"
          maxLength={3}
        />
      ) : null}
      {time.kind === 'none' ? (
        <Muted style={{ fontSize: 12 }}>时间还没定也可以先加上，之后点它再改。</Muted>
      ) : null}
      <PlanNote />
      <Button
        testID="vaccine-plan-save"
        label={existing ? '保存' : '加进计划'}
        disabled={invalid}
        onPress={() => void save()}
      />
      {dose && existing ? (
        <Button
          testID="vaccine-plan-remove"
          tone="ghost"
          label="从计划里移除"
          onPress={() => void removeCustom(dose)}
        />
      ) : null}
    </>
  );
}

/** 隐藏的剂次在这里恢复。已经打过的不会出现在这里，它们一直显示在疫苗本上。 */
export function HiddenDosesSheet({ birthAt }: { birthAt: number }) {
  const { events, vaccinePlans } = useRecords();
  const region = useRegion();
  const { change } = useVaccinePlans();
  const { hidden } = planSchedule(
    region,
    birthAt,
    vaccinePlans,
    events.map((e) => e.data),
  );
  return (
    <>
      <Muted style={{ fontSize: 13, lineHeight: 20 }}>
        隐藏只是不显示、不提醒，已经记下的接种不受影响。以诊所安排和健康手册为准。
      </Muted>
      <View>
        {hidden.map((dose, i) => (
          <View key={dose.id} style={[s.hiddenRow, i < hidden.length - 1 ? s.divider : null]}>
            <View style={{ flex: 1, gap: 1 }}>
              <Text style={s.doseName}>{dose.name}</Text>
              <Muted style={{ fontSize: 11 }}>{doseTimeText(dose)}</Muted>
            </View>
            <Chip
              testID={`vaccine-restore-${dose.localId}`}
              label="恢复"
              selected={false}
              onPress={() => void change(dose.id, { hidden: false }, `已恢复 · ${dose.name}`)}
            />
          </View>
        ))}
      </View>
    </>
  );
}

/** 建档时常见：打过的一次勾上。默认都用上面的日期，日期不一样的单独改。 */
export function VaccineBackfillSheet({ birthAt }: { birthAt: number }) {
  const app = useApp();
  const sheet = useSheet();
  const { toast } = useFeedback();
  const { events, vaccinePlans } = useRecords();
  const region = useRegion();
  const shots = events.map((e) => e.data);
  const now = Date.now();
  const doses = dosesToBackfill(
    vaccineStatuses(planSchedule(region, birthAt, vaccinePlans, shots), birthAt, shots, now),
  );
  const [date, setDate] = useState(() => new Date());
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  /** 只存单独改过的，其他的跟着上面的日期走。 */
  const [ownDates, setOwnDates] = useState<ReadonlyMap<string, Date>>(new Map());
  const [picking, setPicking] = useState<string | null>(null);
  const chosen = doses.filter((d) => selected.has(d.id));
  const dateOf = (id: string) => ownDates.get(id) ?? date;
  const earliest = Math.min(
    doseTimestamp(date, now),
    ...chosen.map((d) => doseTimestamp(dateOf(d.id), now)),
  );
  const check = checkRecordTime({ at: earliest, birthAt, now, dateOnly: true });

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (!next.delete(id)) next.add(id);
    setSelected(next);
  };

  const save = async () => {
    if (chosen.length === 0) return;
    const at = Date.now();
    const ids: string[] = [];
    for (const dose of chosen) {
      ids.push(
        await app.write('event', {
          type: 'vaccine',
          at: doseTimestamp(dateOf(dose.id), at),
          vaccineId: dose.id,
          name: dose.name,
          byName: app.label,
        }),
      );
    }
    sheet.close();
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    toast(`已记录 ${ids.length} 剂`, {
      undo: () => {
        for (const id of ids) void app.remove(id);
      },
    });
  };

  return (
    <>
      <PastDatePicker label="接种日期" testID="backfill-date" value={date} onChange={setDate} />
      <DayChips
        testID="backfill-date"
        value={date.getTime()}
        onChange={(at) => setDate(new Date(at))}
      />
      <TimeCheckText check={check} />
      <Muted style={{ fontSize: 12, lineHeight: 19 }}>
        勾上打过的。哪一剂日期不一样，点它右边的日期单独改。
      </Muted>
      <View>
        {doses.map((dose, i) => {
          const on = selected.has(dose.id);
          return (
            <Pressable
              key={dose.id}
              testID={`backfill-${dose.localId}`}
              accessibilityRole="checkbox"
              accessibilityLabel={dose.name}
              accessibilityState={{ checked: on }}
              onPress={() => toggle(dose.id)}
              style={[s.backfillRow, i < doses.length - 1 ? s.divider : null]}
            >
              <View style={[s.check, on ? s.checkOn : null]}>
                {on ? <Text style={s.checkMark}>✓</Text> : null}
              </View>
              <View style={{ flex: 1, gap: 1 }}>
                <Text style={s.doseName}>{dose.name}</Text>
                <Muted style={{ fontSize: 11 }}>{doseTimeText(dose)}</Muted>
              </View>
              {on ? (
                <Pressable
                  testID={`backfill-date-${dose.localId}`}
                  accessibilityRole="button"
                  accessibilityLabel={`单独选择${dose.name}的接种日期，现在是 ${formatFullDate(dateOf(dose.id).getTime())}`}
                  hitSlop={LINK_HIT_SLOP}
                  onPress={() => setPicking(dose.id)}
                >
                  <Text
                    style={[s.rowDate, ownDates.has(dose.id) ? { color: colors.accent } : null]}
                  >
                    {formatFullDate(dateOf(dose.id).getTime())}
                  </Text>
                </Pressable>
              ) : null}
            </Pressable>
          );
        })}
      </View>
      {picking ? (
        <DateTimePicker
          value={dateOf(picking)}
          mode="date"
          maximumDate={new Date()}
          onChange={(event, picked) => {
            const id = picking;
            setPicking(null);
            if (event.type === 'set' && picked) setOwnDates(new Map(ownDates).set(id, picked));
          }}
        />
      ) : null}
      <Muted style={{ fontSize: 11, lineHeight: 18 }}>{region.disclaimer}</Muted>
      <Button
        testID="backfill-save"
        tone="green"
        label={chosen.length > 0 ? `记下 ${chosen.length} 剂` : '记下'}
        disabled={chosen.length === 0}
        onPress={() => void save()}
      />
    </>
  );
}

const s = StyleSheet.create({
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  planBar: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 2 },
  planSummary: { flex: 1, fontSize: 12 },
  link: { fontSize: 12, color: colors.accent },
  dateText: { fontSize: 14, color: colors.ink },
  hiddenRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10 },
  divider: { borderBottomWidth: 1, borderBottomColor: colors.rule },
  doseName: { fontSize: 13, color: colors.ink },
  backfillRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 11,
    minHeight: 48,
  },
  check: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.off,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkOn: { backgroundColor: colors.green, borderColor: colors.green },
  checkMark: { fontSize: 12, lineHeight: 14, color: colors.card },
  rowDate: { fontFamily: fonts.monoRegular, fontSize: 12, color: colors.inkSoft },
});
