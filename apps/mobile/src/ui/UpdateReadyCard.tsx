import { t } from '@xiaodouya/shared';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useApp } from '../lib/app';
import {
  getUpdateController,
  useCanInstallPackages,
  useUpdatePhase,
  useUpdateSettings,
} from '../lib/appUpdateRuntime';
import { UpdateSheet } from '../sheets/updateSheet';
import { colors, spacing } from '../theme';
import { useSheet } from './overlays';

/**
 * 新版本下载好、校验过之后，今天页记录按钮下面的一张提示卡，点了才调起系统安装。
 * 不用 Toast：Toast 只有一个位置，下载完的时机不定，正好在记录时出现就会顶掉“已记录 · 撤销”；
 * 几秒后消失，半夜也容易错过。卡片放在按钮下面，出现时不会把按钮挤走。
 * 关掉后同一个版本不再出现，设置里“检查更新”那一行还写着已下载好。
 */
export function UpdateReadyCard() {
  const app = useApp();
  const sheet = useSheet();
  const updates = getUpdateController(app.api, app.db);
  const phase = useUpdatePhase(updates);
  const settings = useUpdateSettings(updates);
  const canInstall = useCanInstallPackages();

  if (!updates || !settings || phase.kind !== 'ready') return null;
  const { versionCode, versionName } = phase.update;
  if (settings.dismissedCode === versionCode) return null;

  const install = () => {
    // 没有“安装未知应用”的授权时，弹层里有「去设置」和说明。
    if (canInstall) void updates.install();
    else sheet.open(t().update.title, () => <UpdateSheet />);
  };

  return (
    <View style={s.card} testID="update-ready-card">
      <Text style={s.text}>{t().update.readyCard(versionName)}</Text>
      <View style={s.actions}>
        <Pressable
          testID="update-ready-later"
          accessibilityRole="button"
          accessibilityLabel={t().update.readyCardLaterA11y}
          hitSlop={8}
          onPress={() => void updates.dismissReady(versionCode)}
        >
          <Text style={s.later}>{t().update.later}</Text>
        </Pressable>
        <Pressable
          testID="update-ready-install"
          accessibilityRole="button"
          accessibilityLabel={t().update.readyCardInstallA11y(versionName)}
          hitSlop={8}
          onPress={install}
        >
          <Text style={s.install}>{t().update.install}</Text>
        </Pressable>
      </View>
    </View>
  );
}

/** 和通知提示卡（NotificationPrompt）同一种样式：提示卡圆角 12、卡片底色、细边。 */
const s = StyleSheet.create({
  card: {
    marginTop: 14,
    marginHorizontal: spacing.page,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  text: { flex: 1, fontSize: 13, lineHeight: 20, color: colors.ink },
  actions: { flexDirection: 'row', gap: 16, alignItems: 'center' },
  later: { fontSize: 13, color: colors.muted },
  install: { fontSize: 13, color: colors.accent, fontWeight: '500' },
});
