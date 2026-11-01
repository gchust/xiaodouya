import { describe, expect, it } from 'vitest';
import {
  assessDayNutrition,
  changeFormUnit,
  type DayNutrition,
  type EventData,
  EventData as EventDataSchema,
  emptyFormulaForm,
  type FormulaData,
  feedMilkFields,
  formulaFormFromData,
  formulaFromForm,
  formulaPresets,
  formulaSnapshot,
  isFormulaData,
  iuToUg,
  kjToKcal,
  lastFeedDefaults,
  type NutrientKey,
  nutrientAmountText,
  nutrientKeys,
  nutritionEntryText,
  parseCollectionData,
  per100mlValues,
  presetsForRegion,
  presetToForm,
  referenceBandFor,
  regionList,
  regions,
  ugToIu,
} from '../src/index';

const HOUR = 3_600_000;
const dayStart = new Date(2026, 5, 10).getTime();
const dayEnd = new Date(2026, 5, 11).getTime();
const afterDay = dayEnd + HOUR;
const during = dayStart + 12 * HOUR;
const reference = regions.US.nutrition;

type Feed = Extract<EventData, { type: 'feed' }>;

const fullLabel = {
  energyKcal: 68,
  proteinG: 1.4,
  fatG: 3.6,
  carbsG: 7.5,
  calciumMg: 50,
  ironMg: 1,
  vitaminDUg: 1.2,
};
const snapshot = { name: '虚构奶粉', per100ml: fullLabel };

function feed(at: number, ml: number, extra: Partial<Feed> = {}): Feed {
  return {
    type: 'feed',
    at,
    ml,
    milkType: 'formula',
    formulaId: 'f1',
    formula: snapshot,
    ...extra,
  };
}

/** 一整天：7 点到 21 点，每 2 小时一次，每次 `ml`。 */
function fullDay(ml: number, extra: Partial<Feed> = {}): Feed[] {
  return Array.from({ length: 8 }, (_, i) => feed(dayStart + (7 + i * 2) * HOUR, ml, extra));
}

function assess(events: EventData[], options: { now?: number; ageMonths?: number } = {}) {
  return assessDayNutrition({
    events,
    dayStart,
    dayEnd,
    now: options.now ?? afterDay,
    ageMonths: options.ageMonths ?? 2,
    reference,
  });
}

const row = (day: DayNutrition, key: NutrientKey) => {
  const found = day.nutrients.find((n) => n.key === key);
  if (!found) throw new Error(`没有 ${key}`);
  return found;
};

describe('单位换算', () => {
  it('维生素 D：1 µg = 40 IU（NIH ODS），互相换算不漂移', () => {
    expect(iuToUg(400)).toBe(10);
    expect(ugToIu(10)).toBe(400);
    expect(ugToIu(iuToUg(51))).toBeCloseTo(51, 6);
  });

  it('能量：1 kcal = 4.184 kJ', () => {
    expect(kjToKcal(418.4)).toBeCloseTo(100, 6);
  });
});

describe('每 100 ml 冲调后的营养', () => {
  const base = { type: 'formula', name: '虚构奶粉' } as const;

  it('标签按每 100 ml 给的，原样用', () => {
    const result = per100mlValues({ ...base, basis: 'per100ml', values: fullLabel });
    expect(result.needsRatio).toBe(false);
    expect(result.values.proteinG).toBe(1.4);
  });

  it('每 100 g 粉按标签的冲调比例换算', () => {
    const result = per100mlValues({
      ...base,
      basis: 'per100g',
      values: { proteinG: 10, calciumMg: 400 },
      powderGPer100ml: 13,
    });
    expect(result.needsRatio).toBe(false);
    expect(result.values.proteinG).toBeCloseTo(1.3, 6);
    expect(result.values.calciumMg).toBeCloseTo(52, 6);
  });

  it('每 100 g 粉缺冲调比例时不换算，也不猜', () => {
    const result = per100mlValues({
      ...base,
      basis: 'per100g',
      values: { proteinG: 10 },
    });
    expect(result.needsRatio).toBe(true);
    expect(result.values).toEqual({});
  });

  it('没填的营养素保持缺失，不当 0', () => {
    const result = per100mlValues({ ...base, basis: 'per100ml', values: { proteinG: 1.4 } });
    expect(result.values.calciumMg).toBeUndefined();
    expect('calciumMg' in result.values).toBe(false);
  });

  it('标签写 0 就是 0，和没填不一样', () => {
    const result = per100mlValues({ ...base, basis: 'per100ml', values: { ironMg: 0 } });
    expect(result.values.ironMg).toBe(0);
  });
});

