import type { EventData, PumpSide } from '../schemas';

/**
 * 吸奶（issue #104）。记的是大人吸了多少，不是宝宝吃了多少：喂奶次数、下次喂奶估算、奶粉营养、趋势、
 * 小工具都只看 `type: 'feed'`，吸奶自然不在里面；分享页明确不发（`shareEventGroup`）。`pump.test.ts` 把这些都钉住了。
 */

type PumpEvent = Extract<EventData, { type: 'pump' }>;

export interface PumpDefaults {
  ml?: number;
  side?: PumpSide;
}

/** 吸奶弹层的默认值：按时间最近的一次吸奶（补记的旧记录不算“上一次”）。没吸过时不猜。不看喂奶的奶量。 */
export function lastPumpDefaults(events: readonly EventData[], now: number): PumpDefaults {
  let last: PumpEvent | null = null;
  for (const e of events) {
    if (e.type === 'pump' && e.at <= now && (!last || e.at > last.at)) last = e;
  }
  if (!last) return {};
  return { ml: last.ml, ...(last.side ? { side: last.side } : {}) };
}
