import { getLocale, L, type Localized, localized, t } from '../i18n';
import type { ReviewStatus } from '../regions/types';
import type { NutrientValues } from '../schemas';

export type NutrientKey = keyof Pick<
  NutrientValues,
  'energyKcal' | 'proteinG' | 'fatG' | 'carbsG' | 'calciumMg' | 'ironMg' | 'vitaminDUg'
>;

export interface NutrientTarget {
  amount: number;
  /** AI 是健康母乳喂养婴儿的平均摄入，RDA 是推荐量，意思不完全一样，界面统称“参考量”。 */
  kind: 'AI' | 'RDA';
}

export interface ReferenceBand {
  fromMonths: number;
  /** 不含。 */
  toMonths: number;
  amounts: Partial<Record<NutrientKey, NutrientTarget>>;
}

export interface NutritionReferenceTable {
  id: string;
  name: string;
  source: { label: string; url: string; version: string };
  bands: readonly ReferenceBand[];
}

/**
 * 美国和加拿大共用的 DRI（IOM / Food and Nutrition Board）。2026-11-01 读取。
 *
 * - 钙：NIH ODS Calcium Fact Sheet for Health Professionals，Table 1（更新于 2025-07-11）。
 *   0–6 个月 200 mg（AI），7–12 个月 260 mg（AI）。
 * - 铁：NIH ODS Iron，Table 1（更新于 2025-09-04）。0–6 个月 0.27 mg（AI），7–12 个月 11 mg（RDA）。
 * - 维生素 D：NIH ODS Vitamin D，Table 2（更新于 2025-06-27）。0–12 个月 10 µg（400 IU，AI）。
 * - 蛋白质、脂肪、碳水：Health Canada “Dietary Reference Intakes Tables: Reference values for
 *   macronutrients”，转载 IOM 2005 的表。0–6 个月蛋白质 9.1、脂肪 31、碳水 60 g/天（都是 AI）；
 *   7–12 个月蛋白质 11.0（RDA）、脂肪 30、碳水 95 g/天（AI）。
 *
 * 这四个页面在开发环境直连都返回 403 或连接失败，读的都是 Internet Archive 2025 年的副本。
 * NIH ODS 是原文的副本，算读到原文。Health Canada 的表也是副本，而且它自己是转载 IOM，IOM 的书没有读到正文。
 *
 * 不放的内容，都是因为没有可靠依据能直接用：
 * - 能量：NASEM 2023 的公式要性别、月龄、身长、体重，App 不知道性别；FAO/WHO/UNU 的表也分性别。
 *   所以能量只显示摄入量，不作比较。
 * - 上限（UL）：不做“超过上限”的判断。配方奶的铁远高于母乳的 AI，这本身不是问题。
 * - 12 个月以上：奶不再是主要来源，比较没有意义。
 */
const iomDri: NutritionReferenceTable = localized({
  id: 'iom-dri',
  name: L('美国 IOM / NIH 的膳食参考摄入量', 'US IOM / NIH dietary reference intakes'),
  source: localized({
    label: L(
      'NIH Office of Dietary Supplements；Health Canada 转载的 IOM 2005 宏量营养素表',
      'NIH Office of Dietary Supplements; IOM 2005 macronutrient table as reproduced by Health Canada',
    ),
    url: 'https://ods.od.nih.gov/factsheets/list-all/',
    version: L(
      '钙 2025-07-11、铁 2025-09-04、维生素 D 2025-06-27（NIH ODS）；宏量营养素 IOM 2005',
      'Calcium 2025-07-11, iron 2025-09-04, vitamin D 2025-06-27 (NIH ODS); macronutrients IOM 2005',
    ),
  }),
  bands: [
    {
      fromMonths: 0,
      toMonths: 6,
      amounts: {
        proteinG: { amount: 9.1, kind: 'AI' },
        fatG: { amount: 31, kind: 'AI' },
        carbsG: { amount: 60, kind: 'AI' },
        calciumMg: { amount: 200, kind: 'AI' },
        ironMg: { amount: 0.27, kind: 'AI' },
        vitaminDUg: { amount: 10, kind: 'AI' },
      },
    },
    {
      fromMonths: 6,
      toMonths: 12,
      amounts: {
        proteinG: { amount: 11, kind: 'RDA' },
        fatG: { amount: 30, kind: 'AI' },
        carbsG: { amount: 95, kind: 'AI' },
        calciumMg: { amount: 260, kind: 'AI' },
        ironMg: { amount: 11, kind: 'RDA' },
        vitaminDUg: { amount: 10, kind: 'AI' },
      },
    },
  ],
});

export interface NutritionReferenceUse {
  table: NutritionReferenceTable;
  /** 这张表对这个地区是不是对照当地原文的。 */
  reviewStatus: ReviewStatus;
  /** 界面上和来源放在一起的一句说明。 */
  note: string | null;
}

export const nutritionReferenceIom: NutritionReferenceUse = {
  table: iomDri,
  reviewStatus: 'primary-source',
  note: null,
};

/**
 * 当地的推荐量没读到原文的地区，先用同一张表并写明。中国营养学会 DRIs 2023 是出版物，WS/T 578
 * 的 PDF 在开发环境连不上（TLS 被断开），搜索也只找到书目和摘要，所以没有一个数字是读到的，
 * 不能凭记忆写。读到后加一张表，再把对应地区指过去就行，页面不用改。见 PROGRESS F-113。
 */
export function nutritionReferenceFallback(reason: Localized): NutritionReferenceUse {
  return {
    table: iomDri,
    reviewStatus: 'needs-review',
    get note() {
      return t().domain.nutrition.fallbackNote(reason[getLocale()]);
    },
  };
}

export function referenceBandFor(
  table: NutritionReferenceTable,
  ageMonths: number,
): ReferenceBand | null {
  return table.bands.find((b) => ageMonths >= b.fromMonths && ageMonths < b.toMonths) ?? null;
}
