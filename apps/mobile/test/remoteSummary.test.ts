import { metricUnits, type ServerRecord } from '@xiaodouya/shared';
import { describe, expect, it } from 'vitest';
import { summarizeRemote } from '../src/lib/remoteSummary';

const NOW = 1_800_000_000_000;
const SELF = 'self';
const MOM = 'mom';
const GRANDMA = 'grandma';
const members = [
  { userId: SELF, label: '爸爸' },
  { userId: MOM, label: '妈妈' },
  { userId: GRANDMA, label: '外婆' },
];

let seq = 0;
function record(
  createdBy: string | null,
  data: Record<string, unknown>,
  overrides: Partial<ServerRecord> = {},
): ServerRecord {
  seq += 1;
  return {
    id: `id-${seq}`,
    collection: 'event',
    data,
    deleted: false,
    updatedAt: NOW,
    seq,
    createdBy,
    ...overrides,
  } as ServerRecord;
}
const feed = (ml: number, at = NOW) => ({ type: 'feed', at, ml });
const summarize = (records: ServerRecord[]) =>
  summarizeRemote(records, { selfId: SELF, members, units: metricUnits, now: NOW });

describe('打开 App 时汇总家人的记录', () => {
  it('只有一条时直接说是什么', () => {
    expect(summarize([record(MOM, feed(75))])).toEqual({
      initial: '妈',
      message: '妈妈 记录了 喂奶 75ml',
    });
  });

  it('一个人记了几条：说条数和最近一条', () => {
    expect(
      summarize([record(MOM, feed(60, NOW - 7_200_000)), record(MOM, feed(120, NOW - 60_000))]),
    ).toEqual({ initial: '妈', message: '妈妈 记了 2 条，最近是 喂奶 120ml' });
  });

  it('几个人都记了：不能算到一个人头上，要说清最近一条是谁记的', () => {
    expect(
      summarize([
        record(MOM, feed(60, NOW - 7_200_000)),
        record(GRANDMA, feed(90, NOW - 60_000)),
        record(MOM, feed(75, NOW - 3_600_000)),
      ]),
    ).toEqual({ initial: '家', message: '家人记了 3 条，最近是 外婆 · 喂奶 90ml' });
  });

  it('最近一条按发生时间算，不按同步顺序：补记的旧记录不能当成最新', () => {
    expect(
      summarize([record(MOM, feed(120, NOW - 60_000)), record(MOM, feed(60, NOW - 86_400_000))])
        ?.message,
    ).toBe('妈妈 记了 2 条，最近是 喂奶 120ml');
  });

  it('离开很久回来也要提示：不能只看最近 1 小时', () => {
    expect(summarize([record(MOM, feed(75, NOW - 3 * 86_400_000))])?.message).toBe(
      '妈妈 记录了 喂奶 75ml',
    );
  });

  it('自己在另一台手机上记的不算', () => {
    expect(summarize([record(SELF, feed(75))])).toBeNull();
    expect(summarize([record(SELF, feed(75)), record(MOM, feed(90))])?.message).toBe(
      '妈妈 记录了 喂奶 90ml',
    );
  });

  it('删除的不算，宝宝资料和证件这类不是记录的也不算', () => {
    expect(summarize([record(MOM, feed(75), { deleted: true })])).toBeNull();
    expect(summarize([record(MOM, { name: 'x' }, { collection: 'baby' })])).toBeNull();
    expect(summarize([record(MOM, { name: 'x' }, { collection: 'document' })])).toBeNull();
  });

  it('回忆显示标题，没有标题时有默认说法', () => {
    expect(
      summarize([record(MOM, { at: NOW, title: '第一次笑' }, { collection: 'moment' })])?.message,
    ).toBe('妈妈 记录了 第一次笑');
    expect(summarize([record(MOM, { at: NOW }, { collection: 'moment' })])?.message).toBe(
      '妈妈 记录了 新的一刻',
    );
  });

  it('数量按看的人自己的单位显示', () => {
    expect(
      summarizeRemote([record(MOM, feed(120))], {
        selfId: SELF,
        members,
        units: { ...metricUnits, volume: 'oz' },
        now: NOW,
      })?.message,
    ).toBe('妈妈 记录了 喂奶 4.1oz');
  });

  it('已经离开家庭的人：用记录里的署名，再没有就说家人', () => {
    expect(summarize([record('gone', { ...feed(75), byName: '阿姨' })])?.message).toBe(
      '阿姨 记录了 喂奶 75ml',
    );
    expect(summarize([record(null, feed(75))])).toEqual({
      initial: '家',
      message: '家人 记录了 喂奶 75ml',
    });
  });

  it('两个都不在成员名单里的人不能被当成同一个人', () => {
    expect(
      summarize([
        record('gone-1', { ...feed(60, NOW - 60_000), byName: '阿姨' }),
        record('gone-2', { ...feed(90), byName: '奶奶' }),
      ])?.message,
    ).toBe('家人记了 2 条，最近是 奶奶 · 喂奶 90ml');
  });
});

describe('event 集合里不是记录的内容', () => {
  const plan = { type: 'vaccine-plan', vaccineId: 'sg:bcg', hidden: true };

  it('家人改疫苗本的配置，不提示“记录了 undefined”', () => {
    expect(summarize([record(MOM, plan)])).toBeNull();
  });

  it('家人配置奶粉同样不提示', () => {
    const formula = { type: 'formula', name: '虚构奶粉', basis: 'per100ml', values: {} };
    expect(summarize([record(MOM, formula)])).toBeNull();
  });

  it('家人记了一笔小金库不提示，哪怕带着 at', () => {
    const money = {
      type: 'money',
      flow: 'in',
      amountMinor: 100,
      currency: 'SGD',
      happenedAt: NOW,
    };
    expect(summarize([record(MOM, money)])).toBeNull();
    expect(summarize([record(MOM, { ...money, at: NOW })])).toBeNull();
  });

  it('也不算进条数', () => {
    expect(summarize([record(MOM, feed(75)), record(MOM, plan)])?.message).toBe(
      '妈妈 记录了 喂奶 75ml',
    );
  });

  it('以后的版本写入的、这个版本不认识的类型同样不算', () => {
    expect(summarize([record(MOM, { type: 'from-the-future', at: NOW })])).toBeNull();
  });
});
