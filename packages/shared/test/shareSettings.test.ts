import { describe, expect, it } from 'vitest';
import { t, withLocale } from '../src/i18n';
import { Prefs } from '../src/schemas';
import {
  CreateMomentsShareRequest,
  CreateShareRequest,
  CreateTimelineShareRequest,
  PublicShareResponse,
  PublicTimelineResponse,
} from '../src/share';
import {
  DEFAULT_SHARE_TTL_DAYS,
  defaultShareDisplay,
  defaultSharePrefs,
  isDefaultShareDisplay,
  publicBabyName,
  SHARE_NICKNAME_MAX,
  ShareDisplay,
  SharePrefs,
  sharePrefsOf,
} from '../src/shareSettings';

/** 分享设置（F-141，issue #96）。名字都是虚构的。 */

const REAL = '测试豆';

describe('公开页面上的名字', () => {
  it('默认和以前一样：真实名字', () => {
    expect(publicBabyName(REAL, defaultShareDisplay)).toBe(REAL);
  });

  it('有称呼时用称呼，前后空格不算', () => {
    expect(publicBabyName(REAL, { ...defaultShareDisplay, nickname: '小宝' })).toBe('小宝');
    expect(publicBabyName(REAL, { ...defaultShareDisplay, nickname: '  小宝 ' })).toBe('小宝');
    expect(publicBabyName(REAL, { ...defaultShareDisplay, nickname: '   ' })).toBe(REAL);
  });

  it('不显示名字时是空字符串，称呼也不用', () => {
    expect(publicBabyName(REAL, { ...defaultShareDisplay, showName: false })).toBe('');
    expect(
      publicBabyName(REAL, { ...defaultShareDisplay, showName: false, nickname: '小宝' }),
    ).toBe('');
  });
});

describe('设置的格式', () => {
  it('称呼去掉前后空格，最多 SHARE_NICKNAME_MAX 个字', () => {
    expect(ShareDisplay.parse({ ...defaultShareDisplay, nickname: ' 小宝 ' }).nickname).toBe(
      '小宝',
    );
    const max = '豆'.repeat(SHARE_NICKNAME_MAX);
    expect(ShareDisplay.safeParse({ ...defaultShareDisplay, nickname: max }).success).toBe(true);
    expect(ShareDisplay.safeParse({ ...defaultShareDisplay, nickname: `${max}豆` }).success).toBe(
      false,
    );
  });

  it('称呼只能是一行普通文字', () => {
    for (const nickname of ['小\n宝', '小\u0000宝', '小 宝', '小\t宝']) {
      expect(ShareDisplay.safeParse({ ...defaultShareDisplay, nickname }).success).toBe(false);
    }
  });

  it('默认值是不带头像、显示真实名字', () => {
    expect(defaultShareDisplay).toEqual({ showName: true, nickname: '', showAvatar: false });
    expect(isDefaultShareDisplay(defaultShareDisplay)).toBe(true);
    expect(isDefaultShareDisplay({ ...defaultShareDisplay, nickname: ' ' })).toBe(true);
    expect(isDefaultShareDisplay({ ...defaultShareDisplay, nickname: '小宝' })).toBe(false);
    expect(isDefaultShareDisplay({ ...defaultShareDisplay, showAvatar: true })).toBe(false);
    expect(isDefaultShareDisplay({ ...defaultShareDisplay, showName: false })).toBe(false);
  });
});

