import { t } from '../i18n';
import type {
  EventData,
  FormulaBasis,
  FormulaData,
  FormulaSnapshot,
  NutrientValues,
} from '../schemas';
import {
  type NutrientKey,
  type NutrientTarget,
  type NutritionReferenceUse,
  referenceBandFor,
} from './nutritionReferences';

/**
 * 奶粉营养估算。只说记录能证明的事：
 * - 有任何一次喂奶算不进去（母乳、没标注、奶粉没数据），就是“数据不足”并说明原因。
 * - 结论只给已经结束的日子，今天只说“目前已摄入 xx%”。
 * - 不评价品牌，也不判断“超过上限”。
 *
 * 奶量是记下的奶量，不知道宝宝有没有喝完，所以界面一直写“估算”。
 */

export const nutrientKeys: readonly NutrientKey[] = [
  'energyKcal',
  'proteinG',
  'fatG',
  'carbsG',
  'calciumMg',
  'ironMg',
  'vitaminDUg',
];

const nutrient = (key: NutrientKey, unit: string, decimals: number) => ({
  get label() {
    return t().domain.nutrition[key];
  },
  unit,
  decimals,
});

export const nutrientMeta: Record<NutrientKey, { label: string; unit: string; decimals: number }> =
  {
    energyKcal: nutrient('energyKcal', 'kcal', 0),
    proteinG: nutrient('proteinG', 'g', 1),
    fatG: nutrient('fatG', 'g', 1),
    carbsG: nutrient('carbsG', 'g', 1),
    calciumMg: nutrient('calciumMg', 'mg', 0),
    ironMg: nutrient('ironMg', 'mg', 2),
    vitaminDUg: nutrient('vitaminDUg', 'µg', 1),
  };

/** 1 µg 维生素 D = 40 IU。NIH ODS Vitamin D Fact Sheet（更新于 2025-06-27）。 */
const IU_PER_UG_VITAMIN_D = 40;
/** 1 kcal = 4.184 kJ，食品标签通用的热化学卡路里。 */
const KJ_PER_KCAL = 4.184;

export const iuToUg = (iu: number) => iu / IU_PER_UG_VITAMIN_D;
export const ugToIu = (ug: number) => ug * IU_PER_UG_VITAMIN_D;
export const kjToKcal = (kj: number) => kj / KJ_PER_KCAL;
export const kcalToKj = (kcal: number) => kcal * KJ_PER_KCAL;

// ─── 每 100 ml 冲调后 ───────────────────────────────────────

type FormulaLabel = Pick<FormulaData, 'basis' | 'values' | 'powderGPer100ml'>;

/** 只取认识的营养素，缺失的不写键。 */
function presentNutrients(values: NutrientValues, scale = 1): NutrientValues {
  const result: NutrientValues = {};
  for (const key of nutrientKeys) {
    const value = values[key];
    if (value !== undefined) result[key] = value * scale;
  }
  return result;
}

/**
 * 标签可能按每 100 ml 冲好的奶，也可能按每 100 g 粉。后者只能用标签给的冲调比例换算：
 * 水量和冲好的奶量并不相等（粉本身占体积），不能拿“多少水加几勺”去猜。
 */
export function per100mlValues(formula: FormulaLabel): {
  values: NutrientValues;
  needsRatio: boolean;
} {
  if (formula.basis === 'per100ml') {
    return { values: presentNutrients(formula.values), needsRatio: false };
  }
  if (!formula.powderGPer100ml) return { values: {}, needsRatio: true };
  return {
    values: presentNutrients(formula.values, formula.powderGPer100ml / 100),
    needsRatio: false,
  };
}

export function formulaSnapshot(formula: FormulaData): FormulaSnapshot {
  return { name: formula.name, per100ml: per100mlValues(formula).values };
}

/** 这款奶粉现在缺什么。配置列表和编辑页用来提醒。 */
export function formulaDataGaps(formula: FormulaData): {
  needsRatio: boolean;
  missing: NutrientKey[];
} {
  const { values, needsRatio } = per100mlValues(formula);
  return { needsRatio, missing: nutrientKeys.filter((key) => values[key] === undefined) };
}

