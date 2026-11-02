import { afterEach, describe, expect, it } from 'vitest';
import {
  ageText,
  assessTemperature,
  dayLabel,
  describeEvent,
  doseStatus,
  type EventData,
  formatDateHeader,
  formatDuration,
  formatFullDate,
  formatMonthDay,
  knowledgeForAge,
  type Locale,
  messagesFor,
  metricUnits,
  milestoneTemplates,
  newCustomVaccineId,
  otherVaccineRecords,
  regionFor,
  regionList,
  roleLabels,
  scaleFor,
  setLocale,
  summarize24h,
  summaryText,
  todayInsight,
  type VaccineDose,
  vaccineRecordName,
  vaccineStatuses,
  withLocale,
} from '../src';

const CJK = /[㐀-鿿　-〿＀-￯]/;
const HOUR = 3_600_000;
const NOW = new Date(2026, 10, 2, 12).getTime();
const both = <T>(run: () => T): { zh: T; en: T } => ({
  zh: withLocale('zh', run),
  en: withLocale('en', run),
});
/** 句子里的数字，排序后比较。阈值、月龄、次数都不能因为翻译变。 */
const numbers = (text: string) =>
  (text.match(/\d+(\.\d+)?/g) ?? []).map(Number).sort((a, b) => a - b);

afterEach(() => setLocale('zh'));

describe('健康提示：两种语言完全一致', () => {
  const temps = [
    [38, 1], // 3 个月以下发烧
    [38.5, 2],
    [39, 4], // 6 个月以下高烧
    [39.5, 5],
    [38, 8], // 发烧
    [37.5, 8], // 偏高
    [35.5, 1], // 过低
    [35.5, 8], // 偏低
    [36.2, 8], // 有点偏低
    [36.8, 8], // 正常
  ] as const;

  for (const unit of ['c', 'f'] as const) {
    it.each(temps)(`%s℃ %s 个月 单位 ${unit}：严重程度和阈值都一样`, (celsius, months) => {
      const { zh, en } = both(() => assessTemperature(celsius, months, unit));
      expect(en.level).toBe(zh.level);
      expect(numbers(en.hint)).toEqual(numbers(zh.hint));
      expect(numbers(en.note)).toEqual(numbers(zh.note));
      expect(en.hint).not.toMatch(CJK);
      expect(en.note).not.toMatch(CJK);
    });
  }

  it('“尽快就医”的紧迫程度不能变弱', () => {
    for (const [celsius, months] of [
      [38, 1],
      [39, 4],
      [35.5, 1],
    ] as const) {
      const en = withLocale('en', () => assessTemperature(celsius, months));
      expect(en.level).toBe('urgent');
      expect(en.note).toContain('as soon as possible');
      expect(en.hint).toContain('as soon as possible');
      expect(en.hint).not.toMatch(/\b(may|might|consider|could)\b/i);
    }
  });

  it('38℃ 在华氏度下写成 100.4°F', () => {
    const en = withLocale('en', () => assessTemperature(38, 1, 'f'));
    expect(en.hint).toContain('100.4°F');
    expect(en.hint).toContain('under 3 months');
  });

  const feed = (at: number): EventData => ({ type: 'feed', at, ml: 90, byName: '妈妈' });
  const wet = (at: number): EventData => ({ type: 'diaper', at, kind: 'wee', byName: '妈妈' });

  const scenarios: Record<string, readonly EventData[]> = {
    '第一天只记了一条，数据不足': [feed(NOW - HOUR)],
    记满一天但偏少: [feed(NOW - 30 * HOUR), feed(NOW - 4 * HOUR), wet(NOW - 3 * HOUR)],
    记满一天正常: [
      ...Array.from({ length: 8 }, (_, i) => feed(NOW - (i * 3 + 1) * HOUR)),
      ...Array.from({ length: 7 }, (_, i) => wet(NOW - (i * 3 + 2) * HOUR)),
      feed(NOW - 30 * HOUR),
    ],
    睡着了: [{ type: 'sleep', at: NOW - HOUR, byName: '妈妈' }, feed(NOW - 2 * HOUR)],
    忘了结束睡眠: [{ type: 'sleep', at: NOW - 20 * HOUR, byName: '妈妈' }],
  };
  const birthAt = new Date(2026, 8, 20).getTime();

  it.each(Object.entries(scenarios))('%s：提示的语气和数字一样', (_name, events) => {
    const { zh, en } = both(() => todayInsight(events, birthAt, NOW));
    expect(en?.tone).toBe(zh?.tone);
    expect(numbers(en?.text ?? '')).toEqual(numbers(zh?.text ?? ''));
    expect(en?.text).not.toMatch(CJK);
  });

  it('数据不足或偏少时，英文同样不能安慰说吃够了', () => {
    for (const name of ['第一天只记了一条，数据不足', '记满一天但偏少']) {
      const en = withLocale('en', () => todayInsight(scenarios[name] ?? [], birthAt, NOW));
      expect(en?.text).not.toMatch(/\b(enough|plenty|sufficient|fine|good|great)\b/i);
    }
    const low = withLocale('en', () => todayInsight(scenarios.记满一天但偏少 ?? [], birthAt, NOW));
    expect(low?.tone).toBe('attention');
    expect(low?.text).toContain('Fewer than usual');
    expect(low?.text).toContain('asking a doctor');
    // 喂得够也只说事实，不下“够了”的结论。
    const normal = withLocale('en', () => todayInsight(scenarios.记满一天正常 ?? [], birthAt, NOW));
    expect(normal?.tone).toBe('neutral');
    expect(normal?.text).not.toMatch(/\b(enough|plenty|sufficient)\b/i);
  });

  it('按月龄的常识卡一一对应，数字一样', () => {
    for (const months of [1, 4, 8, 14]) {
      for (const unit of ['c', 'f'] as const) {
        const { zh, en } = both(() => knowledgeForAge(months, unit));
        expect(en).toHaveLength(zh.length);
        en.forEach((card, i) => {
          expect(numbers(card.body)).toEqual(numbers(zh[i]?.body ?? ''));
          expect(`${card.title}${card.body}`).not.toMatch(CJK);
        });
      }
    }
  });
});