describe('跟着账号的默认值', () => {
  it('没设置过时用默认值：有效期 7 天、时间线 30 天', () => {
    expect(sharePrefsOf(undefined)).toEqual(defaultSharePrefs);
    expect(defaultSharePrefs.ttlDays).toBe(DEFAULT_SHARE_TTL_DAYS);
    expect(defaultSharePrefs.timeline).toBe('month');
  });

  it('一项坏了只退回那一项，称呼留着', () => {
    const parsed = SharePrefs.parse({
      ttlDays: 3,
      timeline: 'custom',
      display: { showName: true, nickname: '小宝', showAvatar: true },
    });
    expect(parsed).toEqual({
      ttlDays: DEFAULT_SHARE_TTL_DAYS,
      timeline: 'month',
      display: { showName: true, nickname: '小宝', showAvatar: true },
    });
  });

  it('偏好里的 share 坏了只丢这一项，别的偏好不受影响', () => {
    const base = {
      feedReminder: false,
      familyNotify: true,
      quietNight: true,
      timezone: 'Asia/Singapore',
      documentLock: false,
      videoWifiOnly: true,
    };
    expect(Prefs.parse({ ...base, share: 'x' })).toEqual(base);
    expect(Prefs.parse({ ...base, share: { ttlDays: 30, timeline: 'all' } }).share).toEqual({
      ttlDays: 30,
      timeline: 'all',
      display: defaultShareDisplay,
    });
  });
});

describe('创建链接的请求', () => {
  const day = {
    fromAt: Date.UTC(2026, 5, 14, 16),
    toAt: Date.UTC(2026, 5, 15, 16),
    timezone: 'Asia/Singapore',
    units: { volume: 'ml', temperature: 'c', weight: 'kg', length: 'cm' },
  } as const;
  const display = { showName: true, nickname: '小宝', showAvatar: true };

  it('三种链接都收 display，旧版 App 不带时也能建', () => {
    expect(CreateShareRequest.parse({ ...day, display }).display).toEqual(display);
    expect(CreateShareRequest.parse(day).display).toBeUndefined();
    expect(CreateTimelineShareRequest.parse({ ...day, display }).display).toEqual(display);
    expect(
      CreateMomentsShareRequest.parse({
        ...day,
        momentIds: ['00000000-0000-4000-8000-000000000001'],
        display,
      }).display,
    ).toEqual(display);
  });

  it('称呼不合规时整个请求不收', () => {
    const bad = { ...display, nickname: '豆'.repeat(SHARE_NICKNAME_MAX + 1) };
    expect(CreateShareRequest.safeParse({ ...day, display: bad }).success).toBe(false);
    expect(CreateTimelineShareRequest.safeParse({ ...day, display: bad }).success).toBe(false);
  });
});

describe('公开的回答', () => {
  it('头像链接可有可无：旧服务端的回答新页面也能读', () => {
    const day = {
      baby: { name: '', dayNumber: 3, age: null },
      range: { fromAt: 0, toAt: 1, timezone: 'UTC' },
      units: { volume: 'ml', temperature: 'c', weight: 'kg', length: 'cm' },
      events: [],
      moments: [],
      omittedMedia: 0,
      mediaExpiresIn: 3600,
    };
    expect(PublicShareResponse.safeParse(day).success).toBe(true);
    const withAvatar = { ...day, baby: { ...day.baby, avatarUrl: 'https://s3.example/a' } };
    expect(PublicShareResponse.parse(withAvatar).baby.avatarUrl).toBe('https://s3.example/a');
    const timeline = {
      kind: 'timeline',
      baby: { name: '小宝', age: null, avatarUrl: null },
      range: { fromAt: 0, toAt: 1, timezone: 'UTC' },
      entries: [],
      nextCursor: null,
      mediaExpiresIn: 3600,
    };
    expect(PublicTimelineResponse.safeParse(timeline).success).toBe(true);
  });
});

describe('文案', () => {
  it('两种语言都有设置行的摘要', () => {
    expect(t().share.settingsRowSub(7, t().share.shownAs('小宝'), false)).toBe(
      '有效期 7 天 · 显示为“小宝”',
    );
    withLocale('en', () => {
      expect(t().share.settingsRowSub(1, t().share.shownHidden, true)).toBe(
        'Expires in 1 day · Name hidden · with photo',
      );
    });
  });
});
