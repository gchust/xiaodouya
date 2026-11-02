import { t } from '@xiaodouya/shared';
import type { UploadProgress } from '../data/uploadQueue';

/** 上传卡片显示什么。不依赖 React Native，方便单元测试。 */
export function uploadCardStatus(progress: UploadProgress): {
  text: string;
  /** 用户关掉卡片后，这个值变了才重新显示。 */
  key: string;
} {
  const { total, failedCount, waitingForWifi, active } = progress;
  if (failedCount > 0 && total === 0) {
    return { text: t().ui.uploadsFailed(failedCount), key: `failed:${failedCount}` };
  }
  if (waitingForWifi) {
    return { text: t().ui.uploadsWaitWifi(total), key: `wifi:${total}:${failedCount}` };
  }
  if (!active && total > 0) {
    return { text: t().ui.uploadsWaiting(total), key: `queued:${total}:${failedCount}` };
  }
  // 传输中数量一直在减少，不算状态变化，否则关掉的卡片每传完一个就跳出来一次。
  return { text: t().ui.uploadsActive(total), key: `uploading:${failedCount}` };
}
