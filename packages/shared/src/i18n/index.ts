import { en } from './en';
import type { Locale } from './locale';
import { type Catalog, zh } from './zh';

export * from './locale';
export type { Catalog } from './zh';

const catalogs: Record<Locale, Catalog> = { zh, en };

/**
 * 当前语言是进程级的状态，只有 App 会改它（App 只有一个用户，换语言时整棵界面重新挂载）。
 * 服务端同时服务不同语言的人，绝不能调用 `setLocale`：要用 `messagesFor` 明确指定语言。
 * 不设置时是中文，这样服务端的推送文字和 v0.1.0 收到的一样。
 */
let current: Locale = 'zh';

export function setLocale(locale: Locale): void {
  current = locale;
}

export function getLocale(): Locale {
  return current;
}

/**
 * 当前语言的目录。必须在函数里调用，不能写在模块顶层：顶层的值在启动时算一次，
 * 那时还不知道语言，之后也不会变（`scripts/check-i18n.mjs` 会拦）。
 */
export function t(): Catalog {
  return catalogs[current];
}

export function messagesFor(locale: Locale): Catalog {
  return catalogs[locale];
}

/** 一段文字的两种语言。地区数据用它：疫苗名、备注这些是数据，跟着地区文件走，不放进目录。 */
export type Localized = Readonly<Record<Locale, string>>;

export function pick(text: Localized): string {
  return text[current];
}

/** 测试用：在指定语言下跑一段同步代码，结束后恢复。 */
export function withLocale<T>(locale: Locale, run: () => T): T {
  const previous = current;
  current = locale;
  try {
    return run();
  } finally {
    current = previous;
  }
}
