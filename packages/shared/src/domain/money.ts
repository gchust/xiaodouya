import { t } from '../i18n';
import { moneyCategoryLabel, moneyOutCategoryIds } from '../regions/moneyCategories';
import type { RegionDefinition } from '../regions/types';
import { MAX_MONEY_MINOR, type MoneyData, type MoneyFlow } from '../schemas';

/**
 * 小金库（issue #90）的纯规则：金额的输入和显示、按币种的汇总、按人和按场合的统计。
 *
 * 金额永远是币种最小单位的整数。输入按字符串拆开换算，不经过浮点（`1.15 * 100` 是 114.99999999999999）。
 * 不同币种的钱不相加，也不换算：汇率是 App 不该猜的东西。
 */

export interface CurrencyInfo {
  code: string;
  /** ISO 4217 的小数位。 */
  digits: number;
  /** 家庭所在地区的币种用的短符号（新加坡写 $）。 */
  symbol: string;
  /** 不是本地币种时用的、能和别的币种分清的符号（S$、US$、CN¥、JP¥）。 */
  wide: string;
  /** 用这种货币的国家（ISO 3166-1），“其他地区”按手机的国家猜默认币种。 */
  countries: readonly string[];
}

const EURO = [
  'AT',
  'BE',
  'CY',
  'DE',
  'EE',
  'ES',
  'FI',
  'FR',
  'GR',
  'HR',
  'IE',
  'IT',
  'LT',
  'LU',
  'LV',
  'MT',
  'NL',
  'PT',
  'SI',
  'SK',
];

/** 可选的币种，按这个顺序列在弹层里。新增币种只加一行。 */
const CURRENCIES: readonly CurrencyInfo[] = [
  { code: 'CNY', digits: 2, symbol: '¥', wide: 'CN¥', countries: ['CN'] },
  { code: 'SGD', digits: 2, symbol: '$', wide: 'S$', countries: ['SG'] },
  { code: 'USD', digits: 2, symbol: '$', wide: 'US$', countries: ['US'] },
  { code: 'HKD', digits: 2, symbol: '$', wide: 'HK$', countries: ['HK'] },
  { code: 'TWD', digits: 2, symbol: '$', wide: 'NT$', countries: ['TW'] },
  { code: 'MOP', digits: 2, symbol: 'MOP$', wide: 'MOP$', countries: ['MO'] },
  { code: 'MYR', digits: 2, symbol: 'RM', wide: 'RM', countries: ['MY'] },
  { code: 'JPY', digits: 0, symbol: '¥', wide: 'JP¥', countries: ['JP'] },
  { code: 'KRW', digits: 0, symbol: '₩', wide: '₩', countries: ['KR'] },
  { code: 'EUR', digits: 2, symbol: '€', wide: '€', countries: EURO },
  { code: 'GBP', digits: 2, symbol: '£', wide: '£', countries: ['GB'] },
  { code: 'AUD', digits: 2, symbol: '$', wide: 'A$', countries: ['AU'] },
  { code: 'NZD', digits: 2, symbol: '$', wide: 'NZ$', countries: ['NZ'] },
  { code: 'CAD', digits: 2, symbol: '$', wide: 'CA$', countries: ['CA'] },
  { code: 'CHF', digits: 2, symbol: 'CHF ', wide: 'CHF ', countries: ['CH'] },
  { code: 'THB', digits: 2, symbol: '฿', wide: '฿', countries: ['TH'] },
  { code: 'INR', digits: 2, symbol: '₹', wide: '₹', countries: ['IN'] },
  { code: 'PHP', digits: 2, symbol: '₱', wide: '₱', countries: ['PH'] },
  { code: 'IDR', digits: 2, symbol: 'Rp', wide: 'Rp', countries: ['ID'] },
  { code: 'VND', digits: 0, symbol: '₫', wide: '₫', countries: ['VN'] },
];

export const currencyChoices: readonly string[] = CURRENCIES.map((c) => c.code);

/** 以后的版本可能写入这里没有的币种：按两位小数，前面写代码。 */
export function currencyInfo(code: string): CurrencyInfo {
  return (
    CURRENCIES.find((c) => c.code === code) ?? {
      code,
      digits: 2,
      symbol: `${code} `,
      wide: `${code} `,
      countries: [],
    }
  );
}

/**
 * 新记一笔的默认币种：地区有就用地区的；“其他地区”按手机的国家猜，猜不到是美元。
 * 记过的话界面先用上一次的（`lastUsedCurrency`），这里只管第一次。
 */
