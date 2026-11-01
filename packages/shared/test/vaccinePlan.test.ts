import { describe, expect, it } from 'vitest';
import {
  doseStatus,
  dosesToBackfill,
  doseTimeText,
  dueVaccine,
  type EventData,
  inertPlanCount,
  isVaccinePlanData,
  nextVaccine,
  otherVaccineRecords,
  parseCollectionData,
  planFor,
  planSchedule,
  regions,
  type VaccinePlanData,
  type VaccinePlanEntry,
  vaccineReminderText,
  vaccineStatuses,
  vaccinesToOffer,
} from '../src';

const { SG, CN, US, OTHER } = regions;
const at = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12).getTime();
const birth = at(2026, 1, 15);

const plan = (
  data: Partial<VaccinePlanData> & { vaccineId: string },
  updatedAt = 1,
): VaccinePlanEntry => ({
  id: `plan-${data.vaccineId}-${updatedAt}`,
  updatedAt,
  data: { type: 'vaccine-plan', ...data },
});

const shot = (vaccineId: string, when = birth, name = vaccineId): EventData => ({
  type: 'vaccine',
  at: when,
  vaccineId,
  name,
});

/** 和页面一样的用法：先合并家庭配置，再算状态。 */
function statusesOf(
  region: Parameters<typeof planSchedule>[0],
  plans: VaccinePlanEntry[],
  events: EventData[],
  now: number,
) {
  return vaccineStatuses(planSchedule(region, birth, plans, events), birth, events, now);
}

describe('存储格式', () => {
  it('放在 event 集合里，服务端和新版 App 都能校验通过', () => {
    const data = { type: 'vaccine-plan', vaccineId: 'sg:bcg', hidden: true };
    expect(parseCollectionData('event', data)).toEqual(data);
    expect(isVaccinePlanData(data)).toBe(true);
    expect(isVaccinePlanData({ type: 'feed', at: 1, ml: 90 })).toBe(false);
  });

  it('格式不对的字段只丢这一项，新版本加的字段原样保留', () => {
    const parsed = parseCollectionData('event', {
      type: 'vaccine-plan',
      vaccineId: 'sg:bcg',
      hidden: 'yes',
      plannedAt: -5,
      months: 'soon',
      futureField: 1,
    });
    expect(parsed).toEqual({ type: 'vaccine-plan', vaccineId: 'sg:bcg', futureField: 1 });
  });

  it('没有 vaccineId 的不算配置', () => {
    expect(parseCollectionData('event', { type: 'vaccine-plan' })).toBeNull();
  });
});

describe('隐藏', () => {
  const hideBcg = [plan({ vaccineId: 'sg:bcg', hidden: true })];

  it('隐藏的剂次不在疫苗本、提醒和接种弹层里', () => {
    const statuses = statusesOf(SG, hideBcg, [], birth);
    expect(statuses.map((v) => v.id)).not.toContain('sg:bcg');
    expect(nextVaccine(statuses)?.id).toBe('sg:hepb-1');
    expect(dueVaccine(statuses)?.id).toBe('sg:hepb-1');
    expect(vaccinesToOffer(statuses).map((v) => v.id)).not.toContain('sg:bcg');
    expect(dosesToBackfill(statuses).map((v) => v.id)).not.toContain('sg:bcg');
  });

  it('隐藏的剂次单独列出来，才能恢复', () => {
    const { hidden } = planSchedule(SG, birth, hideBcg, []);
    expect(hidden.map((v) => v.id)).toEqual(['sg:bcg']);
  });

  it('恢复之后回到原来的位置', () => {
    const restored = [plan({ vaccineId: 'sg:bcg', hidden: false })];
    expect(statusesOf(SG, restored, [], birth).map((v) => v.id)).toEqual(
      vaccineStatuses(SG, birth, [], birth).map((v) => v.id),
    );
    expect(planSchedule(SG, birth, restored, []).hidden).toEqual([]);
  });

  it('已经记录的接种永远显示已接种，隐藏不能让它消失', () => {
    const events = [shot('sg:bcg')];
    const bcg = statusesOf(SG, hideBcg, events, birth).find((v) => v.id === 'sg:bcg');
    expect(bcg?.state).toBe('done');
    expect(bcg?.doneAt).toBe(birth);
    expect(planSchedule(SG, birth, hideBcg, events).hidden).toEqual([]);
  });

  it('v0.1.0 没有前缀的接种记录也算已记录', () => {
    const bcg = statusesOf(SG, hideBcg, [shot('bcg')], birth).find((v) => v.id === 'sg:bcg');
    expect(bcg?.state).toBe('done');
  });

  it('二选一的剂次，隐藏一种不影响另一种，记过的那一种照常排除另一种', () => {
    const option = CN.vaccineSchedule.find((v) => v.choice);
    const other = CN.vaccineSchedule.find(
      (v) =>
        v.choice?.group === option?.choice?.group && v.choice?.option !== option?.choice?.option,
    );
    if (!option || !other) throw new Error('中国的表应该有二选一的剂次');
    const hideOption = [plan({ vaccineId: option.id, hidden: true })];
    const ids = statusesOf(CN, hideOption, [], birth).map((v) => v.id);
    expect(ids).not.toContain(option.id);
    expect(ids).toContain(other.id);
    const recorded = statusesOf(CN, hideOption, [shot(option.id)], birth).map((v) => v.id);
    expect(recorded).toContain(option.id);
    expect(recorded).not.toContain(other.id);
  });
});

