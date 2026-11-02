import { t } from '../i18n';

/**
 * 单位只影响显示和输入。记录里永远存公制（毫升、摄氏度、公斤、厘米），
 * 这样换单位、换地区、家人用不同单位都不用迁移数据，健康规则也只有一套。
 */

export const volumeUnits = ['ml', 'oz'] as const;
export const temperatureUnits = ['c', 'f'] as const;
export const weightUnits = ['kg', 'lb'] as const;
export const lengthUnits = ['cm', 'in'] as const;

export type VolumeUnit = (typeof volumeUnits)[number];
export type TemperatureUnit = (typeof temperatureUnits)[number];
export type WeightUnit = (typeof weightUnits)[number];
export type LengthUnit = (typeof lengthUnits)[number];

export interface Units {
  volume: VolumeUnit;
  temperature: TemperatureUnit;
  weight: WeightUnit;
  length: LengthUnit;
}

export type Dimension = keyof Units;

export const metricUnits: Units = { volume: 'ml', temperature: 'c', weight: 'kg', length: 'cm' };

export interface UnitScale {
  label: string;
  /** 提示文字里用的名称，跟随当前语言。 */
  name: string;
  step: number;
  min: number;
  max: number;
  decimals: number;
}

/**
 * 步长和上下限都按显示单位定，每个网格点换算成公制再换回来都不变（见 units.test.ts）。
 * 范围要落在 `EventData` 的校验之内，否则记录会被服务端拒绝。
 * °F 用 0.2 而不是 0.1：0.2°F 约等于原来的 0.1℃，常见阈值 96.8、100.4、102.2 都在网格上。
 */
type ScaleData = Omit<UnitScale, 'name'>;

const scales: Record<Dimension, Record<string, ScaleData>> = {
  volume: {
    ml: { label: 'ml', step: 10, min: 10, max: 1000, decimals: 0 },
    oz: { label: 'oz', step: 0.5, min: 0.5, max: 33.5, decimals: 1 },
  },
  temperature: {
    c: { label: '℃', step: 0.1, min: 30, max: 45, decimals: 1 },
    f: { label: '°F', step: 0.2, min: 86, max: 113, decimals: 1 },
  },
  weight: {
    kg: { label: 'kg', step: 0.1, min: 0.5, max: 100, decimals: 1 },
    lb: { label: 'lb', step: 0.2, min: 1.2, max: 220, decimals: 1 },
  },
  length: {
    cm: { label: 'cm', step: 0.5, min: 25, max: 250, decimals: 1 },
    in: { label: 'in', step: 0.5, min: 10, max: 98, decimals: 1 },
  },
};

const fallbackUnit: Units = metricUnits;

export function scaleFor(dimension: Dimension, unit: string): UnitScale {
  const known = scales[dimension][unit];
  const id = (known ? unit : fallbackUnit[dimension]) as keyof ReturnType<typeof unitNames>;
  return { ...(known ?? (scales[dimension][id] as ScaleData)), name: unitNames()[id] };
}

function unitNames() {
  const { ml, oz, c, f, kg, lb, cm, in: inch } = t().domain.units;
  return { ml, oz, c, f, kg, lb, cm, in: inch };
}

const ML_PER_OZ = 29.5735;
const LB_PER_KG = 2.20462;
const CM_PER_IN = 2.54;

const round = (value: number, decimals: number) => Number(value.toFixed(decimals));

/** 公制 → 显示单位，按该单位的小数位取整。 */
export function toDisplay(dimension: Dimension, metric: number, unit: string): number {
  const { decimals } = scaleFor(dimension, unit);
  switch (unit) {
    case 'oz':
      return round(metric / ML_PER_OZ, decimals);
    case 'f':
      return round((metric * 9) / 5 + 32, decimals);
    case 'lb':
      return round(metric * LB_PER_KG, decimals);
    case 'in':
      return round(metric / CM_PER_IN, decimals);
    default:
      return round(metric, decimals);
  }
}

/**
 * 显示单位 → 公制。奶量必须是整数毫升（校验要求）；其他保留足够的小数位，
 * 让显示值换算回来不变：摄氏度只留 1 位的话 99.2°F 会回不来。
 */
export function toMetric(dimension: Dimension, display: number, unit: string): number {
  switch (unit) {
    case 'oz':
      return Math.round(display * ML_PER_OZ);
    case 'f':
      return round(((display - 32) * 5) / 9, 2);
    case 'lb':
      return round(display / LB_PER_KG, 3);
    case 'in':
      return round(display * CM_PER_IN, 2);
    default:
      return dimension === 'volume' ? Math.round(display) : round(display, 3);
  }
}

/**
 * 保存时用：显示值没变就保留原来的公制值。否则家人记的 131ml 在盎司界面下
 * 只是改了备注，也会变成 130ml。
 */
export function metricToSave(
  dimension: Dimension,
  original: number | undefined,
  display: number,
  unit: string,
): number {
  if (original !== undefined && toDisplay(dimension, original, unit) === display) return original;
  return toMetric(dimension, display, unit);
}

/**
 * 加减一步。按“第几格”计算，不累加小数，所以不会漂移；
 * 不在网格上的值（比如家人记的 130ml 显示成 4.4oz）先对齐到相邻的格子。
 */
