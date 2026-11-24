import {
  type BabyData,
  buildWidgetView,
  type EventData,
  metricUnits,
  startOfLocalDay,
  type WidgetSession,
} from '@xiaodouya/shared';
import { describe, expect, it, vi } from 'vitest';

// 库的入口会加载原生模块，vitest 里加载不了。这里换成只做“把属性摊平”的替身：
// 要看的是我们的布局交出去的文字、字号、点击和时钟，不是库怎么画。
vi.mock('react-native-android-widget', () => {
  const make = (name: string) => {
    const component = () => null;
    component.__name__ = name;
    component.convertProps = ({ style, ...rest }: { style?: object }) => ({ ...style, ...rest });
    return component;
  };
  return {
    FlexWidget: make('FlexWidget'),
    TextWidget: make('TextWidget'),
    ImageWidget: make('ImageWidget'),
    SvgWidget: make('SvgWidget'),
  };
});

const { renderWidgetFor } = await import('../src/widgets/views');

interface Element {
  type: {
    (props: unknown): Element;
    __name__?: string;
    convertProps?: (props: unknown) => Node['props'];
  };
  props: { children?: Element | (Element | null)[] } & Record<string, unknown>;
}

/** 和库的 `buildWidgetTree` 一样：一层层调用组件，直到遇到带 `__name__` 的基础元素。 */
function buildWidgetTree(input: Element): Node {
  let element = input;
  while (!element.type.__name__) element = element.type(element.props);
  const { children, ...rest } = element.props;
  const list = (Array.isArray(children) ? children : children ? [children] : []).flat();
  return {
    type: element.type.__name__,
    props: element.type.convertProps?.(rest) ?? {},
    children: list.filter((child): child is Element => Boolean(child)).map(buildWidgetTree),
  };
}

interface Node {
  type: string;
  props: Record<string, unknown> & { text?: string; clock?: { timeZone: string; format: string } };
  children?: Node[];
}

const HOUR = 3_600_000;
const MIN = 60_000;
const now = new Date(2026, 10, 24, 16, 30, 0).getTime();
const session: WidgetSession = { signedIn: true, hasFamily: true, role: 'caregiver', label: '' };
const baby: BabyData = { name: '测试豆', birthAt: now - 30 * 24 * HOUR };
const ids = { feed: 'f', sleep: 's', wee: 'w', poo: 'p', both: 'b' };

function view(events: EventData[]) {
  const v = buildWidgetView({
    session,
    baby,
    entries: events.map((data, i) => ({ id: `e${i}`, data })),
    units: metricUnits,
    now,
    dayStart: startOfLocalDay(now),
    syncedAt: now,
  });
  if (v.kind !== 'ready') throw new Error('blocked');
  return v;
}

function flat(node: Node): Node[] {
  return [node, ...(node.children ?? []).flatMap(flat)];
}

function tree(
  name: Parameters<typeof renderWidgetFor>[0],
  events: EventData[],
  size?: { width: number; height: number },
) {
  const { light } = renderWidgetFor(name, view(events), ids, undefined, size);
  return flat(buildWidgetTree(light as unknown as Element));
}

const texts = (nodes: Node[]) => nodes.flatMap((n) => (n.props.text ? [n.props.text] : []));
const clocks = (nodes: Node[]) => nodes.flatMap((n) => (n.props.clock ? [n.props.clock] : []));
const fontSizes = (nodes: Node[]) =>
  nodes.flatMap((n) => (typeof n.props.fontSize === 'number' ? [n.props.fontSize] : []));

const fed: EventData = { type: 'feed', at: now - 2 * HOUR - 15 * MIN, ml: 120 };

describe('记喂奶小工具', () => {
  it('大字是自己走的“过了多久”，说明写喂的钟点，不写上次喂了多少', () => {
    const nodes = tree('FeedWidget', [fed]);
    expect(clocks(nodes)).toHaveLength(1);
    expect(clocks(nodes)[0]?.format).toBe('H:mm');
    expect(clocks(nodes)[0]?.timeZone).toMatch(/^GMT(-\d\d:\d\d)?$/);
    expect(texts(nodes)).toContain('距上次喂奶 · 14:15');
    // 奶量只出现在按钮上：那是这一下要记的。
    expect(texts(nodes).filter((x) => x.includes('120ml'))).toEqual(['＋ 120ml']);
  });

  it('超过 20 小时的记录不用时钟（满 24 小时会绕回 0），写日期和钟点', () => {
    const nodes = tree('FeedWidget', [{ type: 'feed', at: now - 21 * HOUR, ml: 120 }]);
    expect(clocks(nodes)).toHaveLength(0);
    expect(texts(nodes)).toContain('19:30');
  });

  it('字号不跟手机的字体大小', () => {
    const nodes = tree('FeedWidget', [fed]).filter((n) => n.type === 'TextWidget');
    expect(nodes.length).toBeGreaterThan(3);
    expect(nodes.every((n) => n.props.allowFontScaling === false)).toBe(true);
  });

  it('小工具拉大字跟着变大，缩小跟着变小', () => {
    const max = (size: { width: number; height: number }) =>
      Math.max(...fontSizes(tree('FeedWidget', [fed], size)));
    expect(max({ width: 156, height: 164 })).toBe(34);
    expect(max({ width: 234, height: 246 })).toBe(51);
    expect(max({ width: 125, height: 131 })).toBeLessThan(34);
  });
});

describe('尿布和睡眠小工具', () => {
  it('尿布和醒着也写过了多久', () => {
    const diaper = tree('DiaperWidget', [{ type: 'diaper', at: now - 40 * MIN, kind: 'wee' }]);
    expect(clocks(diaper)).toHaveLength(1);
    expect(texts(diaper)).toContain('距上次 · 尿尿 15:50');
    const sleep = tree('SleepWidget', [{ type: 'sleep', at: now - 3 * HOUR, endAt: now - HOUR }]);
    expect(clocks(sleep)).toHaveLength(1);
    expect(texts(sleep)).toContain('醒着 · 从 15:30');
  });
});

describe('快捷记录', () => {
  const events: EventData[] = [fed, { type: 'diaper', at: now - 40 * MIN, kind: 'wee' }];

  it('一格高只有一排五个按钮，没有标题和最近的记录', () => {
    const nodes = tree('QuickWidget', events, { width: 352, height: 84 });
    expect(texts(nodes)).toEqual(['喂奶', '120ml', '尿尿', '便便', '都有', '睡着了']);
    expect(nodes.filter((n) => n.props.clickAction === 'RECORD')).toHaveLength(5);
  });

  it('两格高有标题和最近的记录，喂奶不写奶量', () => {
    const all = texts(tree('QuickWidget', events, { width: 352, height: 168 }));
    expect(all.some((x) => x.includes('第 31 天'))).toBe(true);
    expect(all).toContain('14:15');
    // 只有按钮上有奶量。
    expect(all.filter((x) => x.includes('120ml'))).toEqual(['120ml']);
  });
});