// ─── 手动录入 ───────────────────────────────────────────────

export interface FormulaForm {
  name: string;
  basis: FormulaBasis;
  powderGPer100ml: string;
  energyUnit: 'kcal' | 'kj';
  vitaminDUnit: 'ug' | 'iu';
  fields: Record<NutrientKey, string>;
}

const emptyFields = (): Record<NutrientKey, string> => ({
  energyKcal: '',
  proteinG: '',
  fatG: '',
  carbsG: '',
  calciumMg: '',
  ironMg: '',
  vitaminDUg: '',
});

export function emptyFormulaForm(name = ''): FormulaForm {
  return {
    name,
    basis: 'per100ml',
    powderGPer100ml: '',
    energyUnit: 'kcal',
    vitaminDUnit: 'ug',
    fields: emptyFields(),
  };
}

/** 显示用，去掉换算留下的长尾巴。 */
function trimNumber(value: number): string {
  return String(Number(value.toFixed(4)));
}

export function formulaFormFromData(
  formula: Pick<FormulaData, 'name' | 'basis' | 'values' | 'powderGPer100ml'>,
): FormulaForm {
  const form = emptyFormulaForm(formula.name);
  form.basis = formula.basis;
  form.powderGPer100ml =
    formula.powderGPer100ml === undefined ? '' : trimNumber(formula.powderGPer100ml);
  for (const key of nutrientKeys) {
    const value = formula.values[key];
    if (value !== undefined) form.fields[key] = trimNumber(value);
  }
  return form;
}

/**
 * 切换 kcal/kJ、µg/IU 时把已填的数字一起换算。换了单位数字却不变的话，67 kcal 会被悄悄存成 67 kJ；
 * 换算之后数字变了，先填数字后选单位的人也看得见，能改回来。
 */
export function changeFormUnit(
  form: FormulaForm,
  field: 'energy' | 'vitaminD',
  unit: 'kcal' | 'kj' | 'ug' | 'iu',
): FormulaForm {
  const key: NutrientKey = field === 'energy' ? 'energyKcal' : 'vitaminDUg';
  const current = field === 'energy' ? form.energyUnit : form.vitaminDUnit;
  const next: FormulaForm =
    field === 'energy'
      ? { ...form, energyUnit: unit as FormulaForm['energyUnit'] }
      : { ...form, vitaminDUnit: unit as FormulaForm['vitaminDUnit'] };
  const value = parseAmount(form.fields[key]);
  if (current === unit || value === null || value === undefined) return next;
  const convert: Record<string, (n: number) => number> = {
    kj: kcalToKj,
    kcal: kjToKcal,
    iu: ugToIu,
    ug: iuToUg,
  };
  const converted = convert[unit]?.(value) ?? value;
  next.fields = { ...form.fields, [key]: trimNumber(converted) };
  return next;
}

function parseAmount(text: string): number | undefined | null {
  const trimmed = text.trim().replace(',', '.');
  if (!trimmed) return undefined;
  const value = Number(trimmed);
  return Number.isFinite(value) && value >= 0 && value <= 100_000 ? value : null;
}

export type FormulaFormResult = { ok: true; data: FormulaData } | { ok: false; error: string };

/** 空着的保持缺失，填错的报错：两者都不能悄悄变成 0。 */
export function formulaFromForm(form: FormulaForm, existing?: FormulaData): FormulaFormResult {
  const name = form.name.trim();
  if (!name) return { ok: false, error: t().domain.nutrition.needName };
  const values: NutrientValues = {};
  for (const key of nutrientKeys) {
    const parsed = parseAmount(form.fields[key]);
    if (parsed === null)
      return { ok: false, error: t().domain.nutrition.badNumber(nutrientMeta[key].label) };
    if (parsed === undefined) continue;
    if (key === 'energyKcal' && form.energyUnit === 'kj') values[key] = kjToKcal(parsed);
    else if (key === 'vitaminDUg' && form.vitaminDUnit === 'iu') values[key] = iuToUg(parsed);
    else values[key] = parsed;
  }
  const ratio = form.basis === 'per100g' ? parseAmount(form.powderGPer100ml) : undefined;
  if (ratio === null || ratio === 0 || (ratio !== undefined && ratio > 100)) {
    return { ok: false, error: t().domain.nutrition.badRatio };
  }
  const { powderGPer100ml: _old, ...rest } = existing ?? {};
  const data: FormulaData = { ...rest, type: 'formula', name, basis: form.basis, values };
  if (ratio !== undefined) data.powderGPer100ml = ratio;
  return { ok: true, data };
}

