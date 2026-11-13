import {
  type EventData,
  formatMonthDay,
  formatShortDate,
  formatTemperature,
  formatVolume,
  type TrendDay,
  type TrendRange,
  t,
  toDisplay,
  trendAverage,
  trendDays,
} from '@xiaodouya/shared';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNow, useRecords, useUnits } from '../lib/app';
import { colors, fonts, spacing, themedStyles } from '../theme';
import { Card, Chip, Dot, Empty, Mono, Muted, PageTitle } from '../ui/primitives';

const RANGES: readonly TrendRange[] = [7, 30];
/** 今天没过完，柱子画浅一些，不能和完整的一天放在一起比。 */
const PARTIAL_OPACITY = 0.5;
const HOUR = 3_600_000;

const hours = (ms: number) => (ms / HOUR).toFixed(1);
const oneDecimal = (n: number) => String(Math.round(n * 10) / 10);
const minutes = (ms: number) => String(Math.round(ms / 60_000));

/** 几天前，今天是 0。testID 用它，和日期、语言都无关。 */
const backOf = (days: readonly TrendDay[], index: number) => days.length - 1 - index;

function dayName(day: TrendDay): string {
  return day.partial ? t().trends.today : formatShortDate(day.start);
}

export function TrendsScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { events } = useRecords();
  const units = useUnits();
  useNow(60_000);
  const now = Date.now();
  const [range, setRange] = useState<TrendRange>(7);

  const days = trendDays(
    events.map((e): EventData => e.data),
    now,
    range,
  );
  const first = days[0];
  const last = days[days.length - 1];
  const hasFeed = days.some((d) => d.feeds > 0);
  const hasSleep = days.some((d) => d.sleepMs !== null);
  const hasDiaper = days.some((d) => d.diapers > 0);
  const tempDays = days.filter((d) => d.temps.length > 0).reverse();
  const empty = !hasFeed && !hasSleep && !hasDiaper && tempDays.length === 0;
  const wide = range === 7;

  return (
    <ScrollView
      testID="trends-screen"
      style={s.root}
      contentContainerStyle={[
        s.content,
        { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 32 },
      ]}
      showsVerticalScrollIndicator={false}
    >
      <View style={{ gap: 6, alignItems: 'flex-start' }}>
        <Pressable
          testID="trends-back"
          accessibilityRole="button"
          accessibilityLabel={t().today.backToToday}
          hitSlop={12}
          onPress={() => router.back()}
        >
          <Text style={s.back}>{t().today.backTodayLink}</Text>
        </Pressable>
        <PageTitle>{t().trends.title}</PageTitle>
      </View>

      <View style={s.rangeRow}>
        <View style={s.chips}>
          {RANGES.map((value) => (
            <Chip
              key={value}
              testID={`trends-range-${value}`}
              label={t().trends.range(value)}
              selected={range === value}
              onPress={() => setRange(value)}
              mono
            />
          ))}
        </View>
        {first && last ? (
          <Muted testID="trends-dates">
            {t().trends.dates(formatShortDate(first.start), formatShortDate(last.start))}
          </Muted>
        ) : null}
      </View>
      <Muted style={s.note}>{t().trends.note}</Muted>

      {empty ? (
        <Empty title={t().trends.empty} sub={t().trends.emptySub} />
      ) : (
        <>
          <Card style={s.card}>
            <CardTitle color={colors.feed} title={t().trends.feed} />
            <Metric
              id="trend-feed-count"
              label={t().trends.feedCount}
              days={days}
              wide={wide}
              color={colors.feed}
              pick={(d) => (d.feeds > 0 ? d.feeds : null)}
              format={String}
              average={(n) => t().trends.feedTimes(oneDecimal(n))}
            />
            <Metric
              id="trend-feed-ml"
              label={t().trends.feedAmount(units.volume)}
              days={days}
              wide={wide}
              color={colors.feed}
              pick={(d) => d.ml}
              format={(ml) => String(toDisplay('volume', ml, units.volume))}
              average={(ml) => formatVolume(ml, units.volume)}
            />
            {/* 这段时间没有亲喂的家庭不画一排全是“–”的空图。 */}
            {days.some((d) => d.nursingMs !== null) ? (
              <Metric
                id="trend-feed-nursing"
                label={t().trends.nursingDuration}
                days={days}
                wide={wide}
                color={colors.feed}
                pick={(d) => d.nursingMs}
                format={minutes}
                average={(ms) => t().trends.nursingMinutes(minutes(ms))}
              />
            ) : null}
            <Axis days={days} wide={wide} />
            {days.some((d) => d.feeds > d.amountFeeds) ? (
              <Muted style={s.note} testID="trend-amount-note">
                {t().trends.amountNote}
              </Muted>
            ) : null}
          </Card>

          <Card style={s.card}>
            <CardTitle color={colors.sleep} title={t().trends.sleep} />
            <Metric
              id="trend-sleep"
              label={t().trends.sleepTotal}
              days={days}
              wide={wide}
              color={colors.sleep}
              pick={(d) => d.sleepMs}
              format={hours}
              average={(ms) => t().trends.sleepHours(hours(ms))}
            />
            <Axis days={days} wide={wide} />
            <Text style={[s.metricLabel, { marginTop: 6 }]}>{t().trends.sleepRhythm}</Text>
            <Rhythm days={days} wide={wide} />
            {wide ? null : <Muted style={s.note}>{t().trends.rhythmOrder}</Muted>}
          </Card>

          <Card style={s.card}>
            <CardTitle color={colors.diaper} title={t().trends.diaper} />
            <Metric
              id="trend-wee"
              label={t().trends.wee}
              days={days}
              wide={wide}
              color={colors.wee}
              pick={(d) => (d.diapers > 0 ? d.wee : null)}
              format={String}
              average={(n) => t().trends.feedTimes(oneDecimal(n))}
            />
            <Metric
              id="trend-poo"
              label={t().trends.poo}
              days={days}
              wide={wide}
              color={colors.poo}
              pick={(d) => (d.diapers > 0 ? d.poo : null)}
              format={String}
              average={(n) => t().trends.feedTimes(oneDecimal(n))}
            />
            <Axis days={days} wide={wide} />
            <Muted style={s.note}>{t().trends.bothNote}</Muted>
          </Card>

          {tempDays.length > 0 ? (
            <Card style={s.card}>
              <View testID="trend-temp">
                <CardTitle color={colors.temp} title={t().trends.temp} />
              </View>
              {tempDays.map((day, index) => {
                const id = `trend-temp-${backOf(days, days.indexOf(day))}`;
                return (
                  <View
                    key={day.start}
                    style={[s.tempRow, index < tempDays.length - 1 ? s.divider : null]}
                    testID={id}
                  >
                    <Text style={s.tempDate}>{dayName(day)}</Text>
                    {/* 中文在等宽字体里会被拉开，只有温度用等宽。 */}
                    <Text style={s.tempValue} testID={`${id}-value`}>
                      {t().trends.tempHigh}{' '}
                      <Text style={s.tempNumber}>
                        {formatTemperature(Math.max(...day.temps), units.temperature)}
                      </Text>
                      {` · ${t().trends.tempCount(day.temps.length)}`}
                    </Text>
                  </View>
                );
              })}
              <Muted style={s.note}>{t().trends.tempNote}</Muted>
            </Card>
          ) : null}
        </>
      )}
    </ScrollView>
  );
}

