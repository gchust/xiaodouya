import { t } from '@xiaodouya/shared';
import { useEffect } from 'react';
import { AppState } from 'react-native';
import { UpdateSheet } from '../sheets/updateSheet';
import { useFeedback, useSheet } from '../ui/overlays';
import { useApp } from './app';
import { getUpdateController, removeInstalledApks } from './appUpdateRuntime';
import { IS_E2E } from './config';

/**
 * 打开 App、回到前台时（最多每隔 UPDATE_CHECK_INTERVAL_MS 问一次服务端）检查新版本，有的话用 Toast 轻轻提一句，不弹窗：
 * 半夜单手记录时不能被一个更新对话框挡住。点“看看”才打开更新弹层，设置里也能找到。
 * 打开了“自动下载新版本”时不提示，在后台下好、校验好，再由今天页的提示卡（UpdateReadyCard）请用户安装。
 *
 * E2E 构建不自动检查：每组的服务端都发布了一个假版本（流程 23），自动提示会挡住别的流程。
 * 本机核对上次下好的包（restore）不问服务端，E2E 也做，流程 23a 靠它测重新打开后的提示卡。
 */
export function UpdateWatcher() {
  const app = useApp();
  const sheet = useSheet();
  const { toast } = useFeedback();
  const updates = getUpdateController(app.api, app.db);
  const ready = app.sessionState === 'ready';

  useEffect(removeInstalledApks, []);

  useEffect(() => {
    if (updates && ready) void updates.restore();
  }, [updates, ready]);

  useEffect(() => {
    if (!updates || !ready || IS_E2E) return;
    const run = () => {
      void updates.autoCheck().then((update) => {
        if (!update) return;
        toast(
          update.required
            ? t().update.toastRequired(update.versionName)
            : t().update.toast(update.versionName),
          {
            undo: () => sheet.open(t().update.title, () => <UpdateSheet />),
            actionLabel: t().update.toastAction,
            actionTestID: 'update-toast-open',
            durationMs: 6000,
          },
        );
      });
    };
    run();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') run();
    });
    return () => sub.remove();
  }, [updates, ready, toast, sheet]);

  return null;
}
