import { describe, expect, it } from 'vitest';
import {
  currencyChoices,
  currencyInfo,
  defaultMoneyCurrency,
  deleteConfirmText,
  describeMoney,
  formatMoney,
  giverSuggestions,
  isMoneyCategory,
  isMoneyData,
  lastUsedCurrency,
  MAX_MONEY_MINOR,
  type MoneyData,
  moneyByCategory,
  moneyByGiver,
  moneyCategoriesFor,
  moneyCategoryLabel,
  moneyInputText,
  moneyTotals,
  parseCollectionData,
  parseMoneyInput,
  regionList,
  regions,
  withLocale,
} from '../src/index';

const day = (d: number) => Date.UTC(2026, 0, d, 4);
const gift = (amountMinor: number, extra: Partial<MoneyData> = {}): MoneyData => ({
  type: 'money',
  flow: 'in',
  amountMinor,
  currency: 'CNY',
  happenedAt: day(1),
  ...extra,
});

describe('记录的格式', () => {
  it('一笔收入能通过校验，放在 event 集合里，不带 at', () => {
    const data = gift(60_000, { from: '爷爷', category: 'lunar-new-year', note: '虚构' });
    expect(parseCollectionData('event', data)).toEqual(data);
    expect(isMoneyData(data)).toBe(true);
    expect('at' in data).toBe(false);
  });

  it('金额必须是正的整数最小单位，不接受小数', () => {
    expect(parseCollectionData('event', gift(12.5))).toBeNull();
    expect(parseCollectionData('event', gift(0))).toBeNull();
    expect(parseCollectionData('event', gift(-100))).toBeNull();
    expect(parseCollectionData('event', gift(MAX_MONEY_MINOR + 1))).toBeNull();
    expect(parseCollectionData('event', gift(MAX_MONEY_MINOR))).not.toBeNull();
  });

  it('币种是三个大写字母，不认识的币种也保留', () => {
    expect(parseCollectionData('event', gift(100, { currency: 'cny' }))).toBeNull();
    expect(parseCollectionData('event', gift(100, { currency: 'XYZ' }))).not.toBeNull();
  });

  it('新版本的未知字段原样保留，格式不对的可选项只丢这一项', () => {
    const parsed = parseCollectionData('event', {
      ...gift(100),
      future: { x: 1 },
      from: 42,
      category: { bad: true },
    });
    expect(parsed).toMatchObject({ future: { x: 1 }, amountMinor: 100 });
    expect((parsed as MoneyData).from).toBeUndefined();
    expect((parsed as MoneyData).category).toBeUndefined();
  });

  it('不认识的去向整条不显示（保留），不能猜是收到还是拿出', () => {
    expect(parseCollectionData('event', { ...gift(100), flow: 'transfer' })).toBeNull();
  });
});

describe('金额输入', () => {
  it('按币种的小数位换算成整数，不经过浮点', () => {
    expect(parseMoneyInput('600', 'CNY')).toEqual({ ok: true, minor: 60_000 });
    expect(parseMoneyInput('0.1', 'CNY')).toEqual({ ok: true, minor: 10 });
    expect(parseMoneyInput('19.99', 'USD')).toEqual({ ok: true, minor: 1999 });
    // 0.1 + 0.2 这类浮点误差不能出现
    expect(parseMoneyInput('1.15', 'SGD')).toEqual({ ok: true, minor: 115 });
    expect(parseMoneyInput('10000', 'JPY')).toEqual({ ok: true, minor: 10_000 });
  });

  it('逗号当小数点（欧洲的写法），空格和千位分隔都能去掉', () => {
    expect(parseMoneyInput('12,5', 'EUR')).toEqual({ ok: true, minor: 1250 });
    expect(parseMoneyInput(' 1 000 ', 'EUR')).toEqual({ ok: true, minor: 100_000 });
    expect(parseMoneyInput('1,000.50', 'USD')).toEqual({ ok: true, minor: 100_050 });
  });

  it('小数位超过币种允许的要提示，不能悄悄四舍五入', () => {
    expect(parseMoneyInput('1.005', 'CNY')).toEqual({ ok: false, reason: 'decimals' });
    expect(parseMoneyInput('100.5', 'JPY')).toEqual({ ok: false, reason: 'decimals' });
  });

  it('空的、零、不是数字、太大的都拦下', () => {
    expect(parseMoneyInput('', 'CNY')).toEqual({ ok: false, reason: 'empty' });
    expect(parseMoneyInput('0', 'CNY')).toEqual({ ok: false, reason: 'zero' });
    expect(parseMoneyInput('0.00', 'CNY')).toEqual({ ok: false, reason: 'zero' });
    expect(parseMoneyInput('abc', 'CNY')).toEqual({ ok: false, reason: 'invalid' });
    expect(parseMoneyInput('-5', 'CNY')).toEqual({ ok: false, reason: 'invalid' });
    expect(parseMoneyInput('1.2.3', 'CNY')).toEqual({ ok: false, reason: 'invalid' });
    expect(parseMoneyInput('99999999999999', 'CNY')).toEqual({ ok: false, reason: 'tooLarge' });
  });

  it('修改时填回去的文字再解析得到同一个数', () => {
    for (const [minor, code] of [
      [60_000, 'CNY'],
      [1999, 'USD'],
      [5, 'SGD'],
      [10_000, 'JPY'],
    ] as const) {
      const text = moneyInputText(minor, code);
      expect(parseMoneyInput(text, code)).toEqual({ ok: true, minor });
    }
    expect(moneyInputText(60_000, 'CNY')).toBe('600');
    expect(moneyInputText(1250, 'EUR')).toBe('12.50');
  });
});

