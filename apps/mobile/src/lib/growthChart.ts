// 生长曲线的几何计算（F-148）。纯函数，不引 React Native，能直接写单元测试。
// 数值都已经换成显示单位（kg/lb、cm/in），参考线和宝宝的点用同一个换算。
import { DAYS_PER_MONTH } from '@xiaodouya/shared';

export interface ChartCurve {
  percentile: number;
  segments: { days: number; value: number }[][];
}

export interface ChartPoint {
  ageDays: number;
  value: number;
}

export interface ChartInput {
  width: number;
  height: number;
  endDays: number;
  curves: readonly ChartCurve[];
  points: readonly ChartPoint[];
}

export interface ChartLayout {
  plot: { left: number; top: number; right: number; bottom: number };
  yTicks: { value: number; y: number; label: string }[];
  xTicks: { months: number; x: number }[];
  /** P3 到 P97 之间的底色，身长跨过 2 岁时是两块。 */
  bands: string[];
  curves: { percentile: number; d: string }[];
  labels: { percentile: number; x: number; y: number }[];
  line: string;
  dots: { x: number; y: number }[];
}

/** 左边放纵轴数字，右边放参考线的百分位，下面放月龄。 */
export const CHART_PADDING = { left: 34, right: 22, top: 10, bottom: 22 };
const LABEL_GAP = 11;
const STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50];

function niceStep(span: number): number {
  return STEPS.find((s) => span / s <= 5) ?? 100;
}

/** 月龄刻度：6 个月内每月一格，12 个月内两个月，2 岁内三个月，3 岁内半年，再往后一年。 */
export function monthTicks(endDays: number): number[] {
  const end = Math.round(endDays / DAYS_PER_MONTH);
  const step = end <= 6 ? 1 : end <= 12 ? 2 : end <= 24 ? 3 : end <= 36 ? 6 : 12;
  const ticks: number[] = [];
  for (let m = 0; m <= end; m += step) ticks.push(m);
  return ticks;
}

function decimalsOf(step: number): number {
  return step < 1 ? 1 : 0;
}

/** 相邻的百分位标签至少隔开 `gap`，从下往上推开，不叠在一起。 */
export function spreadLabels(ys: number[], gap: number): number[] {
  const order = ys.map((y, i) => ({ y, i })).sort((a, b) => b.y - a.y);
  for (let k = 1; k < order.length; k++) {
    const prev = order[k - 1] as { y: number };
    const cur = order[k] as { y: number };
    if (prev.y - cur.y < gap) cur.y = prev.y - gap;
  }
  const out = [...ys];
  for (const { y, i } of order) out[i] = y;
  return out;
}

export function layoutGrowthChart({
  width,
  height,
  endDays,
  curves,
  points,
}: ChartInput): ChartLayout {
  const plot = {
    left: CHART_PADDING.left,
    top: CHART_PADDING.top,
    right: width - CHART_PADDING.right,
    bottom: height - CHART_PADDING.bottom,
  };
  const values = [
    ...curves.flatMap((c) => c.segments.flat().map((p) => p.value)),
    ...points.map((p) => p.value),
  ].filter(Number.isFinite);
  let low = Math.min(...values);
  let high = Math.max(...values);
  if (!Number.isFinite(low) || !Number.isFinite(high)) {
    low = 0;
    high = 1;
  }
  if (high - low < 1e-6) {
    low -= 0.5;
    high += 0.5;
  }
  const step = niceStep((high - low) * 1.08);
  const min = Math.floor(low / step) * step;
  const max = Math.ceil(high / step) * step;
  const x = (days: number) => plot.left + (days / endDays) * (plot.right - plot.left);
  const y = (value: number) =>
    plot.bottom - ((value - min) / (max - min)) * (plot.bottom - plot.top);
  const r = (n: number) => Math.round(n * 10) / 10;
  const path = (list: { days: number; value: number }[]) =>
    list
      .filter((p) => Number.isFinite(p.value))
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${r(x(p.days))} ${r(y(p.value))}`)
      .join(' ');

  const yTicks: ChartLayout['yTicks'] = [];
  for (let v = min; v <= max + step / 2; v += step) {
    const value = Math.round(v / step) * step;
    yTicks.push({ value, y: r(y(value)), label: value.toFixed(decimalsOf(step)) });
  }

  const outer = (p: number) => curves.find((c) => c.percentile === p);
  const p3 = outer(3);
  const p97 = outer(97);
  const bands =
    p3 && p97
      ? p3.segments.map((seg, i) => {
          const top = [...(p97.segments[i] ?? [])].reverse();
          return `${path([...seg, ...top])} Z`;
        })
      : [];

  const ends = curves.map((c) => c.segments.at(-1)?.at(-1));
  const spread = spreadLabels(
    ends.map((p) => (p ? y(p.value) : 0)),
    LABEL_GAP,
  );
  const labels = curves.map((c, i) => ({
    percentile: c.percentile,
    x: r(plot.right + 4),
    y: r(spread[i] ?? 0),
  }));

  const dots = points.map((p) => ({ x: r(x(p.ageDays)), y: r(y(p.value)) }));
  return {
    plot,
    yTicks,
    xTicks: monthTicks(endDays).map((months) => ({ months, x: r(x(months * DAYS_PER_MONTH)) })),
    bands,
    curves: curves.map((c) => ({ percentile: c.percentile, d: c.segments.map(path).join(' ') })),
    labels,
    line: points.length > 1 ? path(points.map((p) => ({ days: p.ageDays, value: p.value }))) : '',
    dots,
  };
}

/**
 * 同一天量了几次时点叠在一起，点击区也叠在一起，手指只点得到最上面（最新）的那个。
 * 点已经选中的点时，换成和它叠在一起的前一个，再点又换回来。读屏直接选中的是哪个就是哪个。
 */
export function nextSelection(
  dots: { x: number; y: number }[],
  tapped: number,
  selected: number,
  hit: number,
): number {
  if (tapped !== selected) return tapped;
  const dot = dots[tapped];
  if (!dot) return tapped;
  const cluster = dots
    .map((d, i) => ({ d, i }))
    .filter(({ d }) => Math.abs(d.x - dot.x) < hit / 2 && Math.abs(d.y - dot.y) < hit / 2)
    .map(({ i }) => i);
  const at = cluster.indexOf(tapped);
  return cluster[(at - 1 + cluster.length) % cluster.length] ?? tapped;
}
