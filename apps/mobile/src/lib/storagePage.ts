import {
  formatBytes,
  quotaStatus,
  type Role,
  type StorageConfigView,
  type StorageUsage,
  storageProviderNames,
  t,
} from '@xiaodouya/shared';

/** 只看回忆的家人不上传，用量和他们没有关系。 */
export function canOpenStorage(role: Role | null): boolean {
  return role === 'admin' || role === 'caregiver';
}

/** S3 表单只给允许自定义存储的服务器上的管理员，其他人看用量。权限仍由服务端判断。 */
export function storagePageMode(role: Role | null, allowCustomStorage: boolean): 'form' | 'usage' {
  return role === 'admin' && allowCustomStorage ? 'form' : 'usage';
}

/**
 * 服务器关闭自定义存储后，已经在用自己存储的家庭还要能改配置：文件在那里，密钥过期不能被锁死。
 * 和服务端的 validateStorageInput 规则一致。
 */
export function canEditStorage(
  allowCustomStorage: boolean,
  source: StorageConfigView['source'],
): boolean {
  return allowCustomStorage || source === 'family';
}

const levelPrefix = (level: 'none' | 'ok' | 'warn' | 'full'): string =>
  level === 'warn' ? t().ui.nearlyFullPrefix : level === 'full' ? t().ui.fullPrefix : '';

/** 家人页“存储”那一行的小字。`config` 只有管理员拿得到，其他人传 null。 */
export function storageSummaryText(usage: StorageUsage, config: StorageConfigView | null): string {
  if (config?.source === 'none') return t().ui.storageNotSet;
  const status = quotaStatus(usage);
  if (status.level !== 'none') {
    const used = usage.quotaUsed ?? usage.total;
    return t().ui.storageUsedOf(
      levelPrefix(status.level),
      formatBytes(used),
      formatBytes(usage.quota ?? 0),
    );
  }
  const used = t().ui.storageUsed(usage.total ? formatBytes(usage.total) : '0');
  if (!config) return used;
  const name = config.provider
    ? storageProviderNames[config.provider]
    : t().ui.serverDefaultStorage;
  return `${name} · ${used}`;
}
