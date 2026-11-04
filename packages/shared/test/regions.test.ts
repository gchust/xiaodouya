import { describe, expect, it } from 'vitest';
import {
  BabyData,
  dueVaccine,
  type EventData,
  effectiveUnits,
  guessRegionId,
  isCustomVaccineId,
  metricUnits,
  newCustomVaccineId,
  nextVaccine,
  normalizeVaccineId,
  optionalRecordedText,
  optionalVaccineBook,
  otherVaccineRecords,
  parseCollectionData,
  regionFor,
  regionList,
  regions,
  type VaccineDose,
  vaccineStatuses,
  vaccinesToOffer,
} from '../src/index';

const at = (y: number, m: number, d: number) => new Date(y, m - 1, d).getTime();
const dose = (list: readonly VaccineDose[], id: string) => list.find((v) => v.id === id);
const months = (list: readonly VaccineDose[], prefix: string) =>
  list.filter((v) => v.localId.startsWith(prefix)).map((v) => v.months);
const { SG, CN, US, OTHER } = regions;

describe('地区注册表', () => {
  it('有 SG、CN、US、OTHER，界面按这个列表渲染，OTHER 排最后', () => {
    expect(regionList.map((r) => r.id)).toEqual(['SG', 'CN', 'US', 'OTHER']);
  });
  it('没有地区的档案来自只支持新加坡的 v0.1.0，按 SG 处理，疫苗本不能变空', () => {
    expect(regionFor(undefined).id).toBe('SG');
    const birth = at(2026, 1, 1);
    const old: EventData[] = [{ type: 'vaccine', at: birth, vaccineId: 'bcg', name: '卡介苗 BCG' }];
    const statuses = vaccineStatuses(regionFor(undefined), birth, old, birth);
    expect(statuses.length).toBeGreaterThan(0);
    expect(statuses.find((v) => v.id === 'sg:bcg')?.state).toBe('done');
    expect(
      otherVaccineRecords(regionFor(undefined), [{ id: 'e', data: old[0] as EventData }]),
    ).toEqual([]);
  });
  it('不认识的地区按 OTHER 处理，不套用别国的方案', () => {
    expect(regionFor('JP').id).toBe('OTHER');
    expect(regionFor('').id).toBe('OTHER');
    expect(regionFor('sg').id).toBe('OTHER');
    expect(regionFor('__proto__').id).toBe('OTHER');
    expect(regionFor('constructor').id).toBe('OTHER');
    expect(regionFor('US').id).toBe('US');
  });
  it('根据系统地区猜测，猜不到就是 OTHER', () => {
    expect(guessRegionId('SG')).toBe('SG');
    expect(guessRegionId('CN')).toBe('CN');
    expect(guessRegionId('US')).toBe('US');
    expect(guessRegionId('us')).toBe('US');
    expect(guessRegionId('JP')).toBe('OTHER');
    // 港澳台的疫苗方案和内地不同，不能归到 CN。
    expect(guessRegionId('HK')).toBe('OTHER');
    expect(guessRegionId('TW')).toBe('OTHER');
    expect(guessRegionId('OTHER')).toBe('OTHER');
    expect(guessRegionId(null)).toBe('OTHER');
    expect(guessRegionId(undefined)).toBe('OTHER');
  });

  it.each(regionList.map((r) => [r.id, r] as const))('%s 的数据完整', (id, region) => {
    expect(region.name.length).toBeGreaterThan(0);
    expect(region.disclaimer).toContain('以诊所安排和健康手册为准');
    expect(region.documentSuggestions).toContain('护照');
    expect(region.documentSuggestions.length).toBeGreaterThan(3);
    expect(['A4', 'Letter']).toContain(region.paperSize);
    // 每一剂的 id 都带本地区前缀，不重复，并按月龄排好，提醒依赖这个顺序。
    const ids = region.vaccineSchedule.map((v) => v.id);
    expect(new Set(ids).size).toBe(ids.length);
    const prefix = `${id.toLowerCase()}:`;
    for (const v of region.vaccineSchedule) {
      expect(v.id).toBe(`${prefix}${v.localId}`);
      expect(v.ageLabel.length).toBeGreaterThan(0);
    }
    const all = region.vaccineSchedule.map((v) => v.months);
    expect(all).toEqual([...all].sort((a, b) => a - b));
  });
  it('有疫苗表的地区都写明来源和版本，读不到原文的要标明待复核', () => {
    for (const region of [SG, CN, US]) {
      expect(region.source?.label.length).toBeGreaterThan(0);
      expect(region.source?.url).toMatch(/^https:\/\//);
      expect(region.source?.version.length).toBeGreaterThan(0);
    }
    expect(SG.reviewStatus).toBe('needs-review');
    expect(CN.reviewStatus).toBe('primary-source');
    expect(US.reviewStatus).toBe('primary-source');
    expect(OTHER.source).toBeNull();
    expect(OTHER.vaccineSchedule).toEqual([]);
    expect(OTHER.emptyScheduleNote?.length).toBeGreaterThan(0);
  });
  it('纸张和默认单位', () => {
    expect(US.paperSize).toBe('Letter');
    expect(SG.paperSize).toBe('A4');
    expect(CN.paperSize).toBe('A4');
    expect(OTHER.paperSize).toBe('A4');
    expect(US.defaultUnits).toEqual({
      volume: 'oz',
      temperature: 'f',
      weight: 'lb',
      length: 'in',
    });
    expect(SG.defaultUnits).toEqual(metricUnits);
    expect(CN.defaultUnits).toEqual(metricUnits);
    expect(OTHER.defaultUnits).toEqual(metricUnits);
    expect(effectiveUnits(undefined, 'JP')).toEqual(metricUnits);
  });
});

describe('BabyData.region 要宽松', () => {
  const baby = { name: '豆豆', birthAt: 1 };
  it('没有地区的旧记录能通过', () => {
    expect(parseCollectionData('baby', baby)?.region).toBeUndefined();
  });
  it('新版本的未知地区不能校验失败，也不能被丢掉', () => {
    expect(parseCollectionData('baby', { ...baby, region: 'JP' })?.region).toBe('JP');
  });
  it('类型不对也不能让整份档案失效', () => {
    const parsed = BabyData.safeParse({ ...baby, region: 42 });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.region).toBeUndefined();
    expect(parseCollectionData('baby', { ...baby, region: 'x'.repeat(500) })?.name).toBe('豆豆');
  });
});

