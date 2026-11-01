import { metricUnits } from '../domain/units';
import { defineSchedule } from '../domain/vaccines';
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
export const SG: RegionDefinition = {
  id: 'SG',
  name: '新加坡',
  vaccineSchedule: defineSchedule('sg', [
    { id: 'bcg', name: '卡介苗 BCG', months: 0, ageLabel: '出生' },
    { id: 'hepb-1', name: '乙肝疫苗 HepB 第 1 剂', months: 0, ageLabel: '出生' },
    {
      id: '6in1-1',
      name: '六合一 6-in-1 第 1 剂',
      months: 2,
      ageLabel: '2 个月',
      note: '含乙肝第 2 剂',
    },
    { id: '5in1-2', name: '五合一 5-in-1 第 2 剂', months: 4, ageLabel: '4 个月' },
    { id: 'pcv-1', name: '肺炎球菌 PCV 第 1 剂', months: 4, ageLabel: '4 个月' },
    {
      id: '6in1-3',
      name: '六合一 6-in-1 第 3 剂',
      months: 6,
      ageLabel: '6 个月',
      note: '含乙肝第 3 剂',
    },
    { id: 'pcv-2', name: '肺炎球菌 PCV 第 2 剂', months: 6, ageLabel: '6 个月' },
    { id: 'flu', name: '流感疫苗 Flu', months: 6, ageLabel: '6 个月起', note: '每年或每季接种' },
    { id: 'pcv-3', name: '肺炎球菌 PCV 加强剂', months: 12, ageLabel: '12 个月' },
    { id: 'mmr-1', name: '麻腮风 MMR 第 1 剂', months: 12, ageLabel: '12 个月' },
    { id: 'var-1', name: '水痘 VAR 第 1 剂', months: 12, ageLabel: '12 个月' },
    { id: 'mmrv-2', name: '麻腮风水痘 MMRV 第 2 剂', months: 15, ageLabel: '15 个月' },
    { id: '5in1-4', name: '五合一 5-in-1 加强剂', months: 18, ageLabel: '18 个月' },
  ]),
  source: {
    label: '新加坡国家儿童免疫计划（NCIS）',
    url: 'https://isomer-user-content.by.gov.sg/18/9459eb0d-6797-466d-8d85-274916ebd27e/NCIS_1%20Apr%202026.pdf',
    version: '2026-04-01（未读到原文，待复核）',
  },
  reviewStatus: 'needs-review',
  disclaimer: '按新加坡国家儿童免疫计划排列，以诊所安排和健康手册为准。',
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
