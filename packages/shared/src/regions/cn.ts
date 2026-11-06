import { metricUnits } from '../domain/units';
import { defineOptionalVaccines, defineSchedule } from '../domain/vaccines';
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

/** 下面的“可能替代”都来自《国家免疫规划疫苗儿童免疫程序及说明（2026 年版）》第二部分的“其他事项”。 */
const SITE_DECIDES = {
  zh: '具体以接种单位为准',
  en: 'the vaccination site decides',
};
const MEN_CONJ_REPLACE = L(
  `24 月龄前按说明书打完规定剂次，可能替代免费的 A 群流脑多糖疫苗，${SITE_DECIDES.zh}`,
  `If the doses on the label are finished before 24 months, it may replace the free group A meningococcal polysaccharide doses; ${SITE_DECIDES.en}`,
);
const HPV_REPLACE = L(
  `按说明书打完全程后，13 周岁的免费双价 HPV 疫苗就不用再打，${SITE_DECIDES.zh}`,
  `Once the full course on the label is done, the free bivalent HPV vaccine at 13 years is not needed; ${SITE_DECIDES.en}`,
);
const HPV_WHO = L('适用人群以说明书为准', 'Who it is for depends on the product label');

/**
 * 自费、自愿的非免疫规划疫苗（issue #62）：接种弹层里直接选，不用手填名字。
 *
 * 月龄是“通常从几月龄开始打第一剂”的参考，不是接种程序，不进疫苗本的状态和提醒。
 * 流感和 EV71 按中国疾控的指南；其余月龄来自接种点宣传单（仓库所有者 2026-11-04 提供，未与说明书核对，待复核）。
 * 宣传单原文注明“图中标识的年龄表示第一次接种该疫苗的时间”；同一种疫苗画在几个月龄上的，
 * 这里只取最早的一个，其余写在注释里。宣传单上的乙脑灭活疫苗（8 月龄）不列在这里：
 * 2026 年版免疫规划里它和乙脑减毒活疫苗二选一，疫苗本上已经有这几剂。
 */
