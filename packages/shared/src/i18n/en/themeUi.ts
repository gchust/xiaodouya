import type { Catalog } from '../zh';

export const themeUi: Catalog['themeUi'] = {
  row: 'Theme',
  rowSub: (theme, appearance) => `${theme} · ${appearance}`,
  title: 'Theme',
  intro:
    "Changes the colors on this phone only. Your family's phones stay the same. Applies right away.",
  themes: 'Colors',
  appearance: 'Light and dark',
  appearanceSystem: 'Match phone',
  appearanceLight: 'Light',
  appearanceDark: 'Dark',
  appearanceNote:
    'When matching your phone, Xiaodouya switches the next time you come back to it, so nothing you are filling in gets interrupted.',
  widgetNote:
    "Home screen widgets and shared web pages keep the original colors. Widgets follow your phone's dark mode.",
  inUse: 'In use',
  name: {
    paper: 'Warm Paper',
    lavender: 'Lavender',
    mist: 'Morning Mist',
    seaSalt: 'Sea Salt',
    matcha: 'Matcha',
  },
  desc: {
    paper: 'Cream paper and terracotta, the original look',
    lavender: 'A soft grey-violet, like the evening sky',
    mist: 'The quiet grey-blue of early morning',
    seaSalt: 'Pale teal, like a breeze by the sea',
    matcha: 'A gentle, warm moss green',
  },
};
