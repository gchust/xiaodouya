import { ageParts, agePartsText } from '../domain/age';
import { scaleFor, toDisplay, toDisplayExact, type Units } from '../domain/units';
import { t } from '../i18n';
import type { BabyData, EventData } from '../schemas';
import { type LmsRow, WHO_GROWTH_LMS } from './whoGrowthData';

/**
 * 生长曲线：WHO Child Growth Standards（0–5 岁）。数据和来源见 whoGrowthData.ts。
 *
 * 只给百分位，不评价好坏：不说“偏瘦”“正常”，也不做“跨两条线”的提醒（需要来源和医护复核，见 F-100）。
 * 没填性别时不画参考线、不算百分位：WHO 的表按性别分，猜一个不如不给。
 * 不知道是不是早产、怎么量的，都按实际月龄、按 WHO 的测量方式（2 岁前卧位、之后立位）算，界面上写明。
 */

export const growthSexes = ['female', 'male'] as const;
export type GrowthSex = (typeof growthSexes)[number];

export const growthMeasures = ['weight', 'length', 'head'] as const;
export type GrowthMeasure = (typeof growthMeasures)[number];

/** WHO expanded tables 说明：1 month = 30.4375 days。 */
export const DAYS_PER_MONTH = 30.4375;
/** WHO 0–5 岁标准的最后一个按月节点（60 个月）。之后不外推。 */
export const WHO_LAST_DAY = 60 * DAYS_PER_MONTH;
/** 卧位身长和立位身高的分界（24 个月）。这一天本身算卧位身长。 */
const LENGTH_TO_HEIGHT_DAY = 24 * DAYS_PER_MONTH;

export const REFERENCE_PERCENTILES = [3, 15, 50, 85, 97] as const;

const DAY_MS = 86_400_000;

export interface Lms {
  l: number;
  m: number;
  s: number;
}

function tableFor(measure: GrowthMeasure, sex: GrowthSex, ageDays: number): readonly LmsRow[] {
  const tables = WHO_GROWTH_LMS[sex];
  if (measure === 'weight') return tables.weight;
  if (measure === 'head') return tables.head;
  return ageDays <= LENGTH_TO_HEIGHT_DAY ? tables.length : tables.height;
}

/** 按年龄（天）在相邻两个节点之间线性插值 L、M、S。出生前和 5 岁以后返回 null。 */
export function whoLms(measure: GrowthMeasure, sex: GrowthSex, ageDays: number): Lms | null {
  if (!(ageDays >= 0 && ageDays <= WHO_LAST_DAY)) return null;
  const rows = tableFor(measure, sex, ageDays);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as LmsRow;
    if (row[0] === ageDays) return { l: row[1], m: row[2], s: row[3] };
    const next = rows[i + 1];
    if (next && row[0] < ageDays && ageDays < next[0]) {
      const f = (ageDays - row[0]) / (next[0] - row[0]);
      return {
        l: row[1] + (next[1] - row[1]) * f,
        m: row[2] + (next[2] - row[2]) * f,
        s: row[3] + (next[3] - row[3]) * f,
      };
    }
  }
  return null;
}

/** LMS 方法（Cole 1990，WHO 2006 的方法报告）。L 接近 0 时是对数形式。 */
export function zScore(value: number, { l, m, s }: Lms): number {
  if (Math.abs(l) < 1e-9) return Math.log(value / m) / s;
  return ((value / m) ** l - 1) / (l * s);
}

export function valueAtZ({ l, m, s }: Lms, z: number): number {
  if (Math.abs(l) < 1e-9) return m * Math.exp(s * z);
  return m * (1 + l * s * z) ** (1 / l);
}

/** 标准正态分布函数（Abramowitz & Stegun 7.1.26 的 erf 近似，误差 < 1.5e-7）。 */
function normalCdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const k = 1 / (1 + 0.3275911 * x);
  const poly =
    k *
    (0.254829592 + k * (-0.284496736 + k * (1.421413741 + k * (-1.453152027 + k * 1.061405429))));
  const erf = 1 - poly * Math.exp(-x * x);
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

