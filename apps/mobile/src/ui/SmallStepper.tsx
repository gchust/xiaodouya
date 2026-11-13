import { t } from '@xiaodouya/shared';
import { Pressable, Text, View } from 'react-native';
import { colors, fonts, themedStyles } from '../theme';

/** 一行带标签的步进器：身高体重、亲喂的两侧时长。 */
export function SmallStepper({
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
        accessibilityLabel={t().records.labelDecrease(label)}
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
        accessibilityLabel={t().records.labelIncrease(label)}
        onPress={onInc}
        style={s.smallBtn}
      >
        <Text style={{ fontSize: 18, color: colors.ink }}>{t().records.plus}</Text>
      </Pressable>
    </View>
  );
}

const s = themedStyles(() => ({
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
}));
