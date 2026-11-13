import { afterEach, describe, expect, it } from 'vitest';
import {
  BabyData,
  DAYS_PER_MONTH,
  describeEvent,
  EventData,
  type GrowthMeasure,
  type GrowthSex,
  growthChartEndDays,
  growthPercentile,
  growthPoints,
  percentileBand,
  percentileText,
  percentileValue,
  referenceCurves,
  setLocale,
  WHO_LAST_DAY,
  whoLms,
  withLocale,
} from '../src/index';

const DAY = 86_400_000;
const BIRTH = new Date(2026, 0, 10, 8).getTime();

afterEach(() => setLocale('zh'));

/**
 * WHO expanded tables（按天的百分位表，3 位小数）里的 P3、P50、P97，2026-11-13 从 who.int 下载：
 * https://www.who.int/tools/child-growth-standards/standards 下三页的
 * “Expanded tables · percentiles”：{wfa,lhfa,hcfa}-{girls,boys}-percentiles-expanded-tables.xlsx。
 * 前 91 天的数据就是按天的表，必须几乎一样；之后是按月的节点之间插值，和按天的表比误差不到 0.4%。
 * 第 730 天还是卧位身长，第 731 天起是立位身高（WHO 的说明：两者在 730 和 731 天之间不连续）。
 */
type Fixture = [day: number, p3: number, p50: number, p97: number];
const EXPANDED: Record<GrowthMeasure, Record<GrowthSex, Fixture[]>> = {
  weight: {
    female: [
      [0, 2.44, 3.232, 4.166],
      [2, 2.408, 3.21, 4.181],
      [45, 3.623, 4.674, 5.98],
      [91, 4.6, 5.839, 7.395],
      [200, 5.978, 7.5, 9.454],
      [487, 7.835, 9.812, 12.453],
      [730, 9.159, 11.474, 14.607],
      [731, 9.164, 11.481, 14.616],
      [1000, 10.524, 13.256, 17.003],
      [1461, 12.511, 16.07, 21.12],
      [1826, 13.964, 18.218, 24.429],
    ],
    male: [
      [0, 2.507, 3.346, 4.35],
      [2, 2.501, 3.337, 4.35],
      [45, 3.932, 5.04, 6.381],
      [91, 5.086, 6.369, 7.909],
      [200, 6.618, 8.148, 9.981],
      [487, 8.543, 10.523, 12.942],
      [730, 9.802, 12.148, 15.065],
      [731, 9.807, 12.155, 15.074],
      [1000, 11.043, 13.806, 17.308],
      [1461, 12.902, 16.349, 20.852],
      [1826, 14.287, 18.335, 23.761],
    ],
  },
  length: {
    female: [
      [0, 45.644, 49.148, 52.651],
      [2, 45.971, 49.485, 53.0],
      [45, 51.649, 55.402, 59.155],
      [91, 55.82, 59.777, 63.735],
      [200, 62.318, 66.633, 70.948],
      [487, 73.35, 78.606, 83.861],
      [730, 80.335, 86.401, 92.467],
      [731, 79.661, 85.73, 91.799],
      [1000, 85.924, 92.818, 99.712],
      [1461, 94.63, 102.731, 110.833],
      [1826, 100.475, 109.419, 118.363],
    ],
    male: [
      [0, 46.324, 49.884, 53.445],
      [2, 46.669, 50.236, 53.803],
      [45, 52.892, 56.606, 60.319],
      [91, 57.557, 61.401, 65.246],
      [200, 64.462, 68.52, 72.578],
      [487, 75.351, 80.211, 85.072],
      [730, 82.057, 87.802, 93.547],
      [731, 81.382, 87.13, 92.879],
      [1000, 87.285, 93.971, 100.657],
      [1461, 95.439, 103.327, 111.215],
      [1826, 101.244, 109.959, 118.674],
    ],
  },
  head: {
    female: [
      [0, 31.651, 33.879, 36.106],
      [2, 31.854, 34.071, 36.289],
      [45, 35.197, 37.441, 39.685],
      [91, 37.187, 39.521, 41.855],
      [200, 40.105, 42.571, 45.037],
      [487, 43.278, 45.865, 48.452],
      [730, 44.555, 47.18, 49.805],
      [731, 44.56, 47.185, 49.809],
      [1000, 45.576, 48.227, 50.878],
      [1461, 46.662, 49.332, 52.002],
      [1826, 47.247, 49.923, 52.598],
    ],
    male: [
      [0, 32.073, 34.462, 36.851],
      [2, 32.299, 34.662, 37.025],
      [45, 36.046, 38.246, 40.446],
      [91, 38.278, 40.501, 42.724],
      [200, 41.405, 43.715, 46.025],
      [487, 44.538, 47.009, 49.48],
      [730, 45.689, 48.249, 50.809],
      [731, 45.693, 48.254, 50.814],
      [1000, 46.557, 49.203, 51.848],
      [1461, 47.461, 50.212, 52.962],
      [1826, 47.927, 50.737, 53.548],
    ],
  },
};