describe('当天汇总', () => {
  it('按奶量和每 100 ml 的值累加', () => {
    const day = assess([feed(dayStart + 8 * HOUR, 100), feed(dayStart + 11 * HOUR, 50)]);
    expect(row(day, 'proteinG').amount).toBeCloseTo(2.1, 6);
    expect(row(day, 'energyKcal').amount).toBeCloseTo(102, 6);
    expect(day.countedMl).toBe(150);
    expect(day.feeds).toBe(2);
  });

  it('只算这一天的喂奶，边界属于当天的开始', () => {
    const day = assess([
      feed(dayStart, 100),
      feed(dayStart - 1, 100),
      feed(dayEnd, 100),
      feed(dayEnd - 1, 100),
    ]);
    expect(day.feeds).toBe(2);
    expect(day.countedMl).toBe(200);
  });

  it('不算还没发生的喂奶（手机时钟或补记造成）', () => {
    const day = assess([feed(dayStart + 8 * HOUR, 100), feed(dayStart + 20 * HOUR, 100)], {
      now: during,
    });
    expect(day.feeds).toBe(1);
  });

  it('用记录上的快照算，不受后来改配方影响', () => {
    const old = feed(dayStart + 8 * HOUR, 100, {
      formula: { name: '旧配方', per100ml: { proteinG: 1 } },
    });
    const day = assess([old]);
    expect(row(day, 'proteinG').amount).toBeCloseTo(1, 6);
  });
});

describe('已结束的日子才下结论', () => {
  it('全部算进去且够：达到参考量', () => {
    const day = assess(fullDay(120));
    const calcium = row(day, 'calciumMg');
    expect(calcium.target?.amount).toBe(200);
    expect(calcium.status).toBe('met');
    expect(day.reasons).toEqual([]);
  });

  it('全部算进去但不够：低于参考量，不说缺乏', () => {
    const day = assess(fullDay(20));
    const protein = row(day, 'proteinG');
    expect(protein.status).toBe('below');
    expect(protein.percent).toBeLessThan(100);
    expect(JSON.stringify(day)).not.toMatch(/缺乏|不够|吃够/);
  });

  it('差一点也不四舍五入成 100%', () => {
    const per100ml = { proteinG: 1.4 };
    // 总量 9.09g，参考 9.1g。
    const events = fullDay(81.16, { formula: { name: '虚构', per100ml } });
    const protein = row(assess(events), 'proteinG');
    expect(protein.amount).toBeLessThan(9.1);
    expect(protein.status).toBe('below');
    expect(protein.percent).toBeLessThan(100);
  });

  it('正好等于参考量算达到', () => {
    const events = fullDay(100, { formula: { name: '虚构', per100ml: { ironMg: 0.03375 } } });
    expect(row(assess(events), 'ironMg').status).toBe('met');
  });
});

describe('今天还没过完：只说进度', () => {
  const today = () => [feed(dayStart + 8 * HOUR, 120), feed(dayStart + 11 * HOUR, 120)];

  it('不管多少都不下结论', () => {
    const day = assess(today(), { now: during });
    expect(day.ended).toBe(false);
    for (const n of day.nutrients) {
      expect(n.status === 'met' || n.status === 'below').toBe(false);
    }
    const calcium = row(day, 'calciumMg');
    expect(calcium.status).toBe('progress');
    expect(calcium.percent).toBe(60);
    expect(calcium.text).toBe('目前已摄入 60%');
  });

  it('当天的最后一毫秒还算没过完，过了才算结束', () => {
    expect(assess(today(), { now: dayEnd - 1 }).ended).toBe(false);
    expect(assess(today(), { now: dayEnd }).ended).toBe(true);
  });

  it('已经超过参考量也只说进度', () => {
    const day = assess(fullDay(200).slice(0, 3), { now: during });
    const iron = row(day, 'ironMg');
    expect(iron.percent).toBeGreaterThan(100);
    expect(iron.status).toBe('progress');
  });

  it('有没算进去的喂奶时写数据不足和原因', () => {
    const day = assess([...today(), feed(dayStart + 9 * HOUR, 90, { milkType: 'breast' })], {
      now: during,
    });
    expect(row(day, 'calciumMg').status).toBe('insufficient');
    expect(day.reasons.join()).toContain('有 1 次是母乳');
  });
});

