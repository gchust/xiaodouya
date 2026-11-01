import { Easing } from 'react-native-reanimated';

/** 设计令牌，来源见 docs/design/SPEC.md。不要在页面里写新的颜色。 */
export const colors = {
  paper: '#f6f1ea',
  card: '#fffdf9',
  sand: '#efe6d9',
  line: '#ebe2d6',
  rule: '#f1eadf',
  ink: '#2b2622',
  inkSoft: '#4a423c',
  muted: '#7a6f66',
  accent: '#c0714f',
  accentLight: '#e9a585',
  off: '#d8cfc3',
  green: '#6f9a6a',
  danger: '#b8645e',
  sleep: '#7d8fb8',
  diaper: '#c9a24a',
  wee: '#d9c06a',
  poo: '#a07a3a',
  dashed: '#d8ccbc',
  hint: '#cfc4b6',
  handle: '#e0d6c9',
  scrim: 'rgba(43,38,34,0.38)',
  white: '#ffffff',
} as const;

export const fonts = {
  serifMedium: 'NotoSerifSC_500Medium',
  serifBold: 'NotoSerifSC_700Bold',
  monoRegular: 'DMMono_400Regular',
  monoMedium: 'DMMono_500Medium',
} as const;

export const spacing = { page: 22 } as const;

export const motion = {
  duration: 340,
  easing: Easing.bezier(0.2, 0.8, 0.2, 1),
} as const;
