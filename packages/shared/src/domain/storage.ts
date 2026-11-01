import type { MediaScope, StorageUsage } from '../schemas';
import { formatBytes } from './age';

export type MediaCategory = 'image' | 'video' | 'audio' | 'document';

/** 证件不管是照片还是 PDF 都算证件，和用量页的分类一致。 */
export function mediaCategory(mime: string, scope: MediaScope): MediaCategory {
  if (scope === 'document') return 'document';
  const lower = mime.toLowerCase();
  if (lower.startsWith('video/')) return 'video';
  if (lower.startsWith('audio/')) return 'audio';
  return 'image';
}

const WARN_FRACTION = 0.8;

export type QuotaLevel = 'none' | 'ok' | 'warn' | 'full';

export interface QuotaStatus {
  level: QuotaLevel;
  /** 0–1，超出时也封顶为 1，给进度条用。没有上限时是 0。 */
  fraction: number;
  /** 提醒用户的话。没什么要说时是 null。 */
  warning: string | null;
}

/** 新字段对旧服务端是缺失的，所以都按可选处理。 */
export function quotaStatus(
  usage: Pick<StorageUsage, 'total'> & Partial<Pick<StorageUsage, 'quota' | 'quotaUsed'>>,
): QuotaStatus {
  const { quota } = usage;
  if (quota === undefined || quota === null || quota <= 0) {
    return { level: 'none', fraction: 0, warning: null };
  }
  const used = usage.quotaUsed ?? usage.total;
  const fraction = Math.min(1, used / quota);
  if (used >= quota) {
    return {
      level: 'full',
      fraction,
      warning: `存储空间已满（共 ${formatBytes(quota)}），新的照片和视频传不上去了。删除一些不需要的回忆或证件后，可以点重试。`,
    };
  }
  if (fraction >= WARN_FRACTION) {
    return {
      level: 'warn',
      fraction,
      warning: `存储空间快满了，已用 ${Math.floor(fraction * 100)}%。满了之后新的文件会传不上去。`,
    };
  }
  return { level: 'ok', fraction, warning: null };
}

/** 服务端回答前或读不到时用：旧版服务端没有 /v1/config，当时都能自定义存储。 */
export const DEFAULT_ALLOW_CUSTOM_STORAGE = true;
