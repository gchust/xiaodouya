import { metricUnits } from '../domain/units';
import { nutritionReferenceFallback } from '../health/nutritionReferences';
import { L, localized } from '../i18n';
import { genericMoneyInCategoryIds } from './moneyCategories';
import type { RegionDefinition } from './types';

/** 用户选了“其他地区”，或者地区这个版本还不认识。没有疫苗表就不做提醒，宁可不提示，也不套用别国的方案。 */
export const OTHER: RegionDefinition = localized({
  id: 'OTHER',
  name: L('其他地区', 'Other regions'),
  vaccineSchedule: [],
  source: null,
  reviewStatus: 'no-schedule',
  disclaimer: L(
    '这里只保存你们记下的疫苗和安排，不是接种建议，以诊所安排和健康手册为准。',
    "This only keeps the vaccines and plans you record. It is not vaccination advice. Your clinic's plan and health record book take precedence.",
  ),
  emptyScheduleNote: L(
    '这个地区还没有内置的疫苗表。打过的和打算打的疫苗都可以自己记下来，家人都能看到。',
    'There is no built-in vaccine schedule for this region yet. You can record vaccines already given and planned, and your family can see them.',
  ),
  nutrition: nutritionReferenceFallback(
    L('当地的推荐量可能不同', 'Local recommended amounts may differ'),
  ),
  documentSuggestions: L<readonly string[]>(
    ['出生证明', '护照', '儿童健康手册', '体检报告', '疫苗接种证明', '保险单', '医疗收据'],
    [
      'Birth certificate',
      'Passport',
      'Child health booklet',
      'Checkup report',
      'Vaccination certificate',
      'Insurance policy',
      'Medical receipt',
    ],
  ),
  defaultUnits: metricUnits,
  paperSize: 'A4',
  money: { categories: genericMoneyInCategoryIds },
});
