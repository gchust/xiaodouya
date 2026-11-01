import { metricUnits } from '../domain/units';
import { defineSchedule } from '../domain/vaccines';
import { nutritionReferenceFallback } from '../health/nutritionReferences';
import type { RegionDefinition } from './types';

const JE = '减毒活疫苗和灭活疫苗二选一，由接种单位安排';
const HEPA = '减毒活疫苗 1 剂，或灭活疫苗 2 剂，二选一，由接种单位安排';

/**
 * 《国家免疫规划疫苗儿童免疫程序及说明（2026 年版）》，国家疾控局、国家卫生健康委，2026 年 6 月。
 *
 * 读到的原文：中国疾控中心网站上的 PDF，看了免疫程序表的图片和第二部分每种疫苗的说明：
 * https://www.chinacdc.cn/jkyj/mygh02/yfjzfw/mycx/202607/P020260706520776746753.pdf
 * 同一份文件的发布页在国家疾控局网站，开发环境连不上，没有打开过：
 * https://www.ndcpa.gov.cn/jbkzzx/c100014/common/content/content_2073005020766703616.html
 * 新华社 2026-07-07 的报道（通过 Internet Archive 读到）印证了百白破从 2 月龄起、共 5 剂：
 * https://www.news.cn/politics/20260707/8a1dfcdac2f942c99070a3125f3eeea4/c.html
 *
 * 这里只有国家免疫规划疫苗。各省可能另外增加项目，自费疫苗也不在表内，都可以记成自定义疫苗。
 * HBsAg 阳性产妇所生新生儿等特殊情况的安排不同，由接种单位决定，所以界面注明以诊所为准。
 */