// ─── 一天的汇总和判断 ───────────────────────────────────────

/** 少于这么多次，或者记录集中在一小段时间，多半有漏记，分不清是“少”还是“没记”。 */
const MIN_FEEDS_FOR_CONCLUSION = 4;
const MIN_SPAN_FOR_CONCLUSION_MS = 12 * 3_600_000;
/** 过了这个月龄辅食是正常来源，只看奶不能说不够。来源同健康规则：约 6 个月开始添加辅食。 */
const SOLIDS_AGE_MONTHS = 6;
/** 吃药记录可能是补充剂（维生素 D 滴剂、铁剂），这几项不能只看奶。 */
const SUPPLEMENT_NUTRIENTS: readonly NutrientKey[] = ['calciumMg', 'ironMg', 'vitaminDUg'];

export type NutrientStatus = 'progress' | 'met' | 'below' | 'insufficient' | 'no-reference';

export interface NutrientResult {
  key: NutrientKey;
  /**
   * 算进去的部分，不是当天的全部摄入。没有任何一次能算这一项时是 null，
   * 不能写成 0：0 的意思是“没吃到”，这里的意思是“不知道”。
   */
  amount: number | null;
  target: NutrientTarget | null;
  /** 向下取整，差一点的不会显示成 100%。 */
  percent: number | null;
  status: NutrientStatus;
  text: string;
  /** 只针对这一项的说明，比如标签没填。 */
  note: string | null;
}

export interface DayNutrition {
  ended: boolean;
  feeds: number;
  countedFeeds: number;
  countedMl: number;
  /** 喂奶里有几次完全算不进去。 */
  uncountedFeeds: number;
  /** 整天层面的说明，每条都是一句话，直接显示。 */
  reasons: string[];
  nutrients: NutrientResult[];
}

export interface DayNutritionInput {
  events: readonly EventData[];
  /** 这一天的范围由调用方按手机时区算好，这里不判断“今天”。 */
  dayStart: number;
  dayEnd: number;
  now: number;
  ageMonths: number;
  reference: NutritionReferenceUse;
}

type Feed = Extract<EventData, { type: 'feed' }>;

function hasAnyValue(per100ml: NutrientValues): boolean {
  return nutrientKeys.some((key) => per100ml[key] !== undefined);
}

