import {
  type BabyData,
  type EventData,
  type GrowthMeasure,
  growthAgeDays,
  growthChartEndDays,
  growthChartNotes,
  growthDisplayValue,
  growthMeasures,
  growthPoints,
  growthPointText,
  growthUnit,
  referenceCurves,
  t,
  type Units,
} from '@xiaodouya/shared';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import Svg, { Circle, Line, Path, Text as SvgText } from 'react-native-svg';
import { layoutGrowthChart } from '../lib/growthChart';
import { colors, fonts, themedStyles } from '../theme';
import { Chip, Mono, Muted } from './primitives';

const CHART_HEIGHT = 210;
/** 点很小，透明的点击区 44×44 盖在上面（相邻的点挨得近时，后面的盖住前面的）。 */
const HIT = 44;
/** 链接文字只有 16 高，上下各扩 14 才到 44。 */
const LINK_HIT_SLOP = { top: 14, bottom: 14, left: 12, right: 12 };

/**
 * 资料页的生长曲线（F-148）：体重、身长、头围三张，WHO 的参考线 + 宝宝自己的线。
 * 只写百分位，不评价好坏；没填性别时不画参考线、不说百分位。
 */
export function GrowthChart({
  baby,
  events,
  units,
  now,
  onSetSex,
}: {
  baby: BabyData;
  events: EventData[];
  units: Units;
  now: number;
  /** 没填性别时说明下面的“填写性别”链接。只读的家人没有。 */
  onSetSex?: () => void;
}) {
  const [measure, setMeasure] = useState<GrowthMeasure>('weight');
  const [selected, setSelected] = useState<number | null>(null);
  const [width, setWidth] = useState(0);
  const text = t().growth;
  const sex = baby.sex;
  const points = growthPoints(baby, events, measure);
  const lastAge = Math.max(growthAgeDays(baby.birthAt, now), points.at(-1)?.ageDays ?? 0);
  const endDays = growthChartEndDays(lastAge);
  const display = (metric: number) => growthDisplayValue(measure, metric, units);
  const curves = sex
    ? referenceCurves(measure, sex, endDays).map((c) => ({
        percentile: c.percentile,
        segments: c.segments.map((seg) => seg.map((p) => ({ ...p, value: display(p.value) }))),
      }))
    : [];
  const shown = points.map((p) => ({ ageDays: p.ageDays, value: display(p.value) }));
  const index = selected !== null && selected < points.length ? selected : points.length - 1;
  const current = points[index];
  const readout = current ? growthPointText(current, baby.birthAt, measure, sex, units) : null;
  const layout =
    width > 0 && points.length > 0
      ? layoutGrowthChart({ width, height: CHART_HEIGHT, endDays, curves, points: shown })
      : null;

  return (
    <View style={s.card}>
      <View style={s.tabs}>
        {growthMeasures.map((m) => (
          <Chip
            key={m}
            testID={`growth-tab-${m}`}
            label={text.tab(text.measures[m], growthUnit(m, units))}
            selected={m === measure}
            onPress={() => {
              setMeasure(m);
              setSelected(null);
            }}
          />
        ))}
      </View>
      {points.length === 0 ? (
        <View style={s.empty} testID="growth-empty">
          <Muted style={{ fontSize: 13, textAlign: 'center', lineHeight: 20 }}>
            {text.empty[measure]}
          </Muted>
        </View>
      ) : (
        <View
          testID="growth-chart"
          style={{ height: CHART_HEIGHT }}
          onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
        >
          {layout ? (
            <>
              <Svg width={width} height={CHART_HEIGHT}>
                {layout.yTicks.map((tick) => (
                  <Line
                    key={`grid-${tick.value}`}
                    x1={layout.plot.left}
                    x2={layout.plot.right}
                    y1={tick.y}
                    y2={tick.y}
                    stroke={colors.rule}
                    strokeWidth={1}
                  />
                ))}
                {layout.bands.map((d) => (
                  <Path key={d} d={d} fill={colors.sand} />
                ))}
                {layout.curves.map((c) => (
                  <Path
                    key={`p${c.percentile}`}
                    d={c.d}
                    fill="none"
                    stroke={c.percentile === 50 ? colors.muted : colors.hint}
                    strokeOpacity={c.percentile === 50 ? 0.55 : 1}
                    strokeWidth={c.percentile === 50 ? 1.4 : 1}
                    strokeDasharray={c.percentile === 15 || c.percentile === 85 ? '3 3' : undefined}
                  />
                ))}
                {layout.labels.map((l) => (
                  <SvgText
                    key={`l${l.percentile}`}
                    x={l.x}
                    y={l.y + 3}
                    fontSize={9}
                    fontFamily={fonts.monoRegular}
                    fill={colors.muted}
                  >
                    {l.percentile}
                  </SvgText>
                ))}
                {layout.yTicks.map((tick) => (
                  <SvgText
                    key={`y-${tick.value}`}
                    x={layout.plot.left - 6}
                    y={tick.y + 3}
                    fontSize={9}
                    fontFamily={fonts.monoRegular}
                    fill={colors.muted}
                    textAnchor="end"
                  >
                    {tick.label}
                  </SvgText>
                ))}
                {layout.xTicks.map((tick) => (
                  <SvgText
                    key={`x-${tick.months}`}
                    x={tick.x}
                    y={layout.plot.bottom + 14}
                    fontSize={9}
                    fontFamily={fonts.monoRegular}
                    fill={colors.muted}
                    textAnchor="middle"
                  >
                    {tick.months}
                  </SvgText>
                ))}
                <SvgText
                  x={layout.plot.left - 6}
                  y={layout.plot.bottom + 14}
                  fontSize={9}
                  fill={colors.muted}
                  textAnchor="end"
                >
                  {text.ageAxis}
                </SvgText>
                {layout.line ? (
                  <Path
                    d={layout.line}
                    fill="none"
                    stroke={colors.growth}
                    strokeWidth={2}
                    strokeLinejoin="round"
                  />
                ) : null}
                {layout.dots.map((dot, i) => (
                  <Circle
                    // biome-ignore lint/suspicious/noArrayIndexKey: 点按时间排好，下标就是身份。
                    key={i}
                    cx={dot.x}
                    cy={dot.y}
                    r={i === index ? 5 : 3.5}
                    fill={i === index ? colors.growth : colors.card}
                    stroke={colors.growth}
                    strokeWidth={2}
                  />
                ))}
              </Svg>
              {layout.dots.map((dot, i) => {
                const point = points[i];
                if (!point) return null;
                return (
                  <Pressable
                    // biome-ignore lint/suspicious/noArrayIndexKey: 同上。
                    key={i}
                    testID={`growth-point-${i}`}
                    accessibilityRole="button"
                    accessibilityLabel={
                      growthPointText(point, baby.birthAt, measure, sex, units).a11y
                    }
                    accessibilityState={{ selected: i === index }}
                    onPress={() => setSelected(i)}
                    style={[s.hit, { left: dot.x - HIT / 2, top: dot.y - HIT / 2 }]}
                  />
                );
              })}
            </>
          ) : null}
        </View>
      )}
      {readout ? (
        <Mono testID="growth-point-text" style={s.readout}>
          {readout.text}
        </Mono>
      ) : null}
      <View style={s.notes}>
        {sex ? null : (
          <>
            <Text style={s.note} testID="growth-no-sex">
              {text.noSex}
            </Text>
            {onSetSex ? (
              <Pressable
                testID="growth-set-sex"
                accessibilityRole="button"
                accessibilityLabel={text.noSexLink}
                hitSlop={LINK_HIT_SLOP}
                onPress={onSetSex}
                style={s.linkRow}
              >
                <Text style={s.link}>{`${text.noSexLink} ›`}</Text>
              </Pressable>
            ) : null}
          </>
        )}
        {growthChartNotes(measure, sex, endDays).map((note) => (
          <Text key={note} style={s.note}>
            {note}
          </Text>
        ))}
      </View>
    </View>
  );
}

const s = themedStyles(() => ({
  card: {
    backgroundColor: colors.card,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 14,
    padding: 14,
    gap: 10,
  },
  tabs: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  empty: { height: 120, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12 },
  hit: { position: 'absolute', width: HIT, height: HIT },
  readout: { fontSize: 13, color: colors.ink, textAlign: 'center' },
  notes: { gap: 4 },
  note: { fontSize: 11, lineHeight: 17, color: colors.muted },
  linkRow: { alignSelf: 'flex-start', paddingBottom: 4 },
  link: { fontSize: 12, color: colors.accentText },
}));
