import { defineSchedule } from '../domain/vaccines';
import { nutritionReferenceIom } from '../health/nutritionReferences';
import { L, localized } from '../i18n';
import type { RegionDefinition } from './types';

/**
 * 美国儿科学会（AAP）Recommended Child and Adolescent Immunization Schedule, United States, 2026。
 * 2026-01-26 发布，读到的是 2026-09-02 更新的 PDF（Table 1 看了图片，各疫苗看了 Notes）：
 * https://downloads.aap.org/AAP/PDF/AAP-Immunization-Schedule.pdf
 *
 * 选 AAP 而不是 CDC 作为默认：产品决定，见 PROGRESS 的 F-90。AAP Immunization FAQs
 * （https://www.aap.org/en/patient-care/immunizations/aap-immunization-faq/ ，2026-10-08 更新）写明
 * 它的乙肝建议没有随 CDC 的改动而改变，仍是出生后 24 小时内。
 *
 * 没有读到 cdc.gov（返回 403）。二手报道说 CDC 2026 年 1 月的表把乙肝出生剂改成了按母亲情况决定，
 * 2026 年 3 月联邦法院暂时阻止了这些改动，CDC 可能已经改回。现状没能确认，而且还在诉讼中，
 * 所以免责声明不评价 AAP 和 CDC 是否一致，只说明来源是 AAP，并请家长问儿科医生。
 *
 * 表里只放面向所有孩子的剂次和常见的条件性剂次。只针对高危人群或特殊情况的没有列入，
 * 需要时可以记成自定义疫苗：Mpox、登革热、MMR 和 HepA 的提前接种、高危儿童的 MenACWY、
 * RSV 第二季的单抗、孕期的 Abrysvo。
 * 体重不足 2000 克、母亲 HBsAg 阳性等情况的乙肝方案不同，由诊所安排。
 */