/**
 * 下面几组把疫苗表的关键事实钉在读到的原文上。改这些数字前要先读现行原文，并更新地区文件里的来源。
 */
describe('中国：《国家免疫规划疫苗儿童免疫程序及说明（2026 年版）》', () => {
  const s = CN.vaccineSchedule;
  it('来源写明 2026 年版', () => {
    expect(CN.source?.label).toContain('2026');
    expect(CN.source?.version).toContain('2026');
  });
  it('百白破 DTaP 从 2 月龄开始，共 5 剂：2、4、6、18 月龄和 6 周岁', () => {
    expect(months(s, 'dtap')).toEqual([2, 4, 6, 18, 72]);
    expect(dose(s, 'cn:dtap-1')?.name).toContain('DTaP');
    expect(dose(s, 'cn:dtap-1')?.ageLabel).toContain('2');
  });
  it('乙肝 HepB 0、1、6 月龄', () => {
    expect(months(s, 'hepb')).toEqual([0, 1, 6]);
  });
  it('卡介苗出生时 1 剂', () => {
    expect(months(s, 'bcg')).toEqual([0]);
  });
  it('脊灰 2、3 月龄 IPV，4 月龄、4 周岁 bOPV', () => {
    expect(months(s, 'ipv')).toEqual([2, 3]);
    expect(months(s, 'bopv')).toEqual([4, 48]);
  });
  it('麻腮风 8、18 月龄', () => {
    expect(months(s, 'mmr')).toEqual([8, 18]);
  });
  it('乙脑：减毒 8 月龄、2 周岁；灭活 8 月龄 2 剂、2 周岁、6 周岁，二选一', () => {
    expect(months(s, 'je-l')).toEqual([8, 24]);
    expect(months(s, 'je-i')).toEqual([8, 8, 24, 72]);
    expect(dose(s, 'cn:je-i-2')?.note).toContain('7–10 天');
    expect(dose(s, 'cn:je-l-1')?.choice?.group).toBe(dose(s, 'cn:je-i-1')?.choice?.group);
    expect(dose(s, 'cn:je-l-1')?.choice?.option).not.toBe(dose(s, 'cn:je-i-1')?.choice?.option);
  });
  it('流脑：A 群 6、9 月龄；A 群 C 群 3、6 周岁', () => {
    expect(months(s, 'mpsv-a-')).toEqual([6, 9]);
    expect(months(s, 'mpsv-ac')).toEqual([36, 72]);
  });
  it('甲肝：减毒 18 月龄 1 剂；灭活 18 月龄、2 周岁，二选一', () => {
    expect(months(s, 'hepa-l')).toEqual([18]);
    expect(months(s, 'hepa-i')).toEqual([18, 24]);
    expect(dose(s, 'cn:hepa-l')?.choice?.group).toBe(dose(s, 'cn:hepa-i-1')?.choice?.group);
  });
  it('双价 HPV 面向 13 周岁女孩，不会提醒给所有孩子', () => {
    expect(months(s, 'hpv')).toEqual([156, 162]);
    expect(dose(s, 'cn:hpv-1')?.kind).toBe('conditional');
    expect(dose(s, 'cn:hpv-1')?.note).toContain('女孩');
  });
  it('名字是中文加常用英文缩写', () => {
    for (const v of s) expect(v.name).toMatch(/[一-龥].*[A-Za-z]/);
  });
});