const OPTIONAL = defineOptionalVaccines('cn', [
  {
    // 宣传单：1.5 月“进口5价轮状疫苗”。
    id: 'rv5',
    name: L('五价轮状病毒疫苗 RV5（进口）', 'Pentavalent rotavirus vaccine (RV5, imported)'),
    startMonths: 1.5,
    startLabel: L('1.5 月龄', '1.5 months'),
    basis: 'leaflet',
  },
  {
    // 宣传单：1.5 月“13价肺炎疫苗”。
    id: 'pcv13',
    name: L('13 价肺炎球菌结合疫苗 PCV13', '13-valent pneumococcal conjugate vaccine (PCV13)'),
    startMonths: 1.5,
    startLabel: L('1.5 月龄', '1.5 months'),
    basis: 'leaflet',
  },
  {
    // 宣传单：2 月“五联”。替代：2026 年版第二部分三（二）1“含 IPV 成分的非免疫规划疫苗，
    // 可视为完成相应剂次的脊灰疫苗接种”，四（二）“含百日咳成分的非免疫规划疫苗，可视为完成相应剂次 DTaP 接种”。
    id: 'dtap-ipv-hib',
    name: L('五联疫苗（百白破-脊灰-Hib）DTaP-IPV/Hib', '5-in-1 vaccine (DTaP-IPV/Hib)'),
    startMonths: 2,
    startLabel: L('2 月龄', '2 months'),
    mayReplace: L(
      `含百白破和脊灰灭活疫苗成分，按说明书接种的，可能替代相应剂次的免费百白破和脊灰疫苗，${SITE_DECIDES.zh}`,
      `It contains DTaP and IPV. Given as the label directs, it may replace the matching free DTaP and polio doses; ${SITE_DECIDES.en}`,
    ),
    basis: 'leaflet',
  },
  {
    // 宣传单：2.5 月“国产轮状疫苗”。国产轮状疫苗不止一种，起始月龄以所用产品的说明书为准。
    id: 'rv',
    name: L('轮状病毒疫苗（国产）', 'Rotavirus vaccine (made in China)'),
    startMonths: 2.5,
    startLabel: L('2.5 月龄', '2.5 months'),
    basis: 'leaflet',
  },
  {
    // 宣传单：3 月“Hib疫苗/四联”。Hib 不在 2026 年版免疫规划里，没有可替代的剂次。
    id: 'hib',
    name: L(
      'b 型流感嗜血杆菌结合疫苗 Hib',
      'Haemophilus influenzae type b conjugate vaccine (Hib)',
    ),
    startMonths: 3,
    startLabel: L('3 月龄', '3 months'),
    basis: 'leaflet',
  },
  {
    // 宣传单：3 月“Hib疫苗/四联”。替代：2026 年版第二部分四（二），含百日咳成分。
    id: 'dtap-hib',
    name: L('四联疫苗（百白破-Hib）DTaP-Hib', '4-in-1 vaccine (DTaP-Hib)'),
    startMonths: 3,
    startLabel: L('3 月龄', '3 months'),
    mayReplace: L(
      `含百白破成分，按说明书接种的，可能替代相应剂次的免费百白破疫苗，${SITE_DECIDES.zh}`,
      `It contains DTaP. Given as the label directs, it may replace the matching free DTaP doses; ${SITE_DECIDES.en}`,
    ),
    basis: 'leaflet',
  },
  {
    // 宣传单：3 月、半岁、9 月、2 岁都写了“ACYW135四价流脑结合疫苗”。
    // 替代：2026 年版第二部分八（二）5“小于 24 月龄儿童，如已按流脑结合疫苗说明书接种了规定的剂次，可视为完成 MPSV—A 接种剂次”。
    id: 'menacyw-conj',
    name: L(
      'ACYW135 群流脑结合疫苗 MenACYW',
      'Meningococcal groups A, C, Y, W135 conjugate vaccine (MenACYW)',
    ),
    startMonths: 3,
    startLabel: L('3 月龄', '3 months'),
    mayReplace: MEN_CONJ_REPLACE,
    basis: 'leaflet',
  },
  {
    // 宣传单：半岁、9 月“AC流脑结合疫苗”。替代依据同上。
    id: 'menac-conj',
    name: L('AC 群流脑结合疫苗 MenAC', 'Meningococcal groups A and C conjugate vaccine (MenAC)'),
    startMonths: 6,
    startLabel: L('6 月龄', '6 months'),
    mayReplace: MEN_CONJ_REPLACE,
    basis: 'leaflet',
  },
  {
    // 《中国流感疫苗预防接种技术指南（2026—2027）》，中国疾病预防控制中心，2026 年 9 月：
    // https://www.chinacdc.cn/jkyj/mygh02/jswj2026/202609/P020260902609797521311.pdf
    // “IIV3 … 可用于 6 月龄及以上人群”；“6 月龄及以上—9 岁以下儿童 … 既往未接种过流感疫苗，
    // 首次接种流感病毒灭活疫苗时，建议接种 2 剂次 … 间隔≥4 周”。宣传单写的是 6.5 月，以指南为准。
    id: 'flu',
    name: L('流感疫苗', 'Influenza (flu) vaccine'),
    startMonths: 6,
    startLabel: L('6 月龄', '6 months'),
    note: L(
      '每个流感季接种；9 岁以下、以前没打过的孩子，第一次通常打 2 剂，间隔至少 4 周',
      'Given each flu season. Children under 9 who have never had it usually get 2 doses the first time, at least 4 weeks apart',
    ),
    basis: 'guideline',
  },
  {
    // 《肠道病毒 71 型灭活疫苗使用技术指南》，中国疾病预防控制中心，2016 年 5 月。chinacdc.cn 上的原链接已失效，
    // 读的是 Internet Archive 的副本：
    // https://web.archive.org/web/2020/https://www.chinacdc.cn/jkzt/crb/xcrxjb/201801/P020180104569154889446.pdf
    // 五（一）“建议 EV71 疫苗接种对象为≥6 月龄易感儿童”“不同厂家疫苗的接种年龄范围可参照相应产品疫苗说明书”；
    // 五（二）“基础免疫程序为 2 剂次，间隔 1 个月”。宣传单写的是 6.5 月，以指南为准。
    id: 'ev71',
    name: L('EV71 手足口病疫苗', 'EV71 vaccine (hand, foot and mouth disease)'),
    startMonths: 6,
    startLabel: L('6 月龄', '6 months'),
    note: L('基础免疫 2 剂，间隔 1 个月', 'The primary course is 2 doses, 1 month apart'),
    basis: 'guideline',
  },
  {
    // 宣传单：1 岁“水痘疫苗”。
    id: 'var',
    name: L('水痘疫苗 VarV', 'Varicella (chickenpox) vaccine'),
    startMonths: 12,
    startLabel: L('1 周岁', '1 year'),
    basis: 'leaflet',
  },
  {
    // 宣传单：2 岁“23价肺炎疫苗”。
    id: 'ppsv23',
    name: L(
      '23 价肺炎球菌多糖疫苗 PPSV23',
      '23-valent pneumococcal polysaccharide vaccine (PPSV23)',
    ),
    startMonths: 24,
    startLabel: L('2 周岁', '2 years'),
    basis: 'leaflet',
  },
  {
    // 宣传单：2 岁“霍乱疫苗”。
    id: 'cholera',
    name: L('霍乱疫苗', 'Cholera vaccine'),
    startMonths: 24,
    startLabel: L('2 周岁', '2 years'),
    basis: 'leaflet',
  },
  {
    // 宣传单：3 岁、6 岁“ACYW135流脑多糖疫苗”。
    // 替代：2026 年版第二部分八（二）6“如儿童 3 周岁和 6 周岁时已接种含 A 群和 C 群流脑疫苗成分的疫苗，
    // 可视为完成相应剂次的 MPSV—AC 接种”。
    id: 'mpsv4',
    name: L(
      'ACYW135 群流脑多糖疫苗 MPSV4',
      'Meningococcal groups A, C, Y, W135 polysaccharide vaccine (MPSV4)',
    ),
    startMonths: 36,
    startLabel: L('3 周岁', '3 years'),
    mayReplace: L(
      `3 周岁、6 周岁时打的，可能替代相应剂次的免费 A 群 C 群流脑多糖疫苗，${SITE_DECIDES.zh}`,
      `Given at 3 or 6 years, it may replace the matching free group A and C meningococcal polysaccharide dose; ${SITE_DECIDES.en}`,
    ),
    basis: 'leaflet',
  },
  {
    // 宣传单：9 岁“二价HPV疫苗(女性)”。适用人群写成以说明书为准，不假定宝宝的性别。
    // 替代：2026 年版第二部分十一（二）2“如接种对象已按照相应 HPV 疫苗（任何价次）产品说明书完成全程接种的，无需再接种”。
    id: 'hpv2',
    name: L('双价 HPV 疫苗 2vHPV（自费）', 'Bivalent HPV vaccine (2vHPV, paid)'),
    startMonths: 108,
    startLabel: L('9 周岁', '9 years'),
    note: HPV_WHO,
    mayReplace: HPV_REPLACE,
    basis: 'leaflet',
  },
  {
    // 宣传单：9 岁“九价HPV疫苗(女性)”。适用人群和替代依据同上。
    id: 'hpv9',
    name: L('九价 HPV 疫苗 9vHPV', '9-valent HPV vaccine (9vHPV)'),
    startMonths: 108,
    startLabel: L('9 周岁', '9 years'),
    note: HPV_WHO,
    mayReplace: HPV_REPLACE,
    basis: 'leaflet',
  },
]);

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
 * 疫苗本里只有国家免疫规划疫苗。各省可能另外增加项目，可以记成自定义疫苗；自费疫苗见上面的 OPTIONAL。
 * HBsAg 阳性产妇所生新生儿等特殊情况的安排不同，由接种单位决定，所以界面注明以诊所为准。
 */
