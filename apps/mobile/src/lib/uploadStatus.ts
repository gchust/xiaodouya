import type { UploadProgress } from '../data/uploadQueue';

/** 上传卡片显示什么。不依赖 React Native，方便单元测试。 */
export function uploadCardStatus(progress: UploadProgress): {
  text: string;
  /** 用户关掉卡片后，这个值变了才重新显示。 */
  key: string;
} {
  const { total, failedCount, waitingForWifi, active } = progress;
  if (failedCount > 0 && total === 0) {
    return { text: `${failedCount} 个文件上传失败`, key: `failed:${failedCount}` };
  }
  if (waitingForWifi) {
    return { text: `${total} 个视频等 Wi-Fi 再上传`, key: `wifi:${total}:${failedCount}` };
  }
  if (!active && total > 0) {
    return { text: `${total} 个文件等待上传`, key: `queued:${total}:${failedCount}` };
  }
  // 传输中数量一直在减少，不算状态变化，否则关掉的卡片每传完一个就跳出来一次。
  return { text: `正在上传 ${total} 个文件`, key: `uploading:${failedCount}` };
}