/**
 * 自费疫苗（issue #62）。月龄只是“通常从几月龄开始”的参考，不进疫苗本的状态和提醒。
 * 流感和 EV71 按中国疾控的指南，其余来自接种点的宣传单（待复核），见 cn.ts。
 */
describe('中国：自费、自愿的非免疫规划疫苗', () => {
  const optional = CN.optionalVaccines;
  const list = optional?.vaccines ?? [];
  const find = (localId: string) => list.find((v) => v.localId === localId);

  it('可以直接从列表选，不用手填名字', () => {
    expect(list.map((v) => v.localId)).toEqual([
      'rv5',
      'pcv13',
      'dtap-ipv-hib',
      'rv',
      'hib',
      'dtap-hib',
      'menacyw-conj',
      'menac-conj',
      'flu',
      'ev71',
      'var',
      'ppsv23',
      'cholera',
      'mpsv4',
      'hpv2',
      'hpv9',
    ]);
  });
  it('按参考首针月龄排列', () => {
    const starts = list.map((v) => v.startMonths);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });
  it('id 带地区前缀，不会和免疫规划的剂次撞，写进记录的是中文原名', () => {
    const scheduled = new Set(CN.vaccineSchedule.map((d) => d.id));
    for (const v of list) {
      expect(v.id).toBe(`cn:opt-${v.localId}`);
      expect(scheduled.has(v.id)).toBe(false);
      expect(v.recordName).toMatch(/[一-龥]/);
    }
    expect(new Set(list.map((v) => v.id)).size).toBe(list.length);
  });
  it('流感疫苗按中国疾控的指南从 6 月龄开始，不用宣传单上的 6.5 月', () => {
    expect(find('flu')?.startMonths).toBe(6);
    expect(find('flu')?.basis).toBe('guideline');
    expect(find('flu')?.note).toContain('2 剂');
  });
  it('EV71 疫苗按中国疾控的指南从 6 月龄开始，不用宣传单上的 6.5 月', () => {
    expect(find('ev71')?.startMonths).toBe(6);
    expect(find('ev71')?.basis).toBe('guideline');
    expect(find('ev71')?.note).toContain('2 剂');
  });
  it('其余的参考月龄来自宣传单，标着待复核', () => {
    expect(list.filter((v) => v.basis === 'guideline').map((v) => v.localId)).toEqual([
      'flu',
      'ev71',
    ]);
    expect(find('rv5')?.startMonths).toBe(1.5);
    expect(find('pcv13')?.startMonths).toBe(1.5);
    expect(find('dtap-ipv-hib')?.startMonths).toBe(2);
    expect(find('rv')?.startMonths).toBe(2.5);
    expect(find('menacyw-conj')?.startMonths).toBe(3);
    expect(find('menac-conj')?.startMonths).toBe(6);
    expect(find('var')?.startMonths).toBe(12);
    expect(find('ppsv23')?.startMonths).toBe(24);
    expect(find('mpsv4')?.startMonths).toBe(36);
    expect(find('hpv9')?.startMonths).toBe(108);
  });
  it('乙脑灭活疫苗已经在免疫规划表里二选一，不再列一次', () => {
    expect(list.some((v) => v.recordName.includes('乙脑'))).toBe(false);
    expect(dose(CN.vaccineSchedule, 'cn:je-i-1')).toBeDefined();
  });
  it('只有官方方案写了能算作完成的，才说可能替代免费疫苗', () => {
    const replacing = list.filter((v) => v.mayReplace).map((v) => v.localId);
    expect(replacing).toEqual([
      'dtap-ipv-hib',
      'dtap-hib',
      'menacyw-conj',
      'menac-conj',
      'mpsv4',
      'hpv2',
      'hpv9',
    ]);
    for (const id of replacing) expect(find(id)?.mayReplace).toContain('以接种单位为准');
  });
  it('HPV 不假定性别，适用人群以说明书为准', () => {
    for (const id of ['hpv2', 'hpv9']) {
      const v = find(id);
      expect(v?.note).toContain('适用人群以说明书为准');
      expect(`${v?.name}${v?.note}${v?.mayReplace}`).not.toMatch(/女孩|女性|男孩|男性/);
    }
  });
  it('说明写明是参考首针月龄，以接种单位安排和说明书为准', () => {
    expect(optional?.note).toContain('第一剂');
    expect(optional?.note).toContain('不是完整的接种程序');
    expect(optional?.note).toContain('以接种单位安排和说明书为准');
  });
  it('其他地区没有自费疫苗列表', () => {
    expect(SG.optionalVaccines).toBeUndefined();
    expect(US.optionalVaccines).toBeUndefined();
    expect(OTHER.optionalVaccines).toBeUndefined();
  });
});

