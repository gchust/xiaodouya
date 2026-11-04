import { L, type Localized, localized } from '../i18n';
import type { NutrientValues } from '../schemas';
import { emptyFormulaForm, type FormulaForm, formulaFormFromData, iuToUg } from './nutrition';

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
    basis: 'per100ml';
    values: NutrientValues;
    source: { label: string; url: string; readOn: string; version: string };
  };
}

const HEALTH_CANADA_LABELS =
  'https://www.canada.ca/en/health-canada/services/food-nutrition/legislation-guidelines/policies/interim-policy-importation-sale-infant-formula-human-milk-fortifiers-metabolic-products';

/** 中文品牌名原样留着：那是罐身上印的字，英文名没有读到的不编。 */
type PresetInput = Omit<FormulaPreset, 'name' | 'label'> & {
  name: string | Localized;
  label: null | {
    basis: 'per100ml';
    values: NutrientValues;
    source: { label: Localized; url: string; readOn: string; version: Localized };
  };
};

const presetData: readonly PresetInput[] = [
  {
    // 合生元官网（biostime.com.cn/pai-star.html，2026-11-01）正文没有营养数值，只有宣传图，图片的 CDN
    // 返回 403 读不到；市场监管总局的配方注册信息也没查到。搜索到的只有测评和电商转述，彼此矛盾，不能用。
    //
    // issue #60 要“派星 1 段新版”，2026-11-04 再查（待复核，没有带数值）：
    // - 京东自营的商品名是“派星 婴儿配方奶粉1段新版(0-6个月)800g 6重HMO+DHA”（SKU 1720648），详情页要登录才显示，
    //   没读到标签。测评文章说 2026 年 3 月升级成 6 种 HMO，没有官方原文。
    // - 第三方站 nznewmilk.com.cn 列了“合生元派星天护婴儿配方奶粉（1段）”国食注字 YP20235061（2023-08-29 批准）
    //   每 100 g 的数值，自称整理自总局公开信息，但写明不是总局网站，也没有标签或证书原图。它的成分表里没有 HMO，
    //   名字也是“派星天护”，所以就算数字对，也多半不是“新版”。
    // - 总局特殊食品信息查询平台（tsspxx.gsxt.gov.cn）在这台机器上返回 502 或连不上，没能核对这个注册号。
    // 罐身多半只给每 100 g，要做成预置还得有冲调表上“每 100 ml 冲好的奶用多少克粉”，只有水量不够。
    id: 'biostime-paixing-1',
    name: '合生元 派星 1 段',
    regions: ['CN'],
    label: null,
  },
  {
    // 同上。段数和适用月龄来自京东的商品列表。
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
  });
}
