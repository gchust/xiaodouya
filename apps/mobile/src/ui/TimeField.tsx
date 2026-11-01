import DateTimePicker from '@react-native-community/datetimepicker';
import {
  checkRecordTime,
  formatClock,
  formatFullDate,
  type RecordTimeCheck,
} from '@xiaodouya/shared';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useRecords } from '../lib/app';
import {
  isDaysAgo,
  resolveTimeChoice,
  type TimeChoice,
  withClock,
  withDate,
  withDaysAgo,
} from '../lib/dates';
import { colors, fonts } from '../theme';
import { Chip, Muted } from './primitives';

const HOUR = 3_600_000;

export const RECORD_OFFSETS = [
  { minutes: 0, label: '刚刚' },
  { minutes: 15, label: '15 分钟前' },
  { minutes: 30, label: '30 分钟前' },
  { minutes: 60, label: '1 小时前' },
] as const;

const DAY_CHIPS = [
  { daysAgo: 0, label: '今天' },
  { daysAgo: 1, label: '昨天' },
  { daysAgo: 2, label: '前天' },
] as const;

export interface RecordTime {
  choice: TimeChoice;
  setChoice: (next: TimeChoice) => void;
  /** 修改和补记只显示确定的时刻，偏移胶囊是给“刚发生”的记录用的。 */
  exactOnly: boolean;
  check: RecordTimeCheck;
  /** 保存时调用：“刚刚”要算到点保存的这一刻。 */
  resolve: () => number;
}

/**
 * 记录弹层的时间状态。`at` 是修改时的原值；`backfill` 是从补记入口进来，默认放在一小时前。
 * 原值即使在未来（别的手机时钟快）也不拦：用户没动时间，只是改个备注，不该被挡住。
 */
export function useRecordTime(
  options: { at?: number; backfill?: boolean; subject?: 'event' | 'memory' } = {},
): RecordTime {
  const { at, backfill, subject } = options;
  const birthAt = useRecords().baby?.data.birthAt;
  const [choice, setChoice] = useState<TimeChoice>(() =>
    at !== undefined
      ? { kind: 'exact', at }
      : backfill
        ? { kind: 'exact', at: Date.now() - HOUR }
        : { kind: 'offset', minutes: 0 },
  );
  const now = Date.now();
  return {
    choice,
    setChoice,
    exactOnly: at !== undefined || Boolean(backfill),
    check: checkRecordTime({
      at: resolveTimeChoice(choice, now),
      birthAt,
      now: Math.max(now, at ?? 0),
      subject,
    }),
    resolve: () => resolveTimeChoice(choice, Date.now()),
  };
}

/** 时间不对的提示。错误挡住保存，所以要比弹层里别的辅助文字醒目。 */
export function TimeCheckText({ check }: { check: RecordTimeCheck }) {
  if (check.error) {
    return (
      <Text testID="time-error" style={s.error}>
        {check.error.message}
      </Text>
    );
  }
  return check.notice ? (
    <Muted testID="time-notice" style={s.notice}>
      {check.notice}
    </Muted>
  ) : null;
}

/** 系统选择器要点好几下才能到昨天，而补记大多是这两天的事。 */
export function DayChips({
  testID,
  value,
  onChange,
}: {
  testID: string;
  value: number;
  onChange: (next: number) => void;
}) {
  const now = Date.now();
  return (
    <View style={s.chips}>
      {DAY_CHIPS.map((d) => (
        <Chip
          key={d.daysAgo}
          testID={`${testID}-day-${d.daysAgo}`}
          label={d.label}
          selected={isDaysAgo(value, d.daysAgo, now)}
          onPress={() => onChange(withDaysAgo(value, d.daysAgo, Date.now()))}
        />
      ))}
    </View>
  );
}

/** 一个具体的日期和时刻。 */
export function DateTimeRow({
  label,
  testID,
  value,
  onChange,
}: {
  label?: string;
  testID: string;
  value: number;
  onChange: (next: number) => void;
}) {
  const [picker, setPicker] = useState<'date' | 'time' | null>(null);
  return (
    <View style={{ gap: 8 }}>
      {label ? <Muted style={{ fontSize: 12 }}>{label}</Muted> : null}
      <View style={s.row}>
        <Pressable
          testID={`${testID}-date`}
          accessibilityRole="button"
          accessibilityLabel={`选择${label ?? ''}日期，现在是 ${formatFullDate(value)}`}
          onPress={() => setPicker('date')}
          style={s.button}
        >
          <Text style={s.buttonText}>{formatFullDate(value)}</Text>
        </Pressable>
        <Pressable
          testID={`${testID}-clock`}
          accessibilityRole="button"
          accessibilityLabel={`选择${label ?? ''}时刻，现在是 ${formatClock(value)}`}
          onPress={() => setPicker('time')}
          style={s.button}
        >
          <Text style={s.buttonText}>{formatClock(value)}</Text>
        </Pressable>
      </View>
      <DayChips testID={testID} value={value} onChange={onChange} />
      {picker ? (
        <DateTimePicker
          value={new Date(value)}
          mode={picker}
          is24Hour
          // 只管得了日期：系统的时刻选择器不支持上限，今天选到未来的时刻靠 checkRecordTime。
          maximumDate={picker === 'date' ? new Date() : undefined}
          onChange={(event, date) => {
            setPicker(null);
            if (event.type !== 'set' || !date) return;
            onChange(
              picker === 'date' ? withDate(value, date, Date.now()) : withClock(value, date),
            );
          }}
        />
      ) : null}
    </View>
  );
}

/**
 * 记录弹层最上面的时间。新记录默认“刚刚”，一下都不用多点；
 * 选“更早”才展开具体的日期和时刻，所以日常记录的路径不变。
 */
export function RecordTimeField({
  time,
  offsets = RECORD_OFFSETS,
}: {
  time: RecordTime;
  offsets?: readonly { minutes: number; label: string }[];
}) {
  const { choice, setChoice, exactOnly, check } = time;
  const exact = choice.kind === 'exact';
  return (
    <>
      {exactOnly ? null : (
        <View style={s.chips}>
          {offsets.map((o) => (
            <Chip
              key={o.minutes}
              testID={`offset-${o.minutes}`}
              label={o.label}
              selected={choice.kind === 'offset' && choice.minutes === o.minutes}
              onPress={() => setChoice({ kind: 'offset', minutes: o.minutes })}
            />
          ))}
          <Chip
            testID="offset-custom"
            label="更早"
            selected={exact}
            onPress={() => {
              if (!exact) setChoice({ kind: 'exact', at: Date.now() - 2 * HOUR });
            }}
          />
        </View>
      )}
      {choice.kind === 'exact' ? (
        <DateTimeRow
          testID="time"
          value={choice.at}
          onChange={(at) => setChoice({ kind: 'exact', at })}
        />
      ) : null}
      <TimeCheckText check={check} />
    </>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', gap: 8 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  button: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 13,
  },
  buttonText: { fontFamily: fonts.monoRegular, fontSize: 14, color: colors.ink },
  error: { fontSize: 13, lineHeight: 20, color: colors.danger },
  notice: { fontSize: 12, lineHeight: 19, color: colors.accent },
});