describe('自费疫苗不改变免疫规划的状态', () => {
  const birth = at(2026, 1, 1);
  const now = at(2026, 3, 10);
  const fiveName = '五联疫苗（百白破-脊灰-Hib）DTaP-IPV/Hib';
  const five: EventData = {
    type: 'vaccine',
    at: now,
    vaccineId: 'cn:opt-dtap-ipv-hib',
    name: fiveName,
  };

  it('打了五联，免费的百白破和脊灰也不会自动标成已接种或跳过', () => {
    const statuses = vaccineStatuses(CN, birth, [five], now);
    expect(statuses.find((v) => v.id === 'cn:dtap-1')?.state).toBe('due');
    expect(statuses.find((v) => v.id === 'cn:ipv-1')?.state).toBe('due');
    expect(statuses.some((v) => v.id.startsWith('cn:opt-'))).toBe(false);
  });
  it('不会出现在提醒和接种弹层的待接种里', () => {
    const statuses = vaccineStatuses(CN, birth, [], at(2036, 1, 1));
    expect(dueVaccine(statuses)?.id.startsWith('cn:opt-')).toBe(false);
    expect(vaccinesToOffer(statuses).some((v) => v.id.startsWith('cn:opt-'))).toBe(false);
  });
  it('记下的自费疫苗进“其他接种记录”', () => {
    expect(otherVaccineRecords(CN, [{ id: 'e', data: five }])).toEqual([
      { id: 'e', vaccineId: 'cn:opt-dtap-ipv-hib', name: fiveName, at: now },
    ]);
  });
});

