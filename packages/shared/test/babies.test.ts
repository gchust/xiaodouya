import { describe, expect, it } from 'vitest';
import {
  babyRefOf,
  type Collection,
  type CollectionData,
  defaultBaby,
  firstBabyId,
  isBabyScoped,
  MULTI_BABY_CLIENT_LEVEL,
  needsMultiBabyUpgrade,
  orderBabies,
  parseClientLevel,
  parseCollectionData,
  recordBabyId,
  settleBabyCreatedAt,
  shareBabyId,
  withBabyId,
} from '../src/index';

// 虚构的 id：家庭 id 也是第一个宝宝档案的 id（AuthScreens 的 BabySetup）。
const FAMILY = '11111111-1111-4111-8111-111111111111';
const SECOND = '22222222-2222-4222-8222-222222222222';
const THIRD = '33333333-3333-4333-8333-333333333333';
const OTHER_USER = '44444444-4444-4444-8444-444444444444';

const feed = { type: 'feed', at: 1000, ml: 90 } as const;

describe('第一个宝宝怎么选', () => {
  it('没有 createdAt 的档案（现有家庭建档时写的）排最前，不看 updatedAt', () => {
    const babies = [
      { id: SECOND, createdAt: 5000, updatedAt: 9000 },
      { id: FAMILY, updatedAt: 1 },
    ];
    expect(firstBabyId(babies)).toBe(FAMILY);
    expect(orderBabies(babies).map((b) => b.id)).toEqual([FAMILY, SECOND]);
  });

  it('都有 createdAt 时按它从小到大，相同时按 id，所有手机算出同一个结果', () => {
    expect(
      orderBabies([
        { id: THIRD, createdAt: 2000 },
        { id: SECOND, createdAt: 1000 },
        { id: FAMILY, createdAt: 2000 },
      ]).map((b) => b.id),
    ).toEqual([SECOND, FAMILY, THIRD]);
    // 输入顺序不影响结果。
    expect(firstBabyId([{ id: THIRD }, { id: SECOND }])).toBe(SECOND);
    expect(firstBabyId([{ id: SECOND }, { id: THIRD }])).toBe(SECOND);
  });

  it('删除的宝宝也参与排序：它的旧记录不能变成另一个宝宝的', () => {
    const babies = [
      { id: FAMILY, deleted: true },
      { id: SECOND, createdAt: 5000 },
    ];
    expect(firstBabyId(babies)).toBe(FAMILY);
    // 显示的是第一个没删除的。
    expect(defaultBaby(babies)?.id).toBe(SECOND);
  });

  it('没有宝宝时都是 null', () => {
    expect(firstBabyId([])).toBeNull();
    expect(defaultBaby([])).toBeNull();
    expect(defaultBaby([{ id: FAMILY, deleted: true }])).toBeNull();
  });

  it('从记录原文读 createdAt：格式不对算没有，删除标记里的也能读', () => {
    expect(babyRefOf(FAMILY, { name: '小豆', birthAt: 1 }, false)).toEqual({
      id: FAMILY,
      deleted: false,
    });
    expect(babyRefOf(SECOND, { createdAt: 5000 }, true)).toEqual({
      id: SECOND,
      createdAt: 5000,
      deleted: true,
    });
    for (const createdAt of ['5000', -1, 1.5, Number.NaN, null]) {
      expect(babyRefOf(SECOND, { createdAt }, false).createdAt).toBeUndefined();
    }
    expect(babyRefOf(SECOND, null, true)).toEqual({ id: SECOND, deleted: true });
  });

  it('档案的 createdAt 格式不对只丢这一项，档案照样能读', () => {
    const baby = parseCollectionData('baby', { name: '小豆', birthAt: 1, createdAt: 'x' });
    expect(baby).not.toBeNull();
    expect(baby?.createdAt).toBeUndefined();
    expect(parseCollectionData('baby', { name: '小豆', birthAt: 1, createdAt: 5 })?.createdAt).toBe(
      5,
    );
  });
});