describe('调整一剂的计划时间', () => {
  const moved = at(2026, 6, 20);
  const later = [plan({ vaccineId: 'sg:bcg', plannedAt: moved })];

  it('内置表的数据不被改写', () => {
    const before = JSON.stringify(SG.vaccineSchedule);
    const { vaccineSchedule } = planSchedule(SG, birth, later, []);
    const bcg = vaccineSchedule.find((v) => v.id === 'sg:bcg');
    expect(bcg?.plannedAt).toBe(moved);
    expect(bcg?.ageLabel).toBe('出生');
    expect(JSON.stringify(SG.vaccineSchedule)).toBe(before);
  });

  it('按计划日期判断：提前两周内算到期，否则未到时间', () => {
    const state = (now: number) =>
      statusesOf(SG, later, [], now).find((v) => v.id === 'sg:bcg')?.state;
    expect(state(at(2026, 6, 1))).toBe('upcoming');
    expect(state(at(2026, 6, 7))).toBe('due');
    expect(state(at(2026, 8, 1))).toBe('due');
  });

  it('按新的时间重新排序，今天页提醒的是真正该打的那一剂', () => {
    const statuses = statusesOf(SG, later, [], birth);
    const ids = statuses.map((v) => v.id);
    expect(ids.indexOf('sg:bcg')).toBeGreaterThan(ids.indexOf('sg:6in1-1'));
    expect(ids.indexOf('sg:bcg')).toBeLessThan(ids.indexOf('sg:6in1-3'));
    expect(dueVaccine(statuses)?.id).toBe('sg:hepb-1');
  });

  it('排在前面的一剂没到期时，后面到期的那一剂还是要提醒', () => {
    // 排序用的是近似时间，月龄和日期混排时，到期的可能排在没到期的后面。
    const now = at(2026, 3, 1);
    const statuses = statusesOf(
      SG,
      [
        plan({ vaccineId: 'sg:bcg', hidden: true }),
        plan({ vaccineId: 'sg:hepb-1', hidden: true }),
        plan({ vaccineId: 'custom:soon', name: '虚构疫苗', plannedAt: at(2026, 3, 15) - 1 }),
        plan({ vaccineId: 'sg:6in1-1', hidden: true }),
        plan({ vaccineId: 'custom:month', name: '虚构疫苗二', months: 2 }),
        plan({ vaccineId: 'custom:far', name: '虚构疫苗三', plannedAt: at(2026, 3, 16) }),
      ],
      [],
      now,
    );
    const first = statuses.find((v) => v.state === 'upcoming');
    if (!first) throw new Error('应该有没到期的剂次');
    expect(dueVaccine([first, ...statuses.filter((v) => v.state === 'due')])?.state).toBe('due');
  });

  it('改过时间的看情况的剂次，是家里定的安排，可以提醒', () => {
    const dose = US.vaccineSchedule.find((v) => v.kind !== 'routine');
    if (!dose) throw new Error('美国的表应该有非常规的剂次');
    const plans = [plan({ vaccineId: dose.id, plannedAt: birth })];
    const statuses = statusesOf(US, plans, [], birth);
    const status = statuses.find((v) => v.id === dose.id);
    if (!status) throw new Error('应该在疫苗本里');
    expect(doseStatus(status)).toEqual({ text: '计划 01.15', tone: 'due' });
    expect(vaccinesToOffer(statuses, undefined, 100).map((v) => v.id)).toContain(dose.id);
  });

  it('已经打了就不再按计划时间显示', () => {
    const bcg = statusesOf(SG, later, [shot('sg:bcg')], birth).find((v) => v.id === 'sg:bcg');
    if (!bcg) throw new Error('应该在疫苗本里');
    expect(bcg.state).toBe('done');
    expect(doseStatus(bcg).text).toBe('已接种 01.15');
  });
});