/** 疫苗本上直接列出自费疫苗（issue #68）：找得到、看得到记过没有，但没有到期和提醒。 */
describe('疫苗本上的自费疫苗', () => {
  const birth = at(2026, 1, 1);
  const pcvName = '13 价肺炎球菌结合疫苗 PCV13';
  const shotOf = (id: string, vaccineId: string, when: number, name = pcvName) => ({
    id,
    data: { type: 'vaccine', at: when, vaccineId, name } as EventData,
  });

  it('按地区列表的顺序列出全部自费疫苗，没记过的没有记录', () => {
    const book = optionalVaccineBook(CN.optionalVaccines, []);
    expect(book.map((e) => e.vaccine.id)).toEqual(CN.optionalVaccines?.vaccines.map((v) => v.id));
    expect(book.every((e) => e.records.length === 0)).toBe(true);
  });
  it('按 id 把记录配到疫苗上，同一种打了几剂都在，新的在前', () => {
    const book = optionalVaccineBook(CN.optionalVaccines, [
      shotOf('a', 'cn:opt-pcv13', at(2026, 2, 15)),
      shotOf('b', 'cn:opt-pcv13', at(2026, 4, 15)),
      shotOf('c', 'cn:opt-rv5', at(2026, 2, 15), '五价轮状病毒疫苗 RV5（进口）'),
    ]);
    const pcv = book.find((e) => e.vaccine.localId === 'pcv13');
    expect(pcv?.records.map((r) => r.id)).toEqual(['b', 'a']);
    expect(pcv?.records[0]).toEqual({
      id: 'b',
      vaccineId: 'cn:opt-pcv13',
      name: pcvName,
      at: at(2026, 4, 15),
    });
    expect(book.find((e) => e.vaccine.localId === 'rv5')?.records.map((r) => r.id)).toEqual(['c']);
    expect(book.find((e) => e.vaccine.localId === 'hib')?.records).toEqual([]);
  });
  it('只按 id 配对：自己填名字的、免疫规划的、别的地区的都不算', () => {
    const book = optionalVaccineBook(CN.optionalVaccines, [
      shotOf('custom', newCustomVaccineId('u1'), birth, '13价肺炎'),
      shotOf('free', 'cn:bcg', birth, '卡介苗 BCG'),
      shotOf('sg', 'sg:pcv-1', birth, '肺炎球菌结合疫苗 PCV 第 1 剂'),
      { id: 'sleep', data: { type: 'sleep', at: birth, endAt: birth + 1000 } as EventData },
    ]);
    expect(book.every((e) => e.records.length === 0)).toBe(true);
  });
  it('没有自费疫苗列表的地区什么都不列', () => {
    const entries = [shotOf('a', 'cn:opt-pcv13', birth)];
    expect(optionalVaccineBook(SG.optionalVaccines, entries)).toEqual([]);
    expect(optionalVaccineBook(US.optionalVaccines, entries)).toEqual([]);
    expect(optionalVaccineBook(OTHER.optionalVaccines, entries)).toEqual([]);
  });
  it('只有记录，没有到期、待接种之类的状态', () => {
    const [entry] = optionalVaccineBook(CN.optionalVaccines, []);
    expect(Object.keys(entry ?? {}).sort()).toEqual(['records', 'vaccine']);
  });
  it('记过的显示日期，几剂时写剂数和最近一次；没记过的不写状态', () => {
    const book = optionalVaccineBook(CN.optionalVaccines, [
      shotOf('a', 'cn:opt-pcv13', at(2026, 2, 15)),
      shotOf('b', 'cn:opt-pcv13', at(2026, 4, 15)),
      shotOf('c', 'cn:opt-rv5', at(2026, 2, 15)),
    ]);
    const text = (localId: string) =>
      optionalRecordedText(book.find((e) => e.vaccine.localId === localId) as never);
    expect(text('rv5')).toBe('已接种 2026.02.15');
    expect(text('pcv13')).toBe('已接种 2 剂 · 最近 2026.04.15');
    expect(text('hib')).toBeNull();
  });
});

