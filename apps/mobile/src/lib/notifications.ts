import { type EventData, feedReminderDelayMs } from '@xiaodouya/shared';
import * as Crypto from 'expo-crypto';
import * as Device from 'expo-device';
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

/**
 * 注册家人记录的远程推送。没有配置 FCM 的构建拿不到 token，这里静默跳过：
 * 喂奶提醒是本机通知，App 内的横幅也不依赖推送，核心功能都不受影响。
 */
export async function registerPushToken(api: Api): Promise<void> {
  try {
    if (!Device.isDevice) return;
    await ensureChannels();
    const current = await Notifications.getPermissionsAsync();
    if (!current.granted) return;
    const token = await Notifications.getExpoPushTokenAsync();
    await api.registerPushToken(token.data, await deviceId());
  } catch {
    // 见上方说明。
  }
}

export async function unregisterPushToken(api: Api): Promise<void> {
  await api.unregisterPushToken(await deviceId());
}

export async function scheduleFeedReminder(events: EventData[], enabled: boolean): Promise<void> {
  try {
    await Notifications.cancelScheduledNotificationAsync(FEED_REMINDER_ID);
    if (!enabled) return;
    const delayMs = feedReminderDelayMs(events, Date.now());
    if (delayMs === null) return;
    const current = await Notifications.getPermissionsAsync();
    if (!current.granted) return;
    await ensureChannels();
    await Notifications.scheduleNotificationAsync({
      identifier: FEED_REMINDER_ID,
      content: { title: '差不多该喂奶了', body: '已到平时的喂奶间隔。' },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
        seconds: Math.max(60, Math.round(delayMs / 1000)),
        channelId: 'feed',
      },
    });
  } catch {
    // 通知不可用不能影响记录。
  }
}
