import { normalizeWidgetLabel, t, WIDGET_LABEL_MAX } from '@xiaodouya/shared';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  Image,
  type ImageSourcePropType,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { requestPinWidget } from 'react-native-android-widget';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp, useRecords } from '../lib/app';
import { colors, spacing } from '../theme';
import { useFeedback } from '../ui/overlays';
import { Button, Field, ListCard, Muted, PageTitle, SectionTitle, Toggle } from '../ui/primitives';
import { scheduleWidgetRefresh } from '../widgets/controller';
import { readWidgetPrefs, saveWidgetPrefs } from '../widgets/prefs';
import type { WidgetName } from '../widgets/views';

interface Entry {
  name: WidgetName;
  title: () => string;
  desc: () => string;
  preview: ImageSourcePropType;
  wide: boolean;
}

/** 顺序按用得多少排：快捷记录最全，放第一个。预览图和系统小部件列表里的是同一张。 */
const entries: Entry[] = [
  {
    name: 'QuickWidget',
    title: () => t().widgetUi.quickName,
    desc: () => t().widgetUi.quickDesc,
    preview: require('../../assets/widgets/quick-preview.png'),
    wide: true,
  },
  {
    name: 'FeedWidget',
    title: () => t().widgetUi.feedName,
    desc: () => t().widgetUi.feedDesc,
    preview: require('../../assets/widgets/feed-preview.png'),
    wide: false,
  },
  {
    name: 'SleepWidget',
    title: () => t().widgetUi.sleepName,
    desc: () => t().widgetUi.sleepDesc,
    preview: require('../../assets/widgets/sleep-preview.png'),
    wide: false,
  },
  {
    name: 'DiaperWidget',
    title: () => t().widgetUi.diaperName,
    desc: () => t().widgetUi.diaperDesc,
    preview: require('../../assets/widgets/diaper-preview.png'),
    wide: false,
  },
  {
    name: 'SummaryWidget',
    title: () => t().widgetUi.summaryName,
    desc: () => t().widgetUi.summaryDesc,
    preview: require('../../assets/widgets/summary-preview.png'),
    wide: true,
  },
];

/**
 * 小工具上的称呼和头像。只存在这台手机上（`widgets/prefs.ts`），不同步给家人：
 * 每个人手机上的叫法可以不一样，头像要不要放在桌面上也该由手机的主人决定。
 */