/** 标准正态分布的分位数（Acklam 的有理近似，相对误差 < 1.2e-9）。 */
function normalQuantile(p: number): number {
  const a = [
    -39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716,
    2.506628277459239,
  ];
  const b = [
    -54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972,
    -13.28068155288572,
  ];
  const c = [
    -0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734,
    4.374664141464968, 2.938163982698783,
  ];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const low = 0.02425;
  const [a0, a1, a2, a3, a4, a5] = a as [number, number, number, number, number, number];
  const [b0, b1, b2, b3, b4] = b as [number, number, number, number, number];
  const [c0, c1, c2, c3, c4, c5] = c as [number, number, number, number, number, number];
  const [d0, d1, d2, d3] = d as [number, number, number, number];
  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c0 * q + c1) * q + c2) * q + c3) * q + c4) * q + c5) /
      ((((d0 * q + d1) * q + d2) * q + d3) * q + 1)
    );
  }
  if (p > 1 - low) return -normalQuantile(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return (
    ((((((a0 * r + a1) * r + a2) * r + a3) * r + a4) * r + a5) * q) /
    (((((b0 * r + b1) * r + b2) * r + b3) * r + b4) * r + 1)
  );
}

/** 某个年龄第 p 百分位的数值（公制）。 */
export function percentileValue(
  measure: GrowthMeasure,
  sex: GrowthSex,
  ageDays: number,
  percentile: number,
): number | null {
  const lms = whoLms(measure, sex, ageDays);
  return lms ? valueAtZ(lms, normalQuantile(percentile / 100)) : null;
}

/**
 * 一次测量在 WHO 标准里的百分位（0–100）。没有参考值时返回 null。
 * WHO 对体重在 ±3 SD 之外另有一种算法；这里显示时 P1 以下、P99 以上只说“低于”“高于”，用不到那么远。
 */
export function growthPercentile(
  measure: GrowthMeasure,
  sex: GrowthSex,
  ageDays: number,
  value: number,
): number | null {
  const lms = whoLms(measure, sex, ageDays);
  if (!lms || !(value > 0)) return null;
  return normalCdf(zScore(value, lms)) * 100;
}

export type PercentileBand =
  | { kind: 'below' }
  | { kind: 'about'; value: number }
  | { kind: 'above' };

/** 显示用：整数百分位，P1 以下和 P99 以上只说低于、高于。 */
export function percentileBand(percentile: number): PercentileBand {
  if (percentile < 1) return { kind: 'below' };
  if (percentile > 99) return { kind: 'above' };
  return { kind: 'about', value: Math.round(percentile) };
}

export function percentileText(percentile: number): string {
  const text = t().growth.percentile;
  const band = percentileBand(percentile);
  if (band.kind === 'below') return text.below;
  if (band.kind === 'above') return text.above;
  return text.about(band.value);
}

export interface CurvePoint {
  days: number;
  value: number;
}

export interface ReferenceCurve {
  percentile: (typeof REFERENCE_PERCENTILES)[number];
  /** 身长在 24 个月处分成两段（卧位身长、立位身高），不能连起来画。 */
  segments: CurvePoint[][];
}

/** 从出生画到 `endDays`（超过 5 岁的部分不画），用表里的节点，两端补上起止点。 */
export function referenceCurves(
  measure: GrowthMeasure,
  sex: GrowthSex,
  endDays: number,
): ReferenceCurve[] {
  const end = Math.min(endDays, WHO_LAST_DAY);
  const pieces: Array<{ rows: readonly LmsRow[]; from: number; to: number; open: boolean }> =
    measure === 'length'
      ? [
          {
            rows: WHO_GROWTH_LMS[sex].length,
            from: 0,
            to: Math.min(end, LENGTH_TO_HEIGHT_DAY),
            open: false,
          },
          ...(end > LENGTH_TO_HEIGHT_DAY
            ? [
                {
                  rows: WHO_GROWTH_LMS[sex].height,
                  from: LENGTH_TO_HEIGHT_DAY,
                  to: end,
                  open: true,
                },
              ]
            : []),
        ]
      : [{ rows: WHO_GROWTH_LMS[sex][measure], from: 0, to: end, open: false }];
  return REFERENCE_PERCENTILES.map((percentile) => {
    const z = normalQuantile(percentile / 100);
    const segments = pieces.map(({ rows, from, to, open }) => {
      const days = [from, ...rows.map((r) => r[0]).filter((d) => d > from && d < to), to];
      return days.map((d) => {
        // 立位那一段的起点是 24 个月的立位身高，不是卧位身长。
        const row = open && d === from ? rows[0] : undefined;
        const lms = row ? { l: row[1], m: row[2], s: row[3] } : whoLms(measure, sex, d);
        return { days: d, value: lms ? valueAtZ(lms, z) : Number.NaN };
      });
    });
    return { percentile, segments };
  });
}

const CHART_MONTHS = [6, 12, 24, 36, 48, 60];

/** 图的右边界（天）：取整到 6、12、24、36、48、60 个月，再往后按整年。 */
export function growthChartEndDays(ageDays: number): number {
  const months = ageDays / DAYS_PER_MONTH;
  const fit = CHART_MONTHS.find((m) => months <= m);
  return (fit ?? Math.ceil(months / 12) * 12) * DAYS_PER_MONTH;
}