describe('记录属于哪个宝宝', () => {
  const babyScoped: [Collection, Record<string, unknown>][] = [
    ['event', feed],
    ['event', { type: 'diaper', at: 1, kind: 'wee' }],
    ['event', { type: 'vaccine', at: 1, vaccineId: 'sg:bcg', name: '卡介苗' }],
    ['event', { type: 'vaccine-plan', vaccineId: 'sg:bcg', hidden: true }],
    ['event', { type: 'money', flow: 'in', amountMinor: 100, currency: 'SGD', happenedAt: 1 }],
    ['moment', { title: '', text: '', at: 1, milestone: false, media: [] }],
    ['letter', { title: '', text: '给宝宝', at: 1 }],
    ['document', { name: '出生证明', files: [] }],
  ];
  const familyLevel: [Collection, Record<string, unknown>][] = [
    ['baby', { name: '小豆', birthAt: 1 }],
    ['event', { type: 'formula', name: '虚构奶粉', basis: 'per100ml', values: { energyKcal: 67 } }],
    ['event', { type: 'resource', url: 'https://example.com/a', title: '虚构文章', addedAt: 1 }],
    ['event', { type: 'favorite', target: 'moment', targetId: SECOND, addedAt: 1 }],
    ['event', { type: 'favorite-folder', name: '辅食', createdAt: 1 }],
    ['document', { name: '护照', files: [], owner: OTHER_USER }],
  ];

  it('照护记录、疫苗配置、小金库、回忆、信、宝宝的证件属于宝宝', () => {
    for (const [collection, data] of babyScoped) {
      expect(parseCollectionData(collection, data), JSON.stringify(data)).not.toBeNull();
      expect(isBabyScoped(collection, data), JSON.stringify(data)).toBe(true);
    }
  });

  it('档案、奶粉、育儿资料、收藏、收藏夹、家人自己的证件不属于哪个宝宝', () => {
    for (const [collection, data] of familyLevel) {
      expect(parseCollectionData(collection, data), JSON.stringify(data)).not.toBeNull();
      expect(isBabyScoped(collection, data), JSON.stringify(data)).toBe(false);
      expect(recordBabyId(collection, { ...data, babyId: SECOND }, FAMILY)).toBeNull();
    }
  });

  it('没有 babyId 的记录属于第一个宝宝，有的属于它写的那个', () => {
    for (const [collection, data] of babyScoped) {
      expect(recordBabyId(collection, data, FAMILY)).toBe(FAMILY);
      const parsed = parseCollectionData(collection, { ...data, babyId: SECOND });
      expect(parsed, JSON.stringify(data)).not.toBeNull();
      expect(recordBabyId(collection, parsed, FAMILY)).toBe(SECOND);
    }
  });

  it('babyId 指向本机还没有的宝宝（还没同步到）时仍算那个宝宝的，不回落', () => {
    expect(recordBabyId('event', { ...feed, babyId: THIRD }, FAMILY)).toBe(THIRD);
  });

  it('还没有宝宝时，没有 babyId 的记录不属于谁', () => {
    expect(recordBabyId('event', feed, null)).toBeNull();
  });

  it('babyId 格式不对只丢这一项：记录照样显示，回落到第一个宝宝', () => {
    for (const [collection, data] of babyScoped) {
      const parsed = parseCollectionData(collection, { ...data, babyId: 'not-a-uuid' });
      expect(parsed, JSON.stringify(data)).not.toBeNull();
      expect(recordBabyId(collection, parsed, FAMILY)).toBe(FAMILY);
    }
  });
});

describe('新记录写上 babyId', () => {
  it('属于宝宝的记录盖上当前宝宝', () => {
    expect(withBabyId('event', feed, FAMILY)).toEqual({ ...feed, babyId: FAMILY });
    const doc: CollectionData['document'] = { name: '出生证明', files: [] };
    expect(withBabyId('document', doc, FAMILY)).toEqual({ ...doc, babyId: FAMILY });
  });

  it('已经有 babyId 的不改', () => {
    expect(withBabyId('event', { ...feed, babyId: SECOND }, FAMILY)).toEqual({
      ...feed,
      babyId: SECOND,
    });
  });

  it('全家共用和家人自己的不盖；还没有宝宝时不盖', () => {
    const formula: CollectionData['event'] = {
      type: 'formula',
      name: '虚构奶粉',
      basis: 'per100ml',
      values: {},
    };
    expect(withBabyId('event', formula, FAMILY)).toBe(formula);
    const personal: CollectionData['document'] = { name: '护照', files: [], owner: OTHER_USER };
    expect(withBabyId('document', personal, FAMILY)).toBe(personal);
    const baby: CollectionData['baby'] = { name: '小豆', birthAt: 1 };
    expect(withBabyId('baby', baby, FAMILY)).toBe(baby);
    expect(withBabyId('event', feed, undefined)).toBe(feed);
  });
});

