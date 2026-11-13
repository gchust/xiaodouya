import { describe, expect, it } from 'vitest';
import {
  type EventData,
  eventMatchesSearch,
  groupByDay,
  highlightParts,
  matchesSearch,
  metricUnits,
  parseSearchQuery,
  searchSnippet,
  vaccineSearchNames,
} from '../src';
import { withLocale } from '../src/i18n';

const at = new Date(2026, 5, 15, 9, 30).getTime();
const hits = (text: string, query: string) =>
  highlightParts(text, parseSearchQuery(query))
    .filter((p) => p.hit)
    .map((p) => p.text);

describe('parseSearchQuery', () => {
  it('空的和只有空格的查询没有词', () => {
    expect(parseSearchQuery('')).toEqual([]);
    expect(parseSearchQuery('  　 ')).toEqual([]);
  });

  it('按空格拆词，全角空格也算，去掉重复', () => {
    expect(parseSearchQuery(' 退烧药　 38.5  退烧药')).toEqual(['退烧药', '38.5']);
  });

  it('全角字母数字变半角，大写变小写', () => {
    expect(parseSearchQuery('ＢＣＧ　３８．５ Tylenol')).toEqual(['bcg', '38.5', 'tylenol']);
  });
});

describe('matchesSearch', () => {
  it('没有词时什么都算命中', () => {
    expect(matchesSearch(['喂奶 90ml'], [])).toBe(true);
  });

  it('不分大小写和全角半角', () => {
    expect(matchesSearch(['吃药 · Tylenol 2.5ml'], parseSearchQuery('TYLENOL'))).toBe(true);
    expect(matchesSearch(['吃药 · ＴＹＬＥＮＯＬ'], parseSearchQuery('tylenol'))).toBe(true);
    expect(matchesSearch(['体温 38.5℃'], parseSearchQuery('３８．５'))).toBe(true);
  });

  it('忽略拉丁字母的重音', () => {
    expect(matchesSearch(['Purée de carottes'], parseSearchQuery('puree'))).toBe(true);
    expect(matchesSearch(['Puree'], parseSearchQuery('PURÉE'))).toBe(true);
  });

  it('不间断空格当普通空格', () => {
    expect(matchesSearch(['dose 1'], ['dose 1'])).toBe(true);
  });

  it('几个词都要命中，可以分在不同的字段里', () => {
    const fields = ['吃药 · 退烧药 2.5ml', '半夜发烧', '妈妈'];
    expect(matchesSearch(fields, parseSearchQuery('退烧药 妈妈'))).toBe(true);
    expect(matchesSearch(fields, parseSearchQuery('退烧药 爸爸'))).toBe(false);
  });

  it('一个词不能跨两个字段拼起来', () => {
    expect(matchesSearch(['退烧', '药'], parseSearchQuery('退烧药'))).toBe(false);
  });

  it('跳过没有的字段', () => {
    expect(matchesSearch([undefined, '洗澡'], parseSearchQuery('洗澡'))).toBe(true);
  });
});

describe('highlightParts', () => {
  it('没有命中时整段原样返回', () => {
    expect(highlightParts('喂奶 90ml', parseSearchQuery('尿布'))).toEqual([
      { text: '喂奶 90ml', hit: false },
    ]);
  });

  it('高亮的是原文里的字，保留大小写和全角', () => {
    expect(hits('吃药 · Tylenol 2.5ml', 'tylenol')).toEqual(['Tylenol']);
    expect(hits('吃药 · ＴＹＬＥＮＯＬ', 'tylenol')).toEqual(['ＴＹＬＥＮＯＬ']);
    expect(hits('Purée de carottes', 'puree')).toEqual(['Purée']);
  });

  it('拼起来还是原文', () => {
    const text = 'Le bébé a mangé une purée, puis encore une PURÉE.';
    const parts = highlightParts(text, parseSearchQuery('purée'));
    expect(parts.map((p) => p.text).join('')).toBe(text);
    expect(parts.filter((p) => p.hit).map((p) => p.text)).toEqual(['purée', 'PURÉE']);
  });

  it('每处都高亮，重叠的词合成一段', () => {
    expect(hits('第一次翻身，又翻身了', '翻身')).toEqual(['翻身', '翻身']);
    expect(hits('退烧药', '退烧 烧药')).toEqual(['退烧药']);
  });

  it('emoji 这类两个码元的字不会被切开', () => {
    const parts = highlightParts('🎂 一岁生日', parseSearchQuery('生日'));
    expect(parts).toEqual([
      { text: '🎂 一岁', hit: false },
      { text: '生日', hit: true },
    ]);
  });
});