export const US: RegionDefinition = localized({
  id: 'US',
  name: L('美国', 'United States'),
  vaccineSchedule: defineSchedule('us', [
    {
      id: 'rsv',
      name: L(
        'RSV 单克隆抗体 RSV-mAb',
        'Respiratory syncytial virus monoclonal antibody (RSV-mAb)',
      ),
      months: 0,
      ageLabel: L('出生–8 个月', 'Birth–8 months'),
      note: L(
        '取决于妈妈孕期是否接种 RSV 疫苗：没打、不清楚或产前不足 14 天才打的，宝宝在 RSV 季节打 1 剂',
        'Depends on whether the mother got an RSV vaccine during pregnancy. If she did not, if it is unknown, or if it was less than 14 days before birth, the baby gets 1 dose during RSV season',
      ),
      kind: 'conditional',
    },
    {
      id: 'hepb-1',
      name: L('乙肝疫苗 HepB 第 1 剂', 'Hepatitis B (HepB), dose\u00a01'),
      months: 0,
      ageLabel: L('出生', 'Birth'),
      note: L('出生后 24 小时内', 'Within 24 hours of birth'),
    },
    {
      id: 'hepb-2',
      name: L('乙肝疫苗 HepB 第 2 剂', 'Hepatitis B (HepB), dose\u00a02'),
      months: 1,
      ageLabel: L('1–2 个月', '1–2 months'),
    },
    {
      id: 'rv-1',
      name: L('轮状病毒疫苗 RV 第 1 剂', 'Rotavirus (RV), dose\u00a01'),
      months: 2,
      ageLabel: L('2 个月', '2 months'),
    },
    {
      id: 'dtap-1',
      name: L(
        '百白破疫苗 DTaP 第 1 剂',
        'Diphtheria, tetanus, and acellular pertussis (DTaP), dose\u00a01',
      ),
      months: 2,
      ageLabel: L('2 个月', '2 months'),
    },
    {
      id: 'hib-1',
      name: L(
        'b 型流感嗜血杆菌疫苗 Hib 第 1 剂',
        'Haemophilus influenzae type b (Hib), dose\u00a01',
      ),
      months: 2,
      ageLabel: L('2 个月', '2 months'),
    },
    {
      id: 'pcv-1',
      name: L('肺炎球菌疫苗 PCV 第 1 剂', 'Pneumococcal conjugate (PCV), dose\u00a01'),
      months: 2,
      ageLabel: L('2 个月', '2 months'),
    },
    {
      id: 'ipv-1',
      name: L('脊灰灭活疫苗 IPV 第 1 剂', 'Inactivated poliovirus (IPV), dose\u00a01'),
      months: 2,
      ageLabel: L('2 个月', '2 months'),
    },
    {
      id: 'rv-2',
      name: L('轮状病毒疫苗 RV 第 2 剂', 'Rotavirus (RV), dose\u00a02'),
      months: 4,
      ageLabel: L('4 个月', '4 months'),
    },
    {
      id: 'dtap-2',
      name: L(
        '百白破疫苗 DTaP 第 2 剂',
        'Diphtheria, tetanus, and acellular pertussis (DTaP), dose\u00a02',
      ),
      months: 4,
      ageLabel: L('4 个月', '4 months'),
    },
    {
      id: 'hib-2',
      name: L(
        'b 型流感嗜血杆菌疫苗 Hib 第 2 剂',
        'Haemophilus influenzae type b (Hib), dose\u00a02',
      ),
      months: 4,
      ageLabel: L('4 个月', '4 months'),
    },
    {
      id: 'pcv-2',
      name: L('肺炎球菌疫苗 PCV 第 2 剂', 'Pneumococcal conjugate (PCV), dose\u00a02'),
      months: 4,
      ageLabel: L('4 个月', '4 months'),
    },
    {
      id: 'ipv-2',
      name: L('脊灰灭活疫苗 IPV 第 2 剂', 'Inactivated poliovirus (IPV), dose\u00a02'),
      months: 4,
      ageLabel: L('4 个月', '4 months'),
    },
    {
      id: 'hepb-3',
      name: L('乙肝疫苗 HepB 第 3 剂', 'Hepatitis B (HepB), dose\u00a03'),
      months: 6,
      ageLabel: L('6–18 个月', '6–18 months'),
    },
    {
      id: 'rv-3',
      name: L('轮状病毒疫苗 RV 第 3 剂', 'Rotavirus (RV), dose\u00a03'),
      months: 6,
      ageLabel: L('6 个月', '6 months'),
      note: L(
        '只有 RotaTeq（RV5）需要；Rotarix（RV1）打 2 剂',
        'Only needed for RotaTeq (RV5). Rotarix (RV1) is 2 doses',
      ),
      kind: 'conditional',
    },
    {
      id: 'dtap-3',
      name: L(
        '百白破疫苗 DTaP 第 3 剂',
        'Diphtheria, tetanus, and acellular pertussis (DTaP), dose\u00a03',
      ),
      months: 6,
      ageLabel: L('6 个月', '6 months'),
    },
    {
      id: 'hib-3',
      name: L(
        'b 型流感嗜血杆菌疫苗 Hib 第 3 剂',
        'Haemophilus influenzae type b (Hib), dose\u00a03',
      ),
      months: 6,
      ageLabel: L('6 个月', '6 months'),
      note: L(
        'ActHIB、Hiberix、Pentacel、Vaxelis 需要；PedvaxHIB 不需要',
        'Needed for ActHIB, Hiberix, Pentacel, Vaxelis. Not needed for PedvaxHIB',
      ),
      kind: 'conditional',
    },
    {
      id: 'pcv-3',
      name: L('肺炎球菌疫苗 PCV 第 3 剂', 'Pneumococcal conjugate (PCV), dose\u00a03'),
      months: 6,
      ageLabel: L('6 个月', '6 months'),
    },
    {
      id: 'ipv-3',
      name: L('脊灰灭活疫苗 IPV 第 3 剂', 'Inactivated poliovirus (IPV), dose\u00a03'),
      months: 6,
      ageLabel: L('6–18 个月', '6–18 months'),
    },
    {
      id: 'flu',
      name: L('流感疫苗 Flu', 'Influenza (Flu)'),
      months: 6,
      ageLabel: L('6 个月起', '6 months and up'),
      note: L(
        '每年接种。8 岁以下之前打过不足 2 剂的，当季打 2 剂，至少间隔 4 周',
        'Every year. Age 8 or younger with fewer than 2 previous doses: 2 doses this season, at least 4 weeks apart',
      ),
    },
    {
      id: 'covid',
      name: L('新冠疫苗 COVID-19', 'COVID-19'),
      months: 6,
      ageLabel: L('6–23 个月', '6–23 months'),
      note: L(
        '2026–2027 版，剂数由医生根据接种史安排',
        '2026–2027 formula. The doctor decides the number of doses based on vaccination history',
      ),
    },
    {
      id: 'hib-booster',
      name: L('b 型流感嗜血杆菌疫苗 Hib 加强剂', 'Haemophilus influenzae type b (Hib), booster'),
      months: 12,
      ageLabel: L('12–15 个月', '12–15 months'),
      note: L('第 3 或第 4 剂，看产品', 'Dose 3 or 4, depending on the product'),
    },
    {
      id: 'pcv-4',
      name: L('肺炎球菌疫苗 PCV 第 4 剂', 'Pneumococcal conjugate (PCV), dose\u00a04'),
      months: 12,
      ageLabel: L('12–15 个月', '12–15 months'),
    },
    {
      id: 'mmr-1',
      name: L('麻腮风疫苗 MMR 第 1 剂', 'Measles, mumps, and rubella (MMR), dose\u00a01'),
      months: 12,
      ageLabel: L('12–15 个月', '12–15 months'),
    },
    {
      id: 'var-1',
      name: L('水痘疫苗 VAR 第 1 剂', 'Varicella (VAR), dose\u00a01'),
      months: 12,
      ageLabel: L('12–15 个月', '12–15 months'),
    },
    {
      id: 'hepa-1',
      name: L('甲肝疫苗 HepA 第 1 剂', 'Hepatitis A (HepA), dose\u00a01'),
      months: 12,
      ageLabel: L('12–23 个月', '12–23 months'),
    },
    {
      id: 'dtap-4',
      name: L(
        '百白破疫苗 DTaP 第 4 剂',
        'Diphtheria, tetanus, and acellular pertussis (DTaP), dose\u00a04',
      ),
      months: 15,
      ageLabel: L('15–18 个月', '15–18 months'),
    },
    {
      id: 'hepa-2',
      name: L('甲肝疫苗 HepA 第 2 剂', 'Hepatitis A (HepA), dose\u00a02'),
      months: 18,
      ageLabel: L('12–23 个月', '12–23 months'),
      note: L('和第 1 剂至少间隔 6 个月', 'At least 6 months after dose 1'),
    },
    {
      id: 'dtap-5',
      name: L(
        '百白破疫苗 DTaP 第 5 剂',
        'Diphtheria, tetanus, and acellular pertussis (DTaP), dose\u00a05',
      ),
      months: 48,
      ageLabel: L('4–6 岁', '4–6 years'),
    },
    {
      id: 'ipv-4',
      name: L('脊灰灭活疫苗 IPV 第 4 剂', 'Inactivated poliovirus (IPV), dose\u00a04'),
      months: 48,
      ageLabel: L('4–6 岁', '4–6 years'),
    },
    {
      id: 'mmr-2',
      name: L('麻腮风疫苗 MMR 第 2 剂', 'Measles, mumps, and rubella (MMR), dose\u00a02'),
      months: 48,
      ageLabel: L('4–6 岁', '4–6 years'),
    },
    {
      id: 'var-2',
      name: L('水痘疫苗 VAR 第 2 剂', 'Varicella (VAR), dose\u00a02'),
      months: 48,
      ageLabel: L('4–6 岁', '4–6 years'),
    },
    {
      id: 'hpv-1',
      name: L('HPV 疫苗 HPV 第 1 剂', 'Human papillomavirus (HPV), dose\u00a01'),
      months: 108,
      ageLabel: L('9–12 岁', '9–12 years'),
      note: L('15 岁以后才开始的要打 3 剂', 'If started at age 15 or older, 3 doses are needed'),
    },
    {
      id: 'hpv-2',
      name: L('HPV 疫苗 HPV 第 2 剂', 'Human papillomavirus (HPV), dose\u00a02'),
      months: 114,
      ageLabel: L('第 1 剂后 6–12 个月', '6–12 months after dose 1'),
    },
    {
      id: 'tdap',
      name: L('青少年百白破疫苗 Tdap', 'Tetanus, diphtheria, and acellular pertussis (Tdap)'),
      months: 132,
      ageLabel: L('11–12 岁', '11–12 years'),
    },
    {
      id: 'menacwy-1',
      name: L(
        '流脑 ACWY 疫苗 MenACWY 第 1 剂',
        'Meningococcal serogroup A, C, W, Y (MenACWY), dose\u00a01',
      ),
      months: 132,
      ageLabel: L('11–12 岁', '11–12 years'),
    },
    {
      id: 'menacwy-2',
      name: L(
        '流脑 ACWY 疫苗 MenACWY 第 2 剂',
        'Meningococcal serogroup A, C, W, Y (MenACWY), dose\u00a02',
      ),
      months: 192,
      ageLabel: L('16 岁', '16 years'),
    },
    {
      id: 'menb',
      name: L('流脑 B 群疫苗 MenB', 'Meningococcal serogroup B (MenB)'),
      months: 192,
      ageLabel: L('16–18 岁', '16–18 years'),
      note: L('由家长和医生共同决定', 'Decided together by parents and doctor'),
      kind: 'shared-decision',
    },
  ]),
  source: localized({
    label: L(
      'American Academy of Pediatrics（AAP）Child and Adolescent Immunization Schedule',
      'American Academy of Pediatrics (AAP) Child and Adolescent Immunization Schedule',
    ),
    url: 'https://downloads.aap.org/AAP/PDF/AAP-Immunization-Schedule.pdf',
    version: L(
      '2026（2026-01-26 发布，2026-09-02 更新）',
      '2026 (published 2026-01-26, updated 2026-09-02)',
    ),
  }),
  reviewStatus: 'primary-source',
  disclaimer: L(
    '按美国儿科学会（AAP）2026 版排列。不同机构的建议可能不同，打哪些、什么时候打请问儿科医生，以诊所安排和健康手册为准。',
    "Based on the American Academy of Pediatrics (AAP) 2026 schedule. Recommendations can differ between organizations. Ask your pediatrician which vaccines to get and when. Your clinic's plan and health record book take precedence.",
  ),
  nutrition: nutritionReferenceIom,
  documentSuggestions: L<readonly string[]>(
    ['出生证明', '社会安全卡 SSN', '护照', '疫苗记录', '儿科体检报告', '医疗保险卡', '医疗收据'],
    [
      'Birth certificate',
      'Social Security card (SSN)',
      'Passport',
      'Vaccine record',
      'Pediatric checkup report',
      'Health insurance card',
      'Medical receipt',
    ],
  ),
  defaultUnits: { volume: 'oz', temperature: 'f', weight: 'lb', length: 'in' },
  paperSize: 'Letter',
});
