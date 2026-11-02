import { getLocale, L, type Localized, t } from '../i18n';

export interface MilestoneTemplate {
  /** 当前语言的标题。 */
  title: string;
  /** 中文标题，只用来生成稳定的 testID。 */
  id: string;
  typical: string;
  /** 这条回忆是不是这个里程碑。标题是记录里的内容，家人可能用另一种语言记过。 */
  matches(title: string | undefined): boolean;
}

function milestone(title: Localized, typical: Localized): MilestoneTemplate {
  return {
    id: title.zh,
    get title() {
      return title[getLocale()];
    },
    get typical() {
      return typical[getLocale()];
    },
    matches: (value) => value === title.zh || value === title.en,
  };
}

export const milestoneTemplates: readonly MilestoneTemplate[] = [
  milestone(L('第一次抬头', 'First time lifting head'), L('通常 1–2 个月', 'Usually 1–2 months')),
  milestone(L('第一次笑出声', 'First laugh'), L('通常 2–3 个月', 'Usually 2–3 months')),
  milestone(L('第一次翻身', 'First roll over'), L('通常 4–6 个月', 'Usually 4–6 months')),
  milestone(
    L('第一次坐稳', 'First time sitting steadily'),
    L('通常 6–8 个月', 'Usually 6–8 months'),
  ),
  milestone(L('长出第一颗牙', 'First tooth'), L('通常 6–10 个月', 'Usually 6–10 months')),
  milestone(
    L('第一次叫爸爸妈妈', 'First time saying mama or dada'),
    L('通常 10–14 个月', 'Usually 10–14 months'),
  ),
];

/**
 * 吃药弹层的快捷药名。点一下等于替用户填了药名，存下来的就是这段文字，之后原样显示。
 * 药名属于用户的内容，不按语言换算。
 */
export function medicineSuggestions(): readonly string[] {
  return t().domain.medicineSuggestions;
}
