import { metricUnits } from '../domain/units';
import { defineSchedule } from '../domain/vaccines';
import { nutritionReferenceFallback } from '../health/nutritionReferences';
import { L, localized } from '../i18n';
import type { RegionDefinition } from './types';

/**
 * 新加坡国家儿童免疫计划（NCIS）标准方案，出生到 18 个月。
 *
 * 依据：
 * - MOH, Communicable Diseases Surveillance, Chapter 7：2020 年 11 月起，乙肝第 2、3 剂
 *   并入六合一，时间改为 2 个月和 6 个月。
 * - MOH NCIS（更新于 2026-04-01）：https://isomer-user-content.by.gov.sg/18/9459eb0d-6797-466d-8d85-274916ebd27e/NCIS_1%20Apr%202026.pdf
 * - HealthXchange（SingHealth）推荐接种时间表。
 *
 * 乙肝携带者母亲的宝宝方案不同（1 个月打第 2 剂），由诊所安排，因此界面始终注明以诊所为准。
 *
 * reviewStatus 是 needs-review：上面的 NCIS PDF 和 moh.gov.sg 在开发环境连不上，完整表格一直没有
 * 对照过原文（2026-11 又试了一次，TLS 连接被断开）。时间点来自上面第一条和第三条二手来源。
 */
export const SG: RegionDefinition = localized({
  id: 'SG',
  name: L('新加坡', 'Singapore'),
  vaccineSchedule: defineSchedule('sg', [
    { id: 'bcg', name: L('卡介苗 BCG', 'BCG'), months: 0, ageLabel: L('出生', 'Birth') },
    {
      id: 'hepb-1',
      name: L('乙肝疫苗 HepB 第 1 剂', 'Hepatitis B (HepB), dose\u00a01'),
      months: 0,
      ageLabel: L('出生', 'Birth'),
    },
    {
      id: '6in1-1',
      name: L('六合一 6-in-1 第 1 剂', '6-in-1, dose\u00a01'),
      months: 2,
      ageLabel: L('2 个月', '2 months'),
      note: L('含乙肝第 2 剂', 'Includes hepatitis B dose 2'),
    },
    {
      id: '5in1-2',
      name: L('五合一 5-in-1 第 2 剂', '5-in-1, dose\u00a02'),
      months: 4,
      ageLabel: L('4 个月', '4 months'),
    },
    {
      id: 'pcv-1',
      name: L('肺炎球菌 PCV 第 1 剂', 'Pneumococcal (PCV), dose\u00a01'),
      months: 4,
      ageLabel: L('4 个月', '4 months'),
    },
    {
      id: '6in1-3',
      name: L('六合一 6-in-1 第 3 剂', '6-in-1, dose\u00a03'),
      months: 6,
      ageLabel: L('6 个月', '6 months'),
      note: L('含乙肝第 3 剂', 'Includes hepatitis B dose 3'),
    },
    {
      id: 'pcv-2',
      name: L('肺炎球菌 PCV 第 2 剂', 'Pneumococcal (PCV), dose\u00a02'),
      months: 6,
      ageLabel: L('6 个月', '6 months'),
    },
    {
      id: 'flu',
      name: L('流感疫苗 Flu', 'Influenza (Flu)'),
      months: 6,
      ageLabel: L('6 个月起', '6 months and up'),
      note: L('每年或每季接种', 'Every year or season'),
    },
    {
      id: 'pcv-3',
      name: L('肺炎球菌 PCV 加强剂', 'Pneumococcal (PCV), booster'),
      months: 12,
      ageLabel: L('12 个月', '12 months'),
    },
    {
      id: 'mmr-1',
      name: L('麻腮风 MMR 第 1 剂', 'Measles, mumps, and rubella (MMR), dose\u00a01'),
      months: 12,
      ageLabel: L('12 个月', '12 months'),
    },
    {
      id: 'var-1',
      name: L('水痘 VAR 第 1 剂', 'Varicella (VAR), dose\u00a01'),
      months: 12,
      ageLabel: L('12 个月', '12 months'),
    },
    {
      id: 'mmrv-2',
      name: L(
        '麻腮风水痘 MMRV 第 2 剂',
        'Measles, mumps, rubella, and varicella (MMRV), dose\u00a02',
      ),
      months: 15,
      ageLabel: L('15 个月', '15 months'),
    },
    {
      id: '5in1-4',
      name: L('五合一 5-in-1 加强剂', '5-in-1, booster'),
      months: 18,
      ageLabel: L('18 个月', '18 months'),
    },
  ]),
  source: localized({
    label: L(
      '新加坡国家儿童免疫计划（NCIS）',
      'Singapore National Childhood Immunisation Schedule (NCIS)',
    ),
    url: 'https://isomer-user-content.by.gov.sg/18/9459eb0d-6797-466d-8d85-274916ebd27e/NCIS_1%20Apr%202026.pdf',
    version: L(
      '2026-04-01（未读到原文，待复核）',
      '2026-04-01 (original not read, pending review)',
    ),
  }),
  reviewStatus: 'needs-review',
  disclaimer: L(
    '按新加坡国家儿童免疫计划排列，以诊所安排和健康手册为准。',
    "Based on Singapore's National Childhood Immunisation Schedule. Your clinic's plan and health record book take precedence.",
  ),
  nutrition: nutritionReferenceFallback(
    L(
      '新加坡当地的推荐量还没有核对原文',
      "Singapore's local recommended amounts have not been checked against the original",
    ),
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
  personalDocumentSuggestions: L<readonly string[]>(
    ['NRIC', '护照', '驾照', '保险单', '医疗收据'],
    ['NRIC', 'Passport', 'Driving licence', 'Insurance policy', 'Medical receipt'],
  ),
  defaultUnits: metricUnits,
  paperSize: 'A4',
  shareTargets: ['whatsapp', 'telegram', 'wechat', 'messages', 'line'],
  money: { currency: 'SGD', categories: ['red-packet', 'birthday', 'holiday', 'gift', 'other'] },
});
