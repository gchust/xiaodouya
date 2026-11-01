import {
  ageParts,
  assessDayNutrition,
  type EventData,
  formatFullDate,
  formatNutrientAmount,
  formatVolume,
  formulaDataGaps,
  type NutrientResult,
  type NutrientStatus,
  nutrientMeta,
} from '@xiaodouya/shared';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNow, useRecords, useRegion, useUnits } from '../lib/app';
import { localDayBounds } from '../lib/dates';
import { AddFormulaFlow, FormulaEditor } from '../sheets/formulaSheets';
import { colors, spacing } from '../theme';
import { useSheet } from '../ui/overlays';
import { ListCard, Mono, Muted, PageTitle, SectionTitle } from '../ui/primitives';

/** 只回看一周：更早的记录一天天翻没有用，也不想让人盯着过去的数字。 */
const DAYS_BACK = 6;

const STATUS_COLORS: Record<NutrientStatus, string> = {
  progress: colors.inkSoft,
  met: colors.green,
  below: colors.accent,
  insufficient: colors.muted,
  'no-reference': colors.muted,
};

export function NutritionScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const sheet = useSheet();
  const { events, baby, formulas } = useRecords();
  const region = useRegion();
  const units = useUnits();
  useNow(60_000);
  const now = Date.now();
  const [back, setBack] = useState(0);
  if (!baby) return null;

  const { start, end } = localDayBounds(now, -back);
  const day = assessDayNutrition({
    events: events.map((e): EventData => e.data),
    dayStart: start,
    dayEnd: end,
    now,
    ageMonths: ageParts(baby.data.birthAt, Math.min(now, end - 1)).months,
    reference: region.nutrition,
  });
  const anyBelow = day.nutrients.some((n) => n.status === 'below');

  return (
    <ScrollView
      testID="nutrition-screen"
      style={s.root}
      contentContainerStyle={[
        s.content,
        { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 32 },
      ]}
      showsVerticalScrollIndicator={false}
    >
      <View style={{ gap: 6, alignItems: 'flex-start' }}>
        <Pressable
          testID="nutrition-back"
          accessibilityRole="button"
          accessibilityLabel="返回今天"
          hitSlop={12}
          onPress={() => router.back()}
        >
          <Text style={s.back}>‹ 今天</Text>
        </Pressable>
        <PageTitle>奶粉营养</PageTitle>
      </View>

      <View style={s.dayRow}>
        <Pressable
          testID="nutrition-prev"
          accessibilityRole="button"
          accessibilityLabel="前一天"
          accessibilityState={{ disabled: back >= DAYS_BACK }}
          disabled={back >= DAYS_BACK}
          hitSlop={12}
          onPress={() => setBack((v) => v + 1)}
        >
          <Text style={[s.dayArrow, back >= DAYS_BACK ? s.dayArrowOff : null]}>‹</Text>
        </Pressable>
        <Text style={s.dayLabel} testID="nutrition-day">
          {back === 0 ? '今天' : back === 1 ? '昨天' : formatFullDate(start)}
        </Text>
        <Pressable
          testID="nutrition-next"
          accessibilityRole="button"
          accessibilityLabel="后一天"
          accessibilityState={{ disabled: back === 0 }}
          disabled={back === 0}
          hitSlop={12}
          onPress={() => setBack((v) => v - 1)}
        >
          <Text style={[s.dayArrow, back === 0 ? s.dayArrowOff : null]}>›</Text>
        </Pressable>
      </View>

      {day.reasons.length > 0 ? (
        <View style={s.reasons} testID="nutrition-reasons">
          <Text style={s.reasonsLabel}>
            {day.nutrients.some((n) => n.status === 'insufficient') ? '数据不足' : '说明'}
          </Text>
          {day.reasons.map((reason) => (
            <Text key={reason} style={s.reasonText}>
              {reason}
            </Text>
          ))}
        </View>
      ) : null}

      <ListCard>
        {day.nutrients.map((nutrient, index) => (
          <NutrientRow
            key={nutrient.key}
            nutrient={nutrient}
            last={index === day.nutrients.length - 1}
          />
        ))}
      </ListCard>

      <View style={{ gap: 6 }}>
        <Muted style={s.note}>
          按记下的奶量和奶粉标签估算，算进去 {day.countedFeeds} 次、
          {formatVolume(day.countedMl, units.volume)}，不知道宝宝有没有喝完，也不含辅食和补充剂。
        </Muted>
        {anyBelow ? (
          <Muted style={s.note}>
            参考量不是每个宝宝的目标。连续几天都低于参考量，或者有担心，可以问问医生。
          </Muted>
        ) : null}
        <Muted style={s.note} testID="nutrition-disclaimer">
          估算，不能替代医生建议。早产或有特殊情况的宝宝，请听医生的。
        </Muted>
        <Muted style={s.note} testID="nutrition-source">
          参考量：{region.nutrition.table.name}。
          {region.nutrition.note ? `${region.nutrition.note}。` : ''}
        </Muted>
      </View>

      <View style={{ gap: 10 }}>
        <View style={s.sectionHead}>
          <SectionTitle>家里的奶粉</SectionTitle>
          <Pressable
            testID="nutrition-add-formula"
            accessibilityRole="button"
            accessibilityLabel="添加奶粉"
            hitSlop={8}
            onPress={() =>
              sheet.open('添加奶粉', () => <AddFormulaFlow onDone={() => sheet.close()} />)
            }
          >
            <Text style={s.add}>＋ 添加</Text>
          </Pressable>
        </View>
        {formulas.length === 0 ? (
          <Muted style={s.note}>还没有配置奶粉。添加后，记喂奶时选上，这里就能估算。</Muted>
        ) : (
          <ListCard>
            {formulas.map((formula, index) => {
              const gaps = formulaDataGaps(formula.data);
              const allMissing = gaps.missing.length === Object.keys(nutrientMeta).length;
              const sub = gaps.needsRatio
                ? '还缺冲调比例，算不出来'
                : allMissing
                  ? '还没有营养数据，请对照罐身录入'
                  : gaps.missing.length > 0
                    ? `还缺 ${gaps.missing.map((key) => nutrientMeta[key].label).join('、')}`
                    : '以罐身标签为准';
              return (
                <Pressable
                  key={formula.id}
                  testID={`formula-row-${formula.data.name}`}
                  accessibilityRole="button"
                  accessibilityLabel={`修改 ${formula.data.name}`}
                  onPress={() =>
                    sheet.open('修改奶粉', () => (
                      <FormulaEditor
                        id={formula.id}
                        existing={formula.data}
                        onDone={() => sheet.close()}
                      />
                    ))
                  }
                  style={[s.formulaRow, index < formulas.length - 1 ? s.divider : null]}
                >
                  <Text style={s.formulaName}>{formula.data.name}</Text>
                  <Muted>{sub}</Muted>
                </Pressable>
              );
            })}
          </ListCard>
        )}
      </View>
    </ScrollView>
  );
}