describe('英文目录', () => {
  /** 把函数也跑一遍：用假参数调用，看生成的文字里有没有混进中文。 */
  function leaves(node: unknown, path: string, out: [string, string][]): void {
    if (typeof node === 'string') out.push([path, node]);
    else if (typeof node === 'function') {
      const args = Array.from({ length: node.length }, () => 2);
      let text: unknown;
      try {
        text = node(...args);
      } catch {
        // 参数类型不是数字的（日期、数组），单独在别的测试里覆盖。
        return;
      }
      if (typeof text === 'string') out.push([path, text]);
    } else if (Array.isArray(node)) {
      for (const [i, v] of node.entries()) leaves(v, `${path}[${i}]`, out);
    } else if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) leaves(value, `${path}.${key}`, out);
    }
  }

  it('没有混进中文，语言名字除外', () => {
    const out: [string, string][] = [];
    leaves(messagesFor('en'), 'en', out);
    const offenders = out.filter(([path, text]) => CJK.test(text) && !path.endsWith('.languageZh'));
    expect(offenders).toEqual([]);
  });
});

describe('日期和数字', () => {
  const at = new Date(2026, 9, 31, 8, 5).getTime();

  it('中文的格式不变', () => {
    expect(formatMonthDay(at)).toBe('10.31');
    expect(formatFullDate(at)).toBe('2026.10.31');
    expect(formatDateHeader(at)).toBe('10月31日 · 星期六');
    expect(formatDuration(2 * HOUR + 5 * 60_000)).toBe('2小时5分');
    expect(formatDuration(25 * 60_000)).toBe('25分钟');
    expect(formatDuration(2 * HOUR)).toBe('2小时');
  });

  it('英文写月份的名字，不用 10.31 这种写法', () => {
    withLocale('en', () => {
      expect(formatMonthDay(at)).toBe('Oct 31');
      expect(formatFullDate(at)).toBe('Oct 31, 2026');
      expect(formatDateHeader(at)).toBe('Oct 31 · Saturday');
      expect(formatDuration(2 * HOUR + 5 * 60_000)).toBe('2 hr 5 min');
      expect(formatDuration(25 * 60_000)).toBe('25 min');
      expect(formatDuration(HOUR)).toBe('1 hr');
    });
  });

  it('月龄和第几天处理单复数', () => {
    const birth = new Date(2026, 0, 15).getTime();
    const on = (y: number, m: number, d: number) => new Date(y, m, d).getTime();
    withLocale('en', () => {
      expect(ageText(birth, on(2026, 0, 15))).toBe('Born today');
      expect(ageText(birth, on(2026, 0, 16))).toBe('1 day');
      expect(ageText(birth, on(2026, 0, 18))).toBe('3 days');
      expect(ageText(birth, on(2026, 1, 15))).toBe('1 month');
      expect(ageText(birth, on(2026, 1, 16))).toBe('1 month 1 day');
      expect(ageText(birth, on(2026, 3, 18))).toBe('3 months 3 days');
      expect(ageText(birth, on(2028, 0, 15))).toBe('2 years');
      expect(ageText(birth, on(2028, 1, 15))).toBe('2 years 1 month');
      expect(ageText(birth, birth - HOUR)).toBe('Not born yet');
      expect(dayLabel(birth, birth)).toBe('Day 1');
      expect(dayLabel(birth, birth - 2 * 86_400_000)).toBe('2 days before birth');
      expect(dayLabel(birth, birth)).not.toMatch(CJK);
    });
    expect(dayLabel(birth, on(2026, 0, 13))).toBe('出生前 2 天');
  });

  it('汇总在英文下处理单复数，中文保持全角空格', () => {
    const s = { feeds: 1, ml: 90, diapers: 2, wetDiapers: 2, sleepMs: 1.5 * HOUR };
    expect(summaryText(s, metricUnits)).toBe('喂奶 1 次 · 90ml　尿布 2　睡 1.5h');
    expect(withLocale('en', () => summaryText(s, metricUnits))).toBe(
      '1 feed · 90ml   2 diapers   Slept 1.5h',
    );
  });

  it('单位名称跟随语言，换算和步长不变', () => {
    const { zh, en } = both(() => scaleFor('weight', 'lb'));
    expect(zh.name).toBe('磅');
    expect(en.name).toBe('pounds');
    expect({ ...en, name: '' }).toEqual({ ...zh, name: '' });
    expect(withLocale('en', () => scaleFor('volume', 'bogus').name)).toBe('milliliters');
  });

  it('角色名跟随语言', () => {
    expect(roleLabels.viewer).toBe('只看回忆和照片');
    expect(withLocale('en', () => roleLabels.viewer)).toBe('Memories and photos only');
  });
});

