import type { Units } from '../domain/units';
import type { UnitPrefs } from '../schemas';
import { CN } from './cn';

export * from './moneyCategories';

import { OTHER } from './other';
import { SG } from './sg';
import type { RegionDefinition } from './types';
import { US } from './us';

export type {
  OptionalVaccines,
  PaperSize,
  RegionDefinition,
  RegionMoney,
  ReviewStatus,
  VaccineSource,
} from './types';

/** 新增国家：加一个数据文件，再在这里登记。页面都是按这个列表和字段渲染的，不用改。 */
export const regions = { SG, CN, US, OTHER } as const;

export const regionList: readonly RegionDefinition[] = [SG, CN, US, OTHER];

/**
 * - 没有地区：只可能来自只支持新加坡的 v0.1.0。线上已经有这样的档案，按 OTHER 处理会清空它们的疫苗本。
 *   新家庭建档时一定会写地区。
 * - 不认识的地区（新版本写入、这个版本还没有数据文件）：按 OTHER，不能套用别国的方案。
 */
export function regionFor(id: string | undefined): RegionDefinition {
  if (id === undefined) return SG;
  return regionList.find((region) => region.id === id) ?? OTHER;
}

/** 建档时的默认值，来自系统地区代码。猜不到时是 OTHER，由用户自己选。 */
export function guessRegionId(regionCode: string | null | undefined): string {
  const code = regionCode?.toUpperCase();
  return regionList.find((region) => region.id === code)?.id ?? OTHER.id;
}

/** 单位属于个人：自己改过的优先，其余跟随家庭的地区。 */
export function effectiveUnits(prefs: UnitPrefs | undefined, regionId: string | undefined): Units {
  const defaults = regionFor(regionId).defaultUnits;
  return {
    volume: prefs?.volume ?? defaults.volume,
    temperature: prefs?.temperature ?? defaults.temperature,
    weight: prefs?.weight ?? defaults.weight,
    length: prefs?.length ?? defaults.length,
  };
}
