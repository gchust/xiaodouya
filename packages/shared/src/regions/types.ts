import type { Units } from '../domain/units';
import type { OptionalVaccine, VaccineDose } from '../domain/vaccines';
import type { NutritionReferenceUse } from '../health/nutritionReferences';
import type { ShareTargetId } from './shareTargets';

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

/** 当地免疫规划以外、家里自愿选的疫苗。接种弹层里可以直接选，不进疫苗本的状态和提醒。 */
export interface OptionalVaccines {
  /** 接种弹层里入口的名字，比如“自费疫苗（非免疫规划）”。 */
  title: string;
  /** 列表上方和选中后的说明：月龄只是首针的参考，必须包含“以接种单位安排和说明书为准”。 */
  note: string;
  vaccines: readonly OptionalVaccine[];
}

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
  /** 没有的地区，接种弹层里不出现这个入口。 */
  optionalVaccines?: OptionalVaccines;
  documentSuggestions: readonly string[];
  /** 家人自己的证件（F-137）的建议名称：大人常用的当地证件。 */
  personalDocumentSuggestions: readonly string[];
  /** 每日营养的参考量用哪张表。本地原文没核对时写清楚，界面会显示这句话。 */
  nutrition: NutritionReferenceUse;
  defaultUnits: Units;
  paperSize: PaperSize;
  money: RegionMoney;
  /**
   * 分享链接时直接列出来的聊天 App，按当地常用程度排（issue #94）。只显示手机上装了的，最多 4 个，
   * 其余的在“更多”（系统分享面板）里。目录在 regions/shareTargets.ts。
   */
  shareTargets: readonly ShareTargetId[];
}

/** 小金库在这个地区的默认值。 */
export interface RegionMoney {
  /** 新记一笔时默认的币种（ISO 4217）。没有的地区按手机的国家猜，见 defaultMoneyCurrency。 */
  currency?: string;
  /** 收到时可选的场合，按常用程度排，最后是 `other`。id 在 regions/moneyCategories.ts。 */
  categories: readonly string[];
}