describe('数据不足：不安慰', () => {
  /** 无论多少奶量，这些情况都不能出现结论。 */
  function expectNoConclusion(day: DayNutrition) {
    for (const n of day.nutrients) {
      expect(['met', 'below', 'progress']).not.toContain(n.status);
    }
  }

  it('没有喂奶记录', () => {
    const day = assess([]);
    expectNoConclusion(day);
    expect(day.reasons.join()).toContain('没有喂奶记录');
  });

  it('全是母乳', () => {
    const day = assess(fullDay(200, { milkType: 'breast', formula: undefined }));
    expectNoConclusion(day);
    expect(day.reasons).toEqual(['有 8 次是母乳，母乳的成分没法估算，没算进去']);
  });

  it('混合喂养', () => {
    const day = assess(fullDay(200, { milkType: 'mixed', formula: undefined }));
    expectNoConclusion(day);
    expect(day.reasons.join()).toContain('有 8 次是混合喂养');
  });

  it('旧记录没有标类型', () => {
    const old = fullDay(200).map(({ type, at, ml }) => ({ type, at, ml }));
    const day = assess(old);
    expectNoConclusion(day);
    expect(day.reasons).toEqual(['有 8 次喂奶没有标注奶类型，没算进去']);
  });

  it('标了奶粉但没选是哪一款', () => {
    const day = assess(fullDay(200, { formula: undefined, formulaId: undefined }));
    expectNoConclusion(day);
    expect(day.reasons).toEqual(['有 8 次喂奶没有标注奶粉，没算进去']);
  });

  it('奶粉还没有填营养数据（只预置了名字）', () => {
    const day = assess(fullDay(200, { formula: { name: '只有名字', per100ml: {} } }));
    expectNoConclusion(day);
    expect(day.reasons).toEqual(['有 8 次用的奶粉还没有营养数据，没算进去']);
  });

  it('混着一次没标的，别的都够也不能说达到', () => {
    const events = [...fullDay(200), { type: 'feed', at: dayStart + 8 * HOUR, ml: 90 } as Feed];
    const day = assess(events);
    expectNoConclusion(day);
    expect(day.reasons.join()).toContain('有 1 次喂奶没有标注奶类型');
    // 已算进去的量还是如实显示。
    expect(row(day, 'ironMg').amount).toBeGreaterThan(0);
  });

  it('只填了部分字段：缺的显示数据不足，已填的照常判断', () => {
    const day = assess(fullDay(120, { formula: { name: '部分', per100ml: { calciumMg: 50 } } }));
    expect(row(day, 'calciumMg').status).toBe('met');
    const iron = row(day, 'ironMg');
    expect(iron.status).toBe('insufficient');
    // 不知道就是不知道：显示 0 等于说宝宝没吃到。
    expect(iron.amount).toBeNull();
    expect(iron.percent).toBeNull();
    expect(nutrientAmountText(iron)).toBe('— / 参考 0.27 mg');
    expect(iron.text).toBe('数据不足');
    expect(iron.note).toContain('8 次');
  });

  it('一次都没算进去时没有数量，不显示 0', () => {
    const day = assess(fullDay(200, { milkType: 'breast', formula: undefined }));
    const protein = row(day, 'proteinG');
    expect(protein.amount).toBeNull();
    expect(nutrientAmountText(protein)).toBe('— / 参考 9.1 g');
    expect(nutrientAmountText(row(day, 'energyKcal'))).toBe('—');
  });

  it('只算进去一部分时写明是已算的量，不当成当天的总量', () => {
    const day = assess([
      feed(dayStart + 8 * HOUR, 100),
      feed(dayStart + 9 * HOUR, 100, { milkType: 'breast', formula: undefined }),
    ]);
    expect(nutrientAmountText(row(day, 'proteinG'))).toBe('已算 1.4 g / 参考 9.1 g');
  });

  it('标签写 0 就显示 0，和没填不一样', () => {
    const day = assess(fullDay(100, { formula: { name: '虚构', per100ml: { ironMg: 0 } } }));
    const iron = row(day, 'ironMg');
    expect(iron.amount).toBe(0);
    expect(iron.status).toBe('below');
    expect(nutrientAmountText(iron)).toBe('0.00 mg / 参考 0.27 mg');
  });

  it('当天记得太少，可能有漏记，不下结论', () => {
    const day = assess([feed(dayStart + 8 * HOUR, 200), feed(dayStart + 11 * HOUR, 200)]);
    expectNoConclusion(day);
    expect(day.reasons.join()).toContain('只记了 2 次');
  });

  it('记录集中在几个小时内（比如刚开始用 App 那天），不下结论', () => {
    const events = Array.from({ length: 6 }, (_, i) => feed(dayStart + (18 + i) * HOUR, 150));
    const day = assess(events);
    expectNoConclusion(day);
    expect(day.reasons.join()).toContain('时间太集中');
  });

  it('当天吃了辅食：够的可以说达到，不够的不能说低于', () => {
    const solids: EventData = { type: 'solids', at: dayStart + 12 * HOUR, food: '虚构米糊' };
    const day = assess([...fullDay(30), solids], { ageMonths: 7 });
    expect(row(day, 'carbsG').status).toBe('insufficient');
    expect(day.reasons.join()).toContain('辅食没有算进去');
  });

  it('满 6 个月后，没记辅食也不说低于（可能只是没记）', () => {
    const day = assess(fullDay(30), { ageMonths: 7 });
    const iron = row(day, 'ironMg');
    expect(iron.status).toBe('insufficient');
    expect(day.reasons.join()).toContain('辅食没有算进去');
  });

  it('满 6 个月后，光奶粉就够的可以说达到', () => {
    const day = assess(fullDay(200), { ageMonths: 7 });
    expect(row(day, 'calciumMg').status).toBe('met');
  });

  it('当天有吃药记录：矿物质和维生素不说低于，宏量营养素不受影响', () => {
    const med: EventData = { type: 'med', at: dayStart + 12 * HOUR, name: '虚构滴剂' };
    const day = assess([...fullDay(20), med]);
    expect(row(day, 'vitaminDUg').status).toBe('insufficient');
    expect(row(day, 'calciumMg').status).toBe('insufficient');
    expect(day.reasons.join()).toContain('补充剂没有算进去');
    // 奶粉里的铁已经超过 0.27 mg 的参考量，够的照常说。
    expect(row(day, 'ironMg').status).toBe('met');
    expect(row(day, 'proteinG').status).toBe('below');
  });
});