const measures: GrowthMeasure[] = ['weight', 'length', 'head'];
const sexes: GrowthSex[] = ['female', 'male'];

describe('WHO LMS：和 WHO 发布的表核对', () => {
  for (const measure of measures) {
    for (const sex of sexes) {
      it(`${measure} ${sex}：P3、P50、P97 和按天的表一致`, () => {
        for (const [day, p3, p50, p97] of EXPANDED[measure][sex]) {
          for (const [p, expected] of [
            [3, p3],
            [50, p50],
            [97, p97],
          ] as const) {
            const got = percentileValue(measure, sex, day, p);
            expect(got, `${measure} ${sex} 第 ${day} 天 P${p}`).not.toBeNull();
            // 前 91 天是按天的表本身，只差表里 3 位小数的舍入；之后是按月节点插值。
            const tolerance = day <= 91 ? 0.0015 : expected * 0.004;
            expect(
              Math.abs((got as number) - expected),
              `${measure} ${sex} 第 ${day} 天 P${p}`,
            ).toBeLessThanOrEqual(tolerance);
          }
        }
      });
    }
  }

  // 按月的表（tab_*_p_0_5、tab_lhfa_*_p_0_2、tab_lhfa_*_p_2_5）在节点上的 M，就是 P50。
  it('节点上的 P50 就是按月表里的 M', () => {
    expect(whoLms('weight', 'female', 12 * DAYS_PER_MONTH)?.m).toBe(8.9481);
    expect(whoLms('weight', 'male', 12 * DAYS_PER_MONTH)?.m).toBe(9.6479);
    expect(whoLms('head', 'male', 60 * DAYS_PER_MONTH)?.m).toBe(50.7375);
    expect(whoLms('weight', 'male', 0)).toEqual({ l: 0.3487, m: 3.3464, s: 0.14602 });
    expect(percentileValue('weight', 'male', 60 * DAYS_PER_MONTH, 50)).toBeCloseTo(18.3366, 4);
  });

  it('身长在 24 个月处分成卧位和立位两段，不跨段插值', () => {
    const at24 = 24 * DAYS_PER_MONTH;
    // tab_lhfa_boys_p_0_2 的第 24 月是 87.8161，tab_lhfa_boys_p_2_5 的第 24 月是 87.1161。
    expect(whoLms('length', 'male', at24)?.m).toBe(87.8161);
    expect(whoLms('length', 'male', at24 + 0.01)?.m).toBeCloseTo(87.1161, 2);
    expect(whoLms('length', 'female', at24)?.m).toBe(86.4153);
    expect(whoLms('length', 'female', at24 + 0.01)?.m).toBeCloseTo(85.7153, 2);
  });

  it('出生前、超过 5 岁时没有参考值，不外推', () => {
    expect(whoLms('weight', 'female', -1)).toBeNull();
    expect(whoLms('weight', 'female', WHO_LAST_DAY + 1)).toBeNull();
    expect(percentileValue('head', 'male', WHO_LAST_DAY + 1, 50)).toBeNull();
    expect(growthPercentile('weight', 'male', WHO_LAST_DAY + 1, 18)).toBeNull();
    expect(WHO_LAST_DAY).toBe(60 * DAYS_PER_MONTH);
  });
});

