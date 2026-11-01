import type { EventData } from '../schemas';
import { ageParts } from './age';

/**
 * - routine：所有孩子的常规剂次，会提醒。
 * - conditional：取决于具体情况（产品、妈妈是否接种、对象），不主动提醒。
 * - shared-decision：由家长和医生共同决定，不主动提醒。
 */
export type VaccineKind = 'routine' | 'conditional' | 'shared-decision';

export interface VaccineDose {
  /** 带地区前缀的 id（`sg:bcg`），写进接种记录。 */
  id: string;
  /** 地区内的 id（`bcg`），用来生成 testID。 */
  localId: string;
  name: string;
  /** 建议接种月龄；是一段时间时取最早的月龄。 */
  months: number;
  ageLabel: string;
  note?: string;
  kind: VaccineKind;
  /** 几种产品二选一（比如乙脑减毒或灭活）。记了其中一种后，另一种的剂次不再显示。 */
  choice?: { group: string; option: string };
}

export type VaccineDoseInput = Omit<VaccineDose, 'id' | 'localId' | 'kind'> & {
  id: string;
  kind?: VaccineKind;
};

/** 地区文件用它声明疫苗表：写地区内的 id，这里统一加前缀。 */
export function defineSchedule(
  namespace: string,
  doses: readonly VaccineDoseInput[],
): readonly VaccineDose[] {
  return doses.map(({ id, kind, ...dose }) => ({
    ...dose,
    id: `${namespace}:${id}`,
    localId: id,
    kind: kind ?? 'routine',
  }));
}

const CUSTOM_PREFIX = 'custom:';

export function newCustomVaccineId(uuid: string): string {
  return `${CUSTOM_PREFIX}${uuid}`;
}

export function isCustomVaccineId(id: string): boolean {
  return id.startsWith(CUSTOM_PREFIX);
}

/** 加地区前缀之前的记录都来自新加坡的表。 */
export function normalizeVaccineId(id: string): string {
  return id.includes(':') ? id : `sg:${id}`;
}

export type VaccineState = 'done' | 'due' | 'upcoming';

export interface VaccineStatus extends VaccineDose {
  state: VaccineState;
  doneAt: number | null;
}

/** 距建议月龄还有不到两周时就提示，给家长预约的时间。 */
const DUE_LEAD_DAYS = 14;

interface HasSchedule {
  vaccineSchedule: readonly VaccineDose[];
}

export function vaccineStatuses(
  region: HasSchedule,
  birthAt: number,
  events: readonly EventData[],
  now: number,
): VaccineStatus[] {
  const done = new Map<string, number>();
  for (const e of events) {
    if (e.type === 'vaccine') done.set(normalizeVaccineId(e.vaccineId), e.at);
  }
  const chosen = new Map<string, Set<string>>();
  for (const dose of region.vaccineSchedule) {
    if (!dose.choice || !done.has(dose.id)) continue;
    const options = chosen.get(dose.choice.group) ?? new Set<string>();
    options.add(dose.choice.option);
    chosen.set(dose.choice.group, options);
  }
  const reference = ageParts(birthAt, now + DUE_LEAD_DAYS * 86_400_000);
  return region.vaccineSchedule
    .filter((dose) => {
      const options = dose.choice ? chosen.get(dose.choice.group) : undefined;
      return !options || options.has((dose.choice as { option: string }).option);
    })
    .map((dose) => {
      const doneAt = done.get(dose.id) ?? null;
      const state: VaccineState =
        doneAt !== null ? 'done' : reference.months >= dose.months ? 'due' : 'upcoming';
      return { ...dose, state, doneAt };
    });
}

/** 下一剂常规疫苗。表是按月龄排好的，所以它没到期就说明都没到期。 */
export function nextVaccine(statuses: readonly VaccineStatus[]): VaccineStatus | null {
  return statuses.find((v) => v.state !== 'done' && v.kind === 'routine') ?? null;
}

/** 今天页的提醒：只有真的到期才显示。 */
export function dueVaccine(statuses: readonly VaccineStatus[]): VaccineStatus | null {
  const next = nextVaccine(statuses);
  return next?.state === 'due' ? next : null;
}

/** 接种弹层只列当前相关的几剂，否则“已接种”按钮会被 13 个选项挤出屏幕。 */
export function vaccinesToOffer(
  statuses: readonly VaccineStatus[],
  preselect?: string,
  limit = 4,
): VaccineStatus[] {
  const pending = statuses.filter((v) => v.state !== 'done' && v.kind === 'routine');
  const offered = pending.slice(
    0,
    Math.max(limit, pending.filter((v) => v.state === 'due').length),
  );
  const chosen = statuses.find((v) => v.state !== 'done' && v.id === preselect);
  return chosen && !offered.includes(chosen) ? [...offered, chosen] : offered;
}

export interface OtherVaccineRecord {
  /** 记录 id，用来打开操作弹层。 */
  id: string;
  vaccineId: string;
  name: string;
  at: number;
}

/**
 * 不在当前地区表里的接种记录：换地区前打的和自定义的。
 * 不做跨地区对应：不同地区的“同名”疫苗能否互相替代，是医生的判断。
 */
export function otherVaccineRecords(
  region: HasSchedule,
  entries: readonly { id: string; data: EventData }[],
): OtherVaccineRecord[] {
  const inSchedule = new Set(region.vaccineSchedule.map((dose) => dose.id));
  const records: OtherVaccineRecord[] = [];
  for (const { id, data } of entries) {
    if (data.type !== 'vaccine') continue;
    const vaccineId = normalizeVaccineId(data.vaccineId);
    if (!inSchedule.has(vaccineId)) records.push({ id, vaccineId, name: data.name, at: data.at });
  }
  return records.sort((a, b) => b.at - a.at);
}