export function defaultMoneyCurrency(
  region: Pick<RegionDefinition, 'money'>,
  deviceCountry: string | null | undefined,
): string {
  if (region.money.currency) return region.money.currency;
  const country = deviceCountry?.toUpperCase();
  return CURRENCIES.find((c) => country && c.countries.includes(country))?.code ?? 'USD';
}

/** 最近写过的一笔的币种：一家人一般一直用同一种，换过一次之后就不用每次再换。 */
export function lastUsedCurrency(
  entries: readonly { data: MoneyData; updatedAt: number }[],
): string | undefined {
  let latest: { data: MoneyData; updatedAt: number } | undefined;
  for (const entry of entries) {
    if (!latest || entry.updatedAt > latest.updatedAt) latest = entry;
  }
  return latest?.data.currency;
}

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 不带符号的数字。整数不写小数（红包一般是整数，`¥600.00` 不好读）；有零头时写满位数（`$12.50`）。 */
function amountText(minorAbs: number, digits: number): string {
  if (digits === 0) return groupThousands(String(minorAbs));
  const scale = 10 ** digits;
  const whole = Math.floor(minorAbs / scale);
  const fraction = minorAbs % scale;
  const wholeText = groupThousands(String(whole));
  return fraction === 0 ? wholeText : `${wholeText}.${String(fraction).padStart(digits, '0')}`;
}

/**
 * 金额的显示。千位用逗号、小数点用点，中文和英文都是这样写；不用 `Intl`，Hermes 上不完整。
 * `localCurrency` 是家庭地区的币种：它用短符号，别的币种用能分清的符号，人民币和日元、新加坡元和美元不会混。
 */
export function formatMoney(
  minor: number,
  currency: string,
  options: { localCurrency?: string; signed?: boolean } = {},
): string {
  const info = currencyInfo(currency);
  const symbol = currency === options.localCurrency ? info.symbol : info.wide;
  const sign = minor < 0 ? '−' : options.signed && minor > 0 ? '+' : '';
  return `${sign}${symbol}${amountText(Math.abs(minor), info.digits)}`;
}

export type MoneyInputResult =
  | { ok: true; minor: number }
  | { ok: false; reason: 'empty' | 'invalid' | 'decimals' | 'zero' | 'tooLarge' };

/**
 * 输入框里的文字换成最小单位。接受 `1,000.50` 和欧洲的 `12,5`：只有一个逗号、后面不是正好三位数时，
 * 逗号当小数点。小数位比币种多时提示，不悄悄四舍五入。
 */
export function parseMoneyInput(text: string, currency: string): MoneyInputResult {
  let s = text.replace(/[\s ]/g, '');
  if (s === '') return { ok: false, reason: 'empty' };
  if (!s.includes('.')) {
    const commas = s.split(',').length - 1;
    if (commas === 1 && !/,\d{3}$/.test(s)) s = s.replace(',', '.');
  }
  s = s.replace(/,(?=\d{3}(\D|$))/g, '');
  const match = /^(\d+)(?:\.(\d*))?$/.exec(s) ?? /^()\.(\d+)$/.exec(s);
  if (!match) return { ok: false, reason: 'invalid' };
  const whole = (match[1] ?? '').replace(/^0+(?=\d)/, '');
  const fraction = (match[2] ?? '').replace(/0+$/, '');
  const { digits } = currencyInfo(currency);
  if (fraction.length > digits) return { ok: false, reason: 'decimals' };
  // 超过 15 位就超出安全整数，先按长度拦。
  if (whole.length > 15) return { ok: false, reason: 'tooLarge' };
  const minor = Number(whole || '0') * 10 ** digits + Number(fraction.padEnd(digits, '0') || '0');
  if (minor === 0) return { ok: false, reason: 'zero' };
  if (minor > MAX_MONEY_MINOR) return { ok: false, reason: 'tooLarge' };
  return { ok: true, minor };
}

/** 修改时填回输入框的文字，再解析会得到同一个数。不加千位分隔，方便改。 */
export function moneyInputText(minor: number, currency: string): string {
  const { digits } = currencyInfo(currency);
  if (digits === 0) return String(minor);
  const scale = 10 ** digits;
  const whole = Math.floor(minor / scale);
  const fraction = minor % scale;
  return fraction === 0 ? String(whole) : `${whole}.${String(fraction).padStart(digits, '0')}`;
}

export interface MoneyTotal {
  currency: string;
  inMinor: number;
  outMinor: number;
  /** 可以是负的：先记了拿出、收到还没补记时，如实显示，不截成 0。 */
  balanceMinor: number;
  count: number;
}