describe('美国：AAP 2026 儿童和青少年免疫表', () => {
  const s = US.vaccineSchedule;
  it('来源是 AAP 2026', () => {
    expect(US.source?.label).toContain('AAP');
    expect(US.source?.version).toContain('2026');
    expect(US.source?.url).toContain('aap.org');
  });
  it('免责声明写明来源是 AAP 并建议问儿科医生，不评价没读到原文的 CDC', () => {
    expect(US.disclaimer).toContain('AAP');
    expect(US.disclaimer).toContain('儿科医生');
    expect(US.disclaimer).not.toContain('CDC');
  });
  it('乙肝 HepB：出生，1–2 个月，6–18 个月，都是常规剂', () => {
    expect(months(s, 'hepb')).toEqual([0, 1, 6]);
    expect(dose(s, 'us:hepb-1')?.kind).toBe('routine');
    expect(dose(s, 'us:hepb-2')?.ageLabel).toBe('1–2 个月');
    expect(dose(s, 'us:hepb-3')?.ageLabel).toBe('6–18 个月');
  });
  it('百白破 DTaP：2、4、6、15–18 个月、4–6 岁', () => {
    expect(months(s, 'dtap')).toEqual([2, 4, 6, 15, 48]);
    expect(dose(s, 'us:dtap-4')?.ageLabel).toBe('15–18 个月');
  });
  it('轮状病毒第 3 剂只有 RV5 需要', () => {
    expect(months(s, 'rv')).toEqual([2, 4, 6]);
    expect(dose(s, 'us:rv-3')?.kind).toBe('conditional');
    expect(dose(s, 'us:rv-3')?.note).toContain('RV5');
  });
  it('Hib 第 3 剂看产品，加强剂在 12–15 个月', () => {
    expect(months(s, 'hib')).toEqual([2, 4, 6, 12]);
    expect(dose(s, 'us:hib-3')?.kind).toBe('conditional');
    expect(dose(s, 'us:hib-booster')?.ageLabel).toBe('12–15 个月');
  });
  it('肺炎球菌 PCV 和脊灰 IPV', () => {
    expect(months(s, 'pcv')).toEqual([2, 4, 6, 12]);
    expect(months(s, 'ipv')).toEqual([2, 4, 6, 48]);
    expect(dose(s, 'us:ipv-3')?.ageLabel).toBe('6–18 个月');
  });
  it('麻腮风 MMR 和水痘 VAR：12–15 个月、4–6 岁', () => {
    expect(months(s, 'mmr')).toEqual([12, 48]);
    expect(months(s, 'var')).toEqual([12, 48]);
  });
  it('甲肝 HepA 在 12–23 个月打完 2 剂', () => {
    expect(months(s, 'hepa')).toEqual([12, 18]);
    expect(dose(s, 'us:hepa-1')?.ageLabel).toBe('12–23 个月');
  });
  it('流感和 COVID-19 从 6 个月起，AAP 列为常规', () => {
    expect(dose(s, 'us:flu')?.months).toBe(6);
    expect(dose(s, 'us:flu')?.kind).toBe('routine');
    expect(dose(s, 'us:covid')?.months).toBe(6);
    expect(dose(s, 'us:covid')?.ageLabel).toBe('6–23 个月');
    expect(dose(s, 'us:covid')?.kind).toBe('routine');
  });
  it('RSV 单抗取决于妈妈孕期是否接种，不能当成每个宝宝都要打', () => {
    expect(dose(s, 'us:rsv')?.kind).toBe('conditional');
    expect(dose(s, 'us:rsv')?.note).toContain('妈妈');
  });
  it('MenB 是和医生共同决定的，准确标出来', () => {
    expect(dose(s, 'us:menb')?.kind).toBe('shared-decision');
  });
  it('青少年：Tdap、HPV、MenACWY', () => {
    expect(dose(s, 'us:tdap')?.ageLabel).toBe('11–12 岁');
    expect(dose(s, 'us:hpv-1')?.ageLabel).toBe('9–12 岁');
    expect(months(s, 'menacwy')).toEqual([132, 192]);
  });
});

