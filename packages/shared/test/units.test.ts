import { describe, expect, it } from 'vitest';
import {
  assessTemperature,
  birthMeasuresFromInput,
  chipsFor,
  convertMeasureText,
  type Dimension,
  defaultPrefs,
  describeEvent,
  effectiveUnits,
  formatBirthMeasures,
  formatLength,
  formatTemperature,
  formatTemperatureRange,
  formatVolume,
  formatWeight,
  knowledgeForAge,
  metricToSave,
  metricUnits,
  type Prefs,
  Prefs as PrefsSchema,
  scaleFor,
  stepDisplay,
  summarize24h,
  summaryText,
  toDisplay,
  toMetric,
  type Units,
  unitsSummary,
} from '../src/index';

const imperial: Units = { volume: 'oz', temperature: 'f', weight: 'lb', length: 'in' };

function grid(dimension: Dimension, unit: string): number[] {
  const { min, max, step, decimals } = scaleFor(dimension, unit);
  const count = Math.round((max - min) / step);
  return Array.from({ length: count + 1 }, (_, i) => Number((min + i * step).toFixed(decimals)));
}

const dimensions: [Dimension, string][] = [
  ['volume', 'ml'],
  ['volume', 'oz'],
  ['temperature', 'c'],
  ['temperature', 'f'],
  ['weight', 'kg'],
  ['weight', 'lb'],
  ['length', 'cm'],
  ['length', 'in'],
];

describe('换算', () => {
  it('常见的对照值', () => {
    expect(toDisplay('temperature', 38, 'f')).toBe(100.4);
    expect(toDisplay('temperature', 37, 'f')).toBe(98.6);
    expect(toMetric('temperature', 100.4, 'f')).toBe(38);
    expect(toMetric('temperature', 102.2, 'f')).toBe(39);
    expect(toMetric('temperature', 96.8, 'f')).toBe(36);
    expect(toMetric('volume', 4, 'oz')).toBe(118);
    expect(toDisplay('volume', 130, 'oz')).toBe(4.4);
    expect(toMetric('weight', 7.5, 'lb')).toBe(3.402);
    expect(toDisplay('weight', 3.4, 'lb')).toBe(7.5);
    expect(toMetric('length', 20, 'in')).toBe(50.8);
    expect(toDisplay('length', 50, 'in')).toBe(19.7);
  });

  it('公制的值原样存储和显示', () => {
    expect(toMetric('volume', 130, 'ml')).toBe(130);
    expect(toDisplay('volume', 130, 'ml')).toBe(130);
    expect(toMetric('temperature', 38, 'c')).toBe(38);
    expect(toMetric('weight', 3.4, 'kg')).toBe(3.4);
    expect(toMetric('length', 50.5, 'cm')).toBe(50.5);
  });

  it.each(dimensions)('%s %s：步进网格上每一个值换算后都能原样回来', (dimension, unit) => {
    for (const value of grid(dimension, unit)) {
      expect(toDisplay(dimension, toMetric(dimension, value, unit), unit)).toBe(value);
    }
  });

  it.each(dimensions)('%s %s：网格的范围都在数据校验之内', (dimension, unit) => {
    const limits = {
      volume: [0, 1000],
      temperature: [30, 45],
      weight: [0.3, 100],
      length: [20, 250],
    }[dimension] as [number, number];
    for (const value of grid(dimension, unit)) {
      const metric = toMetric(dimension, value, unit);
      expect(metric).toBeGreaterThanOrEqual(limits[0]);
      expect(metric).toBeLessThanOrEqual(limits[1]);
    }
  });

  it('奶量写入的永远是整数毫升，否则会被校验拒绝', () => {
    for (const value of grid('volume', 'oz')) {
      expect(Number.isInteger(toMetric('volume', value, 'oz'))).toBe(true);
    }
  });
});