export const CN: RegionDefinition = localized({
  id: 'CN',
  name: L('中国大陆', 'Mainland China'),
  vaccineSchedule: defineSchedule('cn', [
    { id: 'bcg', name: L('卡介苗 BCG', 'BCG'), months: 0, ageLabel: L('出生时', 'At birth') },
    {
      id: 'hepb-1',
      name: L('乙肝疫苗 HepB 第 1 剂', 'Hepatitis B (HepB), dose\u00a01'),
      months: 0,
      ageLabel: L('出生时', 'At birth'),
      note: L('出生后 24 小时内', 'Within 24 hours of birth'),
    },
    {
      id: 'hepb-2',
      name: L('乙肝疫苗 HepB 第 2 剂', 'Hepatitis B (HepB), dose\u00a02'),
      months: 1,
      ageLabel: L('1 月龄', '1 month'),
    },
    {
      id: 'ipv-1',
      name: L('脊灰灭活疫苗 IPV 第 1 剂', 'Inactivated polio (IPV), dose\u00a01'),
      months: 2,
      ageLabel: L('2 月龄', '2 months'),
    },
    {
      id: 'dtap-1',
      name: L(
        '百白破疫苗 DTaP 第 1 剂',
        'Diphtheria, tetanus, and acellular pertussis (DTaP), dose\u00a01',
      ),
      months: 2,
      ageLabel: L('2 月龄', '2 months'),
    },
    {
      id: 'ipv-2',
      name: L('脊灰灭活疫苗 IPV 第 2 剂', 'Inactivated polio (IPV), dose\u00a02'),
      months: 3,
      ageLabel: L('3 月龄', '3 months'),
    },
    {
      id: 'bopv-1',
      name: L('脊灰减毒活疫苗 bOPV 第 3 剂', 'Live oral polio (bOPV), dose\u00a03'),
      months: 4,
      ageLabel: L('4 月龄', '4 months'),
    },
    {
      id: 'dtap-2',
      name: L(
        '百白破疫苗 DTaP 第 2 剂',
        'Diphtheria, tetanus, and acellular pertussis (DTaP), dose\u00a02',
      ),
      months: 4,
      ageLabel: L('4 月龄', '4 months'),
    },
    {
      id: 'hepb-3',
      name: L('乙肝疫苗 HepB 第 3 剂', 'Hepatitis B (HepB), dose\u00a03'),
      months: 6,
      ageLabel: L('6 月龄', '6 months'),
    },
    {
      id: 'dtap-3',
      name: L(
        '百白破疫苗 DTaP 第 3 剂',
        'Diphtheria, tetanus, and acellular pertussis (DTaP), dose\u00a03',
      ),
      months: 6,
      ageLabel: L('6 月龄', '6 months'),
    },
    {
      id: 'mpsv-a-1',
      name: L(
        'A 群流脑多糖疫苗 MPSV-A 第 1 剂',
        'Group A meningococcal polysaccharide (MPSV-A), dose\u00a01',
      ),
      months: 6,
      ageLabel: L('6 月龄', '6 months'),
    },
    {
      id: 'mmr-1',
      name: L('麻腮风疫苗 MMR 第 1 剂', 'Measles, mumps, and rubella (MMR), dose\u00a01'),
      months: 8,
      ageLabel: L('8 月龄', '8 months'),
    },
    {
      id: 'je-l-1',
      name: L('乙脑减毒活疫苗 JE-L 第 1 剂', 'Live Japanese encephalitis (JE-L), dose\u00a01'),
      months: 8,
      ageLabel: L('8 月龄', '8 months'),
      note: JE,
      choice: { group: 'je', option: 'live' },
    },
    {
      id: 'je-i-1',
      name: L('乙脑灭活疫苗 JE-I 第 1 剂', 'Inactivated Japanese encephalitis (JE-I), dose\u00a01'),
      months: 8,
      ageLabel: L('8 月龄', '8 months'),
      note: JE,
      choice: { group: 'je', option: 'inactivated' },
    },
    {
      id: 'je-i-2',
      name: L('乙脑灭活疫苗 JE-I 第 2 剂', 'Inactivated Japanese encephalitis (JE-I), dose\u00a02'),
      months: 8,
      ageLabel: L('8 月龄', '8 months'),
      note: L('和第 1 剂间隔 7–10 天', '7–10 days after dose 1'),
      choice: { group: 'je', option: 'inactivated' },
    },
    {
      id: 'mpsv-a-2',
      name: L(
        'A 群流脑多糖疫苗 MPSV-A 第 2 剂',
        'Group A meningococcal polysaccharide (MPSV-A), dose\u00a02',
      ),
      months: 9,
      ageLabel: L('9 月龄', '9 months'),
    },
    {
      id: 'dtap-4',
      name: L(
        '百白破疫苗 DTaP 第 4 剂',
        'Diphtheria, tetanus, and acellular pertussis (DTaP), dose\u00a04',
      ),
      months: 18,
      ageLabel: L('18 月龄', '18 months'),
    },
    {
      id: 'mmr-2',
      name: L('麻腮风疫苗 MMR 第 2 剂', 'Measles, mumps, and rubella (MMR), dose\u00a02'),
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
      name: L('甲肝灭活疫苗 HepA-I 第 1 剂', 'Inactivated hepatitis A (HepA-I), dose\u00a01'),
      months: 18,
      ageLabel: L('18 月龄', '18 months'),
      note: HEPA,
      choice: { group: 'hepa', option: 'inactivated' },
    },
    {
      id: 'je-l-2',
      name: L('乙脑减毒活疫苗 JE-L 第 2 剂', 'Live Japanese encephalitis (JE-L), dose\u00a02'),
      months: 24,
      ageLabel: L('2 周岁', '2 years'),
      choice: { group: 'je', option: 'live' },
    },
    {
      id: 'je-i-3',
      name: L('乙脑灭活疫苗 JE-I 第 3 剂', 'Inactivated Japanese encephalitis (JE-I), dose\u00a03'),
      months: 24,
      ageLabel: L('2 周岁', '2 years'),
      choice: { group: 'je', option: 'inactivated' },
    },
    {
      id: 'hepa-i-2',
      name: L('甲肝灭活疫苗 HepA-I 第 2 剂', 'Inactivated hepatitis A (HepA-I), dose\u00a02'),
      months: 24,
      ageLabel: L('2 周岁', '2 years'),
      choice: { group: 'hepa', option: 'inactivated' },
    },
    {
      id: 'mpsv-ac-1',
      name: L(
        'A 群 C 群流脑多糖疫苗 MPSV-AC 第 3 剂',
        'Group A and C meningococcal polysaccharide (MPSV-AC), dose\u00a03',
      ),
      months: 36,
      ageLabel: L('3 周岁', '3 years'),
    },
    {
      id: 'bopv-2',
      name: L('脊灰减毒活疫苗 bOPV 第 4 剂', 'Live oral polio (bOPV), dose\u00a04'),
      months: 48,
      ageLabel: L('4 周岁', '4 years'),
    },
    {
      id: 'dtap-5',
      name: L(
        '百白破疫苗 DTaP 第 5 剂',
        'Diphtheria, tetanus, and acellular pertussis (DTaP), dose\u00a05',
      ),
      months: 72,
      ageLabel: L('6 周岁', '6 years'),
    },
    {
      id: 'mpsv-ac-2',
      name: L(
        'A 群 C 群流脑多糖疫苗 MPSV-AC 第 4 剂',
        'Group A and C meningococcal polysaccharide (MPSV-AC), dose\u00a04',
      ),
      months: 72,
      ageLabel: L('6 周岁', '6 years'),
    },
    {
      id: 'je-i-4',
      name: L('乙脑灭活疫苗 JE-I 第 4 剂', 'Inactivated Japanese encephalitis (JE-I), dose\u00a04'),
      months: 72,
      ageLabel: L('6 周岁', '6 years'),
      choice: { group: 'je', option: 'inactivated' },
    },
    {
      id: 'hpv-1',
      name: L('双价 HPV 疫苗 2vHPV 第 1 剂', 'Bivalent HPV (2vHPV), dose\u00a01'),
      months: 156,
      ageLabel: L('13 周岁', '13 years'),
      note: L('接种对象是 13 周岁女孩', 'For girls aged 13'),
      kind: 'conditional',
    },
    {
      id: 'hpv-2',
      name: L('双价 HPV 疫苗 2vHPV 第 2 剂', 'Bivalent HPV (2vHPV), dose\u00a02'),
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
  optionalVaccines: localized({
    title: L('自费疫苗（非免疫规划）', 'Optional vaccines (outside the national program)'),
    note: L(
      '自费、自愿接种。月龄是通常开始打第一剂的参考，不是完整的接种程序，App 不会提醒。参考来自接种单位的宣传资料和中国疾控的疫苗指南，以接种单位安排和说明书为准。',
      "Optional and paid for by the family. The age is when the first dose usually starts, not a full schedule, and the app won't send reminders. Based on a vaccination site's leaflet and China CDC's vaccine guidelines. The vaccination site's plan and the product label take precedence.",
    ),
    vaccines: OPTIONAL,
  }),
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
  personalDocumentSuggestions: L<readonly string[]>(
    ['身份证', '护照', '驾驶证', '医保卡', '户口本'],
    [
      'ID card',
      'Passport',
      "Driver's license",
      'Medical insurance card',
      'Household register (hukou)',
    ],
  ),
  defaultUnits: metricUnits,
  paperSize: 'A4',
  money: {
    currency: 'CNY',
    categories: [
      'lunar-new-year',
      'red-packet',
      'full-month',
      'hundred-days',
      'birthday',
      'gift',
      'other',
    ],
  },
});