describe('新加坡：沿用原来的表', () => {
  const s = SG.vaccineSchedule;
  it('乙肝第 2 剂随六合一在 2 个月，不再有单独的 1 个月剂', () => {
    expect(s.find((v) => v.months === 1)).toBeUndefined();
    expect(dose(s, 'sg:6in1-1')?.months).toBe(2);
    expect(dose(s, 'sg:6in1-1')?.note).toContain('乙肝');
  });
  it('13 剂和原来的 id、月龄都还在', () => {
    expect(s.map((v) => [v.localId, v.months])).toEqual([
      ['bcg', 0],
      ['hepb-1', 0],
      ['6in1-1', 2],
      ['5in1-2', 4],
      ['pcv-1', 4],
      ['6in1-3', 6],
      ['pcv-2', 6],
      ['flu', 6],
      ['pcv-3', 12],
      ['mmr-1', 12],
      ['var-1', 12],
      ['mmrv-2', 15],
      ['5in1-4', 18],
    ]);
  });
  it('E2E 依赖的名字', () => {
    expect(dose(s, 'sg:bcg')?.name).toBe('卡介苗 BCG');
  });
});

describe('接种记录按地区划分，换地区不丢', () => {
  const birth = at(2026, 1, 1);
  const shot = (vaccineId: string, name = vaccineId, when = birth): EventData => ({
    type: 'vaccine',
    at: when,
    vaccineId,
    name,
  });
  const entries = (events: EventData[]) => events.map((data, i) => ({ id: `e${i}`, data }));

  it('没有前缀的旧 id 当作新加坡的', () => {
    expect(normalizeVaccineId('bcg')).toBe('sg:bcg');
    expect(normalizeVaccineId('sg:bcg')).toBe('sg:bcg');
    expect(normalizeVaccineId('cn:bcg')).toBe('cn:bcg');
    expect(normalizeVaccineId('custom:abc')).toBe('custom:abc');
  });
  it('旧记录在新加坡的表里算已接种', () => {
    const statuses = vaccineStatuses(SG, birth, [shot('bcg')], at(2026, 1, 25));
    expect(statuses.find((v) => v.id === 'sg:bcg')?.state).toBe('done');
    expect(otherVaccineRecords(SG, entries([shot('bcg')]))).toEqual([]);
  });
  it('时间戳是 0 也算已接种', () => {
    const statuses = vaccineStatuses(SG, 0, [shot('bcg', 'BCG', 0)], 1000);
    expect(statuses.find((v) => v.id === 'sg:bcg')?.state).toBe('done');
  });
  it('换到别的地区，记录进“其他接种记录”，不自动算成当地的同名疫苗', () => {
    const events = [shot('bcg', '卡介苗 BCG')];
    const statuses = vaccineStatuses(CN, birth, events, at(2026, 1, 25));
    expect(statuses.find((v) => v.id === 'cn:bcg')?.state).toBe('due');
    expect(otherVaccineRecords(CN, entries(events))).toEqual([
      { id: 'e0', vaccineId: 'sg:bcg', name: '卡介苗 BCG', at: birth },
    ]);
  });
  it('换回来又都在', () => {
    const events = [shot('cn:bcg', '卡介苗 BCG'), shot('sg:hepb-1', '乙肝')];
    expect(vaccineStatuses(CN, birth, events, birth).find((v) => v.id === 'cn:bcg')?.state).toBe(
      'done',
    );
    expect(otherVaccineRecords(CN, entries(events)).map((r) => r.vaccineId)).toEqual(['sg:hepb-1']);
    expect(otherVaccineRecords(SG, entries(events)).map((r) => r.vaccineId)).toEqual(['cn:bcg']);
  });
  it('自定义疫苗在任何地区都进“其他接种记录”，按时间倒序', () => {
    const id = newCustomVaccineId('abc');
    expect(id).toBe('custom:abc');
    expect(isCustomVaccineId(id)).toBe(true);
    expect(isCustomVaccineId('sg:bcg')).toBe(false);
    const events = [shot(id, '伤寒', birth), shot('custom:def', '黄热病', birth + 1000)];
    for (const region of [SG, CN, US, OTHER]) {
      expect(otherVaccineRecords(region, entries(events)).map((r) => r.name)).toEqual([
        '黄热病',
        '伤寒',
      ]);
    }
  });
  it('其他类型的记录不算', () => {
    const events: EventData[] = [{ type: 'feed', at: 0, ml: 90 }];
    expect(otherVaccineRecords(OTHER, entries(events))).toEqual([]);
  });
  it('OTHER 没有表：状态为空，什么都不提醒', () => {
    const statuses = vaccineStatuses(OTHER, birth, [], at(2026, 9, 1));
    expect(statuses).toEqual([]);
    expect(nextVaccine(statuses)).toBeNull();
    expect(dueVaccine(statuses)).toBeNull();
    expect(vaccinesToOffer(statuses)).toEqual([]);
  });
});