describe('不作比较的情况', () => {
  it('能量没有可靠的参考值：只显示摄入量，不给百分比和结论', () => {
    const energy = row(assess(fullDay(120)), 'energyKcal');
    expect(energy.target).toBeNull();
    expect(energy.percent).toBeNull();
    expect(energy.status).toBe('no-reference');
  });

  it('有没算进去的喂奶时，能量也是数据不足', () => {
    const energy = row(assess(fullDay(120, { milkType: 'breast' })), 'energyKcal');
    expect(energy.status).toBe('insufficient');
  });

  it('满 12 个月后没有这张表的参考值', () => {
    const day = assess(fullDay(120), { ageMonths: 12 });
    expect(row(day, 'calciumMg').status).toBe('no-reference');
    expect(row(day, 'calciumMg').target).toBeNull();
  });
});

describe('推荐量表', () => {
  it('和读到的原文一致（NIH ODS、Health Canada 转载的 IOM 表）', () => {
    const young = referenceBandFor(reference.table, 5)?.amounts;
    expect(young?.calciumMg).toEqual({ amount: 200, kind: 'AI' });
    expect(young?.ironMg).toEqual({ amount: 0.27, kind: 'AI' });
    expect(young?.vitaminDUg).toEqual({ amount: 10, kind: 'AI' });
    expect(young?.proteinG).toEqual({ amount: 9.1, kind: 'AI' });
    expect(young?.fatG).toEqual({ amount: 31, kind: 'AI' });
    expect(young?.carbsG).toEqual({ amount: 60, kind: 'AI' });
    const older = referenceBandFor(reference.table, 6)?.amounts;
    expect(older?.calciumMg).toEqual({ amount: 260, kind: 'AI' });
    expect(older?.ironMg).toEqual({ amount: 11, kind: 'RDA' });
    expect(older?.vitaminDUg).toEqual({ amount: 10, kind: 'AI' });
    expect(older?.proteinG).toEqual({ amount: 11, kind: 'RDA' });
    expect(older?.fatG).toEqual({ amount: 30, kind: 'AI' });
    expect(older?.carbsG).toEqual({ amount: 95, kind: 'AI' });
  });

  it('不放没读到依据的能量和上限', () => {
    for (const band of reference.table.bands) {
      expect(band.amounts.energyKcal).toBeUndefined();
      expect(Object.keys(band.amounts).every((k) => nutrientKeys.includes(k as NutrientKey))).toBe(
        true,
      );
    }
  });

  it('每个地区都声明用哪张表，没核对本地原文的标待复核并写明', () => {
    for (const region of regionList) {
      expect(region.nutrition.table.source.url).toMatch(/^https:/);
      if (region.nutrition.reviewStatus === 'needs-review') {
        expect(region.nutrition.note).toBeTruthy();
      }
    }
    expect(regions.US.nutrition.reviewStatus).toBe('primary-source');
    expect(regions.CN.nutrition.reviewStatus).toBe('needs-review');
    expect(regions.CN.nutrition.note).toContain('中国');
  });
});