describe('记录是数据，不翻译', () => {
  const record = (name: string, vaccineId: string): EventData => ({
    type: 'vaccine',
    at: NOW,
    vaccineId,
    name,
    byName: '妈妈',
  });

  it('用户填的药名、辅食和备注原样显示', () => {
    withLocale('en', () => {
      expect(
        describeEvent({ type: 'med', at: NOW, name: '布洛芬', dose: '2ml', byName: '妈妈' }, NOW),
      ).toBe('Medicine · 布洛芬 2ml');
      expect(describeEvent({ type: 'solids', at: NOW, food: '米糊', byName: '妈妈' }, NOW)).toBe(
        'Solids · 米糊',
      );
    });
  });

  it('内置剂次写进记录的永远是中文原名，不管当前是什么语言', () => {
    for (const region of regionList) {
      const inZh = region.vaccineSchedule.map((dose) => withLocale('zh', () => dose.recordName));
      const inEn = region.vaccineSchedule.map((dose) => withLocale('en', () => dose.recordName));
      expect(inEn).toEqual(inZh);
      expect(inEn).toEqual(region.vaccineSchedule.map((dose) => withLocale('zh', () => dose.name)));
    }
  });

  it('内置剂次在英文下按 id 显示，中文下显示记录里的字', () => {
    const stored = record('乙肝疫苗 HepB 第 1 剂', 'us:hepb-1');
    expect(describeEvent(stored, NOW)).toBe('接种 乙肝疫苗 HepB 第 1 剂');
    expect(withLocale('en', () => describeEvent(stored, NOW))).toBe(
      'Vaccine: Hepatitis B (HepB), dose\u00a01',
    );
    // 没有地区前缀的旧记录来自新加坡的表。
    expect(withLocale('en', () => vaccineRecordName('bcg', '卡介苗 BCG'))).toBe('BCG');
  });

  it('自己填的疫苗和不认识的 id 原样显示', () => {
    const custom = newCustomVaccineId('abc');
    expect(withLocale('en', () => vaccineRecordName(custom, '自费流感'))).toBe('自费流感');
    expect(withLocale('en', () => vaccineRecordName('xx:gone', '旧的疫苗'))).toBe('旧的疫苗');
  });

  it('其他接种记录也按当前语言显示内置剂次', () => {
    const entries = [{ id: '1', data: record('卡介苗 BCG', 'sg:bcg') }];
    const us = regionFor('US');
    expect(withLocale('en', () => otherVaccineRecords(us, entries))[0]?.name).toBe('BCG');
  });

  it('里程碑认得两种语言记下的标题', () => {
    const first = milestoneTemplates[0];
    expect(first?.matches('第一次抬头')).toBe(true);
    expect(first?.matches('First time lifting head')).toBe(true);
    expect(first?.matches('别的内容')).toBe(false);
    expect(first?.id).toBe('第一次抬头');
    expect(withLocale('en', () => first?.id)).toBe('第一次抬头');
    expect(withLocale('en', () => first?.title)).toBe('First time lifting head');
  });
});

