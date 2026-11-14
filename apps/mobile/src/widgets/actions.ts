import {
  planWidgetAction,
  type WidgetAction,
  type WidgetPlan,
  type WidgetSession,
  withBabyId,
} from '@xiaodouya/shared';
import type { RecordStore } from '../data/store';

/**
 * 执行一次小工具点击。写入走 `RecordStore`，和界面记录是同一条路径：
 * 先写本地、标记为待上传，同步引擎自然会看到它，也能在时间线上修改和删除。
 * 不依赖 React Native，所以能直接写单元测试。
 */
export async function runWidgetAction(
  action: WidgetAction,
  store: RecordStore,
  session: WidgetSession,
  now: number,
  /** 小工具给哪个宝宝记（`widgetBabyId`，issue #106）。null 是 App 里的当前宝宝。 */
  babyId: string | null = null,
): Promise<WidgetPlan> {
  const { formulas } = store.getSnapshot();
  const { baby, events } = store.viewFor(babyId);
  const plan = planWidgetAction(action, {
    session,
    hasBaby: Boolean(baby),
    entries: events,
    formulas,
    isKnownId: (id) => store.has(id),
    now,
  });
  if (plan.kind !== 'write') return plan;
  // 新记录写给小工具的宝宝，不是 App 里正在看的那个。改已有的（结束睡眠、亲喂）原样留着主人。
  const data = store.has(plan.id)
    ? plan.data
    : (withBabyId('event', plan.data, baby?.id) as typeof plan.data);
  await store.write('event', plan.id, data);
  return { ...plan, data };
}
