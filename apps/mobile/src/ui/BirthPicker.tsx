import DateTimePicker from '@react-native-community/datetimepicker';
import { formatClock, formatFullDate } from '@xiaodouya/shared';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, fonts } from '../theme';
import { Muted } from './primitives';

/** 出生日期和时刻：建档页和资料页共用。 */
export function BirthPicker({ value, onChange }: { value: Date; onChange: (next: Date) => void }) {
  const [picker, setPicker] = useState<'date' | 'time' | null>(null);
  return (
    <>
      <View style={{ gap: 5 }}>
        <Muted style={{ fontSize: 12 }}>出生时间</Muted>
        <View style={s.row}>
          <Pressable
            testID="birth-date"
            accessibilityRole="button"
            accessibilityLabel="选择出生日期"
            onPress={() => setPicker('date')}
            style={s.button}
          >
            <Text style={s.text}>{formatFullDate(value.getTime())}</Text>
          </Pressable>
          <Pressable
            testID="birth-time"
            accessibilityRole="button"
            accessibilityLabel="选择出生时刻"
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

const s = StyleSheet.create({
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
});
