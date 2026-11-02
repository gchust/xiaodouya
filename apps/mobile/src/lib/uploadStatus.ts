import { type MediaKind, t } from '@xiaodouya/shared';
import type { UploadCounts, UploadProgress } from '../data/uploadQueue';

const KIND_ORDER: readonly MediaKind[] = ['image', 'video', 'audio', 'pdf'];

/** “3 张照片、1 个视频”。用户不知道也不用知道一张照片其实是原图和缩略图两个任务。 */
export function uploadCountsText(counts: UploadCounts): string {
  const parts = KIND_ORDER.filter((kind) => counts[kind] > 0).map((kind) =>
    t().ui.uploadKindCount(kind, counts[kind]),
  );
  return parts.join(t().ui.uploadCountsJoiner);
}

/** 上传卡片显示什么。不依赖 React Native，方便单元测试。 */
export function uploadCardStatus(progress: UploadProgress): {
  text: string;
  /** 用户关掉卡片后，这个值变了才重新显示。 */
  key: string;
} {
  const { total, failedCount, waitingForWifi, active, counts, failedCounts, offline } = progress;
  if (failedCount > 0 && total === 0) {
    return {
      text: t().ui.uploadsFailed(uploadCountsText(failedCounts)),
      key: `failed:${failedCount}`,
    };
  }
  const summary = uploadCountsText(counts);
  if (offline) {
    return { text: t().ui.uploadsOffline(summary), key: `offline:${total}:${failedCount}` };
  }
  if (waitingForWifi) {
    return { text: t().ui.uploadsWaitWifi(summary), key: `wifi:${total}:${failedCount}` };
  }
  if (!active && total > 0) {
    return { text: t().ui.uploadsWaiting(summary), key: `queued:${total}:${failedCount}` };
  }
  // 传输中数量一直在减少，不算状态变化，否则关掉的卡片每传完一个就跳出来一次。
  return { text: t().ui.uploadsActive(summary), key: `uploading:${failedCount}` };
}

/** “1.2 MB/s” 这样的数字，大的不留小数，免得读起来跳。 */
export function formatSpeed(bytesPerSecond: number): string {
  const units = ['KB/s', 'MB/s', 'GB/s'] as const;
  let value = bytesPerSecond / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** 分钟就够了，读秒只会让人觉得数字在乱跳。 */
export function formatEta(seconds: number): string {
  if (seconds < 60) return t().ui.etaUnderMinute;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return t().ui.etaMinutes(minutes);
  return t().ui.etaHours(Math.ceil(minutes / 60));
}

/** “1.2 MB/s · 约 3 分钟”。不在传（等 Wi-Fi、排队、断网、刚开始）时返回 null，界面只显示状态。 */
export function uploadSpeedText(
  progress: Pick<UploadProgress, 'speed' | 'etaSeconds'>,
): string | null {
  if (progress.speed === null) return null;
  const speed = formatSpeed(progress.speed);
  return progress.etaSeconds === null
    ? speed
    : t().ui.uploadSpeed(speed, formatEta(progress.etaSeconds));
}