describe('金额显示', () => {
  it('本地的币种用短符号，整数不写小数', () => {
    expect(formatMoney(60_000, 'CNY', { localCurrency: 'CNY' })).toBe('¥600');
    expect(formatMoney(123_456_789, 'CNY', { localCurrency: 'CNY' })).toBe('¥1,234,567.89');
    expect(formatMoney(1250, 'SGD', { localCurrency: 'SGD' })).toBe('$12.50');
    expect(formatMoney(10_000, 'JPY', { localCurrency: 'JPY' })).toBe('¥10,000');
  });

  it('不是本地的币种用能分清的符号：人民币和日元、新加坡元和美元不会混', () => {
    expect(formatMoney(60_000, 'CNY', { localCurrency: 'SGD' })).toBe('CN¥600');
    expect(formatMoney(10_000, 'JPY', { localCurrency: 'CNY' })).toBe('JP¥10,000');
    expect(formatMoney(1250, 'SGD', { localCurrency: 'USD' })).toBe('S$12.50');
    expect(formatMoney(1250, 'USD', { localCurrency: 'SGD' })).toBe('US$12.50');
  });

  it('不认识的币种按两位小数，前面写代码', () => {
    expect(currencyInfo('XYZ').digits).toBe(2);
    expect(formatMoney(1250, 'XYZ')).toBe('XYZ 12.50');
  });

  it('带正负号：收到是 +，拿出和负的余额是 −', () => {
    expect(formatMoney(60_000, 'CNY', { localCurrency: 'CNY', signed: true })).toBe('+¥600');
    expect(formatMoney(-20_000, 'CNY', { localCurrency: 'CNY', signed: true })).toBe('−¥200');
    expect(formatMoney(-20_000, 'CNY', { localCurrency: 'CNY' })).toBe('−¥200');
  });

  it('可选的币种里有每个地区的默认币种', () => {
    for (const region of regionList) {
      if (region.money.currency) expect(currencyChoices).toContain(region.money.currency);
    }
  });
});

describe('汇总', () => {
  const entries: MoneyData[] = [
    gift(60_000, { from: '爷爷', category: 'lunar-new-year' }),
    gift(20_000, { from: '爷爷', category: 'red-packet' }),
    gift(50_000, { from: '妈妈', category: 'red-packet' }),
    gift(30_000, { flow: 'out', category: 'bank' }),
    gift(10_000, { from: ' 外婆 ' }),
    gift(5000, { currency: 'USD', from: 'Aunt', category: 'birthday' }),
  ];

  it('每个币种分开算收到、拿出和余额，不跨币种相加', () => {
    expect(moneyTotals(entries)).toEqual([
      { currency: 'CNY', inMinor: 140_000, outMinor: 30_000, balanceMinor: 110_000, count: 5 },
      { currency: 'USD', inMinor: 5000, outMinor: 0, balanceMinor: 5000, count: 1 },
    ]);
  });

  it('拿出的比收到的多时余额是负的，不截成 0', () => {
    expect(moneyTotals([gift(100), gift(300, { flow: 'out' })])[0]?.balanceMinor).toBe(-200);
  });

  it('没有记录时没有汇总', () => {
    expect(moneyTotals([])).toEqual([]);
  });

  it('按人：只算收到的，名字去掉首尾空格，按主币种金额从多到少', () => {
    expect(moneyByGiver(entries, 'CNY')).toEqual([
      { key: '爷爷', amounts: [{ currency: 'CNY', minor: 80_000 }], count: 2 },
      { key: '妈妈', amounts: [{ currency: 'CNY', minor: 50_000 }], count: 1 },
      { key: '外婆', amounts: [{ currency: 'CNY', minor: 10_000 }], count: 1 },
      { key: 'Aunt', amounts: [{ currency: 'USD', minor: 5000 }], count: 1 },
    ]);
  });

  it('没写是谁给的单独一组（key 是 null）', () => {
    expect(moneyByGiver([gift(100), gift(200, { from: '  ' })], 'CNY')).toEqual([
      { key: null, amounts: [{ currency: 'CNY', minor: 300 }], count: 2 },
    ]);
  });

  it('按场合：收到和拿出分开算', () => {
    expect(moneyByCategory(entries, 'in', 'CNY')).toEqual([
      { key: 'red-packet', amounts: [{ currency: 'CNY', minor: 70_000 }], count: 2 },
      { key: 'lunar-new-year', amounts: [{ currency: 'CNY', minor: 60_000 }], count: 1 },
      { key: null, amounts: [{ currency: 'CNY', minor: 10_000 }], count: 1 },
      { key: 'birthday', amounts: [{ currency: 'USD', minor: 5000 }], count: 1 },
    ]);
    expect(moneyByCategory(entries, 'out', 'CNY')).toEqual([
      { key: 'bank', amounts: [{ currency: 'CNY', minor: 30_000 }], count: 1 },
    ]);
  });
});

