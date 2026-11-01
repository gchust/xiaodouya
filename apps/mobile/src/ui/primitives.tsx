import type { ReactNode } from 'react';
import { useEffect } from 'react';
import {
  ActivityIndicator,
  ImageBackground,
  Pressable,
  type PressableProps,
  type StyleProp,
  StyleSheet,
  Text,
  TextInput,
  type TextInputProps,
  type TextProps,
  type TextStyle,
  View,
  type ViewStyle,
} from 'react-native';
import Animated, {
  type AnimatedStyle,
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { colors, fonts, motion } from '../theme';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

type PressScaleProps = Omit<PressableProps, 'style'> & {
  scaleTo?: number;
  style?: StyleProp<AnimatedStyle<ViewStyle>>;
  children?: ReactNode;
};

/** 所有可点击卡片和按钮的按压反馈：缩到 0.95。 */
export function PressScale({
  scaleTo = 0.95,
  style,
  children,
  onPressIn,
  onPressOut,
  ...rest
}: PressScaleProps) {
  const scale = useSharedValue(1);
  const animated = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  return (
    <AnimatedPressable
      accessibilityRole="button"
      {...rest}
      onPressIn={(e) => {
        scale.value = withSpring(scaleTo, { damping: 20, stiffness: 400 });
        onPressIn?.(e);
      }}
      onPressOut={(e) => {
        scale.value = withSpring(1, { damping: 20, stiffness: 400 });
        onPressOut?.(e);
      }}
      style={[style, animated]}
    >
      {children}
    </AnimatedPressable>
  );
}

export function Body({ style, ...rest }: TextProps) {
  return <Text {...rest} style={[styles.body, style]} />;
}

export function Muted({ style, ...rest }: TextProps) {
  return <Text {...rest} style={[styles.muted, style]} />;
}

export function Mono({
  style,
  weight = 'regular',
  ...rest
}: TextProps & { weight?: 'regular' | 'medium' }) {
  return (
    <Text
      {...rest}
      style={[
        {
          fontFamily: weight === 'medium' ? fonts.monoMedium : fonts.monoRegular,
          color: colors.ink,
        },
        style,
      ]}
    />
  );
}

export function PageTitle({ style, ...rest }: TextProps) {
  return <Text accessibilityRole="header" {...rest} style={[styles.pageTitle, style]} />;
}

export function SectionTitle({ style, ...rest }: TextProps) {
  return <Text accessibilityRole="header" {...rest} style={[styles.sectionTitle, style]} />;
}

export function Serif({ style, ...rest }: TextProps) {
  return <Text {...rest} style={[styles.serif, style]} />;
}

export function Card({ style, children }: { style?: StyleProp<ViewStyle>; children: ReactNode }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

/** 列表型卡片（内边距 4/16，行之间有分隔线）。 */
export function ListCard({ children }: { children: ReactNode }) {
  return <View style={styles.listCard}>{children}</View>;
}

export function Row({
  label,
  value,
  last,
  onPress,
  testID,
  valueStyle,
  accessibilityLabel,
}: {
  label: string;
  value: ReactNode;
  last?: boolean;
  onPress?: () => void;
  testID?: string;
  valueStyle?: StyleProp<TextStyle>;
  accessibilityLabel?: string;
}) {
  const content = (
    <View style={[styles.kvRow, !last && styles.divider]}>
      <Muted style={styles.kvLabel}>{label}</Muted>
      {typeof value === 'string' ? (
        <Body style={[styles.kvValue, valueStyle]}>{value}</Body>
      ) : (
        value
      )}
    </View>
  );
  if (!onPress) return content;
  return (
    <Pressable
      onPress={onPress}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
    >
      {content}
    </Pressable>
  );
}

type ButtonTone = 'accent' | 'dark' | 'green' | 'outline' | 'ghost';

export function Button({
  label,
  onPress,
  tone = 'accent',
  disabled,
  busy,
  style,
  testID,
  height = 54,
  labelStyle,
}: {
  label: string;
  onPress: () => void;
  tone?: ButtonTone;
  disabled?: boolean;
  busy?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  height?: number;
  labelStyle?: StyleProp<TextStyle>;
}) {
  const tones: Record<ButtonTone, { bg: string; ink: string; border?: string }> = {
    accent: { bg: colors.accent, ink: colors.white },
    dark: { bg: colors.ink, ink: colors.paper },
    green: { bg: colors.green, ink: colors.white },
    outline: { bg: 'transparent', ink: colors.ink, border: colors.ink },
    ghost: { bg: 'transparent', ink: colors.muted },
  };
  const t = tones[tone];
  const inactive = disabled || busy;
  return (
    <PressScale
      testID={testID}
      accessibilityLabel={label}
      accessibilityState={{ disabled: Boolean(inactive), busy: Boolean(busy) }}
      disabled={inactive}
      onPress={onPress}
      scaleTo={0.97}
      style={[
        styles.button,
        { height, backgroundColor: t.bg, opacity: disabled ? 0.45 : 1 },
        t.border ? { borderWidth: 1, borderColor: t.border } : null,
        style,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={t.ink} />
      ) : (
        <Text style={[styles.buttonLabel, { color: t.ink }, labelStyle]}>{label}</Text>
      )}
    </PressScale>
  );
}

export function Chip({
  label,
  selected,
  onPress,
  testID,
  mono,
  style,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  testID?: string;
  mono?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      // 胶囊看起来只有 30 高；相邻胶囊间隔 8，左右只能各扩 4。
      hitSlop={{ top: 7, bottom: 7, left: 4, right: 4 }}
      onPress={onPress}
      style={[styles.chip, { backgroundColor: selected ? colors.ink : colors.paper }, style]}
    >
      <Text
        style={[
          styles.chipLabel,
          { color: selected ? colors.paper : colors.ink },
          mono ? { fontFamily: fonts.monoMedium } : null,
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export function Toggle({
  value,
  onChange,
  label,
  sub,
  last,
  testID,
  disabled,
}: {
  value: boolean;
  onChange: (next: boolean) => void;
  label: string;
  sub?: string;
  last?: boolean;
  testID?: string;
  disabled?: boolean;
}) {
  const position = useSharedValue(value ? 1 : 0);
  useEffect(() => {
    position.value = withTiming(value ? 1 : 0, { duration: 200 });
  }, [value, position]);
  const knob = useAnimatedStyle(() => ({ left: 3 + position.value * 16 }));
  const track = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(position.value, [0, 1], [colors.off, colors.accent]),
  }));
  return (
    <Pressable
      testID={testID}
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: value, disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={() => onChange(!value)}
      style={[styles.toggleRow, !last && styles.divider, disabled ? { opacity: 0.5 } : null]}
    >
      <View style={styles.toggleText}>
        <Body style={{ fontSize: 14 }}>{label}</Body>
        {sub ? <Muted style={{ fontSize: 11 }}>{sub}</Muted> : null}
      </View>
      <Animated.View style={[styles.track, track]}>
        <Animated.View style={[styles.knob, knob]} />
      </Animated.View>
    </Pressable>
  );
}

export function Field({
  label,
  mono,
  style,
  ...rest
}: TextInputProps & { label?: string; mono?: boolean }) {
  return (
    <View style={{ gap: 5 }}>
      {label ? <Muted style={{ fontSize: 12 }}>{label}</Muted> : null}
      <TextInput
        placeholderTextColor={colors.muted}
        selectionColor={colors.accent}
        accessibilityLabel={label ?? rest.placeholder}
        {...rest}
        style={[styles.field, mono ? { fontFamily: fonts.monoRegular, fontSize: 13 } : null, style]}
      />
    </View>
  );
}

/** 弹层里的无边框输入框。 */
export function SoftInput({ style, ...rest }: TextInputProps) {
  return (
    <TextInput
      placeholderTextColor={colors.muted}
      selectionColor={colors.accent}
      accessibilityLabel={rest.placeholder}
      {...rest}
      style={[styles.softInput, style]}
    />
  );
}

/** 图片还没加载出来时的条纹占位，也是整个 App 的视觉母题之一。 */
export function Stripes({
  style,
  children,
}: {
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
}) {
  return (
    <ImageBackground
      source={require('../../assets/stripes.png')}
      resizeMode="repeat"
      style={[styles.stripes, style]}
    >
      {children}
    </ImageBackground>
  );
}

export function Dot({
  color,
  size = 10,
  hollow,
}: {
  color: string;
  size?: number;
  hollow?: boolean;
}) {
  return (
    <View
      style={
        hollow
          ? {
              width: size,
              height: size,
              borderRadius: size / 2,
              borderWidth: 1.5,
              borderColor: color,
            }
          : { width: size, height: size, borderRadius: size / 2, backgroundColor: color }
      }
    />
  );
}

/** 空状态：一句温和的话，不用插画。 */
export function Empty({ title, sub }: { title: string; sub?: string }) {
  return (
    <View style={styles.empty}>
      <Serif style={styles.emptyTitle}>{title}</Serif>
      {sub ? <Muted style={styles.emptySub}>{sub}</Muted> : null}
    </View>
  );
}

export const styles = StyleSheet.create({
  body: { color: colors.ink, fontSize: 14 },
  muted: { color: colors.muted, fontSize: 12 },
  serif: { fontFamily: fonts.serifMedium, color: colors.ink, fontSize: 14, lineHeight: 24.5 },
  // 行高 31 比字体本身矮，下伸部分会超出文字框。内边距给它留位置，负外边距抵消，布局不变。
  pageTitle: {
    fontFamily: fonts.serifBold,
    fontSize: 26,
    lineHeight: 31,
    paddingBottom: 2,
    marginBottom: -2,
    color: colors.ink,
  },
  sectionTitle: { fontFamily: fonts.serifBold, fontSize: 15, color: colors.ink, lineHeight: 22 },
  card: {
    backgroundColor: colors.card,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 14,
    padding: 16,
  },
  listCard: {
    backgroundColor: colors.card,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 4,
  },
  divider: { borderBottomWidth: StyleSheet.hairlineWidth * 2, borderBottomColor: colors.rule },
  kvRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
    paddingVertical: 11,
    alignItems: 'center',
  },
  kvLabel: { fontSize: 13 },
  kvValue: { fontSize: 13, textAlign: 'right', flexShrink: 1 },
  button: { borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  buttonLabel: { fontSize: 16, fontWeight: '500' },
  chip: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999, alignItems: 'center' },
  chipLabel: { fontSize: 12 },
  toggleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 13,
  },
  toggleText: { flex: 1, gap: 2 },
  track: { width: 40, height: 24, borderRadius: 999 },
  knob: {
    position: 'absolute',
    top: 3,
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: colors.white,
    elevation: 2,
  },
  field: {
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 11,
    fontSize: 14,
    color: colors.ink,
  },
  softInput: {
    backgroundColor: colors.paper,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 13,
    fontSize: 14,
    color: colors.ink,
  },
  stripes: { overflow: 'hidden', backgroundColor: colors.line },
  empty: { paddingVertical: 48, paddingHorizontal: 22, alignItems: 'center', gap: 8 },
  emptyTitle: { fontSize: 16, fontFamily: fonts.serifBold, textAlign: 'center' },
  emptySub: { fontSize: 13, textAlign: 'center', lineHeight: 20 },
});

export { motion };
