import { getLocale, type Localized, localized } from '../i18n';
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
  /** 界面上显示的名字，跟随当前语言。 */
  name: string;
  /**
   * 写进接种记录的名字。记录里存的是数据，不跟着写的人的语言变：v0.1.0 和其他家人读的都是它，
   * 内置剂次永远写中文原名，显示时再按 id 换成当前语言（见 vaccineRecordName）。
   */
  recordName: string;
  /** 建议接种月龄；是一段时间时取最早的月龄。 */
  months: number;
  ageLabel: string;
  note?: string;
  kind: VaccineKind;
  /** 几种产品二选一（比如乙脑减毒或灭活）。记了其中一种后，另一种的剂次不再显示。 */
  choice?: { group: string; option: string };
  /** 家里定的计划日期（见 planSchedule）。有它就按它判断到期，地区文件不写这个字段。 */
  plannedAt?: number;
}

export type VaccineDoseInput = Omit<
  VaccineDose,
  'id' | 'localId' | 'kind' | 'name' | 'recordName' | 'ageLabel' | 'note'
> & {
  id: string;
  kind?: VaccineKind;
  name: Localized;
  ageLabel: Localized;
  note?: Localized;
};

/** 所有内置剂次的名字，给 vaccineRecordName 查。换了地区之后，旧的记录也要能显示成当前语言。 */
const doseNames = new Map<string, Localized>();

/** 地区文件用它声明疫苗表：写地区内的 id，这里统一加前缀。 */
export function defineSchedule(
  namespace: string,
  doses: readonly VaccineDoseInput[],
): readonly VaccineDose[] {
  return doses.map(({ id, kind, name, ...dose }) => {
    const fullId = `${namespace}:${id}`;
    doseNames.set(fullId, name);
    return localized({
      ...dose,
      name,
      recordName: name.zh,
      id: fullId,
      localId: id,
      kind: kind ?? 'routine',
    });
  });
}

/**
 * 参考首针月龄的依据：
 * - guideline：疫苗说明书，或疾控、卫生部门的指南原文。
 * - leaflet：接种单位的宣传资料，没有和说明书核对，待复核。
 */
export type OptionalVaccineBasis = 'guideline' | 'leaflet';

/**
 * 不在当地免疫规划里、家里自愿选择的疫苗（比如中国的自费疫苗）。只是让家长不用手填名字：
 * 不进疫苗本的状态和提醒，记下后和自定义的一样放在“其他接种记录”。
 */
export interface OptionalVaccine {
  /** 带地区前缀的 id（`cn:opt-pcv13`），写进接种记录。`opt-` 保证不和免疫规划的剂次撞。 */
  id: string;
  /** 地区内的 id（`pcv13`），用来生成 testID。 */
  localId: string;
  name: string;
  /** 写进接种记录的名字，永远是中文原名，理由同 VaccineDose.recordName。 */
  recordName: string;
  /** 通常从几月龄开始打第一剂。只是参考，不是完整的接种程序，也不用来判断到期。 */
  startMonths: number;
  startLabel: string;
  note?: string;
  /** 官方方案写明可以算作完成的免费剂次。只是一句说明，不会自动把那些剂次标成已接种。 */
  mayReplace?: string;
  basis: OptionalVaccineBasis;
}

export type OptionalVaccineInput = Omit<
  OptionalVaccine,
  'id' | 'localId' | 'name' | 'recordName' | 'startLabel' | 'note' | 'mayReplace'
> & {
  id: string;
  name: Localized;
  startLabel: Localized;
  note?: Localized;
  mayReplace?: Localized;
};

/** 地区文件用它声明自费疫苗。名字也登记进 doseNames，英文界面下记录才能按 id 换语言。 */
export function defineOptionalVaccines(
  namespace: string,
  vaccines: readonly OptionalVaccineInput[],
): readonly OptionalVaccine[] {
  return vaccines.map(({ id, name, ...vaccine }) => {
    const fullId = `${namespace}:opt-${id}`;
    doseNames.set(fullId, name);
    return localized({ ...vaccine, name, recordName: name.zh, id: fullId, localId: id });
  });
}

/**
 * 接种记录显示成什么名字。自己填的和不认识的原样显示，内置剂次按当前语言：
 * 记录里存的是中文原名，中文界面就显示记录里的字，不改变已有内容。
 */
export function vaccineRecordName(vaccineId: string, stored: string): string {
  const locale = getLocale();
  if (locale === 'zh') return stored;
  return doseNames.get(normalizeVaccineId(vaccineId))?.[locale] ?? stored;
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
  const doneNames = new Map<string, string>();
  for (const e of events) {
    if (e.type !== 'vaccine') continue;
    const id = normalizeVaccineId(e.vaccineId);
    done.set(id, e.at);
    doneNames.set(id, e.name);
  }
  const chosen = new Map<string, Set<string>>();
  for (const dose of region.vaccineSchedule) {
    if (!dose.choice || !done.has(dose.id)) continue;
    const options = chosen.get(dose.choice.group) ?? new Set<string>();
    options.add(dose.choice.option);
    chosen.set(dose.choice.group, options);
  }
  const horizon = now + DUE_LEAD_DAYS * 86_400_000;
  const reference = ageParts(birthAt, horizon);
  return region.vaccineSchedule
    .filter((dose) => {
      const options = dose.choice ? chosen.get(dose.choice.group) : undefined;
      return !options || options.has((dose.choice as { option: string }).option);
    })
    .map((dose) => {
      const doneAt = done.get(dose.id) ?? null;
      const reached =
        dose.plannedAt !== undefined ? horizon >= dose.plannedAt : reference.months >= dose.months;
      const state: VaccineState = doneAt !== null ? 'done' : reached ? 'due' : 'upcoming';
      // 自己加的疫苗，接种记录改过名字时以记录为准，疫苗本和时间线才对得上。
      const name = isCustomVaccineId(dose.id) ? (doneNames.get(dose.id) ?? dose.name) : dose.name;
      return { ...dose, name, state, doneAt };
    });
}

/** 常规剂次，或者家里定了日期的剂次。后者不是 App 在建议打，所以可以提醒。 */
function isRemindable(dose: VaccineStatus): boolean {
  return dose.kind === 'routine' || dose.plannedAt !== undefined;
}

/** 下一剂常规疫苗。 */
export function nextVaccine(statuses: readonly VaccineStatus[]): VaccineStatus | null {
  return statuses.find((v) => v.state !== 'done' && isRemindable(v)) ?? null;
}

/** 今天页的提醒：只有真的到期才显示。月龄和日期混排时顺序是近似的，所以要找到期的，不能只看第一个。 */
export function dueVaccine(statuses: readonly VaccineStatus[]): VaccineStatus | null {
  return statuses.find((v) => v.state === 'due' && isRemindable(v)) ?? null;
}

/** 接种弹层只列当前相关的几剂，否则“已接种”按钮会被 13 个选项挤出屏幕。 */
export function vaccinesToOffer(
  statuses: readonly VaccineStatus[],
  preselect?: string,
  limit = 4,
): VaccineStatus[] {
  const pending = statuses.filter((v) => v.state !== 'done' && isRemindable(v));
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
    if (!inSchedule.has(vaccineId)) {
      records.push({ id, vaccineId, name: vaccineRecordName(vaccineId, data.name), at: data.at });
    }
  }
  return records.sort((a, b) => b.at - a.at);
}