describe('地区内容', () => {
  it.each(regionList.map((region) => [region.id, region] as const))(
    '%s：英文完整，也写明以诊所为准',
    (_id, region) => {
      const text = both(() => ({
        name: region.name,
        disclaimer: region.disclaimer,
        note: region.emptyScheduleNote,
        docs: region.documentSuggestions,
        source: region.source?.label,
        version: region.source?.version,
        doses: region.vaccineSchedule.map((d) => ({ name: d.name, age: d.ageLabel, note: d.note })),
        nutrition: region.nutrition.note,
      }));
      expect(JSON.stringify(text.en)).not.toMatch(CJK);
      expect(text.zh.disclaimer).toContain('以诊所安排和健康手册为准');
      expect(text.en.disclaimer).toContain('take precedence');
      expect(text.en.docs).toHaveLength(text.zh.docs.length);
      expect(text.en.doses).toHaveLength(text.zh.doses.length);
      text.en.doses.forEach((dose, i) => {
        const zh = text.zh.doses[i];
        // 月龄和注释里的数字一个都不能变。
        expect(numbers(dose.age)).toEqual(numbers(zh?.age ?? ''));
        expect(numbers(dose.note ?? '')).toEqual(numbers(zh?.note ?? ''));
        expect(Boolean(dose.note)).toBe(Boolean(zh?.note));
      });
    },
  );

  it('美国的疫苗名用 AAP 表上的术语', () => {
    const names = withLocale('en', () =>
      regionFor('US').vaccineSchedule.map((dose: VaccineDose) => dose.name.replace('\u00a0', ' ')),
    );
    for (const term of [
      'Hepatitis B (HepB), dose 1',
      'Rotavirus (RV), dose 1',
      'Diphtheria, tetanus, and acellular pertussis (DTaP), dose 1',
      'Haemophilus influenzae type b (Hib), dose 1',
      'Pneumococcal conjugate (PCV), dose 1',
      'Inactivated poliovirus (IPV), dose 1',
      'Measles, mumps, and rubella (MMR), dose 1',
      'Varicella (VAR), dose 1',
      'Hepatitis A (HepA), dose 1',
      'Human papillomavirus (HPV), dose 1',
    ]) {
      expect(names).toContain(term);
    }
  });

  it('疫苗本的状态文字跟随语言，判断不变', () => {
    const birthAt = new Date(2026, 8, 20).getTime();
    const statuses = (locale: Locale) =>
      withLocale(locale, () =>
        vaccineStatuses(regionFor('US'), birthAt, [], NOW).map((dose) => doseStatus(dose)),
      );
    const zh = statuses('zh');
    const en = statuses('en');
    expect(en.map((s) => s.tone)).toEqual(zh.map((s) => s.tone));
    expect(JSON.stringify(en)).not.toMatch(CJK);
  });

  it('换语言后再次读取能拿到新的语言，中间不用重新加载', () => {
    const us = regionFor('US');
    expect(us.name).toBe('美国');
    setLocale('en');
    expect(us.name).toBe('United States');
    expect(us.vaccineSchedule[1]?.ageLabel).toBe('Birth');
  });

  it('summarize24h 不受语言影响', () => {
    const events: EventData[] = [{ type: 'feed', at: NOW - HOUR, ml: 90, byName: '妈妈' }];
    const { zh, en } = both(() => summarize24h(events, NOW));
    expect(en).toEqual(zh);
  });
});
