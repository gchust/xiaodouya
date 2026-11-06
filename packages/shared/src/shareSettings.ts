import { z } from 'zod';

/**
 * 分享设置（F-141，issue #96）。单独一个文件：`schemas.ts` 的 `Prefs` 要用它，
 * 而 `share.ts` 依赖 `schemas.ts`，放在那里会循环引用。
 */

export const SHARE_TTL_DAYS = [1, 7, 30] as const;
export type ShareTtlDays = (typeof SHARE_TTL_DAYS)[number];
export const DEFAULT_SHARE_TTL_DAYS: ShareTtlDays = 7;

export const ShareTtlDays = z.union(SHARE_TTL_DAYS.map((days) => z.literal(days)));

/** 分享时间线弹层默认选哪个范围。“自定义”要选日期，不能当默认。 */
export const shareTimelineDefaults = ['week', 'month', 'all'] as const;
export type ShareTimelineDefault = (typeof shareTimelineDefaults)[number];
export const DEFAULT_SHARE_TIMELINE: ShareTimelineDefault = 'month';

/** 称呼最长几个字。网页标题一行放得下，也足够写“小宝”“Bean”这样的小名。 */
export const SHARE_NICKNAME_MAX = 20;

// 控制字符和换行：称呼会出现在网页标题里，只该是一行普通文字。
const CONTROL = /[\p{Cc}\p{Zl}\p{Zp}]/u;

/**
 * 对方打开链接时看到的宝宝：名字显示不显示、换成什么称呼、带不带头像。
 * 创建链接时存进 `shares` 那一行，公开接口按那一行执行，之后改设置不影响已经发出去的链接。
 */
export const ShareDisplay = z.object({
  showName: z.boolean(),
  /** 空字符串是用真实名字。`showName` 为假时不用它。 */
  nickname: z
    .string()
    .trim()
    .max(SHARE_NICKNAME_MAX)
    .refine((value) => !CONTROL.test(value)),
  showAvatar: z.boolean(),
});
export type ShareDisplay = z.infer<typeof ShareDisplay>;

/**
 * 和这个功能之前的链接一模一样：显示真实名字，不带头像（以前的分享页从来没有头像）。
 * 旧版 App 建的链接在库里是空值，也按这个处理。
 */
export const defaultShareDisplay: ShareDisplay = {
  showName: true,
  nickname: '',
  showAvatar: false,
};

/**
 * 跟着账号走的分享默认值，存在 `Prefs.share`。每一项坏了只退回那一项的默认值，
 * 不让一项不认识的值把整份设置（包括称呼）清掉。
 */
export const SharePrefs = z.object({
  ttlDays: ShareTtlDays.catch(DEFAULT_SHARE_TTL_DAYS),
  timeline: z.enum(shareTimelineDefaults).catch(DEFAULT_SHARE_TIMELINE),
  display: ShareDisplay.catch(defaultShareDisplay),
});
export type SharePrefs = z.infer<typeof SharePrefs>;

export const defaultSharePrefs: SharePrefs = {
  ttlDays: DEFAULT_SHARE_TTL_DAYS,
  timeline: DEFAULT_SHARE_TIMELINE,
  display: defaultShareDisplay,
};

/** 没设置过（旧账号、旧服务端）时用默认值。 */
export function sharePrefsOf(stored: SharePrefs | undefined): SharePrefs {
  return stored ?? defaultSharePrefs;
}

/**
 * 公开页面上宝宝的名字。隐藏时是空字符串，页面换成“宝宝”/“your baby”（按看的人的语言）；
 * 有称呼时用称呼；都没有时是真实名字。服务端生成公开响应时用它，真实名字不出服务端。
 */
export function publicBabyName(realName: string, display: ShareDisplay): string {
  if (!display.showName) return '';
  return display.nickname.trim() || realName;
}

export function isDefaultShareDisplay(display: ShareDisplay): boolean {
  return (
    display.showName === defaultShareDisplay.showName &&
    display.nickname.trim() === defaultShareDisplay.nickname &&
    display.showAvatar === defaultShareDisplay.showAvatar
  );
}
