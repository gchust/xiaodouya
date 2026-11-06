import { getLocale, L, type Localized } from '../i18n';
import type { MoneyFlow } from '../schemas';

/**
 * 小金库的场合（收到）和用途（拿出）。记录里只存 id，显示时按当前语言取名字，所以换语言、换地区后
 * 以前记的都还有名字。哪个地区列出哪些在地区文件的 `money.categories` 里：红包、压岁钱这类只在有这个
 * 习俗的地区（中国、新加坡）出现，美国和其他地区只有生日、节日这些各地都有的场合。
 *
 * 新增一个场合：在这里加一条，再写进需要它的地区，不用改页面。id 一经发布不能改，记录里存的就是它。
 */
const catalog: Record<string, { flow: MoneyFlow | 'both'; label: Localized }> = {
  'lunar-new-year': { flow: 'in', label: L('压岁钱', 'Lunar New Year money') },
  'red-packet': { flow: 'in', label: L('红包', 'Red packet') },
  'full-month': { flow: 'in', label: L('满月', 'One-month celebration') },
  'hundred-days': { flow: 'in', label: L('百天', '100-day celebration') },
  birthday: { flow: 'in', label: L('生日', 'Birthday') },
  holiday: { flow: 'in', label: L('节日', 'Holiday') },
  gift: { flow: 'in', label: L('礼金', 'Gift') },
  bank: { flow: 'out', label: L('存进银行', 'Into the bank') },
  spent: { flow: 'out', label: L('给宝宝花了', 'Spent on your baby') },
  other: { flow: 'both', label: L('其他', 'Other') },
};

/** 拿出的去向各地一样，都可以选。 */
export const moneyOutCategoryIds: readonly string[] = ['bank', 'spent', 'other'];

/** 没有自己的列表的地区用这些：不带任何地方的习俗。 */
export const genericMoneyInCategoryIds: readonly string[] = [
  'birthday',
  'holiday',
  'gift',
  'other',
];

export function isMoneyCategory(id: string, flow: MoneyFlow): boolean {
  const entry = catalog[id];
  return entry !== undefined && (entry.flow === flow || entry.flow === 'both');
}

/** 当前语言的名字；以后的版本写入的、这个版本不认识的 id 返回 undefined，界面就不显示场合。 */
export function moneyCategoryLabel(id: string | undefined): string | undefined {
  if (id === undefined || !Object.hasOwn(catalog, id)) return undefined;
  return catalog[id]?.label[getLocale()];
}
