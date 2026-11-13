import type { ComponentProps } from 'react';
import { Text as RNText, TextInput as RNTextInput, StyleSheet } from 'react-native';
import { maxFontScaleFor } from '../lib/fontScale';

// 系统大字体（issue #110）的规则只在这里套用：大字只放大到 1.2 倍，正文跟着系统字体走，
// 见 lib/fontScale.ts。写了大字号（≥ 24）的文件从这里引 Text，primitives 里的文字组件也用它。

export function Text(props: ComponentProps<typeof RNText>) {
  const fontSize = StyleSheet.flatten(props.style)?.fontSize;
  return <RNText maxFontSizeMultiplier={maxFontScaleFor(fontSize)} {...props} />;
}

export function TextInput(props: ComponentProps<typeof RNTextInput>) {
  const fontSize = StyleSheet.flatten(props.style)?.fontSize;
  return <RNTextInput maxFontSizeMultiplier={maxFontScaleFor(fontSize)} {...props} />;
}