describe('不改数值就不能改变存储的值', () => {
  it('每一个毫升值显示成盎司再保存，都还是原来的毫升', () => {
    for (let ml = 0; ml <= 1000; ml++) {
      expect(metricToSave('volume', ml, toDisplay('volume', ml, 'oz'), 'oz')).toBe(ml);
    }
  });
  it('130ml → 4.4oz → 保存 → 130ml，不漂移', () => {
    expect(metricToSave('volume', 130, 4.4, 'oz')).toBe(130);
  });
  it('摄氏度记录在华氏界面下保存不变', () => {
    for (let c = 300; c <= 450; c++) {
      const celsius = c / 10;
      expect(
        metricToSave('temperature', celsius, toDisplay('temperature', celsius, 'f'), 'f'),
      ).toBe(celsius);
    }
  });
  it('公斤和厘米也一样', () => {
    expect(metricToSave('weight', 3.45, toDisplay('weight', 3.45, 'lb'), 'lb')).toBe(3.45);
    expect(metricToSave('length', 50.5, toDisplay('length', 50.5, 'in'), 'in')).toBe(50.5);
  });
  it('改了数值才换算', () => {
    expect(metricToSave('volume', 130, 4.5, 'oz')).toBe(133);
  });
  it('没有原值时换算', () => {
    expect(metricToSave('volume', undefined, 4, 'oz')).toBe(118);
  });
});

describe('步进', () => {
  it('公制的步长和以前一样', () => {
    expect(stepDisplay('volume', 120, 1, 'ml')).toBe(130);
    expect(stepDisplay('volume', 80, -1, 'ml')).toBe(70);
    expect(stepDisplay('temperature', 36.8, 1, 'c')).toBe(36.9);
    expect(stepDisplay('weight', 3.4, 1, 'kg')).toBe(3.5);
    expect(stepDisplay('length', 50, 1, 'cm')).toBe(50.5);
  });
  it('盎司每次 0.5', () => {
    expect(stepDisplay('volume', 4, 1, 'oz')).toBe(4.5);
    expect(stepDisplay('volume', 4.5, -1, 'oz')).toBe(4);
  });
  it('不在网格上的值先对齐到网格，而不是一直带着零头', () => {
    expect(stepDisplay('volume', 4.4, 1, 'oz')).toBe(4.5);
    expect(stepDisplay('volume', 4.4, -1, 'oz')).toBe(4);
    expect(stepDisplay('volume', 135, 1, 'ml')).toBe(140);
  });
  it('华氏度每次 0.2，来回不漂移', () => {
    let value = 98.6;
    for (let i = 0; i < 50; i++) value = stepDisplay('temperature', value, 1, 'f');
    for (let i = 0; i < 50; i++) value = stepDisplay('temperature', value, -1, 'f');
    expect(value).toBe(98.6);
    expect(stepDisplay('temperature', 98.6, 1, 'f')).toBe(98.8);
  });
  it.each(dimensions)('%s %s：一路加到上限都停留在网格上', (dimension, unit) => {
    const { min, max, decimals } = scaleFor(dimension, unit);
    let value = min;
    for (let i = 0; i < 3000; i++) {
      const next = stepDisplay(dimension, value, 1, unit);
      expect(next).toBeLessThanOrEqual(max);
      expect(Number(next.toFixed(decimals))).toBe(next);
      value = next;
    }
    expect(value).toBe(max);
    expect(stepDisplay(dimension, min, -1, unit)).toBe(min);
  });
  it('盎司有自己的快捷值，公制保持原来的', () => {
    expect(chipsFor('ml')).toEqual([60, 80, 90, 100, 120]);
    expect(chipsFor('oz')).toEqual([2, 3, 4, 5, 6]);
  });
});

