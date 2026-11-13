import type { ComponentProps } from 'react';
import { Text as RNText, TextInput as RNTextInput, StyleSheet } from 'react-native';
import { LARGE_TEXT_MAX_SCALE, maxFontScaleFor } from '../lib/fontScale';

// 系统大字体（issue #110）的规则只在这里套用：大字只放大到 1.2 倍，正文跟着系统字体走，
// 见 lib/fontScale.ts。写了大字号（≥ 24）的文件从这里引 Text，primitives 里的文字组件也用它。

export function Text(props: ComponentProps<typeof RNText>) {
  const fontSize = StyleSheet.flatten(props.style)?.fontSize;
  return <RNText maxFontSizeMultiplier={maxFontScaleFor(fontSize)} {...props} />;
}

/**
 * 定大小的圆形里的字（家人头像的首字）：圆不跟着变大，字放大到 2 倍会被圆裁掉一半，
 * 所以和大字一样最多 1.2 倍。旁边的称呼照样跟着系统放大。
 */
export function BadgeText(props: ComponentProps<typeof RNText>) {
  return <RNText maxFontSizeMultiplier={LARGE_TEXT_MAX_SCALE} {...props} />;
}

export function TextInput(props: ComponentProps<typeof RNTextInput>) {
  const fontSize = StyleSheet.flatten(props.style)?.fontSize;
  return <RNTextInput maxFontSizeMultiplier={maxFontScaleFor(fontSize)} {...props} />;
}
