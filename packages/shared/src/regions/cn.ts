import { metricUnits } from '../domain/units';
import { defineSchedule } from '../domain/vaccines';
import { nutritionReferenceFallback } from '../health/nutritionReferences';
import { L, localized } from '../i18n';
import type { RegionDefinition } from './types';

const JE = L(
  '减毒活疫苗和灭活疫苗二选一，由接种单位安排',
  'Either the live or the inactivated vaccine, arranged by the vaccination site',
);
const HEPA = L(
  '减毒活疫苗 1 剂，或灭活疫苗 2 剂，二选一，由接种单位安排',
  '1 dose of live vaccine, or 2 doses of inactivated vaccine, arranged by the vaccination site',
);

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
export const CN: RegionDefinition = localized({
  id: 'CN',
  name: L('中国大陆', 'Mainland China'),
  vaccineSchedule: defineSchedule('cn', [
    { id: 'bcg', name: L('卡介苗 BCG', 'BCG'), months: 0, ageLabel: L('出生时', 'At birth') },
    {
      id: 'hepb-1',
      name: L('乙肝疫苗 HepB 第 1 剂', 'Hepatitis B (HepB), dose 1'),
      months: 0,
      ageLabel: L('出生时', 'At birth'),
      note: L('出生后 24 小时内', 'Within 24 hours of birth'),
    },
    {
      id: 'hepb-2',
      name: L('乙肝疫苗 HepB 第 2 剂', 'Hepatitis B (HepB), dose 2'),
      months: 1,
      ageLabel: L('1 月龄', '1 month'),
    },
    {
      id: 'ipv-1',
      name: L('脊灰灭活疫苗 IPV 第 1 剂', 'Inactivated polio (IPV), dose 1'),
      months: 2,
      ageLabel: L('2 月龄', '2 months'),
    },
    {
      id: 'dtap-1',
      name: L(
        '百白破疫苗 DTaP 第 1 剂',
        'Diphtheria, tetanus, and acellular pertussis (DTaP), dose 1',
      ),
      months: 2,
      ageLabel: L('2 月龄', '2 months'),
    },
    {
      id: 'ipv-2',
      name: L('脊灰灭活疫苗 IPV 第 2 剂', 'Inactivated polio (IPV), dose 2'),
      months: 3,
      ageLabel: L('3 月龄', '3 months'),
    },
    {
      id: 'bopv-1',
      name: L('脊灰减毒活疫苗 bOPV 第 3 剂', 'Live oral polio (bOPV), dose 3'),
      months: 4,
      ageLabel: L('4 月龄', '4 months'),
    },
    {
      id: 'dtap-2',
      name: L(
        '百白破疫苗 DTaP 第 2 剂',
        'Diphtheria, tetanus, and acellular pertussis (DTaP), dose 2',
      ),
      months: 4,
      ageLabel: L('4 月龄', '4 months'),
    },
    {
      id: 'hepb-3',
      name: L('乙肝疫苗 HepB 第 3 剂', 'Hepatitis B (HepB), dose 3'),
      months: 6,
      ageLabel: L('6 月龄', '6 months'),
    },
    {
      id: 'dtap-3',
      name: L(
        '百白破疫苗 DTaP 第 3 剂',
        'Diphtheria, tetanus, and acellular pertussis (DTaP), dose 3',
      ),
      months: 6,
      ageLabel: L('6 月龄', '6 months'),
    },
    {
      id: 'mpsv-a-1',
      name: L(
        'A 群流脑多糖疫苗 MPSV-A 第 1 剂',
        'Group A meningococcal polysaccharide (MPSV-A), dose 1',
      ),
      months: 6,
      ageLabel: L('6 月龄', '6 months'),
    },
    {
      id: 'mmr-1',
      name: L('麻腮风疫苗 MMR 第 1 剂', 'Measles, mumps, and rubella (MMR), dose 1'),
      months: 8,
      ageLabel: L('8 月龄', '8 months'),
    },
    {
      id: 'je-l-1',
      name: L('乙脑减毒活疫苗 JE-L 第 1 剂', 'Live Japanese encephalitis (JE-L), dose 1'),
      months: 8,
      ageLabel: L('8 月龄', '8 months'),
      note: JE,
      choice: { group: 'je', option: 'live' },
    },
    {
      id: 'je-i-1',
      name: L('乙脑灭活疫苗 JE-I 第 1 剂', 'Inactivated Japanese encephalitis (JE-I), dose 1'),
      months: 8,
      ageLabel: L('8 月龄', '8 months'),
      note: JE,
      choice: { group: 'je', option: 'inactivated' },
    },
    {
      id: 'je-i-2',
      name: L('乙脑灭活疫苗 JE-I 第 2 剂', 'Inactivated Japanese encephalitis (JE-I), dose 2'),
      months: 8,
      ageLabel: L('8 月龄', '8 months'),
      note: L('和第 1 剂间隔 7–10 天', '7–10 days after dose 1'),
      choice: { group: 'je', option: 'inactivated' },
    },
    {
      id: 'mpsv-a-2',
      name: L(
        'A 群流脑多糖疫苗 MPSV-A 第 2 剂',
        'Group A meningococcal polysaccharide (MPSV-A), dose 2',
      ),
      months: 9,
      ageLabel: L('9 月龄', '9 months'),
    },
    {
      id: 'dtap-4',
      name: L(
        '百白破疫苗 DTaP 第 4 剂',
        'Diphtheria, tetanus, and acellular pertussis (DTaP), dose 4',
      ),
      months: 18,
      ageLabel: L('18 月龄', '18 months'),
    },
    {
      id: 'mmr-2',
      name: L('麻腮风疫苗 MMR 第 2 剂', 'Measles, mumps, and rubella (MMR), dose 2'),
      months: 18,
      ageLabel: L('18 月龄', '18 months'),
    },
    {
      id: 'hepa-l',
      name: L('甲肝减毒活疫苗 HepA-L', 'Live hepatitis A (HepA-L)'),
      months: 18,
      ageLabel: L('18 月龄', '18 months'),
      note: HEPA,
      choice: { group: 'hepa', option: 'live' },
    },
    {
      id: 'hepa-i-1',
      name: L('甲肝灭活疫苗 HepA-I 第 1 剂', 'Inactivated hepatitis A (HepA-I), dose 1'),
      months: 18,
      ageLabel: L('18 月龄', '18 months'),
      note: HEPA,
      choice: { group: 'hepa', option: 'inactivated' },
    },
    {
      id: 'je-l-2',
      name: L('乙脑减毒活疫苗 JE-L 第 2 剂', 'Live Japanese encephalitis (JE-L), dose 2'),
      months: 24,
      ageLabel: L('2 周岁', '2 years'),
      choice: { group: 'je', option: 'live' },
    },
    {
      id: 'je-i-3',
      name: L('乙脑灭活疫苗 JE-I 第 3 剂', 'Inactivated Japanese encephalitis (JE-I), dose 3'),
      months: 24,
      ageLabel: L('2 周岁', '2 years'),
      choice: { group: 'je', option: 'inactivated' },
    },
    {
      id: 'hepa-i-2',
      name: L('甲肝灭活疫苗 HepA-I 第 2 剂', 'Inactivated hepatitis A (HepA-I), dose 2'),
      months: 24,
      ageLabel: L('2 周岁', '2 years'),
      choice: { group: 'hepa', option: 'inactivated' },
    },
    {
      id: 'mpsv-ac-1',
      name: L(
        'A 群 C 群流脑多糖疫苗 MPSV-AC 第 3 剂',
        'Group A and C meningococcal polysaccharide (MPSV-AC), dose 3',
      ),
      months: 36,
      ageLabel: L('3 周岁', '3 years'),
    },
    {
      id: 'bopv-2',
      name: L('脊灰减毒活疫苗 bOPV 第 4 剂', 'Live oral polio (bOPV), dose 4'),
      months: 48,
      ageLabel: L('4 周岁', '4 years'),
    },
    {
      id: 'dtap-5',
      name: L(
        '百白破疫苗 DTaP 第 5 剂',
        'Diphtheria, tetanus, and acellular pertussis (DTaP), dose 5',
      ),
      months: 72,
      ageLabel: L('6 周岁', '6 years'),
    },
    {
      id: 'mpsv-ac-2',
      name: L(
        'A 群 C 群流脑多糖疫苗 MPSV-AC 第 4 剂',
        'Group A and C meningococcal polysaccharide (MPSV-AC), dose 4',
      ),
      months: 72,
      ageLabel: L('6 周岁', '6 years'),
    },
    {
      id: 'je-i-4',
      name: L('乙脑灭活疫苗 JE-I 第 4 剂', 'Inactivated Japanese encephalitis (JE-I), dose 4'),
      months: 72,
      ageLabel: L('6 周岁', '6 years'),
      choice: { group: 'je', option: 'inactivated' },
    },
    {
      id: 'hpv-1',
      name: L('双价 HPV 疫苗 2vHPV 第 1 剂', 'Bivalent HPV (2vHPV), dose 1'),
      months: 156,
      ageLabel: L('13 周岁', '13 years'),
      note: L('接种对象是 13 周岁女孩', 'For girls aged 13'),
      kind: 'conditional',
    },
    {
      id: 'hpv-2',
      name: L('双价 HPV 疫苗 2vHPV 第 2 剂', 'Bivalent HPV (2vHPV), dose 2'),
      months: 162,
      ageLabel: L('第 1 剂后 6 个月', '6 months after dose 1'),
      note: L('接种对象是 13 周岁女孩', 'For girls aged 13'),
      kind: 'conditional',
    },
  ]),
  source: localized({
    label: L(
      '《国家免疫规划疫苗儿童免疫程序及说明（2026 年版）》，国家疾控局、国家卫生健康委',
      'China National Immunization Program childhood schedule and instructions (2026 edition). Document is in Chinese; title translated here',
    ),
    url: 'https://www.chinacdc.cn/jkyj/mygh02/yfjzfw/mycx/202607/P020260706520776746753.pdf',
    version: L('2026 年版（2026 年 6 月）', '2026 edition (June 2026)'),
  }),
  reviewStatus: 'primary-source',
  disclaimer: L(
    '按《国家免疫规划疫苗儿童免疫程序及说明（2026 年版）》排列，只含国家免疫规划疫苗，以诊所安排和健康手册为准。',
    "Based on China's National Immunization Program schedule (2026 edition). National program vaccines only. Your clinic's plan and health record book take precedence.",
  ),
  nutrition: nutritionReferenceFallback(
    L(
      '中国营养学会的 DRIs 还没有核对原文',
      'The Chinese Nutrition Society DRIs have not been checked against the original',
    ),
  ),
  documentSuggestions: L<readonly string[]>(
    [
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
    [
      'Birth medical certificate',
      'Household register (hukou)',
      'Passport',
      'Vaccination certificate',
      'Maternal and child health handbook',
      'Medical insurance card',
      'Checkup report',
      'Insurance policy',
      'Medical receipt',
    ],
  ),
  defaultUnits: metricUnits,
  paperSize: 'A4',
});
