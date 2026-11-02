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

/**
 * 一段内容的两种语言。地区和预置数据用它：疫苗名、备注这些跟着数据文件走，不放进目录，
 * 新增地区只加一个文件。
 */
export class Localized<T = string> {
  constructor(
    readonly zh: T,
    readonly en: T,
  ) {}
}

export function L<T = string>(zh: T, en: T): Localized<T> {
  return new Localized(zh, en);
}

type Resolved<T> = {
  [K in keyof T]: [NonNullable<T[K]>] extends [never]
    ? T[K]
    : NonNullable<T[K]> extends Localized<infer V>
      ? V | Extract<T[K], undefined>
      : T[K];
};

/**
 * 把 `Localized` 字段变成跟随当前语言的属性。数据文件在模块加载时就求值，
 * 那时还不知道语言，所以不能直接存成字符串。
 */
export function localized<T extends object>(source: T): Resolved<T> {
  const out = {} as Resolved<T>;
  for (const key of Object.keys(source) as (keyof T)[]) {
    const value = source[key];
    Object.defineProperty(
      out,
      key,
      value instanceof Localized
        ? { enumerable: true, get: () => value[current] }
        : { enumerable: true, value },
    );
  }
  return out;
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
