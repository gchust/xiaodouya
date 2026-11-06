import DateTimePicker from '@react-native-community/datetimepicker';
import { formatClock, formatFullDate, t } from '@xiaodouya/shared';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { colors, fonts, themedStyles } from '../theme';
import { Muted } from './primitives';

/** 出生日期和时刻：建档页和资料页共用。 */
export function BirthPicker({ value, onChange }: { value: Date; onChange: (next: Date) => void }) {
  const [picker, setPicker] = useState<'date' | 'time' | null>(null);
  return (
    <>
      <View style={{ gap: 5 }}>
        <Muted style={{ fontSize: 12 }}>{t().ui.birthTime}</Muted>
        <View style={s.row}>
          <Pressable
            testID="birth-date"
            accessibilityRole="button"
            accessibilityLabel={t().ui.pickBirthDate}
            onPress={() => setPicker('date')}
            style={s.button}
          >
            <Text style={s.text}>{formatFullDate(value.getTime())}</Text>
          </Pressable>
          <Pressable
            testID="birth-time"
            accessibilityRole="button"
            accessibilityLabel={t().ui.pickBirthClock}
            onPress={() => setPicker('time')}
            style={s.button}
          >
            <Text style={s.text}>{formatClock(value.getTime())}</Text>
          </Pressable>
        </View>
      </View>
      {picker ? (
        <DateTimePicker
          value={value}
          mode={picker}
          is24Hour
          maximumDate={picker === 'date' ? new Date() : undefined}
          onChange={(_event, date) => {
            setPicker(null);
            if (date) onChange(date);
          }}
        />
      ) : null}
    </>
  );
}

/** 只选日期，不能选未来。用于补记接种：很多家庭是孩子出生后才开始用的。 */
export function PastDatePicker({
  label,
  testID,
  value,
  onChange,
}: {
  label: string;
  testID: string;
  value: Date;
  onChange: (next: Date) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <View style={{ gap: 5 }}>
        <Muted style={{ fontSize: 12 }}>{label}</Muted>
        <Pressable
          testID={testID}
          accessibilityRole="button"
          accessibilityLabel={t().ui.pickNamed(label)}
          onPress={() => setOpen(true)}
          style={s.button}
        >
          <Text style={s.text}>{formatFullDate(value.getTime())}</Text>
        </Pressable>
      </View>
      {open ? (
        <DateTimePicker
          value={value}
          mode="date"
          maximumDate={new Date()}
          onChange={(_event, date) => {
            setOpen(false);
            if (date) onChange(date);
          }}
        />
      ) : null}
    </>
  );
}

const s = themedStyles(() => ({
  row: { flexDirection: 'row', gap: 8 },
  button: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 13,
  },
  text: { fontFamily: fonts.monoRegular, fontSize: 14, color: colors.ink },
}));
