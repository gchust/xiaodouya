import { describe, expect, it } from 'vitest';
import {
  defaultPrefs,
  getLocale,
  localeFromAcceptLanguage,
  localeFromTag,
  messagesFor,
  Prefs,
  resolveLocale,
  setLocale,
  t,
  withLocale,
} from '../src';

describe('跟随系统', () => {
  it('zh 开头的都用中文，其他一律英文', () => {
    for (const tag of ['zh', 'zh-CN', 'zh-Hans-SG', 'zh-TW', 'zh-Hant', 'ZH-cn', 'zh_CN']) {
      expect(resolveLocale(undefined, tag)).toBe('zh');
    }
    for (const tag of ['en', 'en-US', 'fr-FR', 'ja-JP', 'de', 'zhx']) {
      expect(resolveLocale(undefined, tag)).toBe('en');
    }
  });

  it('读不到手机语言时用英文', () => {
    expect(resolveLocale(undefined, null)).toBe('en');
    expect(resolveLocale(undefined, undefined)).toBe('en');
    expect(resolveLocale(undefined, '')).toBe('en');
  });

  it('用户选过的优先于手机语言', () => {
    expect(resolveLocale('en', 'zh-CN')).toBe('en');
    expect(resolveLocale('zh', 'en-US')).toBe('zh');
  });

  it('E2E 构建没选过时固定中文，CI 模拟器是 en-US', () => {
    expect(resolveLocale(undefined, 'en-US', true)).toBe('zh');
    expect(resolveLocale('en', 'en-US', true)).toBe('en');
    expect(resolveLocale(undefined, 'en-US', false)).toBe('en');
  });
});

describe('Accept-Language', () => {
  it('取排在最前的语言', () => {
    expect(localeFromAcceptLanguage('en')).toBe('en');
    expect(localeFromAcceptLanguage('zh-CN,zh;q=0.9,en;q=0.8')).toBe('zh');
    expect(localeFromAcceptLanguage('fr-FR, zh;q=0.5')).toBe('en');
  });

  it('没有或读不出来时返回 null，不猜', () => {
    expect(localeFromAcceptLanguage(undefined)).toBeNull();
    expect(localeFromAcceptLanguage('')).toBeNull();
    expect(localeFromAcceptLanguage('*')).toBeNull();
  });

  it('localeFromTag 没有标签时返回 null', () => {
    expect(localeFromTag(null)).toBeNull();
  });
});

describe('Prefs.locale', () => {
  it('不认识的值只丢掉这一项，不让整份偏好校验失败', () => {
    const parsed = Prefs.parse({ ...defaultPrefs, locale: 'fr' });
    expect(parsed.locale).toBeUndefined();
    expect(parsed.feedReminder).toBe(defaultPrefs.feedReminder);
  });

  it('v0.1.0 的偏好没有这个字段，仍然能通过', () => {
    expect(Prefs.parse(defaultPrefs).locale).toBeUndefined();
  });

  it('认识的值原样保留', () => {
    expect(Prefs.parse({ ...defaultPrefs, locale: 'en' }).locale).toBe('en');
  });
});

describe('当前语言', () => {
  it('不设置时是中文，服务端的推送靠这个默认值', () => {
    expect(getLocale()).toBe('zh');
    expect(t().common.save).toBe('保存');
  });

  it('withLocale 结束后恢复，出错也恢复', () => {
    expect(withLocale('en', () => t().common.save)).toBe('Save');
    expect(() =>
      withLocale('en', () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(getLocale()).toBe('zh');
  });

  it('setLocale 改变 t()，messagesFor 不受影响', () => {
    setLocale('en');
    expect(t().common.save).toBe('Save');
    expect(messagesFor('zh').common.save).toBe('保存');
    setLocale('zh');
  });
});
