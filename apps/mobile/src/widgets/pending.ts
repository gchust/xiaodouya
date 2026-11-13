import { TAP_STUCK_MS, type WidgetAction } from '@xiaodouya/shared';
import type { WidgetButton, WidgetIds } from './views';

/**
 * 点了以后、写好之前，被点的按钮先画成“记录中…”（issue #69）。后台任务从系统拉起到写完，
 * 进程活着时也要一会儿，这段时间小工具画面不变，人会以为没点上又点。
 *
 * “记录中…”的按钮仍然带着原来那次点击的 id：再点只会落在同一条记录上（见 `planWidgetAction`），
 * 而进程在写完前被杀、画面停在“记录中…”时，再点一下就能补记上或者刷新成真实状态。
 * 不依赖 React Native，可以直接写单元测试。
 */
export interface PendingTap {
  action: WidgetAction;
  since: number;
}

export function buttonOf(action: WidgetAction): WidgetButton {
  if (action.type === 'diaper') return action.kind;
  // 开始和结束亲喂都是记喂奶小工具上那一个按钮。
  if (action.type === 'feed' || action.type === 'breastStart' || action.type === 'breastEnd') {
    return 'feed';
  }
  return 'sleep';
}

/** 被点的按钮沿用这次点击的 id，其他按钮用新的。结束睡眠和亲喂用的是记录本身的 id，不在这里。 */
export function idsWithPending(ids: WidgetIds, action: WidgetAction | undefined): WidgetIds {
  if (!action || action.type === 'sleepEnd' || action.type === 'breastEnd') return ids;
  return { ...ids, [buttonOf(action)]: action.id };
}

const sameAction = (a: WidgetAction, b: WidgetAction) => JSON.stringify(a) === JSON.stringify(b);

/** 每个小工具最多一个正在写的点击：画面上只有一个“记录中…”，后点的盖掉先点的。 */
export function createPendingTaps(stuckMs = TAP_STUCK_MS) {
  const taps = new Map<string, PendingTap>();
  return {
    start(widget: string, action: WidgetAction, now: number) {
      taps.set(widget, { action, since: now });
    },
    /** 只清掉自己那次：后点的另一个按钮还在写，不能把它的“记录中…”也清掉。 */
    finish(widget: string, action: WidgetAction) {
      const tap = taps.get(widget);
      if (tap && sameAction(tap.action, action)) taps.delete(widget);
    },
    /** 卡住太久（任务异常结束）就不再画“记录中…”，按钮不能一直停在那里。 */
    get(widget: string, now: number): WidgetAction | undefined {
      const tap = taps.get(widget);
      if (!tap) return undefined;
      if (now - tap.since >= stuckMs) {
        taps.delete(widget);
        return undefined;
      }
      return tap.action;
    },
  };
}
