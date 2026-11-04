import { describe, expect, it } from 'vitest';
import {
  AppUpdateQuery,
  AppUpdateResponse,
  AUTO_DOWNLOAD_MAX_ATTEMPTS,
  autoAttemptsFor,
  autoDownloadBlocker,
  defaultAutoUpdatePrefs,
  exhaustAutoAttempts,
  isReleaseKey,
  parseDownloadedUpdate,
  ReleaseManifest,
  recordAutoAttempt,
  releaseNotesFor,
  shouldAutoCheckUpdate,
  shouldNotifyUpdate,
  UPDATE_CHECK_INTERVAL_MS,
  updateDecision,
} from '../src/appUpdate';

const manifest = (over: Partial<ReleaseManifest> = {}): ReleaseManifest => ({
  platform: 'android',
  versionCode: 120,
  versionName: '0.4.0',
  apk: {
    key: 'releases/android/xiaodouya-0.4.0-120.apk',
    size: 48_000_000,
    sha256: 'a'.repeat(64),
  },
  publishedAt: '2026-11-03T08:00:00.000Z',
  ...over,
});

describe('版本比较', () => {
  it('只按 versionCode 比，versionName 只是给人看的', () => {
    expect(updateDecision(manifest(), 119)).toEqual({ available: true, required: false });
    // 名字更“大”但号码一样：不是新版本。
    expect(updateDecision(manifest({ versionName: '9.9.9' }), 120).available).toBe(false);
    // 装的比清单还新（比如自己编的开发版）：不提示，更不能“降级”。
    expect(updateDecision(manifest(), 121)).toEqual({ available: false, required: false });
  });

  it('低于最低支持版本时必须更新，已经是最新时不算', () => {
    const m = manifest({ minSupportedVersionCode: 100 });
    expect(updateDecision(m, 99)).toEqual({ available: true, required: true });
    expect(updateDecision(m, 100)).toEqual({ available: true, required: false });
    // 清单写错（最低支持比最新还高）时，已经装了最新版的人不能被要求更新。
    expect(updateDecision(manifest({ minSupportedVersionCode: 200 }), 120)).toEqual({
      available: false,
      required: false,
    });
  });
});

describe('清单', () => {
  it('能读发布脚本写的格式，多出来的字段不影响', () => {
    const parsed = ReleaseManifest.safeParse({ ...manifest(), schema: 1, future: { x: 1 } });
    expect(parsed.success).toBe(true);
  });

  it('sha256 必须是 64 位小写十六进制，大小必须是正整数', () => {
    const bad = (apk: Partial<ReleaseManifest['apk']>) =>
      ReleaseManifest.safeParse(manifest({ apk: { ...manifest().apk, ...apk } })).success;
    expect(bad({ sha256: 'A'.repeat(64) })).toBe(false);
    expect(bad({ sha256: 'a'.repeat(63) })).toBe(false);
    expect(bad({ size: 0 })).toBe(false);
    expect(bad({ size: 1.5 })).toBe(false);
  });

  it('APK 只能在发布前缀下面，不能借清单签出别的对象', () => {
    const prefix = 'releases/android/';
    expect(isReleaseKey('releases/android/xiaodouya-0.4.0-120.apk', prefix)).toBe(true);
    expect(isReleaseKey('families/abc/original', prefix)).toBe(false);
    expect(isReleaseKey('releases/android/../../families/abc', prefix)).toBe(false);
    expect(isReleaseKey('releases/android/', prefix)).toBe(false);
    expect(isReleaseKey('releases/android/sub/x.apk', prefix)).toBe(false);
  });
});

describe('接口', () => {
  it('查询参数从字符串转成数字，乱填的拒绝', () => {
    expect(AppUpdateQuery.parse({ platform: 'android', versionCode: '57' })).toEqual({
      platform: 'android',
      versionCode: 57,
    });
    expect(AppUpdateQuery.safeParse({ platform: 'ios', versionCode: '1' }).success).toBe(false);
    expect(AppUpdateQuery.safeParse({ platform: 'android', versionCode: '-1' }).success).toBe(
      false,
    );
    expect(AppUpdateQuery.safeParse({ platform: 'android', versionCode: 'x' }).success).toBe(false);
  });

  it('App 收到的响应也要校验，链接和哈希不对就当没收到', () => {
    const update = {
      versionCode: 120,
      versionName: '0.4.0',
      size: 1000,
      sha256: 'b'.repeat(64),
      url: 'https://example.test/releases/android/x.apk?X-Amz-Signature=1',
      expiresIn: 900,
      required: false,
      notes: null,
    };
    expect(AppUpdateResponse.safeParse({ update }).success).toBe(true);
    expect(AppUpdateResponse.safeParse({ update: null }).success).toBe(true);
    expect(AppUpdateResponse.safeParse({ update: { ...update, sha256: 'zz' } }).success).toBe(
      false,
    );
    expect(AppUpdateResponse.safeParse({ update: { ...update, url: 'not a url' } }).success).toBe(
      false,
    );
  });
});