describe('searchSnippet', () => {
  const long = `${'今天天气很好，我们去公园散步。'.repeat(8)}宝宝第一次翻身了！${'后来又睡了一觉。'.repeat(5)}`;

  it('短的正文或者命中在开头附近时原样返回', () => {
    expect(searchSnippet('宝宝第一次翻身', parseSearchQuery('翻身'))).toBe('宝宝第一次翻身');
    expect(searchSnippet(long, [])).toBe(long);
  });

  it('命中在后面时从命中前一点开始，前面加省略号', () => {
    const snippet = searchSnippet(long, parseSearchQuery('翻身'));
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet).toContain('宝宝第一次翻身了');
    expect(snippet.indexOf('翻身')).toBeLessThan(30);
    expect(long.endsWith(snippet.slice(1))).toBe(true);
  });

  it('没有命中时原样返回（命中在标题里）', () => {
    expect(searchSnippet(long, parseSearchQuery('标题'))).toBe(long);
  });
});

describe('groupByDay', () => {
  it('按当地日历日分组，天和天里都是新的在前', () => {
    const day = (d: number, h: number) => new Date(2026, 5, d, h).getTime();
    const items = [
      { id: 'a', at: day(14, 8) },
      { id: 'b', at: day(15, 7) },
      { id: 'c', at: day(14, 22) },
      { id: 'd', at: day(15, 23) },
    ];
    const groups = groupByDay(items, (x) => x.at);
    expect(groups.map((g) => g.dayStart)).toEqual([
      new Date(2026, 5, 15).getTime(),
      new Date(2026, 5, 14).getTime(),
    ]);
    expect(groups.map((g) => g.data.map((x) => x.id))).toEqual([
      ['d', 'b'],
      ['c', 'a'],
    ]);
  });
});

describe('vaccineSearchNames', () => {
  it('内置剂次有存下的名字、中文和英文名', () => {
    expect(vaccineSearchNames('sg:bcg', '卡介苗 BCG')).toEqual(['卡介苗 BCG', 'BCG']);
    // 加地区前缀之前的记录
    expect(vaccineSearchNames('hepb-1', '乙肝疫苗 HepB 第 1 剂')).toContain(
      'Hepatitis B (HepB), dose 1',
    );
  });

  it('自己填的和不认识的只有存下的名字', () => {
    expect(vaccineSearchNames('custom:abc', 'Typhoid')).toEqual(['Typhoid']);
  });
});

describe('eventMatchesSearch', () => {
  const ev = (data: Partial<EventData> & Pick<EventData, 'type'>) => ({ at, ...data }) as EventData;
  const match = (event: EventData, query: string) =>
    eventMatchesSearch(event, parseSearchQuery(query), at, metricUnits);

  it('搜得到界面上的标题文字，跟着当前语言', () => {
    const feed = ev({ type: 'feed', ml: 90 });
    withLocale('zh', () => {
      expect(match(feed, '喂奶')).toBe(true);
      expect(match(feed, '90ml')).toBe(true);
      expect(match(feed, 'feed')).toBe(false);
    });
    withLocale('en', () => {
      expect(match(feed, 'FEED')).toBe(true);
      expect(match(feed, '喂奶')).toBe(false);
    });
  });

  it('体温按数字搜得到', () => {
    const temp = ev({ type: 'temp', celsius: 38.5 });
    withLocale('zh', () => {
      expect(match(temp, '38.5')).toBe(true);
      expect(match(temp, '体温')).toBe(true);
      expect(match(temp, '37')).toBe(false);
    });
  });

  it('搜得到药名、剂量、辅食、备注、记录人和奶粉', () => {
    withLocale('zh', () => {
      const med = ev({
        type: 'med',
        name: 'Tylenol',
        dose: '2.5ml',
        note: '半夜发烧',
        byName: '妈妈',
      });
      expect(match(med, 'tylenol 2.5')).toBe(true);
      expect(match(med, '发烧')).toBe(true);
      expect(match(med, '妈妈')).toBe(true);
      expect(match(med, '吃药')).toBe(true);
      expect(match(ev({ type: 'solids', food: '南瓜泥' }), '南瓜')).toBe(true);
      expect(
        match(ev({ type: 'feed', ml: 90, formula: { name: 'Similac', per100ml: {} } }), 'similac'),
      ).toBe(true);
    });
  });

  it('类型的名字也算：睡眠的标题是“睡了”，搜“睡眠”也要找得到', () => {
    const sleep = ev({ type: 'sleep', endAt: at + 3_600_000 });
    withLocale('zh', () => expect(match(sleep, '睡眠')).toBe(true));
    withLocale('en', () => expect(match(sleep, 'sleep')).toBe(true));
  });

  it('内置疫苗的中英文名在两种语言下都搜得到', () => {
    const bcg = ev({ type: 'vaccine', vaccineId: 'sg:bcg', name: '卡介苗 BCG' });
    for (const locale of ['zh', 'en'] as const) {
      withLocale(locale, () => {
        expect(match(bcg, '卡介苗')).toBe(true);
        expect(match(bcg, 'bcg')).toBe(true);
      });
    }
    const hepb = ev({ type: 'vaccine', vaccineId: 'sg:hepb-1', name: '乙肝疫苗 HepB 第 1 剂' });
    withLocale('zh', () => expect(match(hepb, 'hepatitis')).toBe(true));
    withLocale('en', () => expect(match(hepb, '乙肝')).toBe(true));
  });
});