describe('提醒和弹层', () => {
  const birth = at(2026, 1, 1);
  it('到期才提醒', () => {
    const shots: EventData[] = ['bcg', 'hepb-1'].map((id) => ({
      type: 'vaccine',
      at: birth,
      vaccineId: id,
      name: id,
    }));
    const early = vaccineStatuses(SG, birth, shots, at(2026, 1, 3));
    expect(nextVaccine(early)?.id).toBe('sg:6in1-1');
    expect(dueVaccine(early)).toBeNull();
    const later = vaccineStatuses(SG, birth, shots, at(2026, 2, 20));
    expect(dueVaccine(later)?.id).toBe('sg:6in1-1');
  });
  it('看情况和共同决定的疫苗不主动提醒，也不占弹层的名额', () => {
    const statuses = vaccineStatuses(US, birth, [], birth);
    expect(statuses.find((v) => v.id === 'us:rsv')?.state).toBe('due');
    expect(dueVaccine(statuses)?.id).toBe('us:hepb-1');
    expect(vaccinesToOffer(statuses).map((v) => v.id)).not.toContain('us:rsv');
    expect(vaccinesToOffer(statuses, 'us:rsv').map((v) => v.id)).toContain('us:rsv');
  });
  it('二选一：选了一种，另一种的剂次就不再出现', () => {
    const now = at(2026, 9, 15);
    const unchosen = vaccineStatuses(CN, birth, [], now).map((v) => v.id);
    expect(unchosen).toContain('cn:je-l-1');
    expect(unchosen).toContain('cn:je-i-1');
    const events: EventData[] = [
      { type: 'vaccine', at: now, vaccineId: 'cn:je-i-1', name: '乙脑灭活疫苗 JE-I 第 1 剂' },
    ];
    const chosen = vaccineStatuses(CN, birth, events, now).map((v) => v.id);
    expect(chosen).toContain('cn:je-i-2');
    expect(chosen).toContain('cn:je-i-4');
    expect(chosen).not.toContain('cn:je-l-1');
    expect(chosen).not.toContain('cn:je-l-2');
    // 甲肝是另一组，不受影响。
    expect(chosen).toContain('cn:hepa-l');
    expect(chosen).toContain('cn:hepa-i-1');
    // 选择过的记录还在表里，不会被当成“其他”。
    expect(otherVaccineRecords(CN, [{ id: 'x', data: events[0] as EventData }])).toEqual([]);
  });
  it('两种都打过时两种都显示，不隐藏已有的记录', () => {
    const events: EventData[] = [
      { type: 'vaccine', at: birth, vaccineId: 'cn:je-i-1', name: 'a' },
      { type: 'vaccine', at: birth, vaccineId: 'cn:je-l-1', name: 'b' },
    ];
    const ids = vaccineStatuses(CN, birth, events, birth).map((v) => v.id);
    expect(ids).toContain('cn:je-i-1');
    expect(ids).toContain('cn:je-l-1');
  });
});