describe('百分位', () => {
  it('表上的 P3、P50、P97 换回百分位还是 3、50、97', () => {
    for (const measure of measures) {
      for (const sex of sexes) {
        for (const [day, p3, p50, p97] of EXPANDED[measure][sex].filter(([d]) => d <= 91)) {
          expect(growthPercentile(measure, sex, day, p3)).toBeCloseTo(3, 0);
          expect(growthPercentile(measure, sex, day, p50)).toBeCloseTo(50, 0);
          expect(growthPercentile(measure, sex, day, p97)).toBeCloseTo(97, 0);
        }
      }
    }
  });

  it('L 接近 0 时用对数公式，不除以 0', () => {
    // 女孩体重在 4 个月附近 L 从正变负，表里第 121.75 天是 -0.005。
    const day = 4 * DAYS_PER_MONTH;
    const median = percentileValue('weight', 'female', day, 50) as number;
    expect(Number.isFinite(median)).toBe(true);
    expect(growthPercentile('weight', 'female', day, median)).toBeCloseTo(50, 6);
  });

  it('显示时在 P1 和 P99 之外只说低于、高于，不说 P0、P100', () => {
    expect(percentileBand(0.2)).toEqual({ kind: 'below' });
    expect(percentileBand(0.99)).toEqual({ kind: 'below' });
    expect(percentileBand(1)).toEqual({ kind: 'about', value: 1 });
    expect(percentileBand(40.4)).toEqual({ kind: 'about', value: 40 });
    expect(percentileBand(99)).toEqual({ kind: 'about', value: 99 });
    expect(percentileBand(99.01)).toEqual({ kind: 'above' });
    expect(percentileText(40.4)).toBe('约 P40');
    expect(percentileText(0.2)).toBe('低于 P1');
    expect(percentileText(99.6)).toBe('高于 P99');
    expect(withLocale('en', () => percentileText(40.4))).toBe('about P40');
    expect(withLocale('en', () => percentileText(0.2))).toBe('below P1');
    expect(withLocale('en', () => percentileText(99.6))).toBe('above P99');
  });
});

describe('参考线', () => {
  it('五条线：P3、P15、P50、P85、P97，到图的右边为止', () => {
    const curves = referenceCurves('weight', 'female', 6 * DAYS_PER_MONTH);
    expect(curves.map((c) => c.percentile)).toEqual([3, 15, 50, 85, 97]);
    for (const curve of curves) {
      const points = curve.segments.flat();
      expect(points[0]?.days).toBe(0);
      expect(points.at(-1)?.days).toBe(6 * DAYS_PER_MONTH);
    }
    const p50 = curves.find((c) => c.percentile === 50)?.segments[0] ?? [];
    expect(p50[0]?.value).toBeCloseTo(3.2322, 4);
  });

  it('身长跨过 24 个月时分成两段，第二段从立位身高开始', () => {
    const curves = referenceCurves('length', 'male', 36 * DAYS_PER_MONTH);
    const p50 = curves.find((c) => c.percentile === 50);
    expect(p50?.segments).toHaveLength(2);
    expect(p50?.segments[0]?.at(-1)?.value).toBeCloseTo(87.8161, 4);
    expect(p50?.segments[1]?.[0]?.value).toBeCloseTo(87.1161, 4);
    expect(referenceCurves('length', 'male', 12 * DAYS_PER_MONTH)[0]?.segments).toHaveLength(1);
  });

  it('超过 5 岁的部分不画', () => {
    const curves = referenceCurves('head', 'female', 72 * DAYS_PER_MONTH);
    expect(curves[0]?.segments.flat().at(-1)?.days).toBe(WHO_LAST_DAY);
  });

  it('图的范围按月龄取整到 6、12、24、36、48、60 个月，再往后按整年', () => {
    expect(growthChartEndDays(0)).toBe(6 * DAYS_PER_MONTH);
    expect(growthChartEndDays(100)).toBe(6 * DAYS_PER_MONTH);
    expect(growthChartEndDays(6 * DAYS_PER_MONTH + 1)).toBe(12 * DAYS_PER_MONTH);
    expect(growthChartEndDays(400)).toBe(24 * DAYS_PER_MONTH);
    expect(growthChartEndDays(59 * DAYS_PER_MONTH)).toBe(60 * DAYS_PER_MONTH);
    expect(growthChartEndDays(61 * DAYS_PER_MONTH)).toBe(72 * DAYS_PER_MONTH);
  });
});