function DisplaySettings() {
  const app = useApp();
  const { baby } = useRecords();
  const { toast } = useFeedback();
  const [loaded, setLoaded] = useState(false);
  const [label, setLabel] = useState('');
  const saved = useRef<string | null>(null);
  const [showAvatar, setShowAvatar] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void readWidgetPrefs(app.db).then((prefs) => {
      if (cancelled) return;
      const current = normalizeWidgetLabel(prefs.label);
      setLabel(current ?? '');
      saved.current = current;
      setShowAvatar(prefs.showAvatar === true);
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [app.db]);

  // 边输入边存：Android 上收起键盘不一定让输入框失去焦点，等失焦再存的话，直接返回就丢了。
  // 重画小工具本来就合并了短时间内的多次变化（scheduleWidgetRefresh）。
  const changeLabel = async (text: string) => {
    setLabel(text);
    const next = normalizeWidgetLabel(text);
    if (next === saved.current) return;
    saved.current = next;
    try {
      await saveWidgetPrefs(app.db, { label: next });
      scheduleWidgetRefresh();
    } catch {
      toast(t().widgetUi.saveFailed);
    }
  };

  const changeAvatar = async (next: boolean) => {
    setShowAvatar(next);
    try {
      await saveWidgetPrefs(app.db, { showAvatar: next });
      scheduleWidgetRefresh();
    } catch {
      setShowAvatar(!next);
      toast(t().widgetUi.saveFailed);
    }
  };

  return (
    <View style={{ gap: 8 }} testID="widget-display">
      <SectionTitle>{t().widgetUi.displayTitle}</SectionTitle>
      <ListCard>
        <View style={s.labelRow}>
          <Field
            testID="widget-label-input"
            label={t().widgetUi.labelField}
            value={label}
            onChangeText={(text) => void changeLabel(text)}
            placeholder={baby?.data.name}
            maxLength={WIDGET_LABEL_MAX}
            editable={loaded}
            returnKeyType="done"
            onEndEditing={() => setLabel(saved.current ?? '')}
          />
          <Muted style={s.hint}>{t().widgetUi.labelHint(WIDGET_LABEL_MAX)}</Muted>
        </View>
        <Toggle
          testID="widget-avatar-toggle"
          label={t().widgetUi.avatarToggle}
          sub={t().widgetUi.avatarSub}
          value={showAvatar}
          onChange={(next) => void changeAvatar(next)}
          disabled={!loaded}
          last={!(showAvatar && !baby?.data.avatar)}
        />
        {showAvatar && !baby?.data.avatar ? (
          <Muted style={[s.hint, s.missing]} testID="widget-avatar-missing">
            {t().widgetUi.avatarMissing}
          </Muted>
        ) : null}
      </ListCard>
    </View>
  );
}

/**
 * 有的桌面（比如 HyperOS）把第三方小工具放在列表最下面，很难找到。
 * 这里直接请系统弹出“添加到桌面”；桌面不支持时只能告诉用户手动的路径。
 */
export function WidgetsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { toast } = useFeedback();
  const [busy, setBusy] = useState<WidgetName | null>(null);

  const pin = async (entry: Entry) => {
    setBusy(entry.name);
    try {
      const accepted = await requestPinWidget({ widgetName: entry.name });
      if (!accepted) toast(t().widgetUi.pinUnsupported);
    } catch {
      toast(t().widgetUi.pinUnsupported);
    } finally {
      setBusy(null);
    }
  };

  const card = (entry: Entry) => (
    <View
      key={entry.name}
      style={[s.card, entry.wide ? s.wide : s.half]}
      testID={`widget-card-${entry.name}`}
    >
      <View style={[s.preview, entry.wide ? s.previewWide : null]}>
        <Image
          source={entry.preview}
          style={s.previewImage}
          resizeMode="contain"
          accessibilityIgnoresInvertColors
        />
      </View>
      <View style={{ gap: 2 }}>
        <Text style={s.name}>{entry.title()}</Text>
        <Muted style={{ fontSize: 11, lineHeight: 15 }} numberOfLines={2}>
          {entry.desc()}
        </Muted>
      </View>
      <Button
        testID={`widget-pin-${entry.name}`}
        label={t().widgetUi.addToHome}
        onPress={() => void pin(entry)}
        busy={busy === entry.name}
        height={38}
        labelStyle={{ fontSize: 13 }}
      />
    </View>
  );

  return (
    <ScrollView
      testID="widgets-screen"
      style={s.root}
      contentContainerStyle={[
        s.content,
        { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 32 },
      ]}
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
    >
      <View style={{ gap: 6, alignItems: 'flex-start' }}>
        <Pressable
          testID="widgets-back"
          accessibilityRole="button"
          accessibilityLabel={t().widgetUi.backToFamily}
          hitSlop={12}
          onPress={() => router.back()}
        >
          <Text style={s.back}>{t().widgetUi.backFamilyLink}</Text>
        </Pressable>
        <PageTitle>{t().widgetUi.galleryRow}</PageTitle>
        <Text style={s.intro}>{t().widgetUi.galleryIntro}</Text>
      </View>
      {/* 放在最上面：改称呼的人多半已经放好了小工具，输入框在下面也容易被键盘挡住。 */}
      <DisplaySettings />
      <View style={s.grid}>{entries.map(card)}</View>
      <View style={s.tip} testID="widgets-manual-hint">
        <Text style={s.tipText}>{t().widgetUi.manualHint}</Text>
      </View>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.paper },
  content: { paddingHorizontal: spacing.page, gap: 16 },
  back: { fontSize: 14, color: colors.muted, padding: 4, marginLeft: -4 },
  intro: { fontSize: 13, lineHeight: 19, color: colors.inkSoft },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  card: {
    backgroundColor: colors.card,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 14,
    padding: 10,
    gap: 8,
  },
  wide: { width: '100%' },
  half: { width: '47.5%', flexGrow: 1 },
  preview: {
    height: 96,
    borderRadius: 10,
    backgroundColor: colors.sand,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 8,
  },
  previewWide: { height: 112 },
  previewImage: { width: '100%', height: '100%' },
  name: { fontSize: 14, fontWeight: '700', color: colors.ink },
  tip: {
    backgroundColor: colors.sand,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  tipText: { fontSize: 12, lineHeight: 18, color: colors.inkSoft },
  labelRow: {
    paddingVertical: 12,
    gap: 6,
    borderBottomWidth: StyleSheet.hairlineWidth * 2,
    borderBottomColor: colors.rule,
  },
  hint: { fontSize: 11, lineHeight: 16 },
  missing: { paddingBottom: 12, marginTop: -4 },
});
