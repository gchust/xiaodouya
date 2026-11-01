import { defineSchedule } from '../domain/vaccines';
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
export const US: RegionDefinition = {
  id: 'US',
  name: '美国',
  vaccineSchedule: defineSchedule('us', [
    {
      id: 'rsv',
      name: 'RSV 单克隆抗体 RSV-mAb',
      months: 0,
      ageLabel: '出生–8 个月',
      note: '取决于妈妈孕期是否接种 RSV 疫苗：没打、不清楚或产前不足 14 天才打的，宝宝在 RSV 季节打 1 剂',
      kind: 'conditional',
    },
    {
      id: 'hepb-1',
      name: '乙肝疫苗 HepB 第 1 剂',
      months: 0,
      ageLabel: '出生',
      note: '出生后 24 小时内',
    },
    { id: 'hepb-2', name: '乙肝疫苗 HepB 第 2 剂', months: 1, ageLabel: '1–2 个月' },
    { id: 'rv-1', name: '轮状病毒疫苗 RV 第 1 剂', months: 2, ageLabel: '2 个月' },
    { id: 'dtap-1', name: '百白破疫苗 DTaP 第 1 剂', months: 2, ageLabel: '2 个月' },
    { id: 'hib-1', name: 'b 型流感嗜血杆菌疫苗 Hib 第 1 剂', months: 2, ageLabel: '2 个月' },
    { id: 'pcv-1', name: '肺炎球菌疫苗 PCV 第 1 剂', months: 2, ageLabel: '2 个月' },
    { id: 'ipv-1', name: '脊灰灭活疫苗 IPV 第 1 剂', months: 2, ageLabel: '2 个月' },
    { id: 'rv-2', name: '轮状病毒疫苗 RV 第 2 剂', months: 4, ageLabel: '4 个月' },
    { id: 'dtap-2', name: '百白破疫苗 DTaP 第 2 剂', months: 4, ageLabel: '4 个月' },
    { id: 'hib-2', name: 'b 型流感嗜血杆菌疫苗 Hib 第 2 剂', months: 4, ageLabel: '4 个月' },
    { id: 'pcv-2', name: '肺炎球菌疫苗 PCV 第 2 剂', months: 4, ageLabel: '4 个月' },
    { id: 'ipv-2', name: '脊灰灭活疫苗 IPV 第 2 剂', months: 4, ageLabel: '4 个月' },
    { id: 'hepb-3', name: '乙肝疫苗 HepB 第 3 剂', months: 6, ageLabel: '6–18 个月' },
    {
      id: 'rv-3',
      name: '轮状病毒疫苗 RV 第 3 剂',
      months: 6,
      ageLabel: '6 个月',
      note: '只有 RotaTeq（RV5）需要；Rotarix（RV1）打 2 剂',
      kind: 'conditional',
    },
    { id: 'dtap-3', name: '百白破疫苗 DTaP 第 3 剂', months: 6, ageLabel: '6 个月' },
    {
      id: 'hib-3',
      name: 'b 型流感嗜血杆菌疫苗 Hib 第 3 剂',
      months: 6,
      ageLabel: '6 个月',
      note: 'ActHIB、Hiberix、Pentacel、Vaxelis 需要；PedvaxHIB 不需要',
      kind: 'conditional',
    },
    { id: 'pcv-3', name: '肺炎球菌疫苗 PCV 第 3 剂', months: 6, ageLabel: '6 个月' },
    { id: 'ipv-3', name: '脊灰灭活疫苗 IPV 第 3 剂', months: 6, ageLabel: '6–18 个月' },
    {
      id: 'flu',
      name: '流感疫苗 Flu',
      months: 6,
      ageLabel: '6 个月起',
      note: '每年接种。8 岁以下之前打过不足 2 剂的，当季打 2 剂，至少间隔 4 周',
    },
    {
      id: 'covid',
      name: '新冠疫苗 COVID-19',
      months: 6,
      ageLabel: '6–23 个月',
      note: '2026–2027 版，剂数由医生根据接种史安排',
    },
    {
      id: 'hib-booster',
      name: 'b 型流感嗜血杆菌疫苗 Hib 加强剂',
      months: 12,
      ageLabel: '12–15 个月',
      note: '第 3 或第 4 剂，看产品',
    },
    { id: 'pcv-4', name: '肺炎球菌疫苗 PCV 第 4 剂', months: 12, ageLabel: '12–15 个月' },
    { id: 'mmr-1', name: '麻腮风疫苗 MMR 第 1 剂', months: 12, ageLabel: '12–15 个月' },
    { id: 'var-1', name: '水痘疫苗 VAR 第 1 剂', months: 12, ageLabel: '12–15 个月' },
    { id: 'hepa-1', name: '甲肝疫苗 HepA 第 1 剂', months: 12, ageLabel: '12–23 个月' },
    { id: 'dtap-4', name: '百白破疫苗 DTaP 第 4 剂', months: 15, ageLabel: '15–18 个月' },
    {
      id: 'hepa-2',
      name: '甲肝疫苗 HepA 第 2 剂',
      months: 18,
      ageLabel: '12–23 个月',
      note: '和第 1 剂至少间隔 6 个月',
    },
    { id: 'dtap-5', name: '百白破疫苗 DTaP 第 5 剂', months: 48, ageLabel: '4–6 岁' },
    { id: 'ipv-4', name: '脊灰灭活疫苗 IPV 第 4 剂', months: 48, ageLabel: '4–6 岁' },
    { id: 'mmr-2', name: '麻腮风疫苗 MMR 第 2 剂', months: 48, ageLabel: '4–6 岁' },
    { id: 'var-2', name: '水痘疫苗 VAR 第 2 剂', months: 48, ageLabel: '4–6 岁' },
    {
      id: 'hpv-1',
      name: 'HPV 疫苗 HPV 第 1 剂',
      months: 108,
      ageLabel: '9–12 岁',
      note: '15 岁以后才开始的要打 3 剂',
    },
    {
      id: 'hpv-2',
      name: 'HPV 疫苗 HPV 第 2 剂',
      months: 114,
      ageLabel: '第 1 剂后 6–12 个月',
    },
    { id: 'tdap', name: '青少年百白破疫苗 Tdap', months: 132, ageLabel: '11–12 岁' },
    { id: 'menacwy-1', name: '流脑 ACWY 疫苗 MenACWY 第 1 剂', months: 132, ageLabel: '11–12 岁' },
    { id: 'menacwy-2', name: '流脑 ACWY 疫苗 MenACWY 第 2 剂', months: 192, ageLabel: '16 岁' },
    {
      id: 'menb',
      name: '流脑 B 群疫苗 MenB',
      months: 192,
      ageLabel: '16–18 岁',
      note: '由家长和医生共同决定',
      kind: 'shared-decision',
    },
  ]),
  source: {
    label: 'American Academy of Pediatrics（AAP）Child and Adolescent Immunization Schedule',
    url: 'https://downloads.aap.org/AAP/PDF/AAP-Immunization-Schedule.pdf',
    version: '2026（2026-01-26 发布，2026-09-02 更新）',
  },
  reviewStatus: 'primary-source',
  disclaimer:
    '按美国儿科学会（AAP）2026 版排列。不同机构的建议可能不同，打哪些、什么时候打请问儿科医生，以诊所安排和健康手册为准。',
  documentSuggestions: [
    '出生证明',
    '社会安全卡 SSN',
    '护照',
    '疫苗记录',
    '儿科体检报告',
    '医疗保险卡',
    '医疗收据',
  ],
  defaultUnits: { volume: 'oz', temperature: 'f', weight: 'lb', length: 'in' },
  paperSize: 'Letter',
};
