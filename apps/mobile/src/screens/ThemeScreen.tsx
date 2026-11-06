import { t } from '@xiaodouya/shared';
import { useRouter } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { setThemePref, useTheme } from '../lib/themePref';
import { colors, fonts, spacing, themedStyles } from '../theme';
import {
  type Appearance,
  appearances,
  paletteFor,
  type Scheme,
  type ThemeId,
  themeIds,
} from '../themes/palettes';
import { Chip, Muted, PageTitle, SectionTitle } from '../ui/primitives';

export function appearanceLabel(appearance: Appearance): string {
  if (appearance === 'light') return t().themeUi.appearanceLight;
  if (appearance === 'dark') return t().themeUi.appearanceDark;
  return t().themeUi.appearanceSystem;
}

/**
 * 一小页“今天”的样子：纸色底上一张卡片，标题、辅助文字、强调色按钮和几种记录的色点。
 * 用那套主题自己的颜色画，不读当前的 colors。
 */
function Preview({ theme, scheme }: { theme: ThemeId; scheme: Scheme }) {
  const p = paletteFor(theme, scheme);
  return (
    <View style={[s.preview, { backgroundColor: p.paper, borderColor: p.line }]}>
      <View style={[s.previewCard, { backgroundColor: p.card, borderColor: p.line }]}>
        <View style={[s.previewTitle, { backgroundColor: p.ink }]} />
        <View style={[s.previewLine, { backgroundColor: p.muted }]} />
        <View style={s.previewDots}>
          <View style={[s.previewDot, { backgroundColor: p.feed }]} />
          <View style={[s.previewDot, { backgroundColor: p.diaper }]} />
          <View style={[s.previewDot, { backgroundColor: p.sleep }]} />
        </View>
      </View>
      <View style={[s.previewButton, { backgroundColor: p.accentFill }]}>
        <View style={[s.previewButtonText, { backgroundColor: p.onAccent }]} />
      </View>
    </View>
  );
}

/** 家人页设置里的“主题配色”。只改这台手机，选了马上换，见 lib/themePref.ts。 */
export function ThemeScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { pref } = useTheme();

  return (
    <ScrollView
      testID="theme-screen"
      style={s.root}
      contentContainerStyle={[
        s.content,
        { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 32 },
      ]}
      showsVerticalScrollIndicator={false}
    >
      <View style={{ gap: 6, alignItems: 'flex-start' }}>
        <Pressable
          testID="theme-back"
          accessibilityRole="button"
          accessibilityLabel={t().widgetUi.backToFamily}
          hitSlop={12}
          onPress={() => router.back()}
        >
          <Text style={s.back}>{t().widgetUi.backFamilyLink}</Text>
        </Pressable>
        <PageTitle>{t().themeUi.title}</PageTitle>
        <Text style={s.intro}>{t().themeUi.intro}</Text>
      </View>

      {/* 深浅放在最上面：换完界面重新挂载、这一页回到顶部，刚点的地方还在眼前。 */}
      <View style={s.section}>
        <SectionTitle>{t().themeUi.appearance}</SectionTitle>
        <View style={s.chips}>
          {appearances.map((appearance) => (
            <Chip
              key={appearance}
              testID={`appearance-${appearance}`}
              label={appearanceLabel(appearance)}
              selected={pref.appearance === appearance}
              onPress={() => {
                if (pref.appearance !== appearance) setThemePref({ ...pref, appearance });
              }}
            />
          ))}
        </View>
        <Muted style={s.note}>{t().themeUi.appearanceNote}</Muted>
      </View>

      <View style={s.section}>
        <SectionTitle>{t().themeUi.themes}</SectionTitle>
        {themeIds.map((id) => {
          const on = pref.theme === id;
          return (
            <Pressable
              key={id}
              testID={`theme-${id}`}
              accessibilityRole="button"
              accessibilityLabel={t().themeUi.name[id]}
              accessibilityState={{ selected: on }}
              onPress={() => {
                if (!on) setThemePref({ ...pref, theme: id });
              }}
              style={[s.option, on ? s.optionOn : null]}
            >
              <View style={s.previews}>
                <Preview theme={id} scheme="light" />
                <Preview theme={id} scheme="dark" />
              </View>
              <View style={s.optionText}>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={s.name}>{t().themeUi.name[id]}</Text>
                  <Muted style={{ fontSize: 12, lineHeight: 17 }}>{t().themeUi.desc[id]}</Muted>
                </View>
                {on ? (
                  <Text testID={`theme-${id}-in-use`} style={s.inUse}>
                    {t().themeUi.inUse}
                  </Text>
                ) : null}
              </View>
            </Pressable>
          );
        })}
      </View>

      <View style={s.tip}>
        <Text style={s.tipText}>{t().themeUi.widgetNote}</Text>
      </View>
    </ScrollView>
  );
}

const s = themedStyles(() => ({
  root: { flex: 1, backgroundColor: colors.paper },
  content: { paddingHorizontal: spacing.page, gap: 20 },
  back: { fontSize: 14, color: colors.muted, padding: 4, marginLeft: -4 },
  intro: { fontSize: 13, lineHeight: 19, color: colors.inkSoft },
  section: { gap: 10 },
  option: {
    backgroundColor: colors.card,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 14,
    padding: 10,
    gap: 10,
  },
  // 选中时边框加粗，不改大小：边框宽度的差用外边距补上，列表不会跳。
  optionOn: { borderColor: colors.accent, borderWidth: 2, margin: -1 },
  previews: { flexDirection: 'row', gap: 8 },
  preview: {
    flex: 1,
    height: 76,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth * 2,
    padding: 8,
    gap: 6,
    overflow: 'hidden',
  },
  previewCard: {
    flex: 1,
    borderRadius: 7,
    borderWidth: StyleSheet.hairlineWidth * 2,
    paddingHorizontal: 7,
    paddingVertical: 6,
    gap: 4,
  },
  previewTitle: { width: '55%', height: 5, borderRadius: 3 },
  previewLine: { width: '75%', height: 3, borderRadius: 2, opacity: 0.7 },
  previewDots: { flexDirection: 'row', gap: 4, marginTop: 'auto' },
  previewDot: { width: 6, height: 6, borderRadius: 3 },
  previewButton: {
    height: 14,
    borderRadius: 7,
    alignItems: 'center',
    justifyContent: 'center',
  },
  previewButtonText: { width: 22, height: 3, borderRadius: 2, opacity: 0.9 },
  optionText: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 2 },
  name: { fontFamily: fonts.serifBold, fontSize: 15, lineHeight: 22, color: colors.ink },
  inUse: { fontSize: 12, color: colors.accentText, fontWeight: '500' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  note: { fontSize: 12, lineHeight: 19 },
  tip: {
    backgroundColor: colors.sand,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  tipText: { fontSize: 12, lineHeight: 18, color: colors.inkSoft },
}));
