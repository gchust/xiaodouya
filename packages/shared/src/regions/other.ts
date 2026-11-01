import { metricUnits } from '../domain/units';
import type { RegionDefinition } from './types';

/** 用户选了“其他地区”，或者地区这个版本还不认识。没有疫苗表就不做提醒，宁可不提示，也不套用别国的方案。 */
export const OTHER: RegionDefinition = {
  id: 'OTHER',
  name: '其他地区',
  vaccineSchedule: [],
  source: null,
  reviewStatus: 'no-schedule',
  disclaimer: '这里只保存打过的疫苗，不是接种建议，以诊所安排和健康手册为准。',
  emptyScheduleNote: '这个地区还没有内置的疫苗表。打过的疫苗可以自己记下来，家人都能看到。',
  documentSuggestions: [
    '出生证明',
    '护照',
    '儿童健康手册',
    '体检报告',
    '疫苗接种证明',
    '保险单',
    '医疗收据',
  ],
  defaultUnits: metricUnits,
  paperSize: 'A4',
};
