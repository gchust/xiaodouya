import { type EventData, planFeedReminders, t } from '@xiaodouya/shared';
import * as Crypto from 'expo-crypto';
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import type { Api } from './api';

const FEED_REMINDER_ID = 'feed-reminder';
const DEVICE_ID_KEY = 'device.id';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

async function ensureChannels() {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync('feed', {
    name: t().ui.channelFeed,
    importance: Notifications.AndroidImportance.HIGH,
  });
  await Notifications.setNotificationChannelAsync('family', {
    name: t().ui.channelFamily,
    importance: Notifications.AndroidImportance.DEFAULT,
  });
}

export async function ensureNotificationPermission(): Promise<boolean> {
  const current = await Notifications.getPermissionsAsync();
  if (current.granted) return true;
  if (!current.canAskAgain) return false;
  return (await Notifications.requestPermissionsAsync()).granted;
}

async function deviceId(): Promise<string> {
  const saved = await SecureStore.getItemAsync(DEVICE_ID_KEY);
  if (saved) return saved;
  const id = Crypto.randomUUID();
  await SecureStore.setItemAsync(DEVICE_ID_KEY, id);
  return id;
}

/** 不再注册推送，但 v0.1.0 升级上来的手机在服务端可能还留着令牌，退出时要清掉。 */
export async function unregisterPushToken(api: Api): Promise<void> {
  await api.unregisterPushToken(await deviceId());
}

/**
 * 喂奶提醒。只有一个宝宝时传 `babyId: null` 的一组，和以前一样只有一条（同一个 id、同样的文字）；
 * 有几个宝宝时每个宝宝一条，文字写上名字（issue #106）。
 */
export async function scheduleFeedReminders(
  babies: { babyId: string | null; name: string; events: EventData[] }[],
  enabled: boolean,
): Promise<void> {
  try {
    await Notifications.cancelScheduledNotificationAsync(FEED_REMINDER_ID);
    // 每个宝宝一条的（有过几个宝宝时排的）。查不到已排的提醒也不能耽误只有一个宝宝的那条。
    try {
      const scheduled = await Notifications.getAllScheduledNotificationsAsync();
      for (const item of scheduled) {
        if (item.identifier.startsWith(`${FEED_REMINDER_ID}:`)) {
          await Notifications.cancelScheduledNotificationAsync(item.identifier);
        }
      }
    } catch {}
    if (!enabled) return;
    const reminders = planFeedReminders(babies, Date.now());
    if (reminders.length === 0) return;
    const current = await Notifications.getPermissionsAsync();
    if (!current.granted) return;
    await ensureChannels();
    for (const reminder of reminders) {
      await Notifications.scheduleNotificationAsync({
        identifier: reminder.babyId ? `${FEED_REMINDER_ID}:${reminder.babyId}` : FEED_REMINDER_ID,
        content: {
          title: t().ui.feedReminderTitle,
          body: reminder.babyId
            ? t().babies.feedReminderBody(reminder.name)
            : t().ui.feedReminderBody,
        },
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
          seconds: Math.max(60, Math.round(reminder.delayMs / 1000)),
          channelId: 'feed',
        },
      });
    }
  } catch {
    // 通知不可用不能影响记录。
  }
}