describe('显示文字', () => {
  it('公制的文字一个字都不能变，E2E 和用户都在依赖', () => {
    expect(describeEvent({ type: 'feed', at: 0, ml: 130 }, 0)).toBe('喂奶 130ml');
    expect(describeEvent({ type: 'temp', at: 0, celsius: 38 }, 0)).toBe('体温 38.0℃');
    expect(describeEvent({ type: 'growth', at: 0, weightKg: 3.6, lengthCm: 50.5 }, 0)).toBe(
      '体重 3.6kg · 身长 50.5cm',
    );
    expect(formatBirthMeasures({ birthWeightKg: 3.2, birthLengthCm: 50 }, metricUnits)).toBe(
      '3.2 kg · 50 cm',
    );
    expect(formatBirthMeasures({ birthWeightKg: 3.2 }, metricUnits)).toBe('3.2 kg · — cm');
  });
  it('按用户的单位描述记录', () => {
    expect(describeEvent({ type: 'feed', at: 0, ml: 118 }, 0, imperial)).toBe('喂奶 4oz');
    expect(describeEvent({ type: 'feed', at: 0, ml: 130 }, 0, imperial)).toBe('喂奶 4.4oz');
    expect(describeEvent({ type: 'temp', at: 0, celsius: 38 }, 0, imperial)).toBe('体温 100.4°F');
    expect(describeEvent({ type: 'growth', at: 0, weightKg: 3.4, lengthCm: 50 }, 0, imperial)).toBe(
      '体重 7.5lb · 身长 19.7in',
    );
    expect(formatBirthMeasures({ birthWeightKg: 3.4, birthLengthCm: 50 }, imperial)).toBe(
      '7.5 lb · 19.7 in',
    );
  });
  it('摘要按用户的单位汇总，先加总再换算', () => {
    const s = summarize24h(
      [
        { type: 'feed', at: 90, ml: 89 },
        { type: 'feed', at: 80, ml: 89 },
      ],
      100,
    );
    expect(summaryText(s)).toContain('喂奶 2 次 · 178ml');
    expect(summaryText(s, imperial)).toContain('喂奶 2 次 · 6oz');
  });
  it('单独的格式函数', () => {
    expect(formatVolume(90, 'ml')).toBe('90ml');
    expect(formatVolume(89, 'oz')).toBe('3oz');
    expect(formatTemperature(36.8, 'c')).toBe('36.8℃');
    expect(formatTemperature(37, 'f')).toBe('98.6°F');
    expect(formatWeight(3.6, 'kg')).toBe('3.6kg');
    expect(formatWeight(3.6, 'lb')).toBe('7.9lb');
    expect(formatLength(50.5, 'cm')).toBe('50.5cm');
    expect(formatLength(50.8, 'in')).toBe('20.0in');
    expect(formatTemperatureRange(37, 40, 'c')).toBe('37–40℃');
    expect(formatTemperatureRange(37, 40, 'f')).toBe('98.6–104.0°F');
    expect(unitsSummary(metricUnits)).toBe('ml · ℃ · kg · cm');
    expect(unitsSummary(imperial)).toBe('oz · °F · lb · in');
  });
});

describe('健康提示按用户的单位显示，判断永远用摄氏度', () => {
  it('摄氏度的文字不变', () => {
    expect(assessTemperature(38, 1).hint).toBe('3 个月以下的宝宝 38℃ 及以上，请尽快就医。');
    expect(assessTemperature(39, 4).hint).toBe('6 个月以下的宝宝 39℃ 及以上，请尽快联系医生。');
    expect(assessTemperature(35.5, 1).hint).toContain('体温低于 36℃');
    expect(assessTemperature(37, 1).hint).toBe('正常范围（36.5–37.5℃）。');
  });
  it('华氏度显示对应的阈值', () => {
    expect(assessTemperature(38, 1, 'f').hint).toBe(
      '3 个月以下的宝宝 100.4°F 及以上，请尽快就医。',
    );
    expect(assessTemperature(39, 4, 'f').hint).toBe(
      '6 个月以下的宝宝 102.2°F 及以上，请尽快联系医生。',
    );
    expect(assessTemperature(35.5, 1, 'f').hint).toContain('体温低于 96.8°F');
    expect(assessTemperature(37, 1, 'f').hint).toBe('正常范围（97.7–99.5°F）。');
  });
  it('华氏度的提示里不能再出现摄氏度', () => {
    for (const c of [35, 36.2, 37, 37.6, 38, 38.5, 39, 40]) {
      for (const months of [0, 4, 8]) {
        expect(assessTemperature(c, months, 'f').hint).not.toContain('℃');
      }
    }
  });
  it('阈值本身不随单位变化', () => {
    for (let c = 340; c <= 420; c++) {
      for (const months of [0, 4, 8]) {
        const celsius = c / 10;
        const a = assessTemperature(celsius, months, 'c');
        const b = assessTemperature(celsius, months, 'f');
        expect(b.level).toBe(a.level);
        expect(b.note).toBe(a.note);
      }
    }
  });
  it('从华氏度输入时，100.4°F 正好算到发烧，100.2°F 没到', () => {
    expect(assessTemperature(toMetric('temperature', 100.4, 'f'), 1, 'f').level).toBe('urgent');
    expect(assessTemperature(toMetric('temperature', 100.2, 'f'), 1, 'f').level).toBe('elevated');
    expect(assessTemperature(toMetric('temperature', 102.2, 'f'), 4, 'f').level).toBe('urgent');
    expect(assessTemperature(toMetric('temperature', 102, 'f'), 4, 'f').level).toBe('fever');
  });
  it('常识卡也用用户的单位', () => {
    const body = (unit?: 'c' | 'f') =>
      knowledgeForAge(1, unit)
        .map((k) => k.body)
        .join();
    expect(body()).toContain('38℃');
    expect(body('f')).toContain('100.4°F');
    expect(body('f')).not.toContain('℃');
  });
});