function CardTitle({ color, title }: { color: string; title: string }) {
  return (
    <View style={s.cardTitle}>
      <Dot color={color} size={8} />
      <Text accessibilityRole="header" style={s.cardTitleText}>
        {title}
      </Text>
    </View>
  );
}

const CHART_HEIGHT = { wide: 64, narrow: 48 } as const;

/**
 * 一项指标：标题、日均、每天一根柱子。没有记录的天不画柱子，7 天时写 “–”，不写 0：
 * 没记不等于没吃没睡。
 */
function Metric({
  id,
  label,
  days,
  wide,
  color,
  pick,
  format,
  average,
}: {
  id: string;
  label: string;
  days: readonly TrendDay[];
  wide: boolean;
  color: string;
  pick: (day: TrendDay) => number | null;
  format: (value: number) => string;
  average: (value: number) => string;
}) {
  const values = days.map(pick);
  const max = Math.max(0, ...values.map((v) => v ?? 0));
  const avg = trendAverage(days, pick);
  const height = wide ? CHART_HEIGHT.wide : CHART_HEIGHT.narrow;
  return (
    <View style={{ gap: 6 }}>
      <View style={s.metricHead}>
        <Text style={s.metricLabel}>{label}</Text>
        {avg ? (
          <Muted style={s.metricAverage} testID={`${id}-average`}>
            {t().trends.average(average(avg.value), avg.days)}
          </Muted>
        ) : null}
      </View>
      {wide ? null : (
        <View style={s.scale}>
          <Mono style={s.scaleText}>{max > 0 ? format(max) : ''}</Mono>
        </View>
      )}
      <View style={[s.bars, { height: height + (wide ? 20 : 0) }]}>
        {days.map((day, index) => {
          const value = values[index] ?? null;
          const back = backOf(days, index);
          const barHeight =
            value === null || value <= 0 ? 0 : Math.max(2, Math.round((value / max) * height));
          return (
            <View
              key={day.start}
              style={[s.column, { gap: wide ? 4 : 0 }]}
              testID={`${id}-${back}`}
              accessible
              accessibilityLabel={t().trends.dayA11y(
                dayName(day),
                value === null ? t().trends.noRecord : format(value),
              )}
            >
              {wide ? (
                <Mono
                  style={[s.value, day.partial ? s.valuePartial : null]}
                  testID={`${id}-${back}-value`}
                >
                  {value === null ? '–' : format(value)}
                </Mono>
              ) : null}
              <View
                style={[
                  s.bar,
                  wide ? s.barWide : s.barNarrow,
                  {
                    height: barHeight,
                    backgroundColor: color,
                    opacity: day.partial ? PARTIAL_OPACITY : 1,
                  },
                ]}
              />
            </View>
          );
        })}
      </View>
    </View>
  );
}

