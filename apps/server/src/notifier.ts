export interface PushMessage {
  token: string;
  title: string;
  body: string;
}

export interface Notifier {
  send(messages: PushMessage[]): Promise<void>;
}

export const noopNotifier: Notifier = { send: async () => {} };

/** 通过 Expo Push 服务发送，它再转发给 FCM / APNs。发送失败不能影响记录同步。 */
export function expoNotifier(accessToken: string | undefined): Notifier {
  return {
    async send(messages) {
      for (let i = 0; i < messages.length; i += 100) {
        const batch = messages.slice(i, i + 100).map((m) => ({
          to: m.token,
          title: m.title,
          body: m.body,
          sound: 'default',
          channelId: 'family',
        }));
        const response = await fetch('https://exp.host/--/api/v2/push/send', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
          },
          body: JSON.stringify(batch),
        });
        if (!response.ok) console.error(`推送发送失败：HTTP ${response.status}`);
      }
    },
  };
}

/** 夜间安静：23:00–07:00（按用户时区）。 */
export function isQuietHour(now: number, timezone: string): boolean {
  let hour: number;
  try {
    hour = Number(
      new Intl.DateTimeFormat('en-US', {
        hour: 'numeric',
        hourCycle: 'h23',
        timeZone: timezone,
      }).format(now),
    );
  } catch {
    return false;
  }
  return hour >= 23 || hour < 7;
}