describe('单位偏好', () => {
  it('默认跟随地区，自己改过的优先', () => {
    expect(effectiveUnits(undefined, 'US')).toEqual(imperial);
    expect(effectiveUnits(undefined, 'SG')).toEqual(metricUnits);
    expect(effectiveUnits(undefined, undefined)).toEqual(metricUnits);
    expect(effectiveUnits({ temperature: 'c' }, 'US')).toEqual({ ...imperial, temperature: 'c' });
    expect(effectiveUnits({ volume: 'oz' }, 'SG')).toEqual({ ...metricUnits, volume: 'oz' });
  });
  const base = {
    feedReminder: true,
    familyNotify: true,
    quietNight: true,
    timezone: 'Asia/Tokyo',
    documentLock: false,
    videoWifiOnly: true,
  };
  it('旧的偏好没有单位也能通过校验', () => {
    expect(PrefsSchema.parse(base).units).toBeUndefined();
  });
  it('新版本的未知单位不能让整份偏好失效，只丢掉这一项', () => {
    const parsed: Prefs = PrefsSchema.parse({
      ...base,
      units: { volume: 'cup', temperature: 'f' },
    });
    expect(parsed.timezone).toBe('Asia/Tokyo');
    expect(parsed.units?.temperature).toBe('f');
    expect(parsed.units?.volume).toBeUndefined();
  });
});

describe('默认时区', () => {
  it('不再假定新加坡，由手机写上来', () => {
    expect(defaultPrefs.timezone).toBe('UTC');
  });
});

describe('出生体重和身长的输入', () => {
  it('建档时切换单位，已经填的数字跟着换算', () => {
    expect(convertMeasureText('weight', '3.4', 'kg', 'lb')).toBe('7.5');
    expect(convertMeasureText('length', '19.7', 'in', 'cm')).toBe('50');
    expect(convertMeasureText('weight', '', 'kg', 'lb')).toBe('');
    expect(convertMeasureText('weight', '3.4', 'kg', 'kg')).toBe('3.4');
  });
  it('按显示单位解析，存公制', () => {
    expect(birthMeasuresFromInput('7.5', '20', imperial)).toEqual({
      ok: true,
      weightKg: 3.402,
      lengthCm: 50.8,
    });
    expect(birthMeasuresFromInput('3.2', '50', metricUnits)).toEqual({
      ok: true,
      weightKg: 3.2,
      lengthCm: 50,
    });
  });
  it('可以不填', () => {
    expect(birthMeasuresFromInput('', '', metricUnits)).toEqual({
      ok: true,
      weightKg: undefined,
      lengthCm: undefined,
    });
  });
  it('范围按公制判断，提示写用户的单位', () => {
    expect(birthMeasuresFromInput('30', '', metricUnits)).toEqual({
      ok: false,
      error: '体重看起来不太对，单位是公斤',
    });
    expect(birthMeasuresFromInput('30', '', imperial)).toEqual({
      ok: false,
      error: '体重看起来不太对，单位是磅',
    });
    expect(birthMeasuresFromInput('', '120', metricUnits)).toEqual({
      ok: false,
      error: '身长看起来不太对，单位是厘米',
    });
    expect(birthMeasuresFromInput('', '120', imperial)).toEqual({
      ok: false,
      error: '身长看起来不太对，单位是英寸',
    });
    expect(birthMeasuresFromInput('abc', '', metricUnits).ok).toBe(false);
  });
  it('没改过的值不换算，不让出生体重悄悄变化', () => {
    const original = { birthWeightKg: 3.45, birthLengthCm: 50.5 };
    expect(
      birthMeasuresFromInput(
        String(toDisplay('weight', 3.45, 'lb')),
        String(toDisplay('length', 50.5, 'in')),
        imperial,
        original,
      ),
    ).toEqual({ ok: true, weightKg: 3.45, lengthCm: 50.5 });
  });
});