describe('默认值', () => {
  it('币种：上一次记的优先，其次地区，其他地区按手机的国家，再猜不到是美元', () => {
    const older = { data: gift(100, { currency: 'USD' }), updatedAt: 1 };
    const newer = { data: gift(100, { currency: 'JPY' }), updatedAt: 2 };
    expect(lastUsedCurrency([older, newer])).toBe('JPY');
    expect(lastUsedCurrency([])).toBeUndefined();
    expect(defaultMoneyCurrency(regions.CN, 'SG')).toBe('CNY');
    expect(defaultMoneyCurrency(regions.SG, null)).toBe('SGD');
    expect(defaultMoneyCurrency(regions.US, null)).toBe('USD');
    expect(defaultMoneyCurrency(regions.OTHER, 'DE')).toBe('EUR');
    expect(defaultMoneyCurrency(regions.OTHER, 'jp')).toBe('JPY');
    expect(defaultMoneyCurrency(regions.OTHER, 'ZZ')).toBe('USD');
    expect(defaultMoneyCurrency(regions.OTHER, undefined)).toBe('USD');
  });

  it('谁给的：先是最近记过的人，再是家人和常用称呼，不重复', () => {
    const recent = [
      gift(1, { from: '大姨' }),
      gift(1, { from: '爷爷' }),
      gift(1, { from: '大姨' }),
    ];
    expect(giverSuggestions(recent, ['妈妈', '爷爷', '奶奶'], 4)).toEqual([
      '大姨',
      '爷爷',
      '妈妈',
      '奶奶',
    ]);
  });
});

describe('场合按地区', () => {
  it('中国有压岁钱和红包，排在前面', () => {
    const ids = moneyCategoriesFor(regions.CN, 'in');
    expect(ids.slice(0, 2)).toEqual(['lunar-new-year', 'red-packet']);
  });

  it('美国和其他地区没有红包、压岁钱这类中文语境的场合', () => {
    for (const region of [regions.US, regions.OTHER]) {
      const ids = moneyCategoriesFor(region, 'in');
      expect(ids).not.toContain('red-packet');
      expect(ids).not.toContain('lunar-new-year');
      expect(ids).toContain('birthday');
    }
  });

  it('每个地区的场合都有两种语言的名字，最后一项是“其他”', () => {
    for (const region of regionList) {
      for (const flow of ['in', 'out'] as const) {
        const ids = moneyCategoriesFor(region, flow);
        expect(ids.at(-1)).toBe('other');
        for (const id of ids) expect(isMoneyCategory(id, flow)).toBe(true);
        for (const id of ids) {
          expect(withLocale('zh', () => moneyCategoryLabel(id))).toMatch(/\S/);
          expect(withLocale('en', () => moneyCategoryLabel(id))).toMatch(/^[\x20-\x7e]+$/);
        }
      }
    }
  });

  it('换了地区后，以前记的场合照样显示名字；不认识的不显示', () => {
    expect(withLocale('en', () => moneyCategoryLabel('lunar-new-year'))).toBe(
      'Lunar New Year money',
    );
    expect(moneyCategoryLabel('from-the-future')).toBeUndefined();
    expect(moneyCategoryLabel(undefined)).toBeUndefined();
  });
});

describe('一句话描述', () => {
  it('场合、谁给的、金额', () => {
    const data = gift(60_000, { from: '爷爷', category: 'lunar-new-year' });
    expect(withLocale('zh', () => describeMoney(data, 'CNY'))).toBe('压岁钱 · 爷爷 · ¥600');
    expect(withLocale('en', () => describeMoney(data, 'CNY'))).toBe(
      'Lunar New Year money · 爷爷 · ¥600',
    );
  });

  it('没有场合时说是收到还是拿出', () => {
    expect(withLocale('zh', () => describeMoney(gift(100, { flow: 'out' }), 'CNY'))).toBe(
      '拿出 · ¥1',
    );
    expect(withLocale('en', () => describeMoney(gift(100), 'CNY'))).toBe('Money in · ¥1');
  });

  it('删除前确认：问句写清楚是一笔钱，先写这一笔，再说可以撤销', () => {
    const data = gift(60_000, { from: '爷爷', category: 'lunar-new-year' });
    const zh = withLocale('zh', () =>
      deleteConfirmText({ kind: 'money', summary: describeMoney(data, 'CNY') }),
    );
    expect(zh.title).toBe('删除这一笔？');
    expect(zh.body.startsWith('压岁钱 · 爷爷 · ¥600\n')).toBe(true);
    expect(zh.body).toContain('撤销');
    expect(zh.confirm).toBe('删除');
    const en = withLocale('en', () =>
      deleteConfirmText({ kind: 'money', summary: describeMoney(data, 'CNY') }),
    );
    expect(en.title).toBe('Delete this entry?');
  });
});
