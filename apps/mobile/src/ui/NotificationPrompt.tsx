import { t } from '@xiaodouya/shared';
import * as Notifications from 'expo-notifications';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useApp } from '../lib/app';
import { ensureNotificationPermission } from '../lib/notifications';
import { colors, spacing } from '../theme';

const DISMISSED_KEY = 'notification-prompt-dismissed';

/**
 * 由用户自己决定要不要开通知。不能在记录后直接弹系统权限框：它会盖住“已记录”和“撤销”，
 * 用户拒绝一次之后，下一条记录又会再弹。
 */
export function NotificationPrompt() {
  const { db } = useApp();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const [permission, dismissed] = await Promise.all([
        Notifications.getPermissionsAsync(),
        db.getMeta(DISMISSED_KEY),
      ]);
      if (alive) setVisible(!permission.granted && permission.canAskAgain && !dismissed);
    })().catch(() => {});
    return () => {
      alive = false;
    };
  }, [db]);

  if (!visible) return null;
  const dismiss = () => {
    setVisible(false);
    void db.setMeta(DISMISSED_KEY, '1');
  };
  return (
    <View style={s.card} testID="notification-prompt">
      <Text style={s.text}>{t().ui.notifPrompt}</Text>
      <View style={s.actions}>
        <Pressable
          testID="notification-dismiss"
          accessibilityRole="button"
          accessibilityLabel={t().ui.notifNo}
          hitSlop={8}
          onPress={dismiss}
        >
          <Text style={s.later}>{t().ui.notifNo}</Text>
        </Pressable>
        <Pressable
          testID="notification-enable"
          accessibilityRole="button"
          accessibilityLabel={t().ui.notifOpen}
          hitSlop={8}
          onPress={() => {
            dismiss();
            void ensureNotificationPermission().catch(() => {});
          }}
        >
          <Text style={s.enable}>{t().ui.notifOpenShort}</Text>
        </Pressable>
      </View>
    </View>
  );
}

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
  enable: { fontSize: 13, color: colors.accent, fontWeight: '500' },
});
