import { L, type Localized, localized } from '../i18n';
import type { FormulaBasis, NutrientValues } from '../schemas';
import {
  emptyFormulaForm,
  type FormulaForm,
  formulaFormFromData,
  iuToUg,
  kjToKcal,
} from './nutrition';

/**
 * 预置奶粉。新增品牌只加一条数据，不用改页面。不代表推荐，界面也不评价。
 *
 * 规则（AGENTS.md 第 8 节）：
 * - 每个数值都要来自真的读到的标签原文，旁边写来源、读取日期和配方版本。
 * - 读不到的品牌 `label` 是 null，只带名字和段数，选中后让用户对照罐身录入。不从测评和电商转述里抄数字。
 * - 选中预置时数值会复制到家庭自己的配置里，所以这里改了不影响已有家庭。
 */
export interface FormulaPreset {
  id: string;
  name: string;
  /** 主要在哪些地区销售，只影响排序。空数组表示不限。 */
  regions: readonly string[];
  label: null | {
    basis: FormulaBasis;
    values: NutrientValues;
    /** 来源给了冲调比例才写；按每 100 g 而没有它时，选中后要用户照罐身的冲调表补上。 */
    powderGPer100ml?: number;
    source: { label: string; url: string; readOn: string; version: string };
  };
}

const HEALTH_CANADA_LABELS =
  'https://www.canada.ca/en/health-canada/services/food-nutrition/legislation-guidelines/policies/interim-policy-importation-sale-infant-formula-human-milk-fortifiers-metabolic-products';

/** 中文品牌名原样留着：那是罐身上印的字，英文名没有读到的不编。 */
type PresetInput = Omit<FormulaPreset, 'name' | 'label'> & {
  name: string | Localized;
  label: null | {
    basis: FormulaBasis;
    values: NutrientValues;
    powderGPer100ml?: number;
    source: { label: Localized; url: string; readOn: string; version: Localized };
  };
};