describe('家庭自己加的疫苗', () => {
  const flu = plan({ vaccineId: 'custom:flu', name: '虚构流感疫苗', plannedAt: at(2026, 3, 10) });

  it('按日期插进疫苗本', () => {
    const statuses = statusesOf(SG, [flu], [], birth);
    const ids = statuses.map((v) => v.id);
    expect(ids.indexOf('custom:flu')).toBeGreaterThan(ids.indexOf('sg:hepb-1'));
    expect(ids.indexOf('custom:flu')).toBeLessThan(ids.indexOf('sg:6in1-1'));
    const dose = statuses.find((v) => v.id === 'custom:flu');
    expect(dose?.localId).toBe('flu');
    expect(dose?.ageLabel).toBe('自己加的');
  });

  it('按月龄算到期，和内置的剂次一样', () => {
    const six = plan({ vaccineId: 'custom:six', name: '虚构疫苗', months: 6 });
    const dose = (now: number) => statusesOf(SG, [six], [], now).find((v) => v.id === 'custom:six');
    expect(dose(at(2026, 6, 15))?.state).toBe('upcoming');
    expect(dose(at(2026, 7, 5))?.state).toBe('due');
    expect(dose(birth)?.ageLabel).toBe('6 个月 · 自己加的');
  });

  it('没填时间也能加，排在最后，不提醒', () => {
    const later = plan({ vaccineId: 'custom:later', name: '虚构疫苗' });
    const statuses = statusesOf(SG, [later], [], at(2040, 1, 1));
    const dose = statuses[statuses.length - 1];
    if (!dose) throw new Error('疫苗本不应该是空的');
    expect(dose.id).toBe('custom:later');
    expect(dose.state).toBe('upcoming');
    expect(doseStatus(dose)).toEqual({ text: '时间待定', tone: 'idle' });
    expect(dueVaccine(statusesOf(OTHER, [later], [], at(2040, 1, 1)))).toBeNull();
  });

  it('打过之后进疫苗本，不会同时出现在其他接种记录', () => {
    const event = shot('custom:flu', at(2026, 3, 11), '虚构流感疫苗（改过名）');
    const planned = planSchedule(SG, birth, [flu], [event]);
    const dose = vaccineStatuses(planned, birth, [event], at(2026, 3, 12)).find(
      (v) => v.id === 'custom:flu',
    );
    expect(dose?.state).toBe('done');
    expect(dose?.name).toBe('虚构流感疫苗（改过名）');
    expect(otherVaccineRecords(planned, [{ id: 'e1', data: event }])).toEqual([]);
  });

  it('把计划移除以后，打过的接种回到其他接种记录，不会消失', () => {
    const event = shot('custom:flu', at(2026, 3, 11), '虚构流感疫苗');
    const planned = planSchedule(SG, birth, [], [event]);
    expect(
      otherVaccineRecords(planned, [{ id: 'e1', data: event }]).map((r) => r.vaccineId),
    ).toEqual(['custom:flu']);
  });

  it('没有名字的自定义配置不显示', () => {
    const { vaccineSchedule } = planSchedule(SG, birth, [plan({ vaccineId: 'custom:x' })], []);
    expect(vaccineSchedule.map((v) => v.id)).not.toContain('custom:x');
  });
});

describe('换地区', () => {
  const config = [
    plan({ vaccineId: 'sg:bcg', hidden: true }),
    plan({ vaccineId: 'sg:6in1-1', plannedAt: at(2026, 4, 1) }),
    plan({ vaccineId: 'custom:flu', name: '虚构流感疫苗', months: 6 }),
  ];

  it('自己加的跟着走，别的地区的隐藏和改时间不生效', () => {
    const inCn = planSchedule(CN, birth, config, []);
    const ids = inCn.vaccineSchedule.map((v) => v.id);
    expect(ids).toContain('custom:flu');
    expect(ids).toContain('cn:bcg');
    expect(inCn.hidden).toEqual([]);
    expect(inertPlanCount(CN, config)).toBe(2);
  });

  it('换回去还在', () => {
    const inSg = planSchedule(SG, birth, config, []);
    expect(inSg.hidden.map((v) => v.id)).toEqual(['sg:bcg']);
    expect(inSg.vaccineSchedule.find((v) => v.id === 'sg:6in1-1')?.plannedAt).toBe(at(2026, 4, 1));
    expect(inertPlanCount(SG, config)).toBe(0);
  });

  it('其他地区没有内置表，疫苗本就是家里自己加的', () => {
    const statuses = statusesOf(OTHER, config, [], at(2026, 7, 10));
    expect(statuses.map((v) => v.id)).toEqual(['custom:flu']);
    expect(dueVaccine(statuses)?.id).toBe('custom:flu');
  });

  it('已经恢复的配置不算没生效', () => {
    expect(inertPlanCount(CN, [plan({ vaccineId: 'sg:bcg', hidden: false })])).toBe(0);
  });
});