export function assessDayNutrition(input: DayNutritionInput): DayNutrition {
  const { dayStart, dayEnd, now, ageMonths, reference } = input;
  const inDay = input.events.filter((e) => e.at >= dayStart && e.at < dayEnd && e.at <= now);
  const feeds = inDay.filter((e): e is Feed => e.type === 'feed');
  const ended = now >= dayEnd;

  let unmarked = 0;
  let noFormula = 0;
  let breast = 0;
  let mixed = 0;
  let noData = 0;
  const counted: { ml: number; per100ml: NutrientValues }[] = [];
  for (const feed of feeds) {
    if (!feed.milkType) unmarked += 1;
    else if (feed.milkType === 'breast') breast += 1;
    else if (feed.milkType === 'mixed') mixed += 1;
    else if (!feed.formula) noFormula += 1;
    else if (!hasAnyValue(feed.formula.per100ml)) noData += 1;
    else counted.push({ ml: feed.ml, per100ml: feed.formula.per100ml });
  }
  const uncountedFeeds = unmarked + noFormula + breast + mixed + noData;

  const text = t().domain.nutrition;
  const reasons: string[] = [];
  if (feeds.length === 0) reasons.push(text.noFeeds);
  if (unmarked > 0) reasons.push(text.unmarked(unmarked));
  if (noFormula > 0) reasons.push(text.noFormula(noFormula));
  if (breast > 0) reasons.push(text.breast(breast));
  if (mixed > 0) reasons.push(text.mixed(mixed));
  if (noData > 0) reasons.push(text.noData(noData));

  // 已结束的日子才有“记得够不够”的问题，今天本来就还没记完。
  let thinRecord = false;
  if (ended && feeds.length > 0) {
    const times = feeds.map((feed) => feed.at);
    if (feeds.length < MIN_FEEDS_FOR_CONCLUSION) {
      thinRecord = true;
      reasons.push(text.thinCount(feeds.length));
    } else if (Math.max(...times) - Math.min(...times) < MIN_SPAN_FOR_CONCLUSION_MS) {
      thinRecord = true;
      reasons.push(text.thinSpan);
    }
  }
  const blocked = feeds.length === 0 || uncountedFeeds > 0 || thinRecord;

  const hasSolids = inDay.some((e) => e.type === 'solids');
  const solidsMatter = hasSolids || ageMonths >= SOLIDS_AGE_MONTHS;
  const hasMed = inDay.some((e) => e.type === 'med');

  const band = referenceBandFor(reference.table, ageMonths);
  let solidsNoted = false;
  let medNoted = false;
  const nutrients = nutrientKeys.map((key): NutrientResult => {
    let total = 0;
    let missing = 0;
    for (const feed of counted) {
      const value = feed.per100ml[key];
      if (value === undefined) missing += 1;
      else total += (value * feed.ml) / 100;
    }
    const amount = missing < counted.length ? total : null;
    const target = band?.amounts[key] ?? null;
    const percent = target && amount !== null ? Math.floor((amount / target.amount) * 100) : null;
    const note = missing > 0 ? text.missingField(missing) : null;
    const result = { key, amount, target, percent, note };
    if (blocked || missing > 0)
      return { ...result, status: 'insufficient', text: text.insufficient };
    if (!target) return { ...result, status: 'no-reference', text: text.noReference };
    if (!ended) return { ...result, status: 'progress', text: text.progress(percent) };
    if (total >= target.amount) return { ...result, status: 'met', text: text.met };
    // 奶以外的来源没记或没法估算：“够”可以说，“不够”不能说。
    const medMatters = hasMed && SUPPLEMENT_NUTRIENTS.includes(key);
    if (solidsMatter || medMatters) {
      if (solidsMatter) solidsNoted = true;
      else medNoted = true;
      return { ...result, status: 'insufficient', text: text.insufficient };
    }
    return { ...result, status: 'below', text: text.below };
  });
  if (solidsNoted) reasons.push(text.solidsNote);
  if (medNoted) reasons.push(text.medNote);

  return {
    ended,
    feeds: feeds.length,
    countedFeeds: counted.length,
    countedMl: counted.reduce((sum, feed) => sum + feed.ml, 0),
    uncountedFeeds,
    reasons,
    nutrients,
  };
}

/** 今天页入口的一句话，克制，不说够不够。没有喂奶记录时不显示入口。 */
export function nutritionEntryText(day: DayNutrition): string | null {
  if (day.feeds === 0) return null;
  const text = t().domain.nutrition;
  if (day.uncountedFeeds > 0) return text.entryUncounted(day.uncountedFeeds);
  const first = day.nutrients.find((n) => n.status === 'progress');
  if (first) return text.entryProgress(nutrientMeta[first.key].label, first.percent);
  return day.nutrients.every((n) => n.status === 'no-reference')
    ? text.entryIntakeOnly
    : text.insufficient;
}

export function formatNutrientAmount(key: NutrientKey, amount: number): string {
  const { unit, decimals } = nutrientMeta[key];
  return `${amount.toFixed(decimals)} ${unit}`;
}

/** 列表里的一行数量。数据不足时写“已算”，不让人把算进去的部分当成当天的总量。 */
export function nutrientAmountText(nutrient: NutrientResult): string {
  const { key, amount, target, status } = nutrient;
  const text = t().domain.nutrition;
  const prefix = status === 'insufficient' ? text.countedPrefix : '';
  const head = amount === null ? '—' : `${prefix}${formatNutrientAmount(key, amount)}`;
  return target ? text.reference(head, formatNutrientAmount(key, target.amount)) : head;
}
