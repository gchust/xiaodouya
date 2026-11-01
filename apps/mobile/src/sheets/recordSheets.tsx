import {
  ageParts,
  assessTemperature,
  describeEvent,
  type EventData,
  estimateNextFeed,
  feedAmountChips,
  medicineSuggestions,
  nextVaccine,
  vaccineStatuses,
} from '@xiaodouya/shared';
import * as Haptics from 'expo-haptics';
import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useApp, useRecords } from '../lib/app';
import { colors, fonts } from '../theme';
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
  const { me, label } = app;
  return useCallback(
    async (event: EventData, id?: string) => {
      const data: EventData = { ...event, byName: event.byName ?? label };
      const recordId = await app.write('event', data, id);
      sheet.close();
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      const others = (me?.members ?? []).filter((m) => m.userId !== me?.user.id);
      const suffix = others.length === 1 ? ` · 已同步给${others[0]?.label}` : '';
      toast(`已记录 · ${describeEvent(data, Date.now())}${suffix}`, {
        undo: id ? undefined : () => void app.remove(recordId),
      });
    },
    [app, sheet, toast, me, label],
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
  const [ml, setMl] = useState(initial?.ml ?? last?.ml ?? 90);
  const [note, setNote] = useState(initial?.note ?? '');
  const [offset, setOffset] = useState(0);
  return (
    <>
      {id ? null : <TimeOffsets value={offset} onChange={setOffset} />}
      <Stepper
        testPrefix="ml"
        value={String(ml)}
        unit="ml"
        onDec={() => setMl((v) => Math.max(10, v - 10))}
        onInc={() => setMl((v) => Math.min(1000, v + 10))}
      />
      <View style={s.mlChips}>
        {feedAmountChips.map((v) => {
          const on = ml === v;
          return (
            <Pressable
              key={v}
              testID={`ml-chip-${v}`}
              accessibilityRole="button"
              accessibilityLabel={`${v} 毫升`}
              accessibilityState={{ selected: on }}
              onPress={() => setMl(v)}
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
              ml,
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

export function MoreSheet({ birthAt }: { birthAt: number }) {
  const sheet = useSheet();
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
          style={[s.moreItem, { opacity: item.onPress ? 1 : 0.5 }]}
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
  const [c, setC] = useState(36.8);
  const [offset, setOffset] = useState(0);
  const assessment = assessTemperature(c, ageParts(birthAt, Date.now()).months);
  const tone =
    assessment.level === 'fever' || assessment.level === 'urgent'
      ? colors.danger
      : assessment.level === 'elevated'
        ? colors.accent
        : colors.ink;
  const step = (delta: number) =>
    setC((v) => Math.min(45, Math.max(30, Math.round((v + delta) * 10) / 10)));
  return (
    <>
      <TimeOffsets value={offset} onChange={setOffset} />
      <Stepper
        testPrefix="temp"
        value={c.toFixed(1)}
        unit="℃"
        color={tone}
        onDec={() => step(-0.1)}
        onInc={() => step(0.1)}
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
            celsius: c,
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
  const [offset, setOffset] = useState(0);
  return (
    <>
      <TimeOffsets value={offset} onChange={setOffset} />
      <Muted style={{ fontSize: 13, lineHeight: 21 }}>
        水温 37–40℃，用手肘试一下不烫就好。洗完先擦干脐部和皮肤褶皱。
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
  const [w, setW] = useState(latest?.weightKg ?? baby?.data.birthWeightKg ?? 3.4);
  const [h, setH] = useState(latest?.lengthCm ?? baby?.data.birthLengthCm ?? 50);
  const round = (v: number) => Math.round(v * 10) / 10;
  return (
    <>
      <SmallStepper
        testPrefix="weight"
        label="体重"
        value={w.toFixed(1)}
        unit="kg"
        onDec={() => setW((v) => Math.max(0.5, round(v - 0.1)))}
        onInc={() => setW((v) => Math.min(100, round(v + 0.1)))}
      />
      <SmallStepper
        testPrefix="length"
        label="身长"
        value={h.toFixed(1)}
        unit="cm"
        onDec={() => setH((v) => Math.max(25, round(v - 0.5)))}
        onInc={() => setH((v) => Math.min(250, round(v + 0.5)))}
      />
      <Button
        testID="growth-save"
        label="记录"
        onPress={() => void save({ type: 'growth', at: Date.now(), weightKg: w, lengthCm: h })}
      />
    </>
  );
}

export function VaccineSheet({ birthAt, preselect }: { birthAt: number; preselect?: string }) {
  const { events } = useRecords();
  const save = useSaveEvent();
  const statuses = vaccineStatuses(
    birthAt,
    events.map((e) => e.data),
    Date.now(),
  );
  const pending = statuses.filter((v) => v.state !== 'done');
  const [selected, setSelected] = useState(preselect ?? nextVaccine(statuses)?.id ?? '');
  const dose = pending.find((v) => v.id === selected);
  return (
    <>
      <View style={{ gap: 8 }}>
        {pending.map((v) => {
          const on = selected === v.id;
          return (
            <Pressable
              key={v.id}
              testID={`vaccine-${v.id}`}
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
      </View>
      <Muted style={{ fontSize: 11, lineHeight: 18 }}>
        按新加坡国家儿童免疫计划排列，以诊所安排和健康手册为准。
      </Muted>
      <Button
        testID="vaccine-save"
        tone="green"
        label="已接种"
        disabled={!dose}
        onPress={() =>
          dose
            ? void save({ type: 'vaccine', at: Date.now(), vaccineId: dose.id, name: dose.name })
            : undefined
        }
      />
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
  bigNumber: { fontSize: 52, lineHeight: 60 },
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
  moreGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  moreItem: {
    width: '31.5%',
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