describe('同一剂有多条配置', () => {
  it('两台手机离线时各写了一条，后写胜出', () => {
    const plans = [
      plan({ vaccineId: 'sg:bcg', hidden: true }, 5),
      plan({ vaccineId: 'sg:bcg', hidden: false }, 9),
      plan({ vaccineId: 'sg:bcg', hidden: true }, 7),
    ];
    expect(planSchedule(SG, birth, plans, []).hidden).toEqual([]);
    expect(planFor(plans, 'sg:bcg')?.updatedAt).toBe(9);
  });

  it('没有前缀的 id 也能找到配置', () => {
    expect(planFor([plan({ vaccineId: 'sg:bcg', hidden: true })], 'bcg')?.data.hidden).toBe(true);
  });
});

describe('没有配置时什么都不变', () => {
  it('和内置表完全一样', () => {
    for (const region of [SG, CN, US, OTHER]) {
      const planned = planSchedule(region, birth, [], []);
      expect(planned.vaccineSchedule).toEqual(region.vaccineSchedule);
      expect(planned.hidden).toEqual([]);
    }
  });
});

describe('界面文字', () => {
  const status = (dose: string, plans: VaccinePlanEntry[], events: EventData[], now: number) => {
    const found = statusesOf(SG, plans, events, now).find((v) => v.id === dose);
    if (!found) throw new Error(`${dose} 应该在疫苗本里`);
    return found;
  };

  it('内置的剂次沿用原来的说法', () => {
    expect(doseStatus(status('sg:bcg', [], [], birth))).toEqual({
      text: '可以预约了',
      tone: 'due',
    });
    expect(doseStatus(status('sg:6in1-1', [], [], birth))).toEqual({
      text: '未到时间',
      tone: 'idle',
    });
    expect(doseStatus(status('sg:bcg', [], [shot('sg:bcg')], birth))).toEqual({
      text: '已接种 01.15',
      tone: 'done',
    });
  });

  it('看情况和共同决定的剂次不提醒', () => {
    const dose = US.vaccineSchedule.find((v) => v.kind === 'shared-decision');
    if (!dose) throw new Error('美国的表应该有共同决定的剂次');
    const found = vaccineStatuses(US, birth, [], at(2040, 1, 1)).find((v) => v.id === dose.id);
    if (!found) throw new Error('应该在疫苗本里');
    expect(doseStatus(found)).toEqual({ text: '和医生商量', tone: 'idle' });
  });

  it('计划时间只说日期，不说“预约”，诊所已经约好了', () => {
    const plans = [plan({ vaccineId: 'sg:bcg', plannedAt: at(2026, 1, 20) })];
    const dose = status('sg:bcg', plans, [], birth);
    expect(doseStatus(dose)).toEqual({ text: '计划 01.20', tone: 'due' });
    expect(doseTimeText(dose)).toBe('计划 01.20');
    expect(vaccineReminderText(dose)).toBe('卡介苗 BCG，计划 01.20。打完点这里在疫苗本里记一笔。');
  });

  it('计划日期过了也不评价，只是继续显示', () => {
    const plans = [plan({ vaccineId: 'sg:bcg', plannedAt: at(2026, 1, 20) })];
    expect(doseStatus(status('sg:bcg', plans, [], at(2026, 5, 1)))).toEqual({
      text: '计划 01.20',
      tone: 'due',
    });
  });

  it('没有计划时提醒文字和以前一样', () => {
    const dose = status('sg:6in1-1', [], [], birth);
    expect(doseTimeText(dose)).toBe('2 个月');
    expect(vaccineReminderText(dose)).toBe(
      '六合一 6-in-1 第 1 剂，2 个月可接种。打完点这里在疫苗本里记一笔。',
    );
  });
});

describe('一次补记', () => {
  it('列出所有没记的，包括看情况的剂次：孩子可能已经打过', () => {
    const statuses = vaccineStatuses(US, birth, [shot('us:hepb-1')], birth);
    const ids = dosesToBackfill(statuses).map((v) => v.id);
    expect(ids).toEqual(statuses.filter((v) => v.state !== 'done').map((v) => v.id));
    expect(statuses.some((v) => v.kind !== 'routine' && ids.includes(v.id))).toBe(true);
  });
});
