import type { Units } from '../domain/units';
import type { VaccineDose } from '../domain/vaccines';

export type PaperSize = 'A4' | 'Letter';

export interface VaccineSource {
  label: string;
  url: string;
  version: string;
}

/**
 * - primary-source：疫苗表对照官方或权威机构的原文写成。
 * - needs-review：没读到原文，用的是二手来源，文件里的注释写明了来源。
 * - no-schedule：这个地区没有内置疫苗表。
 *
 * 不管哪一种都还没有经过当地医护复核，见 PROGRESS 的 F-100。
 */
export type ReviewStatus = 'primary-source' | 'needs-review' | 'no-schedule';

/** 一个地区的全部差异都在这里，页面只读这些字段，不判断具体是哪个地区。 */
export interface RegionDefinition {
  /** 存进 `BabyData.region`，大写的 ISO 3166-1 代码，要和系统地区代码对得上。 */
  id: string;
  name: string;
  vaccineSchedule: readonly VaccineDose[];
  source: VaccineSource | null;
  reviewStatus: ReviewStatus;
  /** 疫苗本和接种弹层底部的说明。必须包含“以诊所安排和健康手册为准”。 */
  disclaimer: string;
  /** 没有疫苗表时，疫苗本上的解释。 */
  emptyScheduleNote?: string;
  documentSuggestions: readonly string[];
  defaultUnits: Units;
  paperSize: PaperSize;
}
