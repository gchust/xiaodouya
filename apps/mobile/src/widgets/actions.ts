import {
  planWidgetAction,
  type WidgetAction,
  type WidgetPlan,
  type WidgetSession,
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
): Promise<WidgetPlan> {
  const { baby, events, formulas } = store.getSnapshot();
  const plan = planWidgetAction(action, {
    session,
    hasBaby: Boolean(baby),
    entries: events,
    formulas,
    isKnownId: (id) => store.has(id),
    now,
  });
  if (plan.kind === 'write') await store.write('event', plan.id, plan.data);
  return plan;
}