function NutrientRow({ nutrient, last }: { nutrient: NutrientResult; last: boolean }) {
  const { key, amount, target, percent, status, text, note } = nutrient;
  const fill = percent === null ? 0 : Math.min(percent, 100);
  return (
    <View style={[s.row, last ? null : s.divider]} testID={`nutrient-${key}`}>
      <View style={s.rowTop}>
        <Text style={s.rowLabel}>{nutrientMeta[key].label}</Text>
        <Text
          style={[s.rowStatus, { color: STATUS_COLORS[status] }]}
          testID={`nutrient-${key}-status`}
        >
          {text}
        </Text>
      </View>
      <Mono style={s.rowAmount}>
        {formatNutrientAmount(key, amount)}
        {target ? ` / 参考 ${formatNutrientAmount(key, target.amount)}` : ''}
      </Mono>
      {target ? (
        <View style={s.track}>
          <View
            style={[
              s.bar,
              {
                width: `${fill}%`,
                backgroundColor: status === 'met' ? colors.green : colors.accent,
                opacity: status === 'insufficient' ? 0.35 : 1,
              },
            ]}
          />
        </View>
      ) : null}
      {note ? <Muted style={{ fontSize: 11 }}>{note}</Muted> : null}
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.paper },
  content: { paddingHorizontal: spacing.page, gap: 16 },
  back: { fontSize: 14, color: colors.muted, padding: 4, marginLeft: -4 },
  dayRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  dayArrow: { fontSize: 24, lineHeight: 28, color: colors.ink, paddingHorizontal: 8 },
  dayArrowOff: { color: colors.hint },
  dayLabel: { fontSize: 14, color: colors.ink },
  reasons: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: colors.sand,
    gap: 4,
  },
  reasonsLabel: { fontSize: 11, color: colors.accent, letterSpacing: 0.7 },
  reasonText: { fontSize: 13, lineHeight: 20, color: colors.ink },
  row: { paddingVertical: 11, gap: 5 },
  divider: { borderBottomWidth: 1, borderBottomColor: colors.rule },
  rowTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    gap: 8,
  },
  rowLabel: { fontSize: 14, color: colors.ink },
  rowStatus: { fontSize: 12 },
  rowAmount: { fontSize: 12, color: colors.muted },
  track: { height: 4, borderRadius: 999, backgroundColor: colors.line, overflow: 'hidden' },
  bar: { height: 4, borderRadius: 999 },
  note: { fontSize: 11, lineHeight: 17 },
  sectionHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  add: { fontSize: 13, color: colors.accent },
  formulaRow: { paddingVertical: 11, gap: 2 },
  formulaName: { fontSize: 14, color: colors.ink },
});
