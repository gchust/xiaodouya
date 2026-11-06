import { getLocale, L, type Localized } from '../i18n';

/**
 * 分享链接时，弹层里直接列出来的常用聊天 App（issue #94）。系统分享面板会列出手机上所有能收文字的 App，
 * 而且不能过滤，所以 Android 上由 App 自己画一排：只列名单里、这台手机上装了的，其余的点“更多”。
 *
 * 名字和图标都用系统给的（`loadLabel`、应用图标），不打包别人的商标图片；`name` 只在系统给的名字是空的时候用。
 * iOS 不能查别的 App 装没装，也不能指定发给谁，一直用系统分享面板。
 */
export type ShareTargetId =
  | 'wechat'
  | 'qq'
  | 'whatsapp'
  | 'telegram'
  | 'messenger'
  | 'line'
  | 'signal'
  | 'viber'
  | 'kakaotalk'
  | 'messages';

export interface ShareTargetApp {
  name: Localized<string>;
  /** 同一个 App 的几个版本（商务版、精简版、官网版），按优先级。装了好几个时只显示第一个。 */
  androidPackages: readonly string[];
}

export const SHARE_TARGET_APPS: Record<ShareTargetId, ShareTargetApp> = {
  // 微信：对文字的 ACTION_SEND 有“发送给朋友”和“添加到微信收藏”两个入口，只指定包名时系统会让人在这两个里选。
  wechat: { name: L('微信', 'WeChat'), androidPackages: ['com.tencent.mm'] },
  qq: { name: L('QQ', 'QQ'), androidPackages: ['com.tencent.mobileqq'] },
  whatsapp: {
    name: L('WhatsApp', 'WhatsApp'),
    androidPackages: ['com.whatsapp', 'com.whatsapp.w4b'],
  },
  telegram: {
    name: L('Telegram', 'Telegram'),
    androidPackages: [
      'org.telegram.messenger',
      'org.telegram.messenger.web',
      'org.thunderdog.challegram',
    ],
  },
  messenger: {
    name: L('Messenger', 'Messenger'),
    androidPackages: ['com.facebook.orca', 'com.facebook.mlite'],
  },
  line: { name: L('LINE', 'LINE'), androidPackages: ['jp.naver.line.android'] },
  signal: { name: L('Signal', 'Signal'), androidPackages: ['org.thoughtcrime.securesms'] },
  viber: { name: L('Viber', 'Viber'), androidPackages: ['com.viber.voip'] },
  kakaotalk: { name: L('KakaoTalk', 'KakaoTalk'), androidPackages: ['com.kakao.talk'] },
  // 短信优先用手机设置的默认短信 App（各家手机不一样），见 pickShareTargets。这里是查不到默认时的常见几个。
  messages: {
    name: L('短信', 'Messages'),
    androidPackages: [
      'com.google.android.apps.messaging',
      'com.samsung.android.messaging',
      'com.android.mms',
      'com.android.messaging',
    ],
  },
};

/** 一排放 4 个，加上“更多”正好一行，小屏也不挤。 */
export const MAX_SHARE_TARGETS = 4;

/** 这台手机上能收文字分享的一个 App（原生层查到的）。 */
export interface ShareReceiver {
  packageName: string;
  /** 系统给的名字，跟着手机语言（中文手机上是“微信”，英文是“WeChat”）。 */
  label: string;
}

export interface ShareTargetChoice {
  id: ShareTargetId;
  packageName: string;
  label: string;
}

/**
 * 按地区的名单和这台手机装了什么，算出弹层里显示哪几个、什么顺序。
 * 只看能收文字分享的 App：装了但不收文字的（或者被系统藏起来的）不显示，点了没反应比不显示更糟。
 */
export function pickShareTargets(
  order: readonly ShareTargetId[],
  receivers: readonly ShareReceiver[],
  options: { defaultSmsPackage?: string | null; max?: number } = {},
): ShareTargetChoice[] {
  const max = options.max ?? MAX_SHARE_TARGETS;
  const byPackage = new Map(receivers.map((r) => [r.packageName, r]));
  const used = new Set<string>();
  const picked: ShareTargetChoice[] = [];
  for (const id of order) {
    if (picked.length >= max) break;
    const app = SHARE_TARGET_APPS[id];
    const candidates =
      id === 'messages' && options.defaultSmsPackage
        ? [options.defaultSmsPackage, ...app.androidPackages]
        : app.androidPackages;
    const found = candidates.map((name) => byPackage.get(name)).find((r) => r !== undefined);
    if (!found || used.has(found.packageName)) continue;
    used.add(found.packageName);
    picked.push({
      id,
      packageName: found.packageName,
      label: found.label.trim() || app.name[getLocale()],
    });
  }
  return picked;
}
