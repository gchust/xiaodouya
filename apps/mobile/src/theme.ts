import { Easing } from 'react-native-reanimated';
import { IS_E2E } from './lib/config';

export { applyPalette, colors, themedStyles } from './themes/runtime';

export const fonts = {
  serifMedium: 'NotoSerifSC_500Medium',
  serifBold: 'NotoSerifSC_700Bold',
  monoRegular: 'DMMono_400Regular',
  monoMedium: 'DMMono_500Medium',
} as const;

export const spacing = { page: 22 } as const;

export const motion = {
  // E2E 构建关掉动画：弹层滑入时元素在移动，Maestro 的点击会落空。
  duration: IS_E2E ? 0 : 340,
  easing: Easing.bezier(0.2, 0.8, 0.2, 1),
} as const;
