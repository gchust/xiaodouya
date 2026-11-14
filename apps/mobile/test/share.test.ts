import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  canShare,
  shareBabyField,
  shareBabyName,
  shareDayPending,
  shareDayRange,
  shareLinkUrl,
} from '../src/lib/share';

const HOUR = 3_600_000;
const originalTz = process.env.TZ;

afterEach(() => {
  process.env.TZ = originalTz;
  vi.unstubAllEnvs();
  vi.resetModules();
});

function inZone<T>(zone: string, run: () => T): T {
  process.env.TZ = zone;
  return run();
}

describe('这一天的范围', () => {
  it('新加坡：当地 0 点到次日 0 点，正好 24 小时', () => {
    inZone('Asia/Singapore', () => {
      const range = shareDayRange(Date.UTC(2026, 5, 15, 4));
      expect(range.fromAt).toBe(Date.UTC(2026, 5, 14, 16));
      expect(range.toAt).toBe(Date.UTC(2026, 5, 15, 16));
    });
  });

  it('同一个时刻在不同时区是不同的一天', () => {
    const at = Date.UTC(2026, 5, 14, 17, 30);
    const sg = inZone('Asia/Singapore', () => shareDayRange(at));
    const ny = inZone('America/New_York', () => shareDayRange(at));
    expect(sg.fromAt).toBe(Date.UTC(2026, 5, 14, 16));
    expect(ny.fromAt).toBe(Date.UTC(2026, 5, 14, 4));
    expect(sg.fromAt).not.toBe(ny.fromAt);
  });

  it('夏令时开始那天是 23 小时', () => {
    inZone('America/New_York', () => {
      const range = shareDayRange(new Date(2026, 2, 8, 12).getTime());
      expect(range.toAt - range.fromAt).toBe(23 * HOUR);
      expect(new Date(range.fromAt).getDate()).toBe(8);
      expect(new Date(range.toAt).getDate()).toBe(9);
    });
  });

  it('夏令时结束那天是 25 小时，服务端的上限刚好放得下', () => {
    inZone('America/New_York', () => {
      const range = shareDayRange(new Date(2026, 10, 1, 12).getTime());
      expect(range.toAt - range.fromAt).toBe(25 * HOUR);
    });
  });

  it('一天的任何时刻都落在同一个范围里', () => {
    inZone('Asia/Singapore', () => {
      const start = new Date(2026, 5, 15, 0, 0, 0, 0).getTime();
      const end = new Date(2026, 5, 15, 23, 59, 59, 999).getTime();
      expect(shareDayRange(start)).toEqual(shareDayRange(end));
    });
  });
});

describe('什么时候有分享入口', () => {
  const base = {
    baseUrl: 'https://share.fictional.test',
    serverUrl: 'https://api.fictional.test',
    defaultServerUrl: 'https://api.fictional.test',
    role: 'caregiver' as const,
  };

  it('构建时配了地址，管理员和一起记录的家人有', () => {
    expect(canShare(base)).toBe(true);
    expect(canShare({ ...base, role: 'admin' })).toBe(true);
  });

  it('没有配置时不显示', () => {
    expect(canShare({ ...base, baseUrl: null })).toBe(false);
    expect(canShare({ ...base, baseUrl: '' })).toBe(false);
    expect(canShare({ ...base, baseUrl: '   ' })).toBe(false);
  });

  it('只看回忆的家人和没有家庭的人没有', () => {
    expect(canShare({ ...base, role: 'viewer' })).toBe(false);
    expect(canShare({ ...base, role: null })).toBe(false);
  });

  it('登录页换成自己的服务器时没有：分享页只连构建时的 API，链接打不开', () => {
    expect(canShare({ ...base, serverUrl: 'https://my-own.fictional.test' })).toBe(false);
    expect(canShare({ ...base, serverUrl: 'https://api.fictional.test/' })).toBe(true);
  });

  it('构建变量没有设置或是空的，读出来都是没有配置', async () => {
    vi.stubEnv('EXPO_PUBLIC_SHARE_BASE_URL', '');
    expect((await import('../src/lib/config')).SHARE_BASE_URL).toBeNull();
    vi.resetModules();
    vi.stubEnv('EXPO_PUBLIC_SHARE_BASE_URL', 'https://share.fictional.test');
    expect((await import('../src/lib/config')).SHARE_BASE_URL).toBe('https://share.fictional.test');
  });
});