describe('预置奶粉', () => {
  it('合生元派星 1 段只有名字，没读到标签就不带数值', () => {
    const preset = formulaPresets.find((p) => p.id === 'biostime-paixing-1');
    expect(preset?.name).toContain('派星');
    expect(preset?.label).toBeNull();
    expect(preset?.regions).toContain('CN');
  });

  it('有数值的预置都写了来源、读取日期和配方版本', () => {
    const withValues = formulaPresets.filter((p) => p.label);
    expect(withValues.length).toBeGreaterThan(0);
    for (const preset of withValues) {
      expect(preset.label?.source.url).toMatch(/^https:/);
      expect(preset.label?.source.readOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(preset.label?.source.version).toBeTruthy();
    }
  });

  it('把标签原文钉住：改数值要回去对照', () => {
    const enfamil = formulaPresets.find((p) => p.id === 'enfamil-neuropro-powder')?.label;
    expect(enfamil?.values).toEqual({
      energyKcal: 68,
      proteinG: 1.42,
      fatG: 3.6,
      carbsG: 7.6,
      calciumMg: 53,
      ironMg: 1.22,
      vitaminDUg: iuToUg(51),
    });
    const similac = formulaPresets.find((p) => p.id === 'similac-360-rtf')?.label;
    expect(similac?.values).toEqual({
      energyKcal: 68,
      proteinG: 1.4,
      fatG: 3.7,
      carbsG: 7.4,
      calciumMg: 53,
      ironMg: 1.2,
      vitaminDUg: iuToUg(41),
    });
  });

  it('id 不重复', () => {
    const ids = formulaPresets.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('当前地区的排前面，别的地区也能选到', () => {
    const cn = presetsForRegion('CN');
    expect(cn[0]?.regions).toContain('CN');
    expect(cn).toHaveLength(formulaPresets.length);
    const us = presetsForRegion('US');
    expect(us[0]?.regions).toContain('US');
  });

  it('选中只有名字的预置：表单里只有名字', () => {
    const preset = formulaPresets.find((p) => p.id === 'biostime-paixing-1');
    if (!preset) throw new Error('缺预置');
    const form = presetToForm(preset);
    expect(form.name).toBe(preset.name);
    expect(form.fields.proteinG).toBe('');
  });
});

describe('手动录入', () => {
  const form = (over: Partial<Parameters<typeof formulaFromForm>[0]> = {}) => ({
    name: '虚构奶粉',
    basis: 'per100ml' as const,
    powderGPer100ml: '',
    energyUnit: 'kcal' as const,
    vitaminDUnit: 'ug' as const,
    fields: {
      energyKcal: '',
      proteinG: '',
      fatG: '',
      carbsG: '',
      calciumMg: '',
      ironMg: '',
      vitaminDUg: '',
    },
    ...over,
  });

  it('名字必填', () => {
    const result = formulaFromForm(form({ name: '  ' }));
    expect(result.ok).toBe(false);
  });

  it('只填名字也能存，营养全部缺失', () => {
    const result = formulaFromForm(form());
    expect(result.ok && result.data.values).toEqual({});
  });

  it('只填部分字段：没填的不写成 0', () => {
    const fields = { ...form().fields, proteinG: '1.4', ironMg: '0' };
    const result = formulaFromForm(form({ fields }));
    expect(result.ok && result.data.values).toEqual({ proteinG: 1.4, ironMg: 0 });
  });

  it('kJ 和 IU 按明确的系数换算后保存', () => {
    const fields = { ...form().fields, energyKcal: '284.5', vitaminDUg: '40' };
    const result = formulaFromForm(form({ fields, energyUnit: 'kj', vitaminDUnit: 'iu' }));
    if (!result.ok) throw new Error('应该成功');
    expect(result.data.values.energyKcal).toBeCloseTo(68, 1);
    expect(result.data.values.vitaminDUg).toBe(1);
  });

  it('接受逗号小数点，不认识的数字报错而不是当 0', () => {
    const comma = formulaFromForm(form({ fields: { ...form().fields, proteinG: '1,4' } }));
    expect(comma.ok && comma.data.values.proteinG).toBe(1.4);
    const bad = formulaFromForm(form({ fields: { ...form().fields, proteinG: '一点' } }));
    expect(bad.ok).toBe(false);
    const negative = formulaFromForm(form({ fields: { ...form().fields, proteinG: '-1' } }));
    expect(negative.ok).toBe(false);
  });

  it('每 100 g 要冲调比例才能换算：没填可以存，但算不出来', () => {
    const fields = { ...form().fields, proteinG: '10' };
    const missing = formulaFromForm(form({ basis: 'per100g', fields }));
    if (!missing.ok) throw new Error('应该能存');
    expect(per100mlValues(missing.data).needsRatio).toBe(true);
    const given = formulaFromForm(form({ basis: 'per100g', fields, powderGPer100ml: '13' }));
    if (!given.ok) throw new Error('应该能存');
    expect(per100mlValues(given.data).values.proteinG).toBeCloseTo(1.3, 6);
  });

  it('冲调比例不合理时报错', () => {
    const result = formulaFromForm(form({ basis: 'per100g', powderGPer100ml: '0' }));
    expect(result.ok).toBe(false);
  });

  it('切换单位时已填的数字跟着换算，换回来还是原值', () => {
    const base = emptyFormulaForm('虚构');
    base.fields.energyKcal = '67';
    base.fields.vitaminDUg = '1.5';
    const kj = changeFormUnit(base, 'energy', 'kj');
    expect(kj.energyUnit).toBe('kj');
    expect(kj.fields.energyKcal).toBe('280.328');
    expect(changeFormUnit(kj, 'energy', 'kcal').fields.energyKcal).toBe('67');
    const iu = changeFormUnit(base, 'vitaminD', 'iu');
    expect(iu.fields.vitaminDUg).toBe('60');
    expect(changeFormUnit(iu, 'vitaminD', 'ug').fields.vitaminDUg).toBe('1.5');
  });

  it('切换单位时空的和填错的不动', () => {
    const base = emptyFormulaForm('虚构');
    expect(changeFormUnit(base, 'energy', 'kj').fields.energyKcal).toBe('');
    base.fields.energyKcal = '一点';
    expect(changeFormUnit(base, 'energy', 'kj').fields.energyKcal).toBe('一点');
  });

  it('改的时候保留预置来源和未知字段，表单能原样回填', () => {
    const existing = {
      type: 'formula',
      name: '虚构奶粉',
      presetId: 'x',
      basis: 'per100ml',
      values: { proteinG: 1.4, vitaminDUg: 1.5 },
      futureField: 1,
    } as FormulaData;
    const filled = formulaFormFromData(existing);
    expect(filled.fields.proteinG).toBe('1.4');
    expect(filled.fields.calciumMg).toBe('');
    const saved = formulaFromForm(filled, existing);
    if (!saved.ok) throw new Error('应该成功');
    expect(saved.data.values).toEqual(existing.values);
    expect(saved.data.presetId).toBe('x');
    expect((saved.data as Record<string, unknown>).futureField).toBe(1);
  });
});

describe('沿用上一次喂奶', () => {
  const formula = (id: string, proteinG: number) => ({
    id,
    data: {
      type: 'formula',
      name: `奶粉${id}`,
      basis: 'per100ml',
      values: { proteinG },
    } as FormulaData,
  });

  it('没有记录时没有默认值', () => {
    expect(lastFeedDefaults([], [], during)).toEqual({ ml: undefined, milkType: undefined });
  });

  it('沿用上一次的奶量、奶类型和奶粉', () => {
    const defaults = lastFeedDefaults(
      [feed(dayStart + HOUR, 90), feed(dayStart + 2 * HOUR, 120)],
      [formula('f1', 1.4)],
      during,
    );
    expect(defaults.ml).toBe(120);
    expect(defaults.milkType).toBe('formula');
    expect(defaults.formulaId).toBe('f1');
  });

  it('快照用奶粉现在的数值：改了配方，之后的喂奶按新的算', () => {
    const defaults = lastFeedDefaults([feed(dayStart + HOUR, 90)], [formula('f1', 2)], during);
    expect(defaults.formula?.per100ml.proteinG).toBe(2);
    expect(defaults.formula?.name).toBe('奶粉f1');
  });

  it('奶粉被删了就不再沿用，也不用旧快照', () => {
    const defaults = lastFeedDefaults([feed(dayStart + HOUR, 90)], [], during);
    expect(defaults.milkType).toBe('formula');
    expect(defaults.formulaId).toBeUndefined();
    expect(defaults.formula).toBeUndefined();
  });

  it('上一次是母乳：不带奶粉', () => {
    const defaults = lastFeedDefaults(
      [
        feed(dayStart + HOUR, 90),
        feed(dayStart + 2 * HOUR, 60, {
          milkType: 'breast',
          formula: undefined,
          formulaId: undefined,
        }),
      ],
      [formula('f1', 1.4)],
      during,
    );
    expect(defaults.milkType).toBe('breast');
    expect(defaults.formulaId).toBeUndefined();
  });

  it('家人用旧版记的没标类型：奶量跟最新的，类型跟最近标过的', () => {
    const defaults = lastFeedDefaults(
      [feed(dayStart + HOUR, 90), { type: 'feed', at: dayStart + 2 * HOUR, ml: 70 }],
      [formula('f1', 1.4)],
      during,
    );
    expect(defaults.ml).toBe(70);
    expect(defaults.formulaId).toBe('f1');
  });

  it('不看还没发生的记录', () => {
    const defaults = lastFeedDefaults(
      [feed(dayStart + HOUR, 90), feed(during + HOUR, 60)],
      [formula('f1', 1.4)],
      during,
    );
    expect(defaults.ml).toBe(90);
  });

  it('feedMilkFields：写进记录的字段，没标的就不写这些键', () => {
    expect(feedMilkFields({ milkType: undefined })).toEqual({});
    expect(feedMilkFields({ milkType: 'breast' })).toEqual({ milkType: 'breast' });
    expect(feedMilkFields({ milkType: 'formula', formulaId: 'f1', formula: snapshot })).toEqual({
      milkType: 'formula',
      formulaId: 'f1',
      formula: snapshot,
    });
  });
});

describe('快照', () => {
  it('写入换算后的每 100 ml，缺比例时是空的', () => {
    const data = {
      type: 'formula',
      name: '虚构',
      basis: 'per100g',
      values: { proteinG: 10 },
    } as FormulaData;
    expect(formulaSnapshot(data).per100ml).toEqual({});
    expect(formulaSnapshot({ ...data, powderGPer100ml: 13 }).per100ml.proteinG).toBeCloseTo(1.3, 6);
  });
});

describe('今天页的入口文字', () => {
  it('没有喂奶记录时不显示入口', () => {
    expect(nutritionEntryText(assess([], { now: during }))).toBeNull();
  });

  it('全部算进去时说进度，不说够不够', () => {
    const text = nutritionEntryText(assess([feed(dayStart + 8 * HOUR, 120)], { now: during }));
    expect(text).toMatch(/^目前已摄入/);
  });

  it('没有参考量时（满 12 个月）不能写成数据不足', () => {
    const text = nutritionEntryText(
      assess([feed(dayStart + 8 * HOUR, 120)], { now: during, ageMonths: 12 }),
    );
    expect(text).toBe('只显示摄入量');
  });

  it('奶粉只填了能量：没有能比较的项，算数据不足', () => {
    const only = { name: '虚构', per100ml: { energyKcal: 68 } };
    const text = nutritionEntryText(
      assess([feed(dayStart + 8 * HOUR, 120, { formula: only })], { now: during }),
    );
    expect(text).toBe('数据不足');
  });

  it('有没算进去的喂奶时说明数量', () => {
    const text = nutritionEntryText(
      assess(
        [
          feed(dayStart + 8 * HOUR, 120, { milkType: 'breast' }),
          { type: 'feed', at: dayStart + 9 * HOUR, ml: 90 },
          feed(dayStart + 10 * HOUR, 90),
        ],
        { now: during },
      ),
    );
    expect(text).toBe('数据不足 · 有 2 次喂奶没算进去');
  });
});

describe('和旧版本兼容', () => {
  const oldFeed = { type: 'feed', at: 1, ml: 90 };

  it('v0.1.0 的喂奶记录照常能读', () => {
    expect(parseCollectionData('event', oldFeed)).toEqual(oldFeed);
  });

  it('不认识的奶类型只丢这一项，整条记录不能消失', () => {
    const parsed = EventDataSchema.parse({ ...oldFeed, milkType: 'juice' });
    expect(parsed).toMatchObject(oldFeed);
    expect((parsed as Feed).milkType).toBeUndefined();
  });

  it('快照格式不对也只丢这一项，整条记录不能消失', () => {
    const parsed = EventDataSchema.parse({
      ...oldFeed,
      milkType: 'formula',
      formulaId: 'x',
      formula: { name: 1 },
    });
    expect((parsed as Feed).formula).toBeUndefined();
    expect((parsed as Feed).milkType).toBe('formula');
  });

  it('营养值格式不对：这一项当缺失，不能算成 0，也不能丢记录', () => {
    const parsed = EventDataSchema.parse({
      ...oldFeed,
      milkType: 'formula',
      formula: { name: '虚构', per100ml: { proteinG: 'x', ironMg: 1 } },
    }) as Feed;
    expect(parsed.formula?.per100ml.proteinG).toBeUndefined();
    expect(parsed.formula?.per100ml.ironMg).toBe(1);
  });

  it('奶粉配置走 event 集合，但不是一条记录', () => {
    const data = { type: 'formula', name: '虚构', basis: 'per100ml', values: {} };
    const parsed = parseCollectionData('event', data);
    expect(parsed && isFormulaData(parsed)).toBe(true);
    // v0.1.0 用这个联合校验 event 集合：校验不过的保留在本地但不显示。
    expect(EventDataSchema.safeParse(data).success).toBe(false);
  });

  it('奶粉配置不能有 at：v0.1.0 收到带 at 的新记录会弹“记录了 undefined”的横幅', () => {
    const saved = formulaFromForm({
      name: '虚构',
      basis: 'per100ml',
      powderGPer100ml: '',
      energyUnit: 'kcal',
      vitaminDUnit: 'ug',
      fields: {
        energyKcal: '',
        proteinG: '',
        fatG: '',
        carbsG: '',
        calciumMg: '',
        ironMg: '',
        vitaminDUg: '',
      },
    });
    if (!saved.ok) throw new Error('应该成功');
    expect('at' in saved.data).toBe(false);
  });

  it('奶粉配置的 basis 不认识时不显示，也不能猜', () => {
    expect(
      parseCollectionData('event', { type: 'formula', name: '虚构', basis: 'x', values: {} }),
    ).toBeNull();
  });
});