describe('有第二个宝宝后挡住旧版 App（issue #106 第二步）', () => {
  it('请求头里的级别：没有、不是非负整数的都算 0', () => {
    expect(parseClientLevel(undefined)).toBe(0);
    expect(parseClientLevel(null)).toBe(0);
    expect(parseClientLevel('')).toBe(0);
    expect(parseClientLevel('abc')).toBe(0);
    expect(parseClientLevel('-1')).toBe(0);
    expect(parseClientLevel('1.5')).toBe(0);
    expect(parseClientLevel('1e3')).toBe(0);
    expect(parseClientLevel('1')).toBe(1);
    expect(parseClientLevel(' 2 ')).toBe(2);
  });

  it('只有一份档案时谁都不挡；加过宝宝后（删除的也算）挡住不按宝宝过滤的版本', () => {
    const first = { id: FAMILY };
    const added = { id: SECOND, createdAt: 5000 };
    expect(needsMultiBabyUpgrade(0, [])).toBe(false);
    expect(needsMultiBabyUpgrade(0, [first])).toBe(false);
    expect(needsMultiBabyUpgrade(0, [first, added])).toBe(true);
    expect(needsMultiBabyUpgrade(0, [first, { ...added, deleted: true }])).toBe(true);
    expect(needsMultiBabyUpgrade(MULTI_BABY_CLIENT_LEVEL - 1, [first, added])).toBe(true);
    expect(needsMultiBabyUpgrade(MULTI_BABY_CLIENT_LEVEL, [first, added])).toBe(false);
    expect(needsMultiBabyUpgrade(MULTI_BABY_CLIENT_LEVEL + 1, [first, added])).toBe(false);
  });

  it('v0.1.0 之前两台手机各建了一份档案（都没有 createdAt）的家庭不挡：那时没有能加宝宝的版本', () => {
    expect(needsMultiBabyUpgrade(0, [{ id: FAMILY }, { id: SECOND }])).toBe(false);
  });
});

describe('服务端收到档案时的 createdAt（只在建档时定一次）', () => {
  const empty = { familyHasBaby: false, isFamilyProfile: false };
  const another = { familyHasBaby: true, isFamilyProfile: false };
  it('家庭的第一份档案不用写；已经有档案时，新档案没有 createdAt 就拒绝', () => {
    expect(settleBabyCreatedAt(undefined, undefined, empty)).toEqual({ createdAt: undefined });
    expect(settleBabyCreatedAt(undefined, 5000, empty)).toEqual({ createdAt: 5000 });
    expect(settleBabyCreatedAt(undefined, undefined, another)).toBeNull();
    expect(settleBabyCreatedAt(undefined, 5000, another)).toEqual({ createdAt: 5000 });
  });

  it('建档页的档案（家庭 id）比后加的宝宝晚传上来也收', () => {
    expect(
      settleBabyCreatedAt(undefined, undefined, { familyHasBaby: true, isFamilyProfile: true }),
    ).toEqual({ createdAt: undefined });
  });

  it('改已有的档案时 createdAt 一直是库里的：旧版改丢了补回去，谁也改不了', () => {
    // 后加的宝宝被 v0.1.0 改了一下，丢了 createdAt：不能和第一个宝宝并列。
    expect(settleBabyCreatedAt({ id: SECOND, createdAt: 5000 }, undefined, another)).toEqual({
      createdAt: 5000,
    });
    expect(settleBabyCreatedAt({ id: SECOND, createdAt: 5000 }, 1, another)).toEqual({
      createdAt: 5000,
    });
    // 第一个宝宝写上一个时间，就可能排到后加的宝宝后面，旧记录全换主人。
    expect(settleBabyCreatedAt({ id: FAMILY }, 9000, another)).toEqual({ createdAt: undefined });
    expect(settleBabyCreatedAt({ id: FAMILY }, undefined, another)).toEqual({
      createdAt: undefined,
    });
  });
});

describe('分享链接属于哪个宝宝', () => {
  it('创建时选了就是那个；没选（旧版 App 建的）是界面上显示的宝宝', () => {
    const babies = [{ id: SECOND, createdAt: 5000 }, { id: FAMILY }];
    expect(shareBabyId(babies, THIRD)).toBe(THIRD);
    expect(shareBabyId(babies, null)).toBe(FAMILY);
    const firstDeleted = [
      { id: FAMILY, deleted: true },
      { id: SECOND, createdAt: 5000 },
    ];
    expect(shareBabyId(firstDeleted, null)).toBe(SECOND);
  });

  it('档案全删了还是第一个宝宝，旧链接照样能看到记录；还没有档案时是 null', () => {
    expect(shareBabyId([{ id: FAMILY, deleted: true }], null)).toBe(FAMILY);
    expect(shareBabyId([], null)).toBeNull();
  });
});