const presetData: readonly PresetInput[] = [
  {
    // 数值来自第三方站纽奶乐（nznewmilk.com.cn，一家奶粉品牌的官网，页面自己写明“不属于国家市场监督管理总局官方网站”、
    // 和合生元无关联）整理的“合生元派星天护婴儿配方奶粉（0—6月龄，1段）”，国食注字 YP20235061，2023-08-29 批准，
    // GB 10765-2021。页面说营养成分表来自总局的配方注册公开信息，标签核验日期 2026-07-03，没有放标签或证书原图。
    // 仓库所有者 2026-11-04 指定采用（issue #60），未经市场监管总局或合生元官方原文核对，按 AGENTS.md 第 8 节属于待复核。
    //
    // 没有核对的地方：
    // - 注册名是“派星天护”。京东自营把“派星 1段新版 6重HMO+DHA”（SKU 1720648）和“派星天护 720g”分开卖，
    //   这个页面的成分表里没有 HMO，所以不能确定它就是京东上的“新版”，要看罐身的国食注字是不是 YP20235061。
    // - 总局特殊食品信息查询平台（tsspxx.gsxt.gov.cn）在这台机器上返回 502 或连不上；合生元官网只有宣传图，图片 CDN 返回 403。
    //
    // 页面是每 100 克奶粉，只抄了这里用的七项；能量 2113 kJ 按 4.184 换成 kcal。页面没有冲调比例，不拿“几勺加多少水”换算，
    // 所以 `powderGPer100ml` 空着，选中后要照罐身的冲调表填每 100 ml 冲好的奶用多少克粉才能算。
    id: 'biostime-paixing-1',
    name: '合生元 派星 1 段',
    regions: ['CN'],
    label: {
      basis: 'per100g',
      values: {
        energyKcal: kjToKcal(2113),
        proteinG: 10.6,
        fatG: 27.3,
        carbsG: 52.5,
        calciumMg: 317,
        ironMg: 3.2,
        vitaminDUg: 12.9,
      },
      source: {
        label: L(
          '第三方网站纽奶乐整理的配方注册信息（仓库所有者指定采用，未经总局或合生元官方原文核对）',
          'Registration data compiled by the third-party site NewMilk (adopted at the repository owner’s request; not checked against SAMR or Biostime originals)',
        ),
        url: 'https://www.nznewmilk.com.cn/formula/registration/yp20235061/',
        readOn: '2026-11-04',
        version: L(
          '注册名“合生元派星天护婴儿配方奶粉（0—6月龄，1段）”，国食注字 YP20235061，每 100 g 奶粉',
          'Registered as Biostime Pai-star Tianhu infant formula (0–6 months, stage 1), SAMR YP20235061, per 100 g powder',
        ),
      },
    },
  },
  {
    // 官网同样没有数值。纽奶乐页面链接了派星天护 2 段（YP20235062），这次没有读，也没有被指定采用。
    // 段数和适用月龄来自京东的商品列表。
    id: 'biostime-paixing-2',
    name: '合生元 派星 2 段',
    regions: ['CN'],
    label: null,
  },
  { id: 'feihe-xingfeifan-1', name: '飞鹤 星飞帆 1 段', regions: ['CN'], label: null },
  { id: 'junlebao-youcui-1', name: '君乐宝 优萃 1 段', regions: ['CN'], label: null },
  {
    // Health Canada 公布的英文标签 “Enfamil NeuroPro Powder (890 g)”，Table 1，每 100 mL 一列。
    // 这是 2022–23 年短缺时临时进口加拿大的美国产品的标签，现在销售的版本可能不同。
    // 能量 Cal 就是 kcal；标签写的维生素 D 是 51 IU，按 1 µg = 40 IU 换算。
    id: 'enfamil-neuropro-powder',
    name: L('Enfamil NeuroPro Infant 粉', 'Enfamil NeuroPro Infant (powder)'),
    regions: ['US'],
    label: {
      basis: 'per100ml',
      values: {
        energyKcal: 68,
        proteinG: 1.42,
        fatG: 3.6,
        carbsG: 7.6,
        calciumMg: 53,
        ironMg: 1.22,
        vitaminDUg: iuToUg(51),
      },
      source: {
        label: L(
          'Health Canada 公布的产品标签（读的是 Internet Archive 的副本，canada.ca 连接失败）',
          'Product label published by Health Canada (read from an Internet Archive copy; canada.ca could not be reached)',
        ),
        url: `${HEALTH_CANADA_LABELS}/english-label-enfamil-neuropro-powder-890g.html`,
        readOn: '2026-11-01',
        version: L('页面更新于 2023-04-24，890 g 粉', 'Page updated 2023-04-24, 890 g powder'),
      },
    },
  },
  {
    // Health Canada 公布的英文标签 “Similac 360 Total Care (59 mL)”，每 100 mL 一列。配料以水开头，是即饮液。
    // Abbott 官网的粉和液的数值不一样（脂肪、碳水都不同），这条只代表即饮液。
    id: 'similac-360-rtf',
    name: L('Similac 360 Total Care 即饮液', 'Similac 360 Total Care (ready-to-feed)'),
    regions: ['US'],
    label: {
      basis: 'per100ml',
      values: {
        energyKcal: 68,
        proteinG: 1.4,
        fatG: 3.7,
        carbsG: 7.4,
        calciumMg: 53,
        ironMg: 1.2,
        vitaminDUg: iuToUg(41),
      },
      source: {
        label: L(
          'Health Canada 公布的产品标签（读的是 Internet Archive 的副本，canada.ca 连接失败）',
          'Product label published by Health Canada (read from an Internet Archive copy; canada.ca could not be reached)',
        ),
        url: `${HEALTH_CANADA_LABELS}/label-similac-360-total-care.html`,
        readOn: '2026-11-01',
        version: L('59 mL 即饮液，页面日期未读到', '59 mL ready-to-feed, page date not found'),
      },
    },
  },
  // Abbott 官网的粉有数值，但页面同时列了粉和液，没能确认每组数值对应哪一种，所以不带数值。
  {
    id: 'similac-360-powder',
    name: L('Similac 360 Total Care 粉', 'Similac 360 Total Care (powder)'),
    regions: ['US'],
    label: null,
  },
  // 官方的 aptaclub 没读到，零售页互相不完全一致。
  { id: 'aptamil-1', name: 'Aptamil 1 First Infant Milk', regions: [], label: null },
];

export const formulaPresets: readonly FormulaPreset[] = presetData.map(({ label, ...rest }) => {
  const preset = localized({
    ...rest,
    label: label && { ...label, source: localized(label.source) },
  });
  return preset as FormulaPreset;
});

/** 当前地区的排前面，其余的也列出来：搬家、代购都很常见。 */
export function presetsForRegion(regionId: string): FormulaPreset[] {
  const rank = (preset: FormulaPreset) => (preset.regions.includes(regionId) ? 0 : 1);
  return [...formulaPresets].sort((a, b) => rank(a) - rank(b));
}

export function presetToForm(preset: FormulaPreset): FormulaForm {
  if (!preset.label) return emptyFormulaForm(preset.name);
  return formulaFormFromData({
    name: preset.name,
    basis: preset.label.basis,
    values: preset.label.values,
    powderGPer100ml: preset.label.powderGPer100ml,
  });
}
