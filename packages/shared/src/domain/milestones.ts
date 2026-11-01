export interface MilestoneTemplate {
  title: string;
  typical: string;
}

export const milestoneTemplates: readonly MilestoneTemplate[] = [
  { title: '第一次抬头', typical: '通常 1–2 个月' },
  { title: '第一次笑出声', typical: '通常 2–3 个月' },
  { title: '第一次翻身', typical: '通常 4–6 个月' },
  { title: '第一次坐稳', typical: '通常 6–8 个月' },
  { title: '长出第一颗牙', typical: '通常 6–10 个月' },
  { title: '第一次叫爸爸妈妈', typical: '通常 10–14 个月' },
];

export const medicineSuggestions = ['维生素D', '益生菌', '退烧药'] as const;