export const CN: RegionDefinition = {
  id: 'CN',
  name: '中国大陆',
  vaccineSchedule: defineSchedule('cn', [
    { id: 'bcg', name: '卡介苗 BCG', months: 0, ageLabel: '出生时' },
    {
      id: 'hepb-1',
      name: '乙肝疫苗 HepB 第 1 剂',
      months: 0,
      ageLabel: '出生时',
      note: '出生后 24 小时内',
    },
    { id: 'hepb-2', name: '乙肝疫苗 HepB 第 2 剂', months: 1, ageLabel: '1 月龄' },
    { id: 'ipv-1', name: '脊灰灭活疫苗 IPV 第 1 剂', months: 2, ageLabel: '2 月龄' },
    { id: 'dtap-1', name: '百白破疫苗 DTaP 第 1 剂', months: 2, ageLabel: '2 月龄' },
    { id: 'ipv-2', name: '脊灰灭活疫苗 IPV 第 2 剂', months: 3, ageLabel: '3 月龄' },
    { id: 'bopv-1', name: '脊灰减毒活疫苗 bOPV 第 3 剂', months: 4, ageLabel: '4 月龄' },
    { id: 'dtap-2', name: '百白破疫苗 DTaP 第 2 剂', months: 4, ageLabel: '4 月龄' },
    { id: 'hepb-3', name: '乙肝疫苗 HepB 第 3 剂', months: 6, ageLabel: '6 月龄' },
    { id: 'dtap-3', name: '百白破疫苗 DTaP 第 3 剂', months: 6, ageLabel: '6 月龄' },
    { id: 'mpsv-a-1', name: 'A 群流脑多糖疫苗 MPSV-A 第 1 剂', months: 6, ageLabel: '6 月龄' },
    { id: 'mmr-1', name: '麻腮风疫苗 MMR 第 1 剂', months: 8, ageLabel: '8 月龄' },
    {
      id: 'je-l-1',
      name: '乙脑减毒活疫苗 JE-L 第 1 剂',
      months: 8,
      ageLabel: '8 月龄',
      note: JE,
      choice: { group: 'je', option: 'live' },
    },
    {
      id: 'je-i-1',
      name: '乙脑灭活疫苗 JE-I 第 1 剂',
      months: 8,
      ageLabel: '8 月龄',
      note: JE,
      choice: { group: 'je', option: 'inactivated' },
    },
    {
      id: 'je-i-2',
      name: '乙脑灭活疫苗 JE-I 第 2 剂',
      months: 8,
      ageLabel: '8 月龄',
      note: '和第 1 剂间隔 7–10 天',
      choice: { group: 'je', option: 'inactivated' },
    },
    { id: 'mpsv-a-2', name: 'A 群流脑多糖疫苗 MPSV-A 第 2 剂', months: 9, ageLabel: '9 月龄' },
    { id: 'dtap-4', name: '百白破疫苗 DTaP 第 4 剂', months: 18, ageLabel: '18 月龄' },
    { id: 'mmr-2', name: '麻腮风疫苗 MMR 第 2 剂', months: 18, ageLabel: '18 月龄' },
    {
      id: 'hepa-l',
      name: '甲肝减毒活疫苗 HepA-L',
      months: 18,
      ageLabel: '18 月龄',
      note: HEPA,
      choice: { group: 'hepa', option: 'live' },
    },
    {
      id: 'hepa-i-1',
      name: '甲肝灭活疫苗 HepA-I 第 1 剂',
      months: 18,
      ageLabel: '18 月龄',
      note: HEPA,
      choice: { group: 'hepa', option: 'inactivated' },
    },
    {
      id: 'je-l-2',
      name: '乙脑减毒活疫苗 JE-L 第 2 剂',
      months: 24,
      ageLabel: '2 周岁',
      choice: { group: 'je', option: 'live' },
    },
    {
      id: 'je-i-3',
      name: '乙脑灭活疫苗 JE-I 第 3 剂',
      months: 24,
      ageLabel: '2 周岁',
      choice: { group: 'je', option: 'inactivated' },
    },
    {
      id: 'hepa-i-2',
      name: '甲肝灭活疫苗 HepA-I 第 2 剂',
      months: 24,
      ageLabel: '2 周岁',
      choice: { group: 'hepa', option: 'inactivated' },
    },
    {
      id: 'mpsv-ac-1',
      name: 'A 群 C 群流脑多糖疫苗 MPSV-AC 第 3 剂',
      months: 36,
      ageLabel: '3 周岁',
    },
    { id: 'bopv-2', name: '脊灰减毒活疫苗 bOPV 第 4 剂', months: 48, ageLabel: '4 周岁' },
    { id: 'dtap-5', name: '百白破疫苗 DTaP 第 5 剂', months: 72, ageLabel: '6 周岁' },
    {
      id: 'mpsv-ac-2',
      name: 'A 群 C 群流脑多糖疫苗 MPSV-AC 第 4 剂',
      months: 72,
      ageLabel: '6 周岁',
    },
    {
      id: 'je-i-4',
      name: '乙脑灭活疫苗 JE-I 第 4 剂',
      months: 72,
      ageLabel: '6 周岁',
      choice: { group: 'je', option: 'inactivated' },
    },
    {
      id: 'hpv-1',
      name: '双价 HPV 疫苗 2vHPV 第 1 剂',
      months: 156,
      ageLabel: '13 周岁',
      note: '接种对象是 13 周岁女孩',
      kind: 'conditional',
    },
    {
      id: 'hpv-2',
      name: '双价 HPV 疫苗 2vHPV 第 2 剂',
      months: 162,
      ageLabel: '第 1 剂后 6 个月',
      note: '接种对象是 13 周岁女孩',
      kind: 'conditional',
    },
  ]),
  source: {
    label: '《国家免疫规划疫苗儿童免疫程序及说明（2026 年版）》，国家疾控局、国家卫生健康委',
    url: 'https://www.chinacdc.cn/jkyj/mygh02/yfjzfw/mycx/202607/P020260706520776746753.pdf',
    version: '2026 年版（2026 年 6 月）',
  },
  reviewStatus: 'primary-source',
  disclaimer:
    '按《国家免疫规划疫苗儿童免疫程序及说明（2026 年版）》排列，只含国家免疫规划疫苗，以诊所安排和健康手册为准。',
  nutrition: nutritionReferenceFallback('中国营养学会的 DRIs 还没有核对原文'),
  documentSuggestions: [
    '出生医学证明',
    '户口本',
    '护照',
    '预防接种证',
    '母子健康手册',
    '医保卡',
    '体检报告',
    '保险单',
    '医疗收据',
  ],
  defaultUnits: metricUnits,
  paperSize: 'A4',
};
