import { type EventData, estimateNextFeed } from '@xiaodouya/shared';
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
    name: '喂奶提醒',
    importance: Notifications.AndroidImportance.HIGH,
  });
  await Notifications.setNotificationChannelAsync('family', {
    name: '家人的记录',
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

/** 只在已经学到喂奶规律时才提醒，默认间隔不够可靠，不应该半夜吵醒人。 */
export async function scheduleFeedReminder(events: EventData[], enabled: boolean): Promise<void> {
  try {
    await Notifications.cancelScheduledNotificationAsync(FEED_REMINDER_ID);
    if (!enabled) return;
    const estimate = estimateNextFeed(events, Date.now());
    if (!estimate.last || !estimate.isLearned || estimate.remainingMs <= 0) return;
    const current = await Notifications.getPermissionsAsync();
    if (!current.granted) return;
    await ensureChannels();
    await Notifications.scheduleNotificationAsync({
      identifier: FEED_REMINDER_ID,
      content: { title: '差不多该喂奶了', body: '已到平时的喂奶间隔。' },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
        seconds: Math.max(60, Math.round(estimate.remainingMs / 1000)),
        channelId: 'feed',
      },
    });
  } catch {
    // 通知不可用不能影响记录。
  }
}
