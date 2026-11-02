import { t } from '../i18n';
import type { EventData, VaccinePlanData } from '../schemas';
import { formatMonthDay } from './age';
import {
  isCustomVaccineId,
  normalizeVaccineId,
  type VaccineDose,
  type VaccineStatus,
} from './vaccines';

/** 只用来和计划日期混排，不用来判断到期。 */
const AVERAGE_MONTH_MS = 30.4375 * 86_400_000;

export interface VaccinePlanEntry {
  id: string;
  data: VaccinePlanData;
  updatedAt: number;
}

/**
 * 每一剂最新的配置。
 * 两台手机离线时可能给同一剂各建了一条，这时和别的记录一样后写胜出。
 */
function latestPlans(plans: readonly VaccinePlanEntry[]): Map<string, VaccinePlanEntry> {
  const latest = new Map<string, VaccinePlanEntry>();
  for (const plan of plans) {
    const id = normalizeVaccineId(plan.data.vaccineId);
    const seen = latest.get(id);
    if (!seen || plan.updatedAt > seen.updatedAt) latest.set(id, plan);
  }
  return latest;
}

export function planFor(
  plans: readonly VaccinePlanEntry[],
  vaccineId: string,
): VaccinePlanEntry | undefined {
  return latestPlans(plans).get(normalizeVaccineId(vaccineId));
}

function customDose(id: string, plan: VaccinePlanData): VaccineDose | null {
  if (!plan.name) return null;
  const { months, plannedAt } = plan;
  const text = t().domain.vaccine;
  return {
    id,
    localId: id.slice(id.indexOf(':') + 1),
    name: plan.name,
    recordName: plan.name,
    // 没填时间的排在最后，也不会到期。
    months: months ?? Number.POSITIVE_INFINITY,
    ageLabel:
      months === undefined
        ? text.selfAdded
        : text.selfAddedAt(months === 0 ? text.birth : text.months(months)),
    kind: 'routine',
    ...(plannedAt === undefined ? {} : { plannedAt }),
  };
}

export interface PlannedSchedule {
  /** 可以直接代替地区传给 vaccineStatuses 和 otherVaccineRecords。 */
  vaccineSchedule: readonly VaccineDose[];
  /** 隐藏了、还没打的剂次。留着才能恢复。 */
  hidden: readonly VaccineDose[];
}

/**
 * 内置表加上家庭配置，得到这个家庭实际的疫苗本。内置表的数据不变，换地区或删掉配置就回到原样。
 *
 * - 已经记录的接种永远优先：隐藏只对还没打的剂次生效，记录不能因为配置消失或变成未接种。
 * - 别的地区的配置不生效但一直留着，换回去就恢复；自己加的不属于哪个地区，一直显示。
 * - 这里不判断时间是否合理：配置是家里的安排，是不是合适由诊所决定。
 */
export function planSchedule(
  region: { vaccineSchedule: readonly VaccineDose[] },
  birthAt: number,
  plans: readonly VaccinePlanEntry[],
  events: readonly EventData[],
): PlannedSchedule {
  if (plans.length === 0) return { vaccineSchedule: region.vaccineSchedule, hidden: [] };
  const latest = latestPlans(plans);
  const recorded = new Set<string>();
  for (const e of events) {
    if (e.type === 'vaccine') recorded.add(normalizeVaccineId(e.vaccineId));
  }
  const visible: VaccineDose[] = [];
  const hidden: VaccineDose[] = [];
  const place = (dose: VaccineDose, plan: VaccinePlanData | undefined) => {
    if (plan?.hidden && !recorded.has(dose.id)) hidden.push(dose);
    else visible.push(dose);
  };
  for (const dose of region.vaccineSchedule) {
    const plan = latest.get(dose.id)?.data;
    place(plan?.plannedAt === undefined ? dose : { ...dose, plannedAt: plan.plannedAt }, plan);
  }
  for (const [id, entry] of latest) {
    if (!isCustomVaccineId(id)) continue;
    const dose = customDose(id, entry.data);
    if (dose) place(dose, entry.data);
  }
  const timeOf = (dose: VaccineDose) => dose.plannedAt ?? birthAt + dose.months * AVERAGE_MONTH_MS;
  const order = (a: VaccineDose, b: VaccineDose) => {
    const [ta, tb] = [timeOf(a), timeOf(b)];
    return ta === tb ? 0 : ta - tb;
  };
  return { vaccineSchedule: visible.sort(order), hidden };
}

/** 属于别的地区、现在没有生效的配置有多少条。换回那个地区就恢复，界面要说清楚它们去了哪里。 */
export function inertPlanCount(
  region: { vaccineSchedule: readonly VaccineDose[] },
  plans: readonly VaccinePlanEntry[],
): number {
  const inSchedule = new Set(region.vaccineSchedule.map((dose) => dose.id));
  let count = 0;
  for (const [id, { data }] of latestPlans(plans)) {
    if (isCustomVaccineId(id) || inSchedule.has(id)) continue;
    if (data.hidden || data.plannedAt !== undefined) count += 1;
  }
  return count;
}

export type DoseTone = 'done' | 'due' | 'idle';

/** 疫苗本右边的状态文字和颜色。 */
export function doseStatus(dose: VaccineStatus): { text: string; tone: DoseTone } {
  const text = t().domain.vaccine;
  if (dose.state === 'done' && dose.doneAt !== null) {
    return { text: text.doneOn(formatMonthDay(dose.doneAt)), tone: 'done' };
  }
  // 日期是家里和诊所定的，不写“可以预约了”，过了也只是继续显示，不评价。
  if (dose.plannedAt !== undefined) {
    return {
      text: text.plannedOn(formatMonthDay(dose.plannedAt)),
      tone: dose.state === 'due' ? 'due' : 'idle',
    };
  }
  // 看情况或和医生商量的剂次不能写成“可以预约了”，那等于建议每个孩子都打。
  if (dose.kind === 'shared-decision') return { text: text.askDoctor, tone: 'idle' };
  if (dose.kind === 'conditional') return { text: text.depends, tone: 'idle' };
  if (dose.state === 'due') return { text: text.canBook, tone: 'due' };
  if (dose.months === Number.POSITIVE_INFINITY) return { text: text.timeTbd, tone: 'idle' };
  return { text: text.notYet, tone: 'idle' };
}

/** 什么时候打：有计划日期说日期，否则是表上的月龄。 */
export function doseTimeText(dose: VaccineDose): string {
  return dose.plannedAt === undefined
    ? dose.ageLabel
    : t().domain.vaccine.plannedOn(formatMonthDay(dose.plannedAt));
}

/** 今天页的疫苗提醒。 */
export function vaccineReminderText(dose: VaccineDose): string {
  const text = t().domain.vaccine;
  const when = dose.plannedAt === undefined ? text.reminderWhen(dose.ageLabel) : doseTimeText(dose);
  return text.reminder(dose.name, when);
}

/** 一次补记时能选的：所有没记的，包括看情况的剂次，孩子可能已经打过。 */
export function dosesToBackfill(statuses: readonly VaccineStatus[]): VaccineStatus[] {
  return statuses.filter((v) => v.state !== 'done');
}