/** 30 天时每隔 7 天写一个日期，从今天往回数，今天一定有。 */
function Axis({ days, wide }: { days: readonly TrendDay[]; wide: boolean }) {
  return (
    <View style={s.axis}>
      {days.map((day, index) => {
        const back = backOf(days, index);
        const label = wide
          ? day.partial
            ? t().trends.today
            : t().trends.weekday(new Date(day.start))
          : back % 7 === 0
            ? day.partial
              ? t().trends.today
              : formatMonthDay(day.start)
            : '';
        return (
          <View key={day.start} style={s.axisColumn}>
            {label ? (
              <Text
                style={[s.axisText, day.partial ? s.axisToday : null]}
                numberOfLines={1}
                importantForAccessibility="no"
              >
                {label}
              </Text>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

const TICKS = ['0', '6', '12', '18', '24'];

/** 每天一条 0 点到 24 点的横条，睡眠是蓝色段，和桌面小工具“今日汇总”的节奏条一样读法。 */
function Rhythm({ days, wide }: { days: readonly TrendDay[]; wide: boolean }) {
  const rowHeight = wide ? 10 : 5;
  return (
    <View style={{ gap: wide ? 6 : 2 }} testID="trend-rhythm">
      {days.map((day, index) => (
        <View
          key={day.start}
          style={s.rhythmRow}
          testID={`trend-rhythm-${backOf(days, index)}`}
          accessible
          accessibilityLabel={t().trends.dayA11y(
            dayName(day),
            day.sleepMs === null ? t().trends.noRecord : t().trends.sleepHours(hours(day.sleepMs)),
          )}
        >
          {wide ? (
            <Text style={[s.rhythmLabel, day.partial ? s.axisToday : null]} numberOfLines={1}>
              {day.partial ? t().trends.today : t().trends.weekday(new Date(day.start))}
            </Text>
          ) : null}
          <View style={[s.track, { height: rowHeight }]}>
            <View style={[s.trackPast, { width: `${day.elapsed * 100}%`, height: rowHeight }]} />
            {day.sleeps.map((span) => (
              <View
                key={span.from}
                style={[
                  s.sleepSpan,
                  {
                    left: `${span.from * 100}%`,
                    width: `${(span.to - span.from) * 100}%`,
                    height: rowHeight,
                  },
                ]}
              />
            ))}
          </View>
        </View>
      ))}
      <View style={s.rhythmRow}>
        {wide ? <View style={s.rhythmLabel} /> : null}
        <View style={s.ticks}>
          {TICKS.map((tick) => (
            <Mono key={tick} style={s.tickText}>
              {tick}
            </Mono>
          ))}
        </View>
      </View>
    </View>
  );
}

const s = themedStyles(() => ({
  root: { flex: 1, backgroundColor: colors.paper },
  content: { paddingHorizontal: spacing.page, gap: 16 },
  back: { fontSize: 14, color: colors.muted, padding: 4, marginLeft: -4 },
  rangeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  chips: { flexDirection: 'row', gap: 8 },
  note: { fontSize: 11, lineHeight: 17 },
  card: { gap: 12 },
  cardTitle: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  cardTitleText: { fontFamily: fonts.serifBold, fontSize: 15, lineHeight: 22, color: colors.ink },
  metricHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    gap: 8,
  },
  metricLabel: { fontSize: 12, color: colors.inkSoft },
  metricAverage: { fontSize: 11, flexShrink: 1, textAlign: 'right' },
  scale: { borderBottomWidth: 1, borderBottomColor: colors.rule, marginBottom: -6 },
  scaleText: { fontSize: 10, color: colors.muted },
  bars: { flexDirection: 'row', alignItems: 'flex-end', gap: 2 },
  // 撑满整排的高度：没有记录的天柱子是 0 高，列本身也要看得见、读得出来。
  column: { flex: 1, alignSelf: 'stretch', alignItems: 'center', justifyContent: 'flex-end' },
  value: { fontSize: 11, color: colors.ink },
  valuePartial: { color: colors.muted },
  bar: {
    borderTopLeftRadius: 3,
    borderTopRightRadius: 3,
    borderBottomLeftRadius: 1,
    borderBottomRightRadius: 1,
  },
  barWide: { width: '100%', maxWidth: 22 },
  barNarrow: { width: '80%' },
  axis: {
    flexDirection: 'row',
    gap: 2,
    borderTopWidth: 1,
    borderTopColor: colors.line,
    paddingTop: 4,
    marginTop: -6,
  },
  axisColumn: { flex: 1, alignItems: 'center', overflow: 'visible' },
  axisText: { fontSize: 10, color: colors.muted, width: 48, textAlign: 'center' },
  axisToday: { color: colors.ink },
  rhythmRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rhythmLabel: { width: 34, fontSize: 10, color: colors.muted },
  track: {
    flex: 1,
    borderRadius: 999,
    backgroundColor: colors.line,
    overflow: 'hidden',
  },
  trackPast: { position: 'absolute', left: 0, top: 0, backgroundColor: colors.off },
  sleepSpan: {
    position: 'absolute',
    top: 0,
    minWidth: 2,
    backgroundColor: colors.sleep,
  },
  ticks: { flex: 1, flexDirection: 'row', justifyContent: 'space-between' },
  tickText: { fontSize: 10, color: colors.muted },
  tempRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    paddingVertical: 9,
    gap: 8,
  },
  divider: { borderBottomWidth: 1, borderBottomColor: colors.rule },
  tempDate: { fontSize: 13, color: colors.ink },
  tempValue: { fontSize: 12, color: colors.inkSoft },
  tempNumber: { fontFamily: fonts.monoRegular, color: colors.ink },
}));
