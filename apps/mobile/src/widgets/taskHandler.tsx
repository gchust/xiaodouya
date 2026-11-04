import { parseWidgetAction } from '@xiaodouya/shared';
import type { WidgetTaskHandler } from 'react-native-android-widget';
import { handleWidgetClick, handleWidgetTick, refreshWidgets } from './controller';

/**
 * 小工具的所有事件都从这里进来。可能在 App 完全没开时被系统拉起，只跑入口文件。
 * 选 Headless JS 而不是原生直接写 SQLite：这样只有一个写入者，校验、同步和记录格式也只有一套；
 * 原生再开一个连接，还要在 Kotlin 里把这些规则重写一遍，App 正开着时内存和数据库也会不一致。
 */
export const widgetTaskHandler: WidgetTaskHandler = async ({
  widgetInfo,
  widgetAction,
  clickAction,
  clickActionData,
  renderWidget,
}) => {
  if (widgetAction === 'WIDGET_DELETED') return;
  try {
    const action = clickAction === 'RECORD' ? parseWidgetAction(clickActionData) : null;
    if (widgetAction === 'WIDGET_CLICK' && action) {
      await handleWidgetClick(widgetInfo.widgetName, action, { renderWidget, widgetInfo });
    } else {
      await handleWidgetTick(widgetInfo.widgetName, { renderWidget, widgetInfo });
    }
  } catch {
    await refreshWidgets();
  }
};