describe('宝宝自己的点', () => {
  const baby = (extra: Partial<BabyData> = {}): BabyData => ({
    name: '小豆',
    birthAt: BIRTH,
    ...extra,
  });
  const growth = (days: number, weightKg: number, lengthCm: number, headCm?: number) =>
    ({
      type: 'growth',
      at: BIRTH + days * DAY,
      weightKg,
      lengthCm,
      ...(headCm === undefined ? {} : { headCm }),
    }) as EventData;

  it('出生体重和身长是第 0 天的点，记录按时间排，别的记录不算', () => {
    const events: EventData[] = [
      growth(60, 5.6, 58),
      { type: 'feed', at: BIRTH + DAY, ml: 90 },
      growth(30, 4.4, 54, 37),
    ];
    const b = baby({ birthWeightKg: 3.2, birthLengthCm: 50 });
    expect(growthPoints(b, events, 'weight').map((p) => [p.ageDays, p.value, p.birth])).toEqual([
      [0, 3.2, true],
      [30, 4.4, false],
      [60, 5.6, false],
    ]);
    expect(growthPoints(b, events, 'length').map((p) => p.value)).toEqual([50, 54, 58]);
    // 出生档案里没有头围；没记头围的记录不画。
    expect(growthPoints(b, events, 'head').map((p) => [p.ageDays, p.value])).toEqual([[30, 37]]);
  });

  it('早于出生的记录不画', () => {
    expect(growthPoints(baby(), [growth(-2, 3, 49)], 'weight')).toEqual([]);
  });
});

describe('数据结构向后兼容', () => {
  it('头围可选；格式不对只丢掉头围，记录还在', () => {
    const base = { type: 'growth', at: BIRTH, weightKg: 4, lengthCm: 54 };
    expect(EventData.parse(base)).toEqual(base);
    expect(EventData.parse({ ...base, headCm: 37.5 })).toEqual({ ...base, headCm: 37.5 });
    expect(EventData.parse({ ...base, headCm: 'big' })).toEqual(base);
    expect(EventData.parse({ ...base, headCm: 500 })).toEqual(base);
  });

  it('性别可选；不认识的值当没填，档案不会校验失败', () => {
    const base = { name: '小豆', birthAt: BIRTH };
    expect(BabyData.parse(base)).toEqual(base);
    expect(BabyData.parse({ ...base, sex: 'female' })).toEqual({ ...base, sex: 'female' });
    expect(BabyData.parse({ ...base, sex: 'male' })).toEqual({ ...base, sex: 'male' });
    expect(BabyData.parse({ ...base, sex: 'x' })).toEqual(base);
  });

  it('没有头围的记录文字和原来一样，有头围时多一段', () => {
    const at = BIRTH;
    expect(describeEvent({ type: 'growth', at, weightKg: 3.6, lengthCm: 50.5 }, at)).toBe(
      '体重 3.6kg · 身长 50.5cm',
    );
    expect(
      describeEvent({ type: 'growth', at, weightKg: 3.6, lengthCm: 50.5, headCm: 35 }, at),
    ).toBe('体重 3.6kg · 身长 50.5cm · 头围 35.0cm');
    expect(
      withLocale('en', () =>
        describeEvent({ type: 'growth', at, weightKg: 3.6, lengthCm: 50.5, headCm: 35 }, at),
      ),
    ).toBe('Weight 3.6kg · Length 50.5cm · Head 35.0cm');
  });
});