describe('什么时候自动检查', () => {
  const now = Date.parse('2026-11-03T08:00:00Z');
  it('没检查过就检查，一天以内不重复', () => {
    expect(shouldAutoCheckUpdate(null, now)).toBe(true);
    expect(shouldAutoCheckUpdate(now - 60_000, now)).toBe(false);
    expect(shouldAutoCheckUpdate(now - UPDATE_CHECK_INTERVAL_MS + 1, now)).toBe(false);
    expect(shouldAutoCheckUpdate(now - UPDATE_CHECK_INTERVAL_MS, now)).toBe(true);
  });

  it('记下的时间在未来（手机时钟被往回调过）时照样检查，不能一直卡住', () => {
    expect(shouldAutoCheckUpdate(now + 3 * UPDATE_CHECK_INTERVAL_MS, now)).toBe(true);
  });

  it('同一个版本只提示一次，必须更新的每次都提示', () => {
    expect(shouldNotifyUpdate({ versionCode: 120, required: false }, null)).toBe(true);
    expect(shouldNotifyUpdate({ versionCode: 120, required: false }, 120)).toBe(false);
    expect(shouldNotifyUpdate({ versionCode: 121, required: false }, 120)).toBe(true);
    expect(shouldNotifyUpdate({ versionCode: 120, required: true }, 120)).toBe(true);
  });
});

describe('发布说明', () => {
  it('按语言取，没有这种语言时用另一种，都没有时是 null', () => {
    expect(releaseNotesFor({ zh: '修了一些问题', en: 'Bug fixes' }, 'en')).toBe('Bug fixes');
    expect(releaseNotesFor({ zh: '修了一些问题' }, 'en')).toBe('修了一些问题');
    expect(releaseNotesFor({ en: 'Bug fixes' }, 'zh')).toBe('Bug fixes');
    expect(releaseNotesFor({ zh: '  ' }, 'zh')).toBe(null);
    expect(releaseNotesFor(undefined, 'zh')).toBe(null);
    expect(releaseNotesFor(null, 'zh')).toBe(null);
  });
});

describe('自动下载', () => {
  const on = { autoDownload: true, wifiOnly: true };
  const update = { versionCode: 120, sha256: 'b'.repeat(64) };

  it('默认关：用户自己打开才下载；打开后默认只在 Wi-Fi 下', () => {
    expect(defaultAutoUpdatePrefs).toEqual({ autoDownload: false, wifiOnly: true });
    expect(
      autoDownloadBlocker({ prefs: defaultAutoUpdatePrefs, network: 'wifi', attempts: 0 }),
    ).toBe('off');
    expect(autoDownloadBlocker({ prefs: on, network: 'wifi', attempts: 0 })).toBe(null);
  });

  it('只在 Wi-Fi 下时，移动数据不下；关掉这一项后移动数据也下；断网都不下', () => {
    expect(autoDownloadBlocker({ prefs: on, network: 'cellular', attempts: 0 })).toBe('needsWifi');
    const anyNetwork = { autoDownload: true, wifiOnly: false };
    expect(autoDownloadBlocker({ prefs: anyNetwork, network: 'cellular', attempts: 0 })).toBe(null);
    expect(autoDownloadBlocker({ prefs: anyNetwork, network: 'none', attempts: 0 })).toBe(
      'offline',
    );
    expect(autoDownloadBlocker({ prefs: on, network: 'none', attempts: 0 })).toBe('offline');
  });

  it('同一个版本自动下载的次数有上限，不无限重试', () => {
    const max = AUTO_DOWNLOAD_MAX_ATTEMPTS;
    expect(max).toBeGreaterThan(0);
    expect(autoDownloadBlocker({ prefs: on, network: 'wifi', attempts: max - 1 })).toBe(null);
    expect(autoDownloadBlocker({ prefs: on, network: 'wifi', attempts: max })).toBe('exhausted');
  });

  it('次数按版本和文件记：换了版本或者重新发布了文件就从头算', () => {
    let stored: string | null = null;
    expect(autoAttemptsFor(stored, update)).toBe(0);
    stored = recordAutoAttempt(stored, update);
    stored = recordAutoAttempt(stored, update);
    expect(autoAttemptsFor(stored, update)).toBe(2);
    expect(autoAttemptsFor(stored, { ...update, versionCode: 121 })).toBe(0);
    expect(autoAttemptsFor(stored, { ...update, sha256: 'c'.repeat(64) })).toBe(0);
    const other = recordAutoAttempt(stored, { ...update, versionCode: 121 });
    expect(autoAttemptsFor(other, { ...update, versionCode: 121 })).toBe(1);
    expect(autoAttemptsFor(other, update)).toBe(0);
    expect(autoAttemptsFor(exhaustAutoAttempts(update), update)).toBe(AUTO_DOWNLOAD_MAX_ATTEMPTS);
    // 存的内容坏了当成没试过：不能把自动下载永远挡住，也不能抛错。
    expect(autoAttemptsFor('garbage', update)).toBe(0);
    expect(autoAttemptsFor('', update)).toBe(0);
  });

  it('下好的版本记在本机，读回来先过校验，坏了当没有', () => {
    const saved = {
      versionCode: 120,
      versionName: '0.4.0',
      size: 1000,
      sha256: 'b'.repeat(64),
      required: false,
      notes: { zh: '修了一些问题' },
    };
    expect(parseDownloadedUpdate(JSON.stringify(saved))).toEqual(saved);
    expect(parseDownloadedUpdate(null)).toBe(null);
    expect(parseDownloadedUpdate('')).toBe(null);
    expect(parseDownloadedUpdate('{not json')).toBe(null);
    expect(parseDownloadedUpdate(JSON.stringify({ ...saved, sha256: 'nope' }))).toBe(null);
    // 签名链接不留：过期了也没用。
    expect(
      parseDownloadedUpdate(JSON.stringify({ ...saved, url: 'https://x.test/a?sig=1' })),
    ).not.toHaveProperty('url');
  });
});
