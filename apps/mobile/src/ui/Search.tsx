import { highlightParts, t } from '@xiaodouya/shared';
import { Pressable, type StyleProp, Text, TextInput, type TextStyle, View } from 'react-native';
import { colors, themedStyles } from '../theme';

/**
 * 搜索框（issue #109）：胶囊形状，没有放大镜图标，占位文字说明能搜什么。
 * 有字时右边一个 `×` 清空。
 */
export function SearchField({
  value,
  onChangeText,
  placeholder,
  accessibilityLabel,
  testID,
  autoFocus,
}: {
  value: string;
  onChangeText: (text: string) => void;
  placeholder: string;
  accessibilityLabel: string;
  testID: string;
  autoFocus?: boolean;
}) {
  return (
    <View style={s.box}>
      <TextInput
        testID={testID}
        accessibilityLabel={accessibilityLabel}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.muted}
        selectionColor={colors.accent}
        autoFocus={autoFocus}
        autoCorrect={false}
        autoCapitalize="none"
        returnKeyType="search"
        maxLength={100}
        style={s.input}
      />
      {value ? (
        <Pressable
          testID={`${testID}-clear`}
          accessibilityRole="button"
          accessibilityLabel={t().search.clear}
          hitSlop={{ top: 6, bottom: 6, left: 8, right: 8 }}
          onPress={() => onChangeText('')}
          style={s.clear}
        >
          <Text style={s.clearGlyph}>×</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/**
 * 放进 Text 里用：命中的字换成强调色加粗，其余原样。拼起来还是原文，读屏读到的也是原文。
 * 衬线正文要传 `hitStyle` 换成粗体的字体文件，只写 fontWeight 的话 Android 不会换字重。
 */
export function Highlighted({
  text,
  terms,
  hitStyle,
}: {
  text: string;
  terms: readonly string[];
  hitStyle?: StyleProp<TextStyle>;
}) {
  if (terms.length === 0) return text;
  return highlightParts(text, terms).map((part, i) =>
    part.hit ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: 片段只按位置区分，同一段文字可以出现几次。
      <Text key={i} style={[s.hit, hitStyle]}>
        {part.text}
      </Text>
    ) : (
      part.text
    ),
  );
}

const s = themedStyles(() => ({
  box: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 44,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
    paddingLeft: 16,
    paddingRight: 6,
  },
  input: { flex: 1, fontSize: 14, color: colors.ink, paddingVertical: 10 },
  clear: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  clearGlyph: { fontSize: 18, lineHeight: 22, color: colors.muted },
  hit: { color: colors.accentText, fontWeight: '700' },
}));
