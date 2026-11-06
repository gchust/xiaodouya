import { defaultShareDisplay, defaultSharePrefs, withLocale } from '@xiaodouya/shared';
import { describe, expect, it } from 'vitest';
import {
  nicknameProblem,
  shareDisplayShown,
  shareDisplaySummary,
  shareDisplayUnsupported,
  shareSettingsSub,
} from '../src/lib/share';

/** 分享设置（F-141）：设置行和弹层上的摘要、称呼的检查、旧服务端的提醒。名字都是虚构的。 */

describe('对方看到什么', () => {
  it('默认是显示名字、不带头像', () => {
    expect(shareDisplayShown(defaultShareDisplay)).toBe('显示名字');
    expect(shareDisplaySummary(defaultShareDisplay)).toBe('对方看到：显示名字');
  });

  it('称呼、隐藏、头像', () => {
    expect(shareDisplaySummary({ ...defaultShareDisplay, nickname: ' 小宝 ' })).toBe(
      '对方看到：显示为“小宝”',
    );
    expect(shareDisplaySummary({ showName: false, nickname: '小宝', showAvatar: true })).toBe(
      '对方看到：不显示名字 · 带头像',
    );
    withLocale('en', () => {
      expect(shareDisplaySummary({ ...defaultShareDisplay, nickname: 'Bean' })).toBe(
        'They see: Shown as "Bean"',
      );
    });
  });

  it('设置行的副标题写有效期和名字', () => {
    expect(shareSettingsSub(undefined)).toBe('有效期 7 天 · 显示名字');
    expect(
      shareSettingsSub({
        ...defaultSharePrefs,
        ttlDays: 30,
        display: { ...defaultShareDisplay, showName: false, showAvatar: true },
      }),
    ).toBe('有效期 30 天 · 不显示名字 · 带头像');
  });
});

describe('称呼', () => {
  it('留空、普通的小名都可以', () => {
    expect(nicknameProblem('')).toBeNull();
    expect(nicknameProblem('小宝')).toBeNull();
    expect(nicknameProblem('  小宝  ')).toBeNull();
  });

  it('太长或者换行时说明原因', () => {
    expect(nicknameProblem('豆'.repeat(21))).toBe('称呼最多 20 个字，只能写一行。');
    expect(nicknameProblem('小\n宝')).toBe('称呼最多 20 个字，只能写一行。');
  });
});

describe('旧服务端', () => {
  it('确定不支持、又改过默认值时提醒；支持或还不知道时不提醒', () => {
    const custom = { ...defaultShareDisplay, nickname: '小宝' };
    expect(shareDisplayUnsupported(custom, false)).toBe(true);
    expect(shareDisplayUnsupported(defaultShareDisplay, false)).toBe(false);
    expect(shareDisplayUnsupported(custom, true)).toBe(false);
    expect(shareDisplayUnsupported(custom, null)).toBe(false);
  });
});
