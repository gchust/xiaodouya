import type { EventData } from '../schemas';
import { ageParts } from './age';

export interface VaccineDose {
  id: string;
  name: string;
  /** 建议接种月龄。 */
  months: number;
  ageLabel: string;
  note?: string;
}

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
 */
export const vaccineSchedule: readonly VaccineDose[] = [
  { id: 'bcg', name: '卡介苗 BCG', months: 0, ageLabel: '出生' },
  { id: 'hepb-1', name: '乙肝疫苗 第 1 剂', months: 0, ageLabel: '出生' },
  {
    id: '6in1-1',
    name: '六合一 第 1 剂',
    months: 2,
    ageLabel: '2 个月',
    note: '含乙肝第 2 剂',
  },
  { id: '5in1-2', name: '五合一 第 2 剂', months: 4, ageLabel: '4 个月' },
  { id: 'pcv-1', name: '肺炎球菌 第 1 剂', months: 4, ageLabel: '4 个月' },
  {
    id: '6in1-3',
    name: '六合一 第 3 剂',
    months: 6,
    ageLabel: '6 个月',
    note: '含乙肝第 3 剂',
  },
  { id: 'pcv-2', name: '肺炎球菌 第 2 剂', months: 6, ageLabel: '6 个月' },
  { id: 'flu', name: '流感疫苗', months: 6, ageLabel: '6 个月起', note: '每年或每季接种' },
  { id: 'pcv-3', name: '肺炎球菌 加强剂', months: 12, ageLabel: '12 个月' },
  { id: 'mmr-1', name: '麻腮风 第 1 剂', months: 12, ageLabel: '12 个月' },
  { id: 'var-1', name: '水痘 第 1 剂', months: 12, ageLabel: '12 个月' },
  {
    id: 'mmrv-2',
    name: '麻腮风水痘 第 2 剂',
    months: 15,
    ageLabel: '15 个月',
  },
  { id: '5in1-4', name: '五合一 加强剂', months: 18, ageLabel: '18 个月' },
];

export type VaccineState = 'done' | 'due' | 'upcoming';

export interface VaccineStatus extends VaccineDose {
  state: VaccineState;
  doneAt: number | null;
}

/** 距建议月龄还有不到两周时就提示，给家长预约的时间。 */
const DUE_LEAD_DAYS = 14;

export function vaccineStatuses(
  birthAt: number,
  events: readonly EventData[],
  now: number,
): VaccineStatus[] {
  const done = new Map<string, number>();
  for (const e of events) {
    if (e.type === 'vaccine') done.set(e.vaccineId, e.at);
  }
  const reference = ageParts(birthAt, now + DUE_LEAD_DAYS * 86_400_000);
  return vaccineSchedule.map((dose) => {
    const doneAt = done.get(dose.id) ?? null;
    const state: VaccineState = doneAt
      ? 'done'
      : reference.months >= dose.months
        ? 'due'
        : 'upcoming';
    return { ...dose, state, doneAt };
  });
}

export function nextVaccine(statuses: readonly VaccineStatus[]): VaccineStatus | null {
  return statuses.find((v) => v.state !== 'done') ?? null;
}

/** 接种弹层只列当前相关的几剂，否则“已接种”按钮会被 13 个选项挤出屏幕。 */
export function vaccinesToOffer(
  statuses: readonly VaccineStatus[],
  preselect?: string,
  limit = 4,
): VaccineStatus[] {
  const pending = statuses.filter((v) => v.state !== 'done');
  const offered = pending.slice(0, Math.max(limit, pending.filter((v) => v.state === 'due').length));
  const chosen = pending.find((v) => v.id === preselect);
  return chosen && !offered.includes(chosen) ? [...offered, chosen] : offered;
}