/** 每个币种一行，记得多的币种在前（就是这家人主要用的）。 */
export function moneyTotals(entries: readonly MoneyData[]): MoneyTotal[] {
  const totals = new Map<string, MoneyTotal>();
  for (const entry of entries) {
    const total = totals.get(entry.currency) ?? {
      currency: entry.currency,
      inMinor: 0,
      outMinor: 0,
      balanceMinor: 0,
      count: 0,
    };
    if (entry.flow === 'in') total.inMinor += entry.amountMinor;
    else total.outMinor += entry.amountMinor;
    total.balanceMinor = total.inMinor - total.outMinor;
    total.count += 1;
    totals.set(entry.currency, total);
  }
  return [...totals.values()].sort(
    (a, b) => b.count - a.count || a.currency.localeCompare(b.currency),
  );
}

export interface MoneyGroup {
  /** 人名或场合 id；没写的是 null。 */
  key: string | null;
  /** 每个币种的合计，记得多的币种在前。 */
  amounts: { currency: string; minor: number }[];
  count: number;
}

function groupBy(
  entries: readonly MoneyData[],
  keyOf: (entry: MoneyData) => string | null,
  mainCurrency: string,
): MoneyGroup[] {
  const groups = new Map<string | null, { count: number; byCurrency: Map<string, number> }>();
  for (const entry of entries) {
    const key = keyOf(entry);
    const group = groups.get(key) ?? { count: 0, byCurrency: new Map<string, number>() };
    group.count += 1;
    group.byCurrency.set(
      entry.currency,
      (group.byCurrency.get(entry.currency) ?? 0) + entry.amountMinor,
    );
    groups.set(key, group);
  }
  const main = (g: MoneyGroup) => g.amounts.find((a) => a.currency === mainCurrency)?.minor ?? -1;
  return [...groups.entries()]
    .map(([key, g]) => ({
      key,
      amounts: [...g.byCurrency.entries()]
        .map(([currency, minor]) => ({ currency, minor }))
        .sort((a, b) =>
          a.currency === mainCurrency ? -1 : b.currency === mainCurrency ? 1 : b.minor - a.minor,
        ),
      count: g.count,
    }))
    .sort((a, b) => main(b) - main(a) || b.count - a.count);
}

const trimmed = (text: string | undefined) => text?.trim() || null;

/** 谁给了多少：只算收到的。名字是用户写的原文，去掉首尾空格后相同的算一个人。 */
export function moneyByGiver(entries: readonly MoneyData[], mainCurrency: string): MoneyGroup[] {
  return groupBy(
    entries.filter((e) => e.flow === 'in'),
    (e) => trimmed(e.from),
    mainCurrency,
  );
}

/** 按场合（收到）或去向（拿出）。 */
export function moneyByCategory(
  entries: readonly MoneyData[],
  flow: MoneyFlow,
  mainCurrency: string,
): MoneyGroup[] {
  return groupBy(
    entries.filter((e) => e.flow === flow),
    (e) => e.category ?? null,
    mainCurrency,
  );
}

/** 记一笔时可选的场合或去向。 */
export function moneyCategoriesFor(
  region: Pick<RegionDefinition, 'money'>,
  flow: MoneyFlow,
): readonly string[] {
  return flow === 'in' ? region.money.categories : moneyOutCategoryIds;
}

/**
 * “谁给的”的快捷胶囊：先是最近记过的人（新的在前），再是家人的称呼和常用称呼，不重复。
 * 只是替用户填字，存下来的就是那时的文字。
 */
export function giverSuggestions(
  newestFirst: readonly MoneyData[],
  extras: readonly string[],
  limit = 8,
): string[] {
  const out: string[] = [];
  const add = (name: string | undefined) => {
    const value = name?.trim();
    if (value && !out.includes(value) && out.length < limit) out.push(value);
  };
  for (const entry of newestFirst) if (entry.flow === 'in') add(entry.from);
  for (const name of extras) add(name);
  return out;
}

/** 一句话说这一笔（Toast、删除确认）：场合（没有就说收到还是拿出）、谁给的、金额。 */
export function describeMoney(data: MoneyData, localCurrency: string | undefined): string {
  const label =
    moneyCategoryLabel(data.category) ??
    (data.flow === 'in' ? t().money.flowIn : t().money.flowOut);
  const from = data.flow === 'in' ? trimmed(data.from) : null;
  const amount = formatMoney(data.amountMinor, data.currency, { localCurrency });
  return [label, from, amount].filter(Boolean).join(' · ');
}

/** 明细按发生的日子倒序；同一天的，后记的在前。 */
export function compareMoneyEntries(
  a: { data: MoneyData; updatedAt: number },
  b: { data: MoneyData; updatedAt: number },
): number {
  return b.data.happenedAt - a.data.happenedAt || b.updatedAt - a.updatedAt;
}