export interface GrowthPoint {
  at: number;
  ageDays: number;
  /** 公制：kg 或 cm。 */
  value: number;
  /** 出生档案里的出生体重、身长。 */
  birth: boolean;
}

export function growthAgeDays(birthAt: number, at: number): number {
  return (at - birthAt) / DAY_MS;
}

/**
 * 宝宝自己的点：出生档案的出生体重、身长，加上身高体重记录，按时间排。早于出生的不画。
 *
 * 身长和前一次（含出生身长）一模一样的不画：身长是必填的（旧版 App 要它），弹层默认带上一次的值，
 * 只量了体重时存下的是沿用来的旧身长。画出来会是一段平线、百分位往下掉，等于给家长看一次没发生的
 * 生长停滞（AGENTS.md 第 8 节）。真量出一样的值时少画一个点，影响很小。
 */
export function growthPoints(
  baby: BabyData,
  events: readonly EventData[],
  measure: GrowthMeasure,
): GrowthPoint[] {
  const birthValue =
    measure === 'weight'
      ? baby.birthWeightKg
      : measure === 'length'
        ? baby.birthLengthCm
        : undefined;
  const points: GrowthPoint[] = birthValue
    ? [{ at: baby.birthAt, ageDays: 0, value: birthValue, birth: true }]
    : [];
  for (const e of events) {
    if (e.type !== 'growth' || e.at < baby.birthAt) continue;
    const value = measure === 'weight' ? e.weightKg : measure === 'length' ? e.lengthCm : e.headCm;
    if (value === undefined) continue;
    points.push({ at: e.at, ageDays: growthAgeDays(baby.birthAt, e.at), value, birth: false });
  }
  points.sort((a, b) => a.at - b.at);
  if (measure !== 'length') return points;
  return points.filter((p, i) => i === 0 || p.value !== points[i - 1]?.value);
}

function measureDimension(measure: GrowthMeasure): 'weight' | 'length' {
  return measure === 'weight' ? 'weight' : 'length';
}

/** 图上用的单位（头围和身长一样用长度单位）。 */
export function growthUnit(measure: GrowthMeasure, units: Units): string {
  const dimension = measureDimension(measure);
  return scaleFor(dimension, units[dimension]).label;
}

/** 公制换成显示单位，取整到一位小数，写在文字里。 */
export function growthDisplayValue(measure: GrowthMeasure, metric: number, units: Units): number {
  const dimension = measureDimension(measure);
  return toDisplay(dimension, metric, units[dimension]);
}

/** 画图用，不取整。参考线和宝宝的点用同一个换算，lb、in 下也对得上。 */
export function growthPlotValue(measure: GrowthMeasure, metric: number, units: Units): number {
  return toDisplayExact(metric, units[measureDimension(measure)]);
}

export interface GrowthPointText {
  text: string;
  a11y: string;
  /** 没填性别、超过 5 岁时是 null，界面上不说百分位。 */
  percentile: number | null;
}

/** 点开一个点：`3 个月零 12 天 · 6.2 kg · 约 P40`。 */
export function growthPointText(
  point: GrowthPoint,
  birthAt: number,
  measure: GrowthMeasure,
  sex: GrowthSex | undefined,
  units: Units,
): GrowthPointText {
  const text = t().growth;
  const parts = ageParts(birthAt, point.at);
  // agePartsText 在出生当天写“今天出生”，放在一次测量上，过几天再看就不对了。
  const age = point.birth
    ? text.birth
    : parts.months === 0 && parts.days === 0
      ? text.birthDay
      : agePartsText(parts);
  const value = `${growthDisplayValue(measure, point.value, units).toFixed(1)} ${growthUnit(measure, units)}`;
  const percentile = sex ? growthPercentile(measure, sex, point.ageDays, point.value) : null;
  const band = percentile === null ? undefined : percentileText(percentile);
  return {
    text: text.point(age, value, band),
    a11y: text.pointA11y(age, value, band),
    percentile,
  };
}

/** 图下面的说明。免责声明和早产提示一直在；没填性别时不提参考线。 */
export function growthChartNotes(
  measure: GrowthMeasure,
  sex: GrowthSex | undefined,
  endDays: number,
): string[] {
  const text = t().growth;
  const notes: string[] = [];
  if (sex) {
    notes.push(text.reference(text.sexLabel[sex]));
    if (measure === 'length' && endDays > LENGTH_TO_HEIGHT_DAY) notes.push(text.heightBreak);
    if (endDays > WHO_LAST_DAY) notes.push(text.overAge);
  }
  notes.push(text.disclaimer, text.preterm);
  return notes;
}
