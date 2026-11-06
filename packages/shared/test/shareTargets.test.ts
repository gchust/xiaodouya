import { afterEach, describe, expect, it } from 'vitest';
import {
  MAX_SHARE_TARGETS,
  pickShareTargets,
  regionList,
  regions,
  SHARE_TARGET_APPS,
  type ShareReceiver,
  type ShareTargetId,
  setLocale,
} from '../src';

afterEach(() => setLocale('zh'));

const receiver = (packageName: string, label = packageName): ShareReceiver => ({
  packageName,
  label,
});
const ids = (list: readonly { id: ShareTargetId }[]) => list.map((target) => target.id);

describe('分享到常用 App：显示哪几个', () => {
  it('按地区的顺序，不按系统列出来的顺序；不在名单里的 App 不出现', () => {
    const installed = [
      receiver('com.android.chrome', 'Chrome'),
      receiver('com.whatsapp', 'WhatsApp'),
      receiver('com.tencent.mobileqq', 'QQ'),
      receiver('com.tencent.mm', '微信'),
    ];
    const picked = pickShareTargets(regions.CN.shareTargets, installed);
    expect(ids(picked)).toEqual(['wechat', 'qq', 'whatsapp']);
    expect(picked[0]).toEqual({ id: 'wechat', packageName: 'com.tencent.mm', label: '微信' });
  });

  it('一个都没装时是空的，界面只留“更多”和复制', () => {
    expect(pickShareTargets(regions.CN.shareTargets, [])).toEqual([]);
    expect(pickShareTargets(regions.OTHER.shareTargets, [receiver('com.android.chrome')])).toEqual(
      [],
    );
  });

  it(`最多 ${MAX_SHARE_TARGETS} 个，按顺序取前面的`, () => {
    const everything = Object.values(SHARE_TARGET_APPS).flatMap((app) =>
      app.androidPackages.map((name) => receiver(name)),
    );
    const picked = pickShareTargets(regions.OTHER.shareTargets, everything);
    expect(picked).toHaveLength(MAX_SHARE_TARGETS);
    expect(ids(picked)).toEqual(regions.OTHER.shareTargets.slice(0, MAX_SHARE_TARGETS));
  });

  it('小豆芽自己也收文字分享（F-143），但不在任何地区的名单里，不会出现在这一排', () => {
    const self = ['com.gchust.xiaodouya', 'com.gchust.xiaodouya.dev'];
    for (const app of Object.values(SHARE_TARGET_APPS)) {
      for (const name of self) expect(app.androidPackages).not.toContain(name);
    }
    for (const region of regionList) {
      const picked = pickShareTargets(
        region.shareTargets,
        self.map((name) => receiver(name)),
      );
      expect(picked).toEqual([]);
    }
  });

  it('同一个 App 的几个包只出现一次，用排在前面的那个', () => {
    const business = pickShareTargets(['whatsapp'], [receiver('com.whatsapp.w4b')]);
    expect(business).toEqual([
      { id: 'whatsapp', packageName: 'com.whatsapp.w4b', label: 'com.whatsapp.w4b' },
    ]);
    const both = pickShareTargets(
      ['whatsapp'],
      [receiver('com.whatsapp.w4b'), receiver('com.whatsapp')],
    );
    expect(both.map((target) => target.packageName)).toEqual(['com.whatsapp']);
  });

  it('短信用手机的默认短信 App；它收不了文字或没有默认时，退回常见的短信 App', () => {
    const installed = [
      receiver('com.google.android.apps.messaging', 'Messages'),
      receiver('com.example.sms', 'Carrier SMS'),
    ];
    expect(
      pickShareTargets(['messages'], installed, { defaultSmsPackage: 'com.example.sms' }),
    ).toEqual([{ id: 'messages', packageName: 'com.example.sms', label: 'Carrier SMS' }]);
    expect(
      pickShareTargets(['messages'], installed, { defaultSmsPackage: 'com.example.missing' }),
    ).toEqual([
      { id: 'messages', packageName: 'com.google.android.apps.messaging', label: 'Messages' },
    ]);
    expect(
      pickShareTargets(['messages'], installed, { defaultSmsPackage: null })[0]?.packageName,
    ).toBe('com.google.android.apps.messaging');
  });

  it('默认短信 App 恰好是名单里别的 App 时，不重复出现', () => {
    const installed = [receiver('com.whatsapp', 'WhatsApp')];
    const picked = pickShareTargets(['whatsapp', 'messages'], installed, {
      defaultSmsPackage: 'com.whatsapp',
    });
    expect(ids(picked)).toEqual(['whatsapp']);
  });

  it('系统给的名字是空的时候，用名单里的名字，跟着界面语言', () => {
    expect(pickShareTargets(['wechat'], [receiver('com.tencent.mm', '  ')])[0]?.label).toBe('微信');
    setLocale('en');
    expect(pickShareTargets(['wechat'], [receiver('com.tencent.mm', '')])[0]?.label).toBe('WeChat');
  });
});

describe('各地区的常用 App 名单', () => {
  it('每个地区都有名单，都在目录里，没有重复', () => {
    for (const region of regionList) {
      expect(region.shareTargets.length, region.id).toBeGreaterThan(0);
      expect(new Set(region.shareTargets).size, region.id).toBe(region.shareTargets.length);
      for (const id of region.shareTargets) expect(SHARE_TARGET_APPS[id], id).toBeDefined();
    }
  });

  it('中国大陆先微信再 QQ（issue #94）', () => {
    expect(regions.CN.shareTargets.slice(0, 2)).toEqual(['wechat', 'qq']);
  });

  it('新加坡先 WhatsApp，美国先短信', () => {
    expect(regions.SG.shareTargets[0]).toBe('whatsapp');
    expect(regions.US.shareTargets[0]).toBe('messages');
  });

  it('同一个包不会属于两个 App', () => {
    const all = Object.values(SHARE_TARGET_APPS).flatMap((app) => app.androidPackages);
    expect(new Set(all).size).toBe(all.length);
  });
});