describe('链接', () => {
  const token = 'A'.repeat(43);

  it('令牌在片段里，地址结尾有没有斜杠都一样', () => {
    expect(shareLinkUrl('https://share.fictional.test', token)).toBe(
      `https://share.fictional.test/#${token}`,
    );
    expect(shareLinkUrl('https://share.fictional.test/', token)).toBe(
      `https://share.fictional.test/#${token}`,
    );
    expect(shareLinkUrl('https://fictional.test/share', token)).toBe(
      `https://fictional.test/share/#${token}`,
    );
  });
});

describe('现在打开页面还缺什么', () => {
  const range = { fromAt: 1000, toAt: 2000 };
  const event = (at: number, type: string, dirty: boolean) => ({
    id: `${at}`,
    data: { type, at, ml: 1, kind: 'wee', celsius: 37 } as never,
    updatedAt: 0,
    dirty,
  });
  const moment = (at: number, ids: string[], dirty = false) => ({
    id: `${at}`,
    data: {
      at,
      title: '',
      text: '',
      milestone: false,
      media: ids.map((id) => ({ id, kind: 'image' as const, mime: 'image/jpeg', size: 1 })),
    },
    updatedAt: 0,
    dirty,
  });

  it('只算这一天、选中的内容里没同步的记录和没传完的文件', () => {
    const result = shareDayPending(
      {
        events: [
          event(1500, 'feed', true),
          event(1600, 'feed', false),
          event(500, 'feed', true), // 别的日子
          event(1700, 'temp', true), // 健康记录没选
        ],
        moments: [moment(1800, ['a', 'b'], true), moment(2500, ['c'], true)],
      },
      range,
      { moments: true, daily: true, health: false },
      new Set(['a', 'c']),
    );
    expect(result).toEqual({ records: 2, files: 1 });
  });

  it('回忆没选时，文件和回忆都不算', () => {
    expect(
      shareDayPending(
        { events: [], moments: [moment(1800, ['a'], true)] },
        range,
        { moments: false, daily: true, health: true },
        new Set(['a']),
      ),
    ).toEqual({ records: 0, files: 0 });
  });
});

describe('链接属于哪个宝宝（issue #106）', () => {
  const baby = { id: '22222222-2222-4222-8222-222222222222' };
  it('只有一个宝宝时不带，请求和以前一样', () => {
    expect(shareBabyField({ multiBaby: false, baby })).toEqual({});
  });
  it('有几个宝宝时是当前宝宝', () => {
    expect(shareBabyField({ multiBaby: true, baby })).toEqual({ babyId: baby.id });
    expect(shareBabyField({ multiBaby: true, baby: null })).toEqual({});
  });
});

describe('已分享的链接写明是哪个宝宝的（issue #106）', () => {
  const babies = [
    { id: '11111111-1111-4111-8111-111111111111', data: { name: '大宝' } },
    { id: '22222222-2222-4222-8222-222222222222', data: { name: '二宝' } },
  ];
  it('只有一个宝宝时不写', () => {
    expect(shareBabyName({ babyId: babies[0]!.id }, { multiBaby: false, babies })).toBeNull();
  });
  it('有几个宝宝时写链接的宝宝；旧版 App 建的（没有 babyId）是第一个宝宝', () => {
    expect(shareBabyName({ babyId: babies[1]!.id }, { multiBaby: true, babies })).toBe('二宝');
    expect(shareBabyName({}, { multiBaby: true, babies })).toBe('大宝');
    expect(
      shareBabyName(
        { babyId: '33333333-3333-4333-8333-333333333333' },
        { multiBaby: true, babies },
      ),
    ).toBeNull();
  });
});
