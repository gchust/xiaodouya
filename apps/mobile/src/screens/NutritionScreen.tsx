import {
  ageParts,
  assessDayNutrition,
  type EventData,
  formatFullDate,
  formatVolume,
  formulaDataGaps,
  type NutrientResult,
  type NutrientStatus,
  nutrientAmountText,
  nutrientMeta,
  t,
} from '@xiaodouya/shared';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNow, useRecords, useRegion, useUnits } from '../lib/app';
import { localDayBounds } from '../lib/dates';
import { AddFormulaFlow, FormulaEditor } from '../sheets/formulaSheets';
import { colors, spacing, themedStyles } from '../theme';
import { useSheet } from '../ui/overlays';
import { ListCard, Mono, Muted, PageTitle, SectionTitle } from '../ui/primitives';

/** 只回看一周：更早的记录一天天翻没有用，也不想让人盯着过去的数字。 */
const DAYS_BACK = 6;

// 低于参考量用提醒色（warn），不跟主题变：不能因为换了主题就看不出来。
const statusColor = (status: NutrientStatus): string =>
  ({
    progress: colors.inkSoft,
    met: colors.greenText,
    below: colors.warnText,
    insufficient: colors.muted,
    'no-reference': colors.muted,
  })[status];

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
          accessibilityLabel={t().today.backToToday}
          hitSlop={12}
          onPress={() => router.back()}
        >
          <Text style={s.back}>{t().today.backTodayLink}</Text>
        </Pressable>
        <PageTitle>{t().today.nutrition}</PageTitle>
      </View>

      <View style={s.dayRow}>
        <Pressable
          testID="nutrition-prev"
          accessibilityRole="button"
          accessibilityLabel={t().nutritionUi.prevDay}
          accessibilityState={{ disabled: back >= DAYS_BACK }}
          disabled={back >= DAYS_BACK}
          hitSlop={12}
          onPress={() => setBack((v) => v + 1)}
        >
          <Text style={[s.dayArrow, back >= DAYS_BACK ? s.dayArrowOff : null]}>‹</Text>
        </Pressable>
        <Text style={s.dayLabel} testID="nutrition-day">
          {back === 0 ? t().ui.today : back === 1 ? t().ui.yesterday : formatFullDate(start)}
        </Text>
        <Pressable
          testID="nutrition-next"
          accessibilityRole="button"
          accessibilityLabel={t().nutritionUi.nextDay}
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
            {day.nutrients.some((n) => n.status === 'insufficient')
              ? t().nutritionUi.insufficient
              : t().nutritionUi.note}
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
          {t().nutritionUi.estimate(day.countedFeeds, formatVolume(day.countedMl, units.volume))}
        </Muted>
        {anyBelow ? <Muted style={s.note}>{t().nutritionUi.refNote}</Muted> : null}
        <Muted style={s.note} testID="nutrition-disclaimer">
          {t().nutritionUi.disclaimer}
        </Muted>
        <Muted style={s.note} testID="nutrition-source">
          {t().nutritionUi.reference(
            region.nutrition.table.name,
            region.nutrition.note ? t().nutritionUi.referenceNote(region.nutrition.note) : '',
          )}
        </Muted>
      </View>

      <View style={{ gap: 10 }}>
        <View style={s.sectionHead}>
          <SectionTitle>{t().nutritionUi.familyFormulas}</SectionTitle>
          <Pressable
            testID="nutrition-add-formula"
            accessibilityRole="button"
            accessibilityLabel={t().records.addFormula}
            hitSlop={8}
            onPress={() =>
              sheet.open(t().records.addFormula, () => (
                <AddFormulaFlow onDone={() => sheet.close()} />
              ))
            }
          >
            <Text style={s.add}>{t().nutritionUi.addLink}</Text>
          </Pressable>
        </View>
        {formulas.length === 0 ? (
          <Muted style={s.note}>{t().nutritionUi.noFormula}</Muted>
        ) : (
          <ListCard>
            {formulas.map((formula, index) => {
              const gaps = formulaDataGaps(formula.data);
              const allMissing = gaps.missing.length === Object.keys(nutrientMeta).length;
              const sub = gaps.needsRatio
                ? t().nutritionUi.missingRatio
                : allMissing
                  ? t().nutritionUi.noData
                  : gaps.missing.length > 0
                    ? t().nutritionUi.missing(
                        gaps.missing
                          .map((key) => nutrientMeta[key].label)
                          .join(t().nutritionUi.listSep),
                      )
                    : t().nutritionUi.labelPrecedence;
              return (
                <Pressable
                  key={formula.id}
                  testID={`formula-row-${formula.data.name}`}
                  accessibilityRole="button"
                  accessibilityLabel={t().nutritionUi.editNamed(formula.data.name)}
                  onPress={() =>
                    sheet.open(t().nutritionUi.editFormula, () => (
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
  const { key, target, percent, status, text, note } = nutrient;
  const fill = percent === null ? 0 : Math.min(percent, 100);
  return (
    <View style={[s.row, last ? null : s.divider]} testID={`nutrient-${key}`}>
      <View style={s.rowTop}>
        <Text style={s.rowLabel}>{nutrientMeta[key].label}</Text>
        <Text
          style={[s.rowStatus, { color: statusColor(status) }]}
          testID={`nutrient-${key}-status`}
        >
          {text}
        </Text>
      </View>
      <Mono style={s.rowAmount}>{nutrientAmountText(nutrient)}</Mono>
      {target ? (
        <View style={s.track}>
          <View
            style={[
              s.bar,
              {
                width: `${fill}%`,
                backgroundColor: status === 'met' ? colors.green : colors.warn,
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

const s = themedStyles(() => ({
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
  reasonsLabel: { fontSize: 11, color: colors.accentText, letterSpacing: 0.7 },
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
  add: { fontSize: 13, color: colors.accentText },
  formulaRow: { paddingVertical: 11, gap: 2 },
  formulaName: { fontSize: 14, color: colors.ink },
}));
