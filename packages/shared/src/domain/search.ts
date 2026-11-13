import { t } from '../i18n';
import type { EventData } from '../schemas';
import { describeEvent } from './events';
import type { Units } from './units';
import { vaccineSearchNames } from './vaccines';

/**
 * 全部记录、回忆和信的搜索（issue #109）。数据都在内存里，一年几千条直接逐条比，不建索引。
 *
 * 比较前把两边都“折叠”：全角字母数字和标点变半角（输入法常打出 ＢＣＧ、３８．５），大写变小写，
 * 拉丁字母去掉重音（purée 和 puree），各种空格都算普通空格。逐个字符折叠并记下它在原文里的位置，
 * 高亮时标的是原文里的字。不用 `normalize('NFKC')` 整段折叠：它会改变长度，位置就对不上了。
 */

const COMBINING_MARKS = /[̀-ͯ]/g;
const LATIN_WITH_ACCENT = /[À-ɏḀ-ỿ]/;
const SPACE = /\s/;

function foldChar(ch: string): string {
  if (SPACE.test(ch)) return ' ';
  const code = ch.codePointAt(0) ?? 0;
  let out = code >= 0xff01 && code <= 0xff5e ? String.fromCharCode(code - 0xfee0) : ch;
  out = out.toLowerCase();
  // 只分解拉丁字母：日文的浊音符号也是组合符号，分解了 が 就会等于 か。
  if (LATIN_WITH_ACCENT.test(out)) out = out.normalize('NFD');
  return out.replace(COMBINING_MARKS, '');
}

interface Folded {
  text: string;
  /** 折叠后每个码元来自原文的哪一段 [start, end)。 */
  starts: number[];
  ends: number[];
}

function fold(text: string): Folded {
  let out = '';
  const starts: number[] = [];
  const ends: number[] = [];
  let index = 0;
  for (const ch of text) {
    const folded = foldChar(ch);
    for (let k = 0; k < folded.length; k++) {
      starts.push(index);
      ends.push(index + ch.length);
    }
    out += folded;
    index += ch.length;
  }
  return { text: out, starts, ends };
}

/** 搜索框里的文字拆成折叠后的词，空格分开的几个词都要命中。 */
export function parseSearchQuery(query: string): string[] {
  return [...new Set(fold(query).text.split(' ').filter(Boolean))];
}

/**
 * 每个词都要在某个字段里出现。一个词不能跨字段拼起来：
 * 备注是“退烧”、记录人是“药”时，搜“退烧药”不该命中。
 */
export function matchesSearch(
  fields: readonly (string | undefined)[],
  terms: readonly string[],
): boolean {
  if (terms.length === 0) return true;
  const haystack = fields
    .filter((f): f is string => Boolean(f))
    .map((f) => fold(f).text)
    .join('\n');
  return terms.every((term) => haystack.includes(term));
}

export interface HighlightPart {
  text: string;
  hit: boolean;
}

/** 把一段显示的文字切成命中和没命中的几段，拼起来还是原文。 */
export function highlightParts(text: string, terms: readonly string[]): HighlightPart[] {
  const ranges = hitRanges(text, terms);
  if (ranges.length === 0) return text ? [{ text, hit: false }] : [];
  const parts: HighlightPart[] = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start > cursor) parts.push({ text: text.slice(cursor, start), hit: false });
    parts.push({ text: text.slice(start, end), hit: true });
    cursor = end;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), hit: false });
  return parts;
}

/** 原文里命中的范围，按位置排好，重叠和相连的合成一段。 */
function hitRanges(text: string, terms: readonly string[]): [number, number][] {
  if (!text || terms.length === 0) return [];
  const folded = fold(text);
  const found: [number, number][] = [];
  for (const term of terms) {
    let from = folded.text.indexOf(term);
    while (from !== -1) {
      const start = folded.starts[from];
      const end = folded.ends[from + term.length - 1];
      if (start !== undefined && end !== undefined) found.push([start, end]);
      from = folded.text.indexOf(term, from + 1);
    }
  }
  found.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const range of found) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([range[0], range[1]]);
  }
  return merged;
}

/** 命中离开头不远时不用截，列表上几行就看得到。 */
const SNIPPET_KEEP = 24;
/** 截的时候命中前面留多少字，够看出上下文。 */
const SNIPPET_LEAD = 16;
const SENTENCE_BREAK = /[。！？；.!?;\n]/;

/**
 * 长正文在结果列表里只显示几行，命中在后面就看不到了。从命中前面一点（最好是上一句的结尾）开始，
 * 前面加省略号；后面交给界面的行数限制截。
 */
export function searchSnippet(text: string, terms: readonly string[]): string {
  const first = hitRanges(text, terms)[0];
  if (!first || first[0] < SNIPPET_KEEP) return text;
  const hit = first[0];
  let begin = hit - SNIPPET_LEAD;
  let atBreak = false;
  for (let i = hit - 1; i >= hit - SNIPPET_LEAD; i--) {
    if (SENTENCE_BREAK.test(text.charAt(i))) {
      begin = i + 1;
      atBreak = true;
      break;
    }
  }
  // 英文这类用空格分词的，没有句子结尾可断时从下一个词开始，不显示半个词。中文的窗口里没有空格，照字截。
  if (!atBreak && !SPACE.test(text.charAt(begin - 1))) {
    for (let i = begin; i < hit; i++) {
      if (SPACE.test(text.charAt(i))) {
        begin = i + 1;
        break;
      }
    }
  }
  // 不要从一个 emoji 的后半截开始。
  const code = text.charCodeAt(begin);
  if (code >= 0xdc00 && code <= 0xdfff) begin += 1;
  return `…${text.slice(begin).trimStart()}`;
}

/** 类型的名字和全部记录页的胶囊一样。睡眠的标题是“睡了 1小时”，搜“睡眠”也要找得到。 */
function typeLabel(type: EventData['type']): string {
  const text = t().today;
  switch (type) {
    case 'feed':
      return text.feed;
    case 'diaper':
      return text.diaper;
    case 'pump':
      return text.filterPump;
    case 'sleep':
      return text.sleep;
    case 'temp':
      return text.filterTemp;
    case 'med':
      return text.filterMed;
    case 'bath':
      return text.filterBath;
    case 'solids':
      return text.filterSolids;
    case 'growth':
      return text.filterGrowth;
    case 'vaccine':
      return text.filterVaccine;
  }
}

function eventFields(event: EventData): (string | undefined)[] {
  switch (event.type) {
    case 'feed':
      // 瓶喂的标题只写“喂奶 90ml”，搜“瓶喂”也要能找到；亲喂的标题本来就有“亲喂”。
      return [
        event.formula?.name,
        event.method === 'breast' ? t().records.feedBreast : t().records.feedBottle,
      ];
    case 'med':
      return [event.name, event.dose];
    case 'solids':
      return [event.food];
    case 'vaccine':
      return vaccineSearchNames(event.vaccineId, event.name);
    default:
      return [];
  }
}

/**
 * 一条记录能不能被搜到：界面上的标题（按当前语言和单位生成，和列表上看到的一样）、类型名、
 * 备注、记录人，瓶喂或亲喂，以及药名、剂量、辅食、奶粉名和疫苗的中英文名。
 */
export function eventMatchesSearch(
  event: EventData,
  terms: readonly string[],
  now: number,
  units: Units,
): boolean {
  if (terms.length === 0) return true;
  return matchesSearch(
    [
      describeEvent(event, now, units),
      typeLabel(event.type),
      event.note,
      event.byName,
      ...eventFields(event),
    ],
    terms,
  );
}
