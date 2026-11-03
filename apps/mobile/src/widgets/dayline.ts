import type { WidgetDayline } from '@xiaodouya/shared';
import type { WidgetPalette } from './palette';

export const DAYLINE_HEIGHT = 30;

/** 再短的一段睡眠也要看得见，不然十分钟的小睡在条上是空的。 */
const MIN_SLEEP_WIDTH = 2;

const num = (n: number) => Number(n.toFixed(1));

/**
 * 今日汇总上的节奏条：中间一条底，睡眠是上面的蓝色段，喂奶的点在上，尿布的点在下，竖线是现在。
 * 小工具里画不了自由布局，所以拼成 SVG 交给 `SvgWidget`。不依赖 React Native，便于测试。
 */
export function daylineSvg(line: WidgetDayline, width: number, p: WidgetPalette): string {
  const w = Math.max(40, width);
  const x = (fraction: number) => num(fraction * w);
  const dot = (fraction: number, cy: number, r: number, fill: string) =>
    `<circle cx="${num(Math.min(w - r, Math.max(r, fraction * w)))}" cy="${cy}" r="${r}" fill="${fill}"/>`;
  const parts = [
    `<rect x="0" y="11" width="${w}" height="8" rx="4" fill="${p.trackAhead}"/>`,
    `<rect x="0" y="11" width="${x(line.now)}" height="8" rx="4" fill="${p.track}"/>`,
    ...line.sleeps.map(({ from, to }) => {
      const width = Math.max(MIN_SLEEP_WIDTH, x(to) - x(from));
      return `<rect x="${x(from)}" y="11" width="${num(width)}" height="8" rx="2" fill="${p.sleepDot}"/>`;
    }),
    ...line.feeds.map((f) => dot(f, 4, 3.2, p.feedDot)),
    ...line.diapers.map((f) => dot(f, 26, 2.6, p.diaperDot)),
    `<rect x="${num(Math.min(w - 1.5, x(line.now)))}" y="7" width="1.5" height="16" fill="${p.nowLine}"/>`,
  ];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${DAYLINE_HEIGHT}" viewBox="0 0 ${w} ${DAYLINE_HEIGHT}">${parts.join('')}</svg>`;
}