export function stepDisplay(
  dimension: Dimension,
  value: number,
  direction: 1 | -1,
  unit: string,
): number {
  const { step, min, max, decimals } = scaleFor(dimension, unit);
  const ticks = value / step;
  const next = direction > 0 ? Math.floor(ticks + 1e-6) + 1 : Math.ceil(ticks - 1e-6) - 1;
  return Math.min(max, Math.max(min, round(next * step, decimals)));
}

const CHIPS: Record<VolumeUnit, readonly number[]> = {
  ml: [60, 80, 90, 100, 120],
  oz: [2, 3, 4, 5, 6],
};

/** 喂奶弹层的快捷值，单位和当前的显示单位一致。 */
export function chipsFor(unit: VolumeUnit): readonly number[] {
  return CHIPS[unit];
}

export function formatVolume(ml: number, unit: VolumeUnit): string {
  return `${toDisplay('volume', ml, unit)}${unit}`;
}

export function formatTemperature(celsius: number, unit: TemperatureUnit): string {
  const { label, decimals } = scaleFor('temperature', unit);
  return `${toDisplay('temperature', celsius, unit).toFixed(decimals)}${label}`;
}

export function formatWeight(kg: number, unit: WeightUnit): string {
  return `${toDisplay('weight', kg, unit).toFixed(1)}${unit}`;
}

export function formatLength(cm: number, unit: LengthUnit): string {
  return `${toDisplay('length', cm, unit).toFixed(1)}${unit}`;
}

/** 提示文字里的阈值：摄氏度写整洁的 38℃，华氏度写 100.4°F。 */
export function formatTemperatureThreshold(celsius: number, unit: TemperatureUnit): string {
  return unit === 'c' ? `${celsius}℃` : formatTemperature(celsius, unit);
}

export function formatTemperatureRange(low: number, high: number, unit: TemperatureUnit): string {
  if (unit === 'c') return `${low}–${high}℃`;
  const { label, decimals } = scaleFor('temperature', unit);
  const part = (c: number) => toDisplay('temperature', c, unit).toFixed(decimals);
  return `${part(low)}–${part(high)}${label}`;
}

export function unitsSummary(units: Units): string {
  return [
    scaleFor('volume', units.volume).label,
    scaleFor('temperature', units.temperature).label,
    scaleFor('weight', units.weight).label,
    scaleFor('length', units.length).label,
  ].join(' · ');
}

// ─── 出生体重和身长（手动输入，范围比成长记录窄）────────────────

interface BirthMeasures {
  birthWeightKg?: number;
  birthLengthCm?: number;
}

/** 输入框里显示的文字。公制保留用户当时填的原样，3.45 不能显示成 3.5。 */
export function birthMeasureText(
  dimension: 'weight' | 'length',
  metric: number | undefined,
  unit: string,
): string {
  if (metric === undefined) return '';
  return unit === 'kg' || unit === 'cm'
    ? String(metric)
    : String(toDisplay(dimension, metric, unit));
}

export function formatBirthMeasures(baby: BirthMeasures, units: Units): string {
  const part = (dimension: 'weight' | 'length', metric: number | undefined, unit: string) =>
    `${birthMeasureText(dimension, metric, unit) || '—'} ${unit}`;
  return `${part('weight', baby.birthWeightKg, units.weight)} · ${part('length', baby.birthLengthCm, units.length)}`;
}

/** 建档时切换地区：已经填的数字跟着换算，否则 3.4（公斤）会被当成 3.4 磅。 */
export function convertMeasureText(
  dimension: 'weight' | 'length',
  text: string,
  from: string,
  to: string,
): string {
  const value = Number.parseFloat(text);
  if (from === to || Number.isNaN(value)) return text;
  return String(toDisplay(dimension, toMetric(dimension, value, from), to));
}

export type BirthMeasuresResult =
  | { ok: true; weightKg: number | undefined; lengthCm: number | undefined }
  | { ok: false; error: string };

/** 解析输入，范围按公制判断。没改过的值原样保留，不让出生体重因为换算悄悄变化。 */
export function birthMeasuresFromInput(
  weightText: string,
  lengthText: string,
  units: Units,
  original: BirthMeasures = {},
): BirthMeasuresResult {
  const parse = (
    dimension: 'weight' | 'length',
    text: string,
    unit: string,
    previous: number | undefined,
  ): number | undefined | null => {
    const trimmed = text.trim();
    if (!trimmed) return undefined;
    if (previous !== undefined && trimmed === birthMeasureText(dimension, previous, unit)) {
      return previous;
    }
    const value = Number.parseFloat(trimmed);
    return Number.isNaN(value) ? null : toMetric(dimension, value, unit);
  };
  const weightKg = parse('weight', weightText, units.weight, original.birthWeightKg);
  if (weightKg === null || (weightKg !== undefined && !(weightKg >= 0.3 && weightKg <= 10))) {
    return { ok: false, error: t().domain.units.badWeight(scaleFor('weight', units.weight).name) };
  }
  const lengthCm = parse('length', lengthText, units.length, original.birthLengthCm);
  if (lengthCm === null || (lengthCm !== undefined && !(lengthCm >= 20 && lengthCm <= 80))) {
    return { ok: false, error: t().domain.units.badLength(scaleFor('length', units.length).name) };
  }
  return { ok: true, weightKg, lengthCm };
}
